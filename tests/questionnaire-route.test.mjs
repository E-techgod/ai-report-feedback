import test from 'node:test';
import assert from 'node:assert/strict';
import { handleQuestionnaire } from '../src/lib/questionnaire-handler.ts';
import { verifyDownloadGrant } from '../src/lib/download-grant.ts';
import { handlePdfDownload } from '../src/lib/report-pdf-handler.ts';
import { questionIds } from '../src/lib/questions.ts';
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
    async writeCells() {
      throw new Error('the questionnaire route must not write tracking cells');
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
  return { h, sheet, ctx: { deps: h.deps, secret: SECRET, gateway: sheet } };
}

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
  const run = async (offsetMs) =>
    handlePdfDownload(pdfRequest(body.report, body.download.token), {
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
    secret: SECRET,
    renderPdf: async () => Buffer.from('%PDF-fake'),
  });
  assert.equal(response.status, 401);
});

test('a failed Sheet write issues no grant and never calls the AI', async () => {
  const { h, sheet, ctx } = context();
  sheet.appendRow = async () => {
    throw new Error('quota exceeded');
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
  assert.equal(response.status, 502);
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
