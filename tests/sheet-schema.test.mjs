import test from 'node:test';
import assert from 'node:assert/strict';
import { columnLetter, parseSheetSchema } from '../src/lib/sheet-schema.ts';

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
  ...Array.from({ length: 10 }, (_, i) => `A) \n${i + 1}.- Pregunta`),
  ...Array.from({ length: 10 }, (_, i) => `B)\n${i + 1}.- Pregunta`),
];

test('maps the live inserted tracking columns and question headers', () => {
  const schema = parseSheetSchema(headers);
  assert.equal(schema.email, 3);
  assert.equal(schema.tracking.reportId, 13);
  assert.equal(schema.questions.A1, 15);
  assert.equal(schema.questions.B10, 34);
  assert.equal(Object.hasOwn(schema.tracking, 'totalReports'), false);
  assert.equal(columnLetter(schema.questions.B10), 'AI');
});

test('maps reordered headers and ignores undefined total counters', () => {
  const rearranged = [...headers, 'Total Emails', 'Total Reportes'];
  [rearranged[3], rearranged[20]] = [rearranged[20], rearranged[3]];
  const schema = parseSheetSchema(rearranged);
  assert.equal(schema.email, 20);
  assert.equal(schema.questions.A6, 3);
  assert.equal(Object.hasOwn(schema.tracking, 'totalReports'), false);
  assert.equal(Object.hasOwn(schema.tracking, 'totalEmails'), false);
});

test('fails closed on missing or duplicate required headers', () => {
  assert.throws(() => parseSheetSchema(headers.filter((h) => h !== 'Correo*')), /Correo/);
  assert.throws(() => parseSheetSchema([...headers, 'Estado Reporte']), /Duplicate/);
  assert.throws(() => parseSheetSchema(headers.filter((h) => !h.startsWith('B)\n10'))), /B10/);
});
