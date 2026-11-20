import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadLedgerKey, issueDownloadGrant } from '../src/lib/download-grant.ts';
import { createDownloadLimiter, createSheetLedger } from '../src/lib/download-ledger.ts';
import { handleQuestionnaire } from '../src/lib/questionnaire-handler.ts';
import { handlePdfDownload } from '../src/lib/report-pdf-handler.ts';
import { classifySheetsError } from '../src/lib/sheets-errors.ts';
import { REJECTED_BY_LIMIT_LABEL } from '../src/lib/sheets.ts';
import { sampleReport } from './helpers/fixtures.mjs';
import { T0, submission } from './helpers/flow-harness.mjs';
import { fakeLedgerGateway } from './helpers/ledger.mjs';
import { STATUS, answersPattern, post, questionnaireContext } from './helpers/sheet-gateway.mjs';

const SECRET = 's'.repeat(32);
const send = (ctx, input) => handleQuestionnaire(post(input), ctx);

/** Runs `fn` with console output captured; returns the parsed structured log events too. */
async function captured(fn) {
  const lines = [];
  const { info, warn, error } = console;
  console.info = console.warn = (line) => lines.push(String(line));
  console.error = () => {};
  try {
    const result = await fn();
    return { result, events: lines.flatMap((l) => (l.startsWith('{') ? [JSON.parse(l)] : [])) };
  } finally {
    Object.assign(console, { info, warn, error });
  }
}

/** Deterministic pseudo-random numbers, so a failing seed can be replayed. */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

class GoogleError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

test('Google failures are classified without ever reading personal data', () => {
  assert.equal(classifySheetsError(new GoogleError('x', 429)), 'quota');
  assert.equal(classifySheetsError({ response: { status: 429 } }), 'quota');
  assert.equal(
    classifySheetsError(new Error('Quota exceeded for quota metric ReadRequests')),
    'quota',
  );
  assert.equal(classifySheetsError(new GoogleError('x', 'ETIMEDOUT')), 'timeout');
  assert.equal(classifySheetsError(new Error('network timeout at: https://sheets...')), 'timeout');
  assert.equal(classifySheetsError(new Error('boom')), 'other');
  assert.equal(classifySheetsError(undefined), 'other');
  assert.equal(classifySheetsError(new GoogleError('forbidden', 403)), 'other');
});

test('a Google quota error is a 503 with Retry-After, a friendly message and a reason-only log', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  sheet.batchRead = async () => {
    throw new GoogleError('Quota exceeded for quota metric ReadRequests, user=svc@secret.iam', 429);
  };
  const input = submission();
  const { result: response, events } = await captured(() => send(ctx, input));
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(body.code, 'service_busy');
  assert.match(body.error, /Inténtalo de nuevo en unos minutos/);
  assert.ok(
    !JSON.stringify(body).includes('svc@secret'),
    'Google error text never reaches the browser',
  );
  assert.equal(sheet.appends, 0, 'nothing was written');
  assert.equal(h.narrativeCalls.length, 0, 'no AI call');
  const logged = events.find((e) => e.event === 'sheets_unavailable');
  assert.equal(logged.reason, 'quota');
  assert.equal(JSON.stringify(events).includes('svc@secret'), false);
});

test('an append Google applied but reported as failed leaves ONE row, and the retry is refused cleanly', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  const realAppend = sheet.appendRow.bind(sheet);
  let first = true;
  sheet.appendRow = async (row) => {
    const result = await realAppend(row); // the write lands...
    if (first) {
      first = false;
      throw new GoogleError('network timeout', 'ETIMEDOUT'); // ...but the caller is told it failed
    }
    return result;
  };
  const input = submission();
  const { result: failed } = await captured(() => send(ctx, input));
  assert.equal(failed.status, 502);
  assert.equal(sheet.rows.length, 2, 'the row exists even though the caller saw an error');
  assert.equal(h.narrativeCalls.length, 0);

  // The user retries with the same id: no second row, and (nothing was ever generated, but the
  // server cannot prove it without storage) no report either: a clear error, never different feedback.
  const { result: retry } = await captured(() => send(ctx, input));
  const body = await retry.json();
  assert.equal(retry.status, 409);
  assert.equal(body.code, 'duplicate_report_unavailable');
  assert.equal(sheet.rows.length, 2, 'still exactly one row');
  assert.equal(h.narrativeCalls.length, 0, 'no AI call');
});

