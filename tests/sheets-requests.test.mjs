import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { google } from 'googleapis';
import { createGoogleSheetsGateway, rangeA1 } from '../src/lib/google-sheets-client.ts';
import { handleQuestionnaire } from '../src/lib/questionnaire-handler.ts';
import { submission } from './helpers/flow-harness.mjs';
import { answersPattern, post, questionnaireContext } from './helpers/sheet-gateway.mjs';

const MIN = 60_000;
const send = (ctx, input) => handleQuestionnaire(post(input), ctx);

/** Counts every Sheets API request (not ranges) the app makes through the gateway. */
function counting(sheet) {
  const log = [];
  const wrap = (name, kind) => {
    const real = sheet[name].bind(sheet);
    let requested = false;
    sheet[name] = async (...args) => {
      // The real gateway memoizes the time zone for the life of the instance (one request, ever).
      if (name !== 'getTimeZone' || !requested) log.push({ name, kind });
      if (name === 'getTimeZone') requested = true;
      return real(...args);
    };
  };
  for (const name of ['getTimeZone', 'readHeaders', 'batchRead', 'readColumn', 'readRows'])
    wrap(name, 'read');
  for (const name of ['appendRow', 'writeCells']) wrap(name, 'write');
  const take = () => {
    const taken = log.splice(0);
    return {
      reads: taken.filter((c) => c.kind === 'read').length,
      writes: taken.filter((c) => c.kind === 'write').length,
      names: taken.map((c) => c.name),
    };
  };
  return take;
}

async function accept(h, ctx, flush, input) {
  h.clock.t += 11 * MIN; // beyond the 10-minute duplicate window
  const response = await send(ctx, input);
  await flush(); // the "Generado" update runs after the response
  return response;
}

test('an accepted submission costs 4 reads + 2 writes on a warm instance (was 10 + 2)', async () => {
  const { h, sheet, flush, ctx } = questionnaireContext();
  const take = counting(sheet);
  const email = 'warm@example.com';
  const costs = [];
  for (let n = 0; n < 4; n++) {
    const response = await accept(h, ctx, flush, submission({ email, answers: answersPattern(n) }));
    assert.equal(response.status, 200);
    costs.push(take());
  }
  // Instance cold start, first ever submission of this email: time zone + header row + 2 columns...
  assert.deepEqual(costs[0].names, [
    'batchRead', // header row (cold: nothing remembered)
    'batchRead', // marker + email columns
    'getTimeZone', // once per instance
    'appendRow',
    'batchRead', // read-back: marker column + email column + the appended row, in one request
    'batchRead', // "Generado": header row + the row, in one request
    'writeCells',
  ]);
  // ...warm instance, e-mail with history: header+columns in ONE request, newest rows in ONE request.
  for (const cost of costs.slice(1))
    assert.deepEqual(cost.names, [
      'batchRead', // header row (validates the remembered schema) + marker column + email column
      'batchRead', // this email's newest rows (duplicate + limit checks)
      'appendRow',
      'batchRead', // read-back + rank, one request
      'batchRead', // "Generado"
      'writeCells',
    ]);
  assert.deepEqual(
    costs.slice(1).map((c) => [c.reads, c.writes]),
    [
      [4, 2],
      [4, 2],
      [4, 2],
    ],
  );
});

test('a refused 6th submission costs 2 reads and writes nothing (was 5 reads)', async () => {
  const { h, sheet, flush, ctx } = questionnaireContext();
  const take = counting(sheet);
  const email = 'limit@example.com';
  for (let n = 0; n < 5; n++)
    assert.equal(
      (await accept(h, ctx, flush, submission({ email, answers: answersPattern(n) }))).status,
      200,
    );
  take();
  h.clock.t += 11 * MIN;
  const refused = await send(ctx, submission({ email, answers: answersPattern(9) }));
  assert.equal(refused.status, 429);
  const cost = take();
  assert.deepEqual([cost.reads, cost.writes], [2, 0]);
});

test('a retry of a known submission id (another instance, or after 15 minutes) costs 2 reads, 0 writes', async () => {
  const { h, sheet, flush, ctx } = questionnaireContext();
  const take = counting(sheet);
  const input = submission({ email: 'retry@example.com' });
  assert.equal((await accept(h, ctx, flush, input)).status, 200);
  take();
  // The in-memory memory of the id is gone (15 minutes), so the marker in the Sheet answers it.
  h.clock.t += 16 * MIN;
  const retry = await send(ctx, input);
  assert.equal(retry.status, 409);
  const cost = take();
  assert.deepEqual([cost.reads, cost.writes], [2, 0]);
  assert.equal(sheet.rows.length, 2, 'no second row');
});

