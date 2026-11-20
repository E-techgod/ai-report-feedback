import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadLedgerKey, issueDownloadGrant } from '../src/lib/download-grant.ts';
import {
  MAX_DOWNLOADS_PER_SUBMISSION,
  createDownloadLimiter,
  createSheetLedger,
} from '../src/lib/download-ledger.ts';
import { handlePdfDownload } from '../src/lib/report-pdf-handler.ts';
import { sampleReport } from './helpers/fixtures.mjs';
import { T0 } from './helpers/flow-harness.mjs';
import { fakeLedgerGateway, freshLimiter } from './helpers/ledger.mjs';

const SECRET = 's'.repeat(32);
const at = (ms) => () => new Date(T0 + ms);

function rig({ gateway = fakeLedgerGateway(), limiter } = {}) {
  const rendered = [];
  const pdf = async (report) => (rendered.push(report), Buffer.from('%PDF-fake'));
  const l = limiter ?? freshLimiter(gateway).limiter;
  const report = sampleReport();
  const { token } = issueDownloadGrant(report, SECRET, new Date(T0));
  const download = (offsetMs = 1_000, over = {}) =>
    handlePdfDownload(
      new Request('https://example.com/api/report/pdf', {
        method: 'POST',
        headers: { 'x-download-token': over.token ?? token },
        body: JSON.stringify(over.report ?? report),
      }),
      { secret: SECRET, renderPdf: over.renderPdf ?? pdf, limiter: l, now: at(offsetMs) },
    );
  return { gateway, rendered, report, token, download, limiter: l };
}

/** Captures the structured security log lines a callback produces. */
async function logged(fn) {
  const lines = [];
  const { info, warn, error } = console;
  console.info = console.warn = (line) => lines.push(String(line));
  console.error = () => {};
  try {
    return { result: await fn(), lines, events: lines.map((l) => JSON.parse(l)) };
  } finally {
    Object.assign(console, { info, warn, error });
  }
}

test('each grant downloads at most five times; once spent, further attempts cost no render and no Google call', async () => {
  const r = rig();
  const { result: statuses, events } = await logged(async () => {
    const out = [];
    for (let i = 0; i < 7; i++) out.push((await r.download(1_000 + i * 1_000)).status);
    return out;
  });
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal(MAX_DOWNLOADS_PER_SUBMISSION, 5);
  // The instance learned the budget was spent when it delivered the 5th: the 6th and 7th were
  // refused from memory, with no render, no ledger append and no ledger read.
  assert.equal(r.gateway.calls.append, 5);
  assert.equal(r.gateway.calls.read, 5);
  assert.equal(r.rendered.length, 5);
  assert.equal(events.filter((e) => e.event === 'download_served').length, 5);
  assert.equal(events.filter((e) => e.event === 'download_limit_reached').length, 2);
});

test('the 429 explains itself, is not cacheable and carries no PDF', async () => {
  const r = rig();
  for (let i = 0; i < 5; i++) await r.download();
  const { result: response } = await logged(() => r.download());
  const body = await response.json();
  assert.equal(response.status, 429);
  assert.match(body.error, /límite de 5 descargas/);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  assert.notEqual(response.headers.get('content-type'), 'application/pdf');
});

test('the five-minute expiry still applies, whatever is left of the budget', async () => {
  const r = rig();
  assert.equal((await r.download(1_000)).status, 200);
  const { events, result } = await logged(() => r.download(300_000));
  assert.equal(result.status, 410);
  assert.equal(events[0].event, 'download_expired');
  assert.equal(r.gateway.calls.append, 1, 'an expired grant never reaches the ledger');
});

test('unauthorized requests are refused without rendering or touching the ledger', async () => {
  const r = rig();
  const other = sampleReport();
  const cases = [
    ['no token', { token: '' }],
    ['garbage token', { token: 'nope' }],
    ['token of another report', { token: issueDownloadGrant(other, SECRET, new Date(T0)).token }],
    ['tampered report', { report: { ...r.report, firstName: 'Mallory' } }],
  ];
  const { events } = await logged(async () => {
    for (const [label, over] of cases)
      assert.equal((await r.download(1_000, over)).status, 401, label);
  });
  assert.equal(r.rendered.length, 0);
  assert.equal(r.gateway.calls.append + r.gateway.calls.read, 0);
  assert.deepEqual(
    events.map((e) => [e.event, e.reason]),
    [
      ['download_unauthorized', 'missing_grant'],
      ['download_unauthorized', 'invalid_grant'],
      ['download_unauthorized', 'invalid_grant'],
      ['download_unauthorized', 'invalid_grant'],
    ],
  );
});

test('a failed render never uses one of the five downloads', async () => {
  const r = rig();
  const failing = async () => {
    throw new Error('render exploded');
  };
  await logged(async () => {
    assert.equal((await r.download(1_000, { renderPdf: failing })).status, 500);
    assert.equal((await r.download(2_000, { renderPdf: failing })).status, 500);
  });
  assert.equal(r.gateway.calls.append, 0);
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await r.download(3_000 + i)).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
});

test('parallel requests on one instance cannot exceed the limit', async () => {
  const r = rig();
  const { result: responses } = await logged(() =>
    Promise.all(Array.from({ length: 12 }, () => r.download())),
  );
  const statuses = responses.map((x) => x.status);
  assert.equal(statuses.filter((s) => s === 200).length, 5);
  assert.equal(statuses.filter((s) => s === 429).length, 7);
});

