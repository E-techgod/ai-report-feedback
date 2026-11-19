import test from 'node:test';
import assert from 'node:assert/strict';
import { handleQuestionnaire } from '../src/lib/questionnaire-handler.ts';
import { questionIds } from '../src/lib/questions.ts';
import { harness, submission } from './helpers/pipeline-harness.mjs';

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
      throw new Error('tracking should run after response');
    },
  };
}

const request = (data) =>
  new Request('https://example.com/api/questionnaire', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });

test('route returns the stored report, schedules tracking after response, and does not append twice', async () => {
  const { deps, store } = await harness({ emailEnabled: false }).build();
  const sheet = gateway();
  const tasks = [];
  let synced = 0;
  deps.syncTracking = async () => {
    synced += 1;
    return true;
  };
  const context = {
    deps,
    secret: 's'.repeat(32),
    gateway: sheet,
    schedule: (fn) => tasks.push(fn),
  };
  const input = submission();
  assert.equal(Object.keys(input.answers).length, questionIds.length);

  const first = await handleQuestionnaire(request(input), context);
  const body = await first.json();
  assert.equal(first.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.duplicate, false);
  assert.equal(sheet.appends, 1);
  assert.equal(synced, 0, 'Sheet projection is outside the response path');
  assert.deepEqual(
    body.report,
    JSON.parse(JSON.stringify((await store.getById(body.reportId)).report)),
  );
  assert.equal(tasks.length, 1);
  await tasks[0]();
  assert.equal(synced, 1);

  const retry = await handleQuestionnaire(request(input), context);
  const retried = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retried.duplicate, true);
  assert.equal(retried.reportId, body.reportId);
  assert.equal(sheet.appends, 1);

  const changed = { ...input, answers: { ...input.answers, A1: !input.answers.A1 } };
  const conflict = await handleQuestionnaire(request(changed), context);
  assert.equal(conflict.status, 409);
  assert.equal(sheet.appends, 1);
});
