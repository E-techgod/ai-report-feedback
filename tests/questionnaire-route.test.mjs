import test from 'node:test';
import assert from 'node:assert/strict';
import { handleQuestionnaire } from '../src/lib/questionnaire-handler.ts';
import { createReportCache } from '../src/lib/report-cache.ts';
import { verifyDownloadGrant } from '../src/lib/download-grant.ts';
import { handlePdfDownload } from '../src/lib/report-pdf-handler.ts';
import { freshLimiter } from './helpers/ledger.mjs';
import { questionIds } from '../src/lib/questions.ts';
import { wallClock } from '../src/lib/sheets.ts';
import { reportDeps, submission } from './helpers/flow-harness.mjs';

const headers = [
  'Marca temporal',
  'Nombre',
  'Apellido*',
  'Correo*',
  'Estado Reporte',
  'Estado Email',
  'Estado Descarga PDF',
  'Estado Descarga CSV',
  'Fecha Generación',
  'Fecha Envío',
  'Fecha Descarga PDF',
  'Fecha Descarga CSV',
  'Último Error',
  'ID Reporte',
  'Intentos Email',
  ...Array.from({ length: 10 }, (_, i) => `A) ${i + 1}.- Pregunta`),
  ...Array.from({ length: 10 }, (_, i) => `B) ${i + 1}.- Pregunta`),
];

function gateway() {
  const rows = [headers];
  let appends = 0;
  const writes = [];
  return {
    rows,
    get appends() {
      return appends;
    },
    async readHeaders() {
      return headers;
    },
    async getTimeZone() {
      return 'Etc/GMT+6';
    },
    async readColumn(index) {
      return rows.map((row) => String(row[index] ?? ''));
    },
    async readRows(numbers) {
      return numbers.map((n) => rows[n - 1]);
    },
    async appendRow(row) {
      appends += 1;
      rows.push(row);
      return { updatedRows: 1, updatedCells: 24, updatedRange: '' };
    },
    writes,
    async writeCells(rowNumber, cells) {
      writes.push({ rowNumber, cells });
      for (const cell of cells) rows[rowNumber - 1][cell.index] = String(cell.value);
      return cells.length;
    },
  };
}

const request = (data) =>
  new Request('https://example.com/api/questionnaire', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });

const SECRET = 's'.repeat(32);

function context(opts) {
  const h = reportDeps(opts);
  const sheet = gateway();
  const tasks = [];
  const flush = async () => {
    while (tasks.length) await tasks.shift()();
  };
  return {
    h,
    sheet,
    tasks,
    flush,
    ctx: {
      deps: h.deps,
      secret: SECRET,
      gateway: sheet,
      schedule: (task) => tasks.push(task),
      reportCache: createReportCache(),
    },
  };
}

const STATUS = 4; // "Estado Reporte"
const OTHER_TRACKING = [5, 6, 7, 8, 9, 10, 11, 12, 14]; // email/download statuses, dates, error, attempts
const silenced = async (fn) => {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
};

const pdfRequest = (report, token) =>
  new Request('https://example.com/api/report/pdf', {
    method: 'POST',
    headers: { 'x-download-token': token },
    body: JSON.stringify(report),
  });

test('a successful submission saves the answers to the Sheet and issues a five-minute grant', async () => {
  const { h, sheet, ctx } = context();
  const input = submission();
  assert.equal(Object.keys(input.answers).length, questionIds.length);

  const response = await handleQuestionnaire(request(input), ctx);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(body.ok, true);
  assert.equal(body.duplicate, false);

  // Google Sheets: one header-mapped row with the identity and every answer as Si/No.
  assert.equal(sheet.appends, 1);
  const row = sheet.rows[1];
  assert.equal(row[1], 'Ana');
  assert.equal(row[3], 'ana.perez@example.com');
  const answers = row.slice(15, 35);
  assert.equal(answers.length, 20);
  questionIds.forEach((id, i) => assert.equal(answers[i], input.answers[id] ? 'Si' : 'No'));
  assert.equal(row[13], `submission:${input.id}`);

  // The AI text reaches the report untouched; the AI was called exactly once.
  assert.equal(h.narrativeCalls.length, 1);
  assert.equal(body.report.narrative.executiveSummary, 'Texto redactado por IA.');
  assert.equal(body.report.narrativeSource, 'ai');

  // Grant: five minutes, bound to this report, no stored state, nothing sensitive in the token.
  assert.equal(body.download.expiresInMs, 300_000);
  assert.equal(verifyDownloadGrant(body.report, body.download.token, SECRET, h.deps.now()), 'ok');
  assert.ok(!body.download.token.includes(body.report.reportId));
  assert.equal('accessToken' in body, false);
  assert.equal('email' in body, false, 'no email status is part of the response');
});

