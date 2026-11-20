import test from 'node:test';
import assert from 'node:assert/strict';
import { handleQuestionnaire } from '../src/lib/questionnaire-handler.ts';
import { handlePdfDownload } from '../src/lib/report-pdf-handler.ts';
import { markPdfDownloaded, PDF_DOWNLOADED_LABEL } from '../src/lib/sheets.ts';
import { questionnaireContext, post, SECRET, headers } from './helpers/sheet-gateway.mjs';
import { submission, T0 } from './helpers/flow-harness.mjs';
import { freshLimiter } from './helpers/ledger.mjs';

const PDF_STATUS = headers.indexOf('Estado Descarga PDF');
const PDF_DATE = headers.indexOf('Fecha Descarga PDF');
const CSV_STATUS = headers.indexOf('Estado Descarga CSV');
const CSV_DATE = headers.indexOf('Fecha Descarga CSV');

/** A saved submission with its report and grant, plus a way to download it. */
async function setup() {
  const c = questionnaireContext();
  const response = await handleQuestionnaire(post(submission()), c.ctx);
  const { report, download } = await response.json();
  await c.flush(); // "Estado Reporte" = Generado
  c.sheet.writes.length = 0;
  const { limiter } = freshLimiter();
  const tasks = [];
  const downloadPdf = (offsetMs = 1_000, overrides = {}) =>
    handlePdfDownload(
      new Request('https://example.com/api/report/pdf', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-download-token': download.token },
        body: JSON.stringify(report),
      }),
      {
        secret: SECRET,
        renderPdf: async () => Buffer.from('%PDF-fake'),
        limiter,
        now: () => new Date(T0 + offsetMs),
        trackDownload: (r, at) => markPdfDownloaded(c.sheet, r.submissionId, at),
        schedule: (task) => tasks.push(task),
        ...overrides,
      },
    );
  const flush = async () => {
    while (tasks.length) await tasks.shift()();
  };
  return { ...c, report, downloadPdf, flush, tasks };
}

test('the first delivered PDF marks the state and the date in the response row', async () => {
  const s = await setup();
  const before = [...s.sheet.rows[1]];
  const response = await s.downloadPdf(1_000);
  assert.equal(response.status, 200);
  assert.equal(s.sheet.writes.length, 0, 'nothing is written before the response is sent');
  await s.flush();

  const row = s.sheet.rows[1];
  assert.equal(row[PDF_STATUS], PDF_DOWNLOADED_LABEL);
  // T0 is 12:00:00Z; the fake sheet's time zone is UTC-6, one second later.
  assert.equal(row[PDF_DATE], '2026-11-19 06:00:01');
  assert.equal(row[CSV_STATUS] ?? '', '', 'the CSV columns are not touched');
  assert.equal(row[CSV_DATE] ?? '', '');
  row.forEach((value, i) => {
    if (i !== PDF_STATUS && i !== PDF_DATE) assert.equal(value, before[i], `column ${i} unchanged`);
  });
  assert.equal(s.sheet.writes.length, 1);
  assert.deepEqual(
    s.sheet.writes[0].cells.map((cell) => cell.index).sort((a, b) => a - b),
    [PDF_STATUS, PDF_DATE],
  );
});

test('later downloads keep the first download date and write nothing', async () => {
  const s = await setup();
  await s.downloadPdf(1_000);
  await s.flush();
  const firstDate = s.sheet.rows[1][PDF_DATE];
  for (const offset of [60_000, 120_000]) {
    assert.equal((await s.downloadPdf(offset)).status, 200);
    await s.flush();
  }
  assert.equal(s.sheet.writes.length, 1);
  assert.equal(s.sheet.rows[1][PDF_DATE], firstDate);
});

test('a Sheets failure never affects the download', async () => {
  const s = await setup();
  s.sheet.writeCells = async () => {
    throw new Error('quota exceeded for user@example.com');
  };
  const response = await s.downloadPdf(1_000);
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), '%PDF-fake');
  await assert.doesNotReject(s.flush(), 'the failure is logged, not thrown');
});

test('a scheduler that throws never affects the download', async () => {
  const s = await setup();
  const response = await s.downloadPdf(1_000, {
    schedule: () => {
      throw new Error('no request scope');
    },
  });
  assert.equal(response.status, 200);
});

test('refused downloads are not recorded', async () => {
  const s = await setup();
  // Expired grant: 410.
  assert.equal((await s.downloadPdf(300_000)).status, 410);
  // Bad token: 401.
  assert.equal(
    (
      await handlePdfDownload(
        new Request('https://example.com/api/report/pdf', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-download-token': 'nope' },
          body: JSON.stringify(s.report),
        }),
        {
          secret: SECRET,
          renderPdf: async () => Buffer.from('%PDF-fake'),
          limiter: freshLimiter().limiter,
          now: () => new Date(T0 + 1_000),
          trackDownload: async () => assert.fail('must not track'),
          schedule: (task) => s.tasks.push(task),
        },
      )
    ).status,
    401,
  );
  assert.equal(s.tasks.length, 0);
  await s.flush();
  assert.equal(s.sheet.writes.length, 0);
  assert.equal(s.sheet.rows[1][PDF_STATUS] ?? '', '');
});