test('a write confirmed late (verification read fails) behaves the same: one row, no duplicate', async () => {
  const { sheet, ctx } = questionnaireContext();
  const realRead = sheet.batchRead.bind(sheet);
  let afterAppend = false;
  const realAppend = sheet.appendRow.bind(sheet);
  sheet.appendRow = async (row) => {
    const r = await realAppend(row);
    afterAppend = true;
    return r;
  };
  sheet.batchRead = async (ranges) => {
    if (afterAppend) {
      afterAppend = false;
      throw new GoogleError('socket hang up', 'ECONNRESET');
    }
    return realRead(ranges);
  };
  const input = submission();
  const { result: failed } = await captured(() => send(ctx, input));
  // Google confirmed the append, only the read-back failed: saved but not confirmed.
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).code, 'saved_unconfirmed');
  const { result: retry } = await captured(() => send(ctx, input));
  assert.equal(retry.status, 409);
  assert.equal(sheet.rows.length, 2);
});

test('a loser of the race cannot be absorbed as a "duplicate": a new attempt with its answers hits the limit', async () => {
  const { h, sheet, ctx } = questionnaireContext({ interleave: true });
  const attempts = Array.from({ length: 7 }, (_, n) =>
    submission({ answers: answersPattern(n + 60) }),
  );
  const { result: responses } = await captured(() =>
    Promise.all(attempts.map((a) => send(ctx, a))),
  );
  const loser = attempts[responses.findIndex((r) => r.status === 429)];
  assert.ok(loser);
  assert.ok(sheet.rows.some((row) => row[STATUS] === REJECTED_BY_LIMIT_LABEL));
  h.clock.t += 60_000;
  const { result: again } = await captured(() => send(ctx, { ...loser, id: crypto.randomUUID() }));
  assert.equal(again.status, 429, 'judged by the limit, not answered as "already received"');
});

test('FAULT INJECTION, submissions: with random Google failures the limit and consistency invariants hold', async () => {
  const seeds = 40;
  for (let seed = 1; seed <= seeds; seed++) {
    const random = rng(seed);
    const { h, sheet, ctx } = questionnaireContext({ interleave: true });
    const email = `fault${seed}@example.com`;
    // Every Sheets call may fail; a failed append may nevertheless have been applied (ambiguous).
    const chance = 0.12;
    for (const name of ['readHeaders', 'batchRead', 'writeCells']) {
      const real = sheet[name].bind(sheet);
      sheet[name] = async (...args) => {
        if (random() < chance) throw new GoogleError('boom', random() < 0.5 ? 429 : 'ETIMEDOUT');
        return real(...args);
      };
    }
    const realAppend = sheet.appendRow.bind(sheet);
    sheet.appendRow = async (row) => {
      const roll = random();
      if (roll < chance / 2) throw new GoogleError('boom', 429); // not applied
      const result = await realAppend(row);
      if (roll < chance) throw new GoogleError('boom', 'ETIMEDOUT'); // applied, reported as failed
      return result;
    };

    const attempts = Array.from({ length: 12 }, (_, n) =>
      submission({ email, answers: answersPattern(n + seed * 7) }),
    );
    // Some users retry once with the same id, like the real page does.
    const retries = attempts.filter(() => random() < 0.5);
    const { result: first } = await captured(() => Promise.all(attempts.map((a) => send(ctx, a))));
    const { result: second } = await captured(() => Promise.all(retries.map((a) => send(ctx, a))));
    // A retry of an already-served submission legitimately answers 200 again (same cached report),
    // so count DISTINCT submissions that were served, and the responses that created a report.
    const bodies = await Promise.all(
      [...first, ...second].filter((r) => r.status === 200).map((r) => r.json()),
    );
    const served = new Set(bodies.map((body) => body.report.submissionId)).size;
    const created = bodies.filter((body) => body.duplicate === false).length;

    assert.ok(served <= 5, `seed ${seed}: ${served} submissions served for one email (max 5)`);
    assert.equal(created, served, `seed ${seed}: one report per served submission`);
    assert.equal(
      h.narrativeCalls.length,
      served,
      `seed ${seed}: the AI is called once per served report`,
    );
    const ids = sheet.rows.slice(1).map((row) => row[13]);
    assert.equal(new Set(ids).size, ids.length, `seed ${seed}: a submission id was written twice`);
    for (const response of [...first, ...second])
      assert.ok(
        [200, 409, 429, 502, 503].includes(response.status),
        `seed ${seed}: ${response.status}`,
      );
  }
});