test('parallel requests spread over several instances still deliver exactly five (the Sheet decides)', async () => {
  const gateway = fakeLedgerGateway(); // one shared spreadsheet...
  const instances = Array.from({ length: 4 }, () => freshLimiter(gateway).limiter); // ...four instances
  const rigs = instances.map((limiter) => rig({ gateway, limiter }));
  // Same report and token on every instance: a grant is valid wherever it is presented.
  const [{ report, token }] = rigs;
  const requests = Array.from({ length: 20 }, (_, i) =>
    rigs[i % rigs.length].download(1_000, { token, report }),
  );
  const { result: responses } = await logged(() => Promise.all(requests));
  const statuses = responses.map((x) => x.status);
  assert.equal(statuses.filter((s) => s === 200).length, 5, 'exactly five PDFs were delivered');
  assert.equal(statuses.filter((s) => s === 429).length, 15);
  // Every attempt that rendered recorded one row; ordinals 1..5 won.
  const ledgerRows = gateway.rows.slice(1);
  assert.ok(ledgerRows.every((row) => row[1] === downloadLedgerKey(report, SECRET)));
});

test('one submission, one budget: grants issued for it later share the same five downloads', async () => {
  const gateway = fakeLedgerGateway();
  const { limiter } = freshLimiter(gateway);
  const a = rig({ gateway, limiter });
  // A second grant for the same submission (e.g. a duplicate within the window) with another deadline.
  const reissued = issueDownloadGrant(a.report, SECRET, new Date(T0), T0 - 60_000);
  assert.notEqual(reissued.token, a.token);
  await logged(async () => {
    for (let i = 0; i < 3; i++) assert.equal((await a.download()).status, 200);
    assert.equal((await a.download(1_000, { token: reissued.token })).status, 200);
    assert.equal((await a.download(1_000, { token: reissued.token })).status, 200);
    assert.equal((await a.download(1_000, { token: reissued.token })).status, 429);
    assert.equal((await a.download()).status, 429);
  });
});

test('different submissions have independent budgets', async () => {
  const gateway = fakeLedgerGateway();
  const { limiter } = freshLimiter(gateway);
  const a = rig({ gateway, limiter });
  const b = rig({ gateway, limiter });
  await logged(async () => {
    for (let i = 0; i < 6; i++) await a.download();
    assert.equal((await a.download()).status, 429);
    assert.equal((await b.download()).status, 200, "another person's report is unaffected");
  });
});

test('if the ledger cannot be reached the download fails closed (503) and is not delivered', async () => {
  const gateway = fakeLedgerGateway({ failAppend: true });
  const r = rig({ gateway });
  const { result: response, events } = await logged(() => r.download());
  assert.equal(response.status, 503);
  assert.notEqual(response.headers.get('content-type'), 'application/pdf');
  assert.equal(events[0].event, 'download_limit_unavailable');
  // Once the Sheet is back the same grant works again: the failure used no download.
  gateway.failAppend = false;
  assert.equal((await r.download()).status, 200);
});

test('a ledger write that cannot be confirmed is not trusted', async () => {
  const gateway = fakeLedgerGateway();
  const lying = {
    append: async (row) => (await gateway.append(row)) + 5, // claims a row that is not ours
    readKeys: (n) => gateway.readKeys(n),
  };
  const limiter = createDownloadLimiter(createSheetLedger(lying));
  const r = rig({ gateway, limiter });
  const { result: response } = await logged(() => r.download());
  assert.equal(response.status, 503);
});

test('the ledger holds only a timestamp and an opaque key: no email, name, answers or token', async () => {
  const r = rig();
  await r.download();
  const [header, row] = r.gateway.rows;
  assert.deepEqual(header, ['Fecha (UTC)', 'Concesión de descarga']);
  assert.equal(row.length, 2);
  assert.match(row[0], /^\d{4}-\d\d-\d\dT/);
  assert.match(row[1], /^dl_[0-9a-f]{32}$/);
  const text = JSON.stringify(r.gateway.rows);
  assert.ok(!text.includes(r.report.firstName));
  assert.ok(!text.includes(r.token));
  assert.ok(!text.includes(r.report.submissionId));
});

test('download logs never contain the token, the report or personal data', async () => {
  const r = rig();
  const { lines } = await logged(async () => {
    for (let i = 0; i < 6; i++) await r.download();
    await r.download(1_000, { token: 'x' });
    await r.download(400_000);
  });
  const text = lines.join('\n');
  assert.ok(!text.includes(r.token));
  assert.ok(!text.includes(r.report.firstName));
  assert.ok(!text.includes(r.report.reportId));
  assert.ok(!text.includes(r.report.submissionId));
  for (const line of lines) assert.equal(JSON.parse(line).app, 'bp-questionnaire');
});

test('the appended row number is read from the A1 ranges Google reports', async () => {
  const { appendedRowNumber } = await import('../src/lib/google-sheets-client.ts');
  assert.equal(appendedRowNumber("'Control de descargas'!A42:B42"), 42);
  assert.equal(appendedRowNumber("'Control de descargas'!A2:B2"), 2);
  assert.equal(appendedRowNumber('Sheet1!A7'), 7);
  assert.equal(appendedRowNumber("'Hoja con ! signo'!A130:B130"), 130);
  assert.equal(appendedRowNumber("'Control de descargas'!$A$9:$B$9"), 9);
  for (const bad of ['', undefined, null, 'garbage', "'Control de descargas'"])
    assert.equal(appendedRowNumber(bad), 0, String(bad));
});
