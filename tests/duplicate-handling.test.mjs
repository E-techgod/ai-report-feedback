import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadLedgerKey, verifyDownloadGrant } from '../src/lib/download-grant.ts';
import { handleQuestionnaire } from '../src/lib/questionnaire-handler.ts';
import { createReportCache } from '../src/lib/report-cache.ts';
import { handlePdfDownload } from '../src/lib/report-pdf-handler.ts';
import { submission } from './helpers/flow-harness.mjs';
import { freshLimiter } from './helpers/ledger.mjs';
import { SECRET, post, questionnaireContext } from './helpers/sheet-gateway.mjs';

const send = (ctx, input) => handleQuestionnaire(post(input), ctx);
const MIN = 60_000;

async function quiet(fn) {
  const { info, warn } = console;
  const lines = [];
  console.info = console.warn = (line) => lines.push(String(line));
  try {
    return { result: await fn(), events: () => lines.map((l) => JSON.parse(l)) };
  } finally {
    Object.assign(console, { info, warn });
  }
}

test('a retry of the same submission gets the same report and grant back, with no second AI call', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  const input = submission();
  const first = await (await send(ctx, input)).json();
  h.clock.t += 30_000;
  const { result: response, events } = await quiet(() => send(ctx, input));
  const retry = await response.json();
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(h.narrativeCalls.length, 1, 'Groq is not called again');
  assert.equal(sheet.appends, 1);
  assert.deepEqual(retry.report, first.report);
  assert.equal(retry.download.token, first.download.token);
  assert.equal(retry.download.expiresInMs, first.download.expiresInMs - 30_000, 'no new window');
  assert.equal(events()[0].outcome, 'served_cached_report');
});

test('when this instance has no cached report, a duplicate gets labelled template text: still no AI call', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  const input = submission();
  const first = await (await send(ctx, input)).json();
  h.clock.t += 60_000;
  // A different instance / a cold start: the report cache is empty.
  const { result: response } = await quiet(() =>
    send({ ...ctx, reportCache: createReportCache() }, input),
  );
  const retry = await response.json();
  assert.equal(retry.ok, true);
  assert.equal(h.narrativeCalls.length, 1, 'the AI was only called for the original');
  assert.equal(retry.report.narrativeSource, 'template');
  assert.equal(sheet.appends, 1);
  // It belongs to the ORIGINAL submission and ends when the original window ends.
  assert.equal(retry.report.submissionId, first.report.submissionId);
  assert.equal(retry.download.expiresInMs, 5 * MIN - 60_000);
  assert.equal(
    verifyDownloadGrant(retry.report, retry.download.token, SECRET, new Date(h.clock.t)),
    'ok',
  );
});

test('a duplicate after the five minutes is refused (409): nothing is regenerated or retrievable', async () => {
  const { h, ctx } = questionnaireContext();
  const input = submission();
  await send(ctx, input);
  // Same person, same answers, new id (a page refresh), 6 minutes later: still a duplicate of the
  // 10-minute window, but the download window of the original is over.
  h.clock.t += 6 * MIN;
  const { result: response, events } = await quiet(() =>
    send(ctx, { ...input, id: crypto.randomUUID() }),
  );
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.ok, false);
  assert.equal(body.duplicate, true);
  assert.ok(!('report' in body) && !('download' in body));
  assert.match(body.error, /ventana de descarga de 5 minutos terminó/);
  assert.match(body.error, /en 4 minutos/, 'tells when a new report can be requested');
  assert.equal(h.narrativeCalls.length, 1, 'no AI call');
  assert.equal(events()[0].outcome, 'refused_window_over');
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
});

test('after the 10-minute duplicate window the survey can be taken again as a new submission', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  const input = submission();
  await send(ctx, input);
  h.clock.t += 11 * MIN;
  const again = await send(ctx, { ...input, id: crypto.randomUUID() });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).duplicate, false);
  assert.equal(sheet.appends, 2);
  assert.equal(h.narrativeCalls.length, 2);
});

test('repeating the survey cannot multiply downloads: duplicates share the original five', async () => {
  const { h, ctx } = questionnaireContext();
  const input = submission();
  const original = await (await send(ctx, input)).json();
  h.clock.t += 30_000;
  const { result } = await quiet(() =>
    send({ ...ctx, reportCache: createReportCache() }, { ...input, id: crypto.randomUUID() }),
  );
  const repeat = await result.json();
  assert.notEqual(repeat.download.token, original.download.token, 'different report, new token');
  assert.equal(
    downloadLedgerKey(repeat.report, SECRET),
    downloadLedgerKey(original.report, SECRET),
  );

  const { limiter } = freshLimiter();
  const run = (body) =>
    handlePdfDownload(
      new Request('https://example.com/api/report/pdf', {
        method: 'POST',
        headers: { 'x-download-token': body.download.token },
        body: JSON.stringify(body.report),
      }),
      {
        secret: SECRET,
        limiter,
        renderPdf: async () => Buffer.from('%PDF-fake'),
        now: () => new Date(h.clock.t + 1_000),
      },
    );
  const statuses = [];
  await quiet(async () => {
    for (const body of [original, original, original, repeat, repeat, repeat, original])
      statuses.push((await run(body)).status);
  });
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
});

test('a duplicate whose original is still being served never extends the deadline', async () => {
  const { h, ctx } = questionnaireContext();
  const input = submission();
  const original = await (await send(ctx, input)).json();
  const deadline = h.clock.t + original.download.expiresInMs;
  for (const step of [60_000, 120_000, 100_000]) {
    h.clock.t += step;
    const { result } = await quiet(() => send(ctx, { ...input, id: crypto.randomUUID() }));
    const body = await result.json();
    assert.equal(body.ok, true);
    assert.equal(h.clock.t + body.download.expiresInMs, deadline);
  }
});

test('a Sheet failure while checking for duplicates still issues nothing and calls no AI', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  sheet.readColumn = async () => {
    throw new Error('quota exceeded');
  };
  const error = console.error;
  console.error = () => {};
  try {
    const response = await send(ctx, submission());
    assert.equal(response.status, 502);
  } finally {
    console.error = error;
  }
  assert.equal(h.narrativeCalls.length, 0);
});