test('the sixth download is refused and does not touch the row again', async () => {
  const s = await setup();
  for (let i = 0; i < 5; i++) assert.equal((await s.downloadPdf(1_000 + i)).status, 200);
  assert.equal((await s.downloadPdf(1_010)).status, 429);
  await s.flush();
  assert.equal(s.sheet.writes.length, 1);
});

test('without tracking configured the download still works', async () => {
  const s = await setup();
  const response = await s.downloadPdf(1_000, { trackDownload: undefined, schedule: undefined });
  assert.equal(response.status, 200);
  await s.flush();
  assert.equal(s.sheet.writes.length, 0);
});

test('markPdfDownloaded writes nothing when the submission row is missing or duplicated', async () => {
  const s = await setup();
  await assert.rejects(
    markPdfDownloaded(s.sheet, '00000000-0000-4000-8000-000000000000'),
    (error) => error.code === 'row_not_found',
  );
  const marker = `submission:${s.report.submissionId}`;
  const idColumn = headers.indexOf('ID Reporte');
  const copy = [...s.sheet.rows[1]];
  assert.equal(copy[idColumn], marker);
  s.sheet.rows.push(copy);
  await assert.rejects(
    markPdfDownloaded(s.sheet, s.report.submissionId),
    (error) => error.code === 'row_ambiguous',
  );
  assert.equal(s.sheet.writes.length, 0);
});

test('markPdfDownloaded finds the row even after rows were inserted above it', async () => {
  const s = await setup();
  s.sheet.rows.splice(1, 0, Array(headers.length).fill('otra fila'));
  assert.equal(await markPdfDownloaded(s.sheet, s.report.submissionId, new Date(T0)), true);
  assert.equal(s.sheet.rows[2][PDF_STATUS], PDF_DOWNLOADED_LABEL);
  assert.equal(s.sheet.rows[1][PDF_STATUS], 'otra fila', 'the other row is untouched');
});

/** Headers still used by the app; everything else of the old Apps Script pipeline is optional. */
const UNUSED = [
  'Estado Email',
  'Estado Descarga CSV',
  'Fecha Generación',
  'Fecha Envío',
  'Fecha Descarga CSV',
  'Último Error',
  'Intentos Email',
];

test('the pipeline works after the unused tracking columns are deleted from the sheet', async () => {
  const c = questionnaireContext();
  c.sheet.rows[0] = headers.filter((h) => !UNUSED.includes(h));
  const response = await handleQuestionnaire(post(submission()), c.ctx);
  assert.equal(response.status, 200);
  const { report, download } = await response.json();
  await c.flush();
  const h = c.sheet.rows[0];
  assert.equal(c.sheet.rows[1][h.indexOf('Estado Reporte')], 'Generado');

  const tasks = [];
  const served = await handlePdfDownload(
    new Request('https://example.com/api/report/pdf', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-download-token': download.token },
      body: JSON.stringify(report),
    }),
    {
      secret: SECRET,
      renderPdf: async () => Buffer.from('%PDF-fake'),
      limiter: freshLimiter().limiter,
      now: () => new Date(T0 + 1_000),
      trackDownload: (r, at) => markPdfDownloaded(c.sheet, r.submissionId, at),
      schedule: (task) => tasks.push(task),
    },
  );
  assert.equal(served.status, 200);
  for (const task of tasks) await task();
  assert.equal(c.sheet.rows[1][h.indexOf('Estado Descarga PDF')], PDF_DOWNLOADED_LABEL);
  assert.equal(c.sheet.rows[1][h.indexOf('Fecha Descarga PDF')], '2026-11-19 06:00:01');
});

test('the columns the app really depends on are still required', async () => {
  for (const missing of ['ID Reporte', 'Estado Reporte']) {
    const c = questionnaireContext();
    c.sheet.rows[0] = headers.filter((h) => h !== missing);
    const response = await handleQuestionnaire(post(submission()), c.ctx);
    assert.equal(
      response.status,
      502,
      `${missing} missing must refuse, not write to a shifted column`,
    );
    assert.equal(c.sheet.appends, 0, 'nothing is appended');
  }
});

test('without the PDF tracking columns the download works and nothing is written', async () => {
  const s = await setup();
  s.sheet.rows[0] = headers.filter(
    (h) => h !== 'Estado Descarga PDF' && h !== 'Fecha Descarga PDF',
  );
  const response = await s.downloadPdf(1_000);
  assert.equal(response.status, 200);
  await assert.doesNotReject(s.flush());
  assert.equal(s.sheet.writes.length, 0);
});
