import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadLedgerKey } from '../src/lib/download-grant.ts';
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

test('a duplicate this instance cannot reproduce is refused with a clear error: no template, no AI call, no grant', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  const input = submission();
  const first = await (await send(ctx, input)).json();
  assert.equal(first.report.narrativeSource, 'ai');
  h.clock.t += 60_000;
  // Another instance / a cold start: its report cache is empty and nothing is stored anywhere.
  const { result: response, events } = await quiet(() =>
    send({ ...ctx, reportCache: createReportCache() }, input),
  );
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.ok, false);
  assert.equal(body.duplicate, true);
  assert.equal(body.code, 'duplicate_report_unavailable');
  assert.ok(!('report' in body) && !('download' in body), 'no report and no new grant');
  assert.match(body.error, /no podemos volver a mostrarte el mismo informe/);
  assert.match(body.error, /sigue|seguir descargándolo hasta que termine su ventana de 5 minutos/);
  assert.match(body.error, /Podrás generar un informe nuevo en 9 minutos/);
  assert.equal(h.narrativeCalls.length, 1, 'the AI was only called for the original');
  assert.equal(sheet.appends, 1);
  assert.equal(events()[0].outcome, 'refused_report_unavailable');
});

test('the same holds for a page refresh (new id, same answers) on an instance without the report', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  const input = submission();
  await send(ctx, input);
  h.clock.t += 30_000;
  const { result: response } = await quiet(() =>
    send({ ...ctx, reportCache: createReportCache() }, { ...input, id: crypto.randomUUID() }),
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'duplicate_report_unavailable');
  assert.equal(h.narrativeCalls.length, 1);
  assert.equal(sheet.appends, 1);
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

test('the original report, its grant and its five downloads are preserved for a duplicate', async () => {
  const { h, ctx } = questionnaireContext();
  const input = submission();
  const original = await (await send(ctx, input)).json();
  h.clock.t += 30_000;
  const { result } = await quiet(() => send(ctx, { ...input, id: crypto.randomUUID() }));
  const repeat = await result.json();
  // Identical feedback and the identical grant: nothing was regenerated or re-signed.
  assert.deepEqual(repeat.report, original.report);
  assert.equal(repeat.report.narrativeSource, 'ai');
  assert.equal(repeat.download.token, original.download.token);
  assert.equal(
    downloadLedgerKey(repeat.report, SECRET),
    downloadLedgerKey(original.report, SECRET),
  );
  assert.equal(h.narrativeCalls.length, 1);

  // And only ONE budget of five downloads exists for the two responses together.
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
    for (const body of [original, repeat, original, repeat, original, repeat, original])
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
    throw new Error('sheet exploded');
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
