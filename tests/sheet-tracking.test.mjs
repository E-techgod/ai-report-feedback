import test from 'node:test';
import assert from 'node:assert/strict';
import { questionIds } from '../src/lib/questions.ts';
import { parseSheetSchema } from '../src/lib/sheet-schema.ts';
import { syncReportTracking } from '../src/lib/sheet-tracking.ts';
import { freshStore, sampleReport, SAMPLE_YES, fingerprintOf } from './helpers/fixtures.mjs';

const HEADERS = [
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
  ...Array.from({ length: 10 }, (_, i) => `A) \n${i + 1}.- Pregunta`),
  ...Array.from({ length: 10 }, (_, i) => `B)\n${i + 1}.- Pregunta`),
];
const AT = new Date('2026-11-18T15:00:00Z');

async function setup({ totals = false } = {}) {
  const headers = totals ? [...HEADERS, 'Total Reportes', 'Total Emails'] : HEADERS;
  const schema = parseSheetSchema(headers);
  const report = sampleReport();
  const row = Array(headers.length).fill('');
  row[schema.email] = 'a@b.com';
  for (const id of questionIds) row[schema.questions[id]] = SAMPLE_YES.includes(id) ? 'Si' : 'No';
  const sheet = [headers, row];
  const calls = [];
  const gateway = {
    async readHeaders() {
      return headers;
    },
    async getTimeZone() {
      return 'Etc/GMT+6';
    },
    async readRows(nums) {
      return nums.map((n) => sheet[n - 1]);
    },
    async writeCells(rowNumber, cells) {
      calls.push(cells);
      for (const { index, value } of cells) sheet[rowNumber - 1][index] = value;
      return cells.length;
    },
  };
  const store = await freshStore();
  const { record } = await store.insertReport({
    report,
    email: 'a@b.com',
    fingerprint: fingerprintOf('a@b.com'),
    emailStatus: 'disabled',
    sheetRowNumber: 2,
    now: AT,
  });
  return { store, gateway, sheet, calls, schema, record };
}

test('syncs the persisted report to only named tracking fields; repeated sync keeps counters stable', async () => {
  const ctx = await setup({ totals: true });
  assert.equal(await syncReportTracking(ctx.store, ctx.gateway, ctx.record.id), true);
  const row = ctx.sheet[1];
  assert.equal(row[ctx.schema.tracking.reportId], ctx.record.id);
  assert.equal(row[ctx.schema.tracking.emailStatus], 'Desactivado');
  assert.equal(row[ctx.schema.tracking.totalReports], 1);
  assert.equal(row[ctx.schema.tracking.totalEmails], 0);
  assert.equal(row[ctx.schema.questions.A1], 'Si');
  assert.equal(row[ctx.schema.tracking.csvStatus], '');
  assert.equal(ctx.calls.length, 1);
  assert.equal(await syncReportTracking(ctx.store, ctx.gateway, ctx.record.id), false);
});

test('later PDF and email state updates project without duplicating counts', async () => {
  const ctx = await setup({ totals: true });
  await syncReportTracking(ctx.store, ctx.gateway, ctx.record.id);
  await ctx.store.markPdfDownloaded(ctx.record.id, AT);
  const downloaded = await ctx.store.getById(ctx.record.id);
  assert.equal(downloaded.pdfDownloadedAt.toISOString(), AT.toISOString());
  await syncReportTracking(ctx.store, ctx.gateway, ctx.record.id);
  assert.equal(ctx.sheet[1][ctx.schema.tracking.pdfStatus], 'Descarga iniciada');
  assert.equal(ctx.sheet[1][ctx.schema.tracking.pdfDownloadedAt], '2026-11-18 09:00:00');
  assert.equal(ctx.sheet[1][ctx.schema.tracking.totalReports], 1);
});

test('refuses to overwrite a moved row or a different report id', async () => {
  const ctx = await setup();
  ctx.sheet[1][ctx.schema.email] = 'other@example.com';
  await assert.rejects(
    () => syncReportTracking(ctx.store, ctx.gateway, ctx.record.id),
    /email does not match/,
  );
  ctx.sheet[1][ctx.schema.email] = 'a@b.com';
  ctx.sheet[1][ctx.schema.tracking.reportId] = crypto.randomUUID();
  await assert.rejects(
    () => syncReportTracking(ctx.store, ctx.gateway, ctx.record.id),
    /different report/,
  );
  assert.equal(ctx.calls.length, 0);
});