test('end to end: the issued grant downloads repeatedly for five minutes, then expires', async () => {
  const { h, ctx } = context();
  const body = await (await handleQuestionnaire(request(submission()), ctx)).json();
  const rendered = [];
  const { limiter } = freshLimiter();
  const run = async (offsetMs) =>
    handlePdfDownload(pdfRequest(body.report, body.download.token), {
      limiter,
      secret: SECRET,
      now: () => new Date(h.clock.t + offsetMs),
      renderPdf: async (r) => (rendered.push(r), Buffer.from('%PDF-fake')),
    });
  assert.equal((await run(5_000)).status, 200);
  assert.equal((await run(120_000)).status, 200);
  assert.equal((await run(299_000)).status, 200);
  assert.equal((await run(300_000)).status, 410);
  assert.equal(rendered.length, 3);
  assert.equal(h.narrativeCalls.length, 1);
});

test("another submission's grant cannot download this client's report", async () => {
  const { ctx } = context();
  const a = await (await handleQuestionnaire(request(submission()), ctx)).json();
  const b = await (
    await handleQuestionnaire(
      request(submission({ email: 'otra@example.com', firstName: 'Beto' })),
      ctx,
    )
  ).json();
  const response = await handlePdfDownload(pdfRequest(a.report, b.download.token), {
    limiter: freshLimiter().limiter,
    secret: SECRET,
    renderPdf: async () => Buffer.from('%PDF-fake'),
  });
  assert.equal(response.status, 401);
});

test('a failed Sheet write issues no grant and never calls the AI', async () => {
  const { h, sheet, ctx } = context();
  sheet.appendRow = async () => {
    throw new Error('sheet exploded');
  };
  const originalError = console.error;
  console.error = () => {};
  let response;
  try {
    response = await handleQuestionnaire(request(submission()), ctx);
  } finally {
    console.error = originalError;
  }
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.ok, false);
  assert.equal('download' in body, false);
  assert.equal('report' in body, false);
  assert.equal(h.narrativeCalls.length, 0);
});

test('when the report cannot be generated the answers stay saved but no grant is issued', async () => {
  const { sheet, ctx } = context({
    narrative: async () => {
      throw new Error('boom');
    },
  });
  const originalError = console.error;
  console.error = () => {};
  let response;
  try {
    response = await handleQuestionnaire(request(submission()), ctx);
  } finally {
    console.error = originalError;
  }
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, 'saved_unconfirmed');
  assert.match(response.headers.get('retry-after') ?? '', /^\d+$/);
  assert.equal(body.saved, true);
  assert.equal('download' in body, false);
  assert.equal('report' in body, false);
  assert.equal(sheet.appends, 1);
});

test('invalid submissions write nothing, call no AI and issue no grant', async () => {
  const { h, sheet, ctx } = context();
  const cases = [
    request(submission({ privacyAccepted: false })),
    request(submission({ answers: {} })),
    new Request('https://example.com/api/questionnaire', { method: 'POST', body: '{nope' }),
    new Request('https://example.com/api/questionnaire', {
      method: 'POST',
      body: 'x'.repeat(10_001),
    }),
  ];
  for (const req of cases) {
    const response = await handleQuestionnaire(req, ctx);
    assert.ok([400, 413].includes(response.status));
    assert.equal('download' in (await response.json()), false);
  }
  assert.equal(sheet.appends, 0);
  assert.equal(h.narrativeCalls.length, 0);
});

test('retrying the same submission does not append another row and gets a fresh grant', async () => {
  const { sheet, ctx } = context();
  const input = submission();
  const first = await (await handleQuestionnaire(request(input), ctx)).json();
  const retry = await (await handleQuestionnaire(request(input), ctx)).json();
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(sheet.appends, 1);
  assert.ok(retry.download.token);
  assert.equal(first.report.submissionId, retry.report.submissionId);
});

test('after a successful report only this row Estado Reporte becomes Generado', async () => {
  const { sheet, tasks, flush, ctx } = context();
  // An earlier, unrelated response row that must stay exactly as it is.
  const earlier = Array(headers.length).fill('');
  earlier[3] = 'otra@example.com';
  earlier[STATUS] = 'Pendiente';
  sheet.rows.push(earlier);
  const snapshotEarlier = [...earlier];
  const snapshotHeaders = [...headers];

  const input = submission();
  const body = await (await handleQuestionnaire(request(input), ctx)).json();
  assert.equal(body.ok, true);
  const row = sheet.rows[2];
  assert.equal(row[STATUS], 'Pendiente', 'not written before the response is sent');
  assert.equal(tasks.length, 1);

  await flush();
  assert.equal(row[STATUS], 'Generado');
  assert.equal(sheet.writes.length, 1);
  assert.equal(sheet.writes[0].rowNumber, 3);
  assert.deepEqual(sheet.writes[0].cells, [{ index: STATUS, value: 'Generado' }]);
  // Nothing else changed: answers, identity, marker, obsolete email/download fields stay empty.
  for (const i of OTHER_TRACKING) assert.equal(row[i], '', `column ${i}`);
  assert.equal(row[13], `submission:${input.id}`);
  const answers = row.slice(15, 35);
  questionIds.forEach((id, i) => assert.equal(answers[i], input.answers[id] ? 'Si' : 'No'));
  assert.deepEqual(sheet.rows[1], snapshotEarlier);
  assert.deepEqual(sheet.rows[0], snapshotHeaders);
});