test('ledger: a quota error is a 503 with its reason logged, and does not deliver the PDF', async () => {
  const gateway = fakeLedgerGateway();
  const realAppend = gateway.append.bind(gateway);
  gateway.append = async () => {
    throw new GoogleError('Quota exceeded', 429);
  };
  const limiter = createDownloadLimiter(createSheetLedger(gateway));
  const report = sampleReport();
  const { token } = issueDownloadGrant(report, SECRET, new Date(T0));
  const request = () =>
    new Request('https://example.com/api/report/pdf', {
      method: 'POST',
      headers: { 'x-download-token': token },
      body: JSON.stringify(report),
    });
  const run = () =>
    handlePdfDownload(request(), {
      secret: SECRET,
      limiter,
      renderPdf: async () => Buffer.from('%PDF-fake'),
      now: () => new Date(T0 + 1_000),
    });
  const { result: response, events } = await captured(run);
  assert.equal(response.status, 503);
  assert.notEqual(response.headers.get('content-type'), 'application/pdf');
  assert.equal(events.find((e) => e.event === 'download_limit_unavailable').reason, 'quota');
  gateway.append = realAppend; // Google recovers: the same grant works
  assert.equal((await run()).status, 200);
});

test('FAULT INJECTION, downloads: with random ledger failures at most five PDFs are ever delivered', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const random = rng(seed * 31);
    const gateway = fakeLedgerGateway();
    const realAppend = gateway.append.bind(gateway);
    const realRead = gateway.readKeys.bind(gateway);
    gateway.append = async (row) => {
      const roll = random();
      if (roll < 0.1) throw new GoogleError('boom', 429); // not applied
      const rowNumber = await realAppend(row);
      if (roll < 0.2) throw new GoogleError('boom', 'ETIMEDOUT'); // applied but reported as failed
      return rowNumber;
    };
    gateway.readKeys = async (n) => {
      if (random() < 0.1) throw new GoogleError('boom', 'ETIMEDOUT');
      return realRead(n);
    };
    // Four "instances" share one spreadsheet.
    const limiters = Array.from({ length: 4 }, () =>
      createDownloadLimiter(createSheetLedger(gateway)),
    );
    const report = sampleReport();
    const { token } = issueDownloadGrant(report, SECRET, new Date(T0));
    const download = (i) =>
      handlePdfDownload(
        new Request('https://example.com/api/report/pdf', {
          method: 'POST',
          headers: { 'x-download-token': token },
          body: JSON.stringify(report),
        }),
        {
          secret: SECRET,
          limiter: limiters[i % limiters.length],
          renderPdf: async () => Buffer.from('%PDF-fake'),
          now: () => new Date(T0 + 1_000),
        },
      );
    const { result: responses } = await captured(() =>
      Promise.all(Array.from({ length: 24 }, (_, i) => download(i))),
    );
    const delivered = responses.filter((r) => r.status === 200).length;
    assert.ok(delivered <= 5, `seed ${seed}: ${delivered} PDFs delivered (max 5)`);
    // A failed attempt may have used a slot (stricter, never looser): the ledger never holds fewer
    // rows than there were deliveries.
    const rows = gateway.rows.filter((r) => r[1] === downloadLedgerKey(report, SECRET)).length;
    assert.ok(rows >= delivered, `seed ${seed}: ${rows} ledger rows for ${delivered} deliveries`);
  }
});
