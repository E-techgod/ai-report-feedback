import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAVED_UNCONFIRMED_MESSAGE,
  duplicateWindowRemaining,
  handleQuestionnaire,
} from '../src/lib/questionnaire-handler.ts';
import { createReportCache } from '../src/lib/report-cache.ts';
import { submission } from './helpers/flow-harness.mjs';
import { answersPattern, post, questionnaireContext } from './helpers/sheet-gateway.mjs';

const MIN = 60_000;
const send = (ctx, input) => handleQuestionnaire(post(input), ctx);

const EXACT_MESSAGE =
  'Recibimos tus respuestas, pero no pudimos completar tu reporte. Por favor, vuelve a intentarlo en aproximadamente 10 minutos.';
// What a 409 must never imply: that the person already holds a report.
const ASSUMES_A_REPORT_WAS_SEEN =
  /todavía tienes|sigue(s)? descargando|puedes seguir|ventana de descarga|tu informe abierto/i;
// What an UNCERTAIN write must never claim.
const CLAIMS_SAVED = /Recibimos tus respuestas|se guardaron|guardamos|ya recibimos/i;

class GoogleError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function captured(fn) {
  const lines = [];
  const { info, warn, error } = console;
  console.info = console.warn = (line) => lines.push(String(line));
  console.error = () => {};
  try {
    const result = await fn();
    return {
      result,
      lines,
      events: lines.flatMap((l) => (l.startsWith('{') ? [JSON.parse(l)] : [])),
    };
  } finally {
    Object.assign(console, { info, warn, error });
  }
}

/** Makes the first read after the append fail (the append itself succeeded). */
function failReadBackOnce(sheet, error = new GoogleError('socket hang up', 'ECONNRESET'), onFail) {
  const realAppend = sheet.appendRow.bind(sheet);
  const realRead = sheet.batchRead.bind(sheet);
  let armed = false;
  let used = false; // one-shot: only the first submission's read-back fails
  sheet.appendRow = async (row) => {
    const result = await realAppend(row);
    armed = !used;
    return result;
  };
  sheet.batchRead = async (ranges) => {
    if (armed) {
      armed = false;
      used = true;
      onFail?.();
      throw error;
    }
    return realRead(ranges);
  };
}

test('saved but not confirmed: 503 saved_unconfirmed with the exact Spanish message and Retry-After', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  failReadBackOnce(sheet);
  const { result: response, events } = await captured(() => send(ctx, submission()));
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, 'saved_unconfirmed');
  assert.equal(body.ok, false);
  assert.equal(body.error, EXACT_MESSAGE);
  assert.equal(SAVED_UNCONFIRMED_MESSAGE, EXACT_MESSAGE);
  assert.ok(!('report' in body) && !('download' in body), 'no report and no grant');
  assert.equal(response.headers.get('retry-after'), '600', 'the whole duplicate window is left');
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(sheet.rows.length, 2, 'the row really exists');
  assert.equal(h.narrativeCalls.length, 0, 'the AI was not called');
  const logged = events.find((e) => e.event === 'sheets_unavailable');
  assert.deepEqual(
    [logged.outcome, logged.reason],
    ['saved_unconfirmed', 'timeout'],
    'logged with a reason only',
  );
});

test('Retry-After is what is left of the 10-minute duplicate window, not a constant', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  // The failure arrives 90 seconds after the row was written.
  failReadBackOnce(sheet, undefined, () => (h.clock.t += 90_000));
  const { result: response } = await captured(() => send(ctx, submission()));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '510');
  assert.equal(duplicateWindowRemaining(1_000, 1_000 + 3 * MIN), 420);
  assert.equal(duplicateWindowRemaining(1_000, 1_000 + 30 * MIN), 1, 'never below 1 second');
  assert.equal(duplicateWindowRemaining(10_000, 0), 600, 'never above the window');
});

test('a verification mismatch after the append is saved-but-unconfirmed too', async () => {
  const { sheet, ctx } = questionnaireContext();
  const realAppend = sheet.appendRow.bind(sheet);
  sheet.appendRow = async (row) => {
    const result = await realAppend(row);
    sheet.rows.at(-1)[3] = 'someone-else@example.com'; // what Google stored is not what we sent
    return result;
  };
  const { result: response } = await captured(() => send(ctx, submission()));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'saved_unconfirmed');
});

test('the retry before the window ends is a 409 that never assumes a report was received', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  failReadBackOnce(sheet);
  const input = submission();
  await captured(() => send(ctx, input));
  for (const retryInput of [input, { ...input, id: crypto.randomUUID() }]) {
    h.clock.t += 60_000;
    const { result: retry } = await captured(() =>
      send({ ...ctx, reportCache: createReportCache() }, retryInput),
    );
    const body = await retry.json();
    assert.equal(retry.status, 409);
    assert.equal(body.code, 'duplicate_report_unavailable');
    assert.match(
      body.error,
      /Ya recibimos este diagnóstico, pero no podemos mostrar su informe desde aquí/,
    );
    assert.match(body.error, /Podrás generar un informe nuevo en \d+ minutos?\./);
    assert.doesNotMatch(body.error, ASSUMES_A_REPORT_WAS_SEEN);
  }
  assert.equal(sheet.rows.length, 2, 'no extra row');
  assert.equal(h.narrativeCalls.length, 0, 'no AI call');
});