test('a column inserted into the sheet is noticed inside the same request: no stale-schema write', async () => {
  const { h, sheet, flush, ctx } = questionnaireContext();
  const email = 'shift@example.com';
  assert.equal(
    (await accept(h, ctx, flush, submission({ email, answers: answersPattern(0) }))).status,
    200,
  );
  // Someone inserts a column right after "Marca temporal" while this instance holds the old header row.
  for (const row of sheet.rows) row.splice(1, 0, row === sheet.rows[0] ? 'Columna nueva' : '');
  const take = counting(sheet);
  const response = await accept(h, ctx, flush, submission({ email, answers: answersPattern(1) }));
  assert.equal(response.status, 200);
  const cost = take();
  // The remembered schema was rejected (one extra request), not trusted:
  assert.equal(cost.names.filter((n) => n === 'batchRead').length, 5);
  const stored = sheet.rows.at(-1);
  assert.equal(stored[4], email, 'email landed in the shifted "Correo*" column');
  assert.equal(stored[1], '', 'and nothing was written into the inserted column');
  assert.equal(stored[5], 'Generado', 'the status update used the new column too');
});

test('Google counts requests, not ranges: every gateway method is exactly one HTTP request', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push({
      method: req.method,
      path: url.pathname,
      ranges: url.searchParams.getAll('ranges'),
    });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (url.pathname.endsWith('values:batchGet'))
        res.end(
          JSON.stringify({
            valueRanges: url.searchParams.getAll('ranges').map(() => ({ values: [['x']] })),
          }),
        );
      else if (url.pathname.endsWith('values:batchUpdate'))
        res.end(JSON.stringify({ totalUpdatedCells: 3 }));
      else if (url.pathname.includes(':append'))
        res.end(
          JSON.stringify({
            updates: { updatedRows: 1, updatedCells: 1, updatedRange: "'T'!A9:B9" },
          }),
        );
      else res.end(JSON.stringify({ properties: { timeZone: 'America/Mexico_City' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const sheets = google.sheets({
      version: 'v4',
      auth: 'test-key',
      rootUrl: `http://127.0.0.1:${port}/`,
    });
    const gateway = createGoogleSheetsGateway({ spreadsheetId: 'TEST', sheets });
    const take = () => seen.splice(0);

    const out = await gateway.batchRead([
      { kind: 'headers' },
      { kind: 'column', index: 13 },
      { kind: 'row', row: 5, width: 25 },
      { kind: 'row', row: 7 },
    ]);
    const batch = take();
    assert.equal(out.length, 4);
    assert.equal(batch.length, 1, '4 ranges, 1 API request');
    assert.deepEqual(batch[0].ranges, [
      "'Respuestas de formulario 1'!1:1",
      "'Respuestas de formulario 1'!N:N",
      "'Respuestas de formulario 1'!A5:Y5",
      "'Respuestas de formulario 1'!7:7",
    ]);

    await gateway.readRows([2, 3, 4, 5, 6], 25);
    assert.equal(take().length, 1, 'readRows of 5 rows is 1 request');

    await gateway.writeCells(9, [
      { index: 4, value: 'a' },
      { index: 5, value: 'b' },
      { index: 6, value: 'c' },
    ]);
    assert.equal(take().length, 1, 'writing 3 cells is 1 request');

    await gateway.appendRow(['a', 'b']);
    assert.equal(take().length, 1);

    await gateway.getTimeZone();
    await gateway.getTimeZone();
    assert.equal(take().length, 1, 'the time zone is requested once per gateway');
    assert.equal(rangeA1({ kind: 'column', index: 0 }), "'Respuestas de formulario 1'!A:A");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A local stand-in for Google that answers every request with `status` and counts them. */
async function serverAnswering(status) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url.split('?')[0]}`);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error: { code: status, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const sheets = google.sheets({
    version: 'v4',
    auth: 'test-key',
    rootUrl: `http://127.0.0.1:${port}/`,
  });
  return {
    seen,
    gateway: createGoogleSheetsGateway({ spreadsheetId: 'TEST', sheets }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('a Google 429 is NOT retried by the client: a retry 100 ms later cannot beat a per-minute quota', async () => {
  const google429 = await serverAnswering(429);
  try {
    await assert.rejects(() => google429.gateway.batchRead([{ kind: 'headers' }]));
    await assert.rejects(() => google429.gateway.writeCells(2, [{ index: 4, value: 'x' }]));
    assert.equal(google429.seen.length, 2, `one request each, got: ${google429.seen.join(', ')}`);
  } finally {
    await google429.close();
  }
});

test('a transient Google 503 is still retried (reads are idempotent)', async () => {
  const google503 = await serverAnswering(503);
  try {
    await assert.rejects(() => google503.gateway.batchRead([{ kind: 'headers' }]));
    assert.ok(google503.seen.length > 1, 'a read hitting a 503 is retried');
  } finally {
    await google503.close();
  }
});