test('a template-text report (AI unavailable) still counts as a generated report', async () => {
  const { fallbackNarrative } = await import('../src/lib/report.ts');
  const { sheet, flush, ctx } = context({
    narrative: async (model) => ({
      narrative: fallbackNarrative(model),
      source: 'template',
      failureReason: 'rate-limited',
    }),
  });
  await handleQuestionnaire(request(submission()), ctx);
  await flush();
  assert.equal(sheet.rows[1][STATUS], 'Generado');
});

test('a failed Sheet status update never affects the response or the grant', async () => {
  const { sheet, flush, ctx } = context();
  sheet.writeCells = async () => {
    throw new Error('quota exceeded');
  };
  const response = await handleQuestionnaire(request(submission()), ctx);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(body.download.token);
  const { lines } = await silenced(() => flush()); // the task itself must not throw
  assert.ok(lines.some((line) => line.includes('could not set Estado Reporte')));
  assert.equal(sheet.rows[1][STATUS], 'Pendiente');
});

test('a scheduler failure does not turn a good report into an error', async () => {
  const { ctx } = context();
  ctx.schedule = () => {
    throw new Error('no request scope');
  };
  const { result } = await silenced(() => handleQuestionnaire(request(submission()), ctx));
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.ok(body.download.token);
});

test('if the row moved or changed, nothing is written', async () => {
  const { sheet, flush, ctx } = context();
  await handleQuestionnaire(request(submission()), ctx);
  // Simulate a row insert/delete: the remembered row number now points at another person's row.
  sheet.rows[1][3] = 'someone-else@example.com';
  const { lines } = await silenced(() => flush());
  assert.equal(sheet.writes.length, 0);
  assert.ok(lines.some((line) => line.includes('no longer matches')));
  assert.equal(sheet.rows[1][STATUS], 'Pendiente');
});

test('failed submissions leave Estado Reporte as Pendiente and schedule nothing', async () => {
  const failedSheet = context();
  failedSheet.sheet.appendRow = async () => {
    throw new Error('sheet exploded');
  };
  await silenced(() => handleQuestionnaire(request(submission()), failedSheet.ctx));
  assert.equal(failedSheet.tasks.length, 0);

  const failedReport = context({
    narrative: async () => {
      throw new Error('boom');
    },
  });
  await silenced(() => handleQuestionnaire(request(submission()), failedReport.ctx));
  assert.equal(failedReport.tasks.length, 0);
  assert.equal(failedReport.sheet.rows[1][STATUS], 'Pendiente');
  assert.equal(failedReport.sheet.writes.length, 0);
});

test('a retry or refresh with the same submission writes the status only once', async () => {
  const { sheet, flush, ctx } = context();
  const input = submission();
  await handleQuestionnaire(request(input), ctx);
  await flush();
  const retry = await (await handleQuestionnaire(request(input), ctx)).json();
  await flush();
  assert.equal(retry.duplicate, true);
  assert.equal(sheet.appends, 1);
  assert.equal(sheet.rows.length, 2);
  assert.equal(sheet.rows[1][STATUS], 'Generado');
  assert.equal(sheet.writes.length, 1, 'already Generado: no second write');
});

test('a page refresh (new submission id, same person and answers) reuses the row and the ORIGINAL window, without another AI call', async () => {
  const { h, sheet, flush, ctx } = context();
  const first = submission();
  const original = await (await handleQuestionnaire(request(first), ctx)).json();
  await flush();
  // Google returns dates as serial numbers; the fake stores text, so mirror the real shape.
  sheet.rows[1][0] = wallClock(h.deps.now(), 'Etc/GMT+6').serial;
  h.clock.t += 60_000; // one minute later
  const refreshed = await (
    await handleQuestionnaire(request({ ...first, id: crypto.randomUUID() }), ctx)
  ).json();
  await flush();
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.duplicate, true);
  // Same report, same deadline: the window is NOT restarted by repeating the survey.
  assert.equal(refreshed.download.expiresInMs, 240_000);
  assert.equal(refreshed.download.token, original.download.token);
  assert.equal(h.narrativeCalls.length, 1, 'the AI is not called again');
  assert.equal(sheet.rows.length, 2, 'no second row');
  assert.equal(sheet.rows[1][STATUS], 'Generado');
  assert.equal(sheet.writes.length, 1);
});