test('after the window the same answers are accepted as a new submission with its own report', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  failReadBackOnce(sheet);
  const input = submission();
  await captured(() => send(ctx, input));
  h.clock.t += 10 * MIN + 1_000;
  const { result: again } = await captured(() => send(ctx, { ...input, id: crypto.randomUUID() }));
  const body = await again.json();
  assert.equal(again.status, 200);
  assert.equal(body.duplicate, false);
  assert.equal(body.report.narrativeSource, 'ai');
  assert.equal(h.narrativeCalls.length, 1, 'one AI call: for the new report only');
  assert.equal(sheet.rows.length, 3);
});

test('the unconfirmed row still counts toward the 5-per-24h limit (limits are unchanged)', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  for (let n = 0; n < 4; n++) {
    h.clock.t += 11 * MIN;
    assert.equal((await send(ctx, submission({ answers: answersPattern(n) }))).status, 200);
  }
  failReadBackOnce(sheet);
  h.clock.t += 11 * MIN;
  const { result: unconfirmed } = await captured(() =>
    send(ctx, submission({ answers: answersPattern(4) })),
  );
  assert.equal(unconfirmed.status, 503);
  h.clock.t += 11 * MIN;
  const { result: sixth } = await captured(() =>
    send(ctx, submission({ answers: answersPattern(5) })),
  );
  assert.equal(sixth.status, 429, 'five rows exist, so the next one is over the limit');
});

test('an UNCERTAIN write (the append call itself fails) claims nothing about being saved', async () => {
  for (const [label, error, status] of [
    ['quota', new GoogleError('Quota exceeded', 429), 503],
    ['timeout', new GoogleError('network timeout', 'ETIMEDOUT'), 502],
    ['other', new Error('boom'), 502],
  ]) {
    const { sheet, ctx } = questionnaireContext();
    const realAppend = sheet.appendRow.bind(sheet);
    sheet.appendRow = async (row) => {
      await realAppend(row); // Google may well have applied it...
      throw error; // ...but the caller cannot know
    };
    const { result: response } = await captured(() => send(ctx, submission()));
    const body = await response.json();
    assert.equal(response.status, status, label);
    assert.notEqual(body.code, 'saved_unconfirmed', label);
    assert.doesNotMatch(body.error, CLAIMS_SAVED, label);
    assert.ok(!('saved' in body), `${label}: no "saved" flag`);
  }
});

test('a failure BEFORE the append writes nothing and is not saved_unconfirmed', async () => {
  const { sheet, ctx } = questionnaireContext();
  sheet.batchRead = async () => {
    throw new GoogleError('Quota exceeded', 429);
  };
  const { result: response } = await captured(() => send(ctx, submission()));
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, 'service_busy');
  assert.doesNotMatch(body.error, CLAIMS_SAVED);
  assert.equal(sheet.rows.length, 1, 'nothing was written');
});

test('a report that could not be completed after a confirmed save uses the same response', async () => {
  const { h, sheet, ctx } = questionnaireContext({
    narrative: async () => {
      throw new Error('boom');
    },
  });
  const { result: response } = await captured(() => send(ctx, submission()));
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, 'saved_unconfirmed');
  assert.equal(body.error, EXACT_MESSAGE);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
  assert.ok(!('report' in body) && !('download' in body));
  assert.equal(sheet.rows.length, 2);
  void h;
});

test('success is unchanged: same report, grant and Groq call count as before', async () => {
  const { h, ctx } = questionnaireContext();
  const response = await send(ctx, submission());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.report.narrativeSource, 'ai');
  assert.equal(body.download.expiresInMs, 300_000, 'the 5-minute window is untouched');
  assert.equal(h.narrativeCalls.length, 1);
});

test('the recovery works only with a NEW submission id: a known id is a duplicate even after the window', async () => {
  const { h, sheet, ctx } = questionnaireContext();
  failReadBackOnce(sheet);
  const input = submission();
  await captured(() => send(ctx, input));
  h.clock.t += 11 * MIN;
  const sameId = await captured(() => send(ctx, input));
  assert.equal(sameId.result.status, 409, 'the server will never reuse a known id');
  assert.equal((await sameId.result.json()).code, 'duplicate_window_over');
  const newId = await captured(() => send(ctx, { ...input, id: crypto.randomUUID() }));
  assert.equal(newId.result.status, 200);
});

test('the page starts a new submission id after a definitive server answer (so "try again in 10 minutes" works)', async () => {
  // Static guard: the behaviour was verified in a DOM (jsdom) against real handler responses, which the
  // repository does not depend on. This keeps the line from being removed unnoticed.
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8');
  assert.match(
    page,
    /if \(!response\?\.ok \|\| data\.ok !== true\) \{[\s\S]*?submissionId\.current = null;[\s\S]*?throw new Error\(/,
  );
  // ...and only there: network errors and timeouts keep the id so their retry never adds a row.
  assert.equal(page.match(/submissionId\.current = null/g)?.length, 1);
});
