import test from 'node:test';
import assert from 'node:assert/strict';
import { questionIds } from '../src/lib/questions.ts';
import { columnLetter, parseSheetSchema } from '../src/lib/sheet-schema.ts';
import {
  buildRow,
  cleanText,
  escapeCell,
  saveSubmission,
  wallClock,
  SavedUnconfirmedError,
} from '../src/lib/sheets.ts';

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
const SCHEMA = parseSheetSchema(HEADERS);

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const answers = (fn) => Object.fromEntries(questionIds.map((id, i) => [id, fn(i)]));
const submission = (over = {}) => ({
  id: uuid(),
  firstName: 'Ana',
  lastName: 'López',
  email: `ana${counter}@example.com`,
  privacyAccepted: true,
  answers: answers((i) => i % 2 === 0),
  ...over,
});

/** In-memory fake of the Google Sheets gateway; `sheet[0]` is the header row. */
function fakeGateway({
  rows = [],
  confirm = { updatedRows: 1, updatedCells: HEADERS.length },
} = {}) {
  const expanded = rows.map((row) => {
    if (row.length !== 24) return row;
    const result = Array(HEADERS.length).fill('');
    result.splice(0, 4, ...row.slice(0, 4));
    questionIds.forEach((id, i) => {
      result[SCHEMA.questions[id]] = row[4 + i];
    });
    return result;
  });
  const sheet = [HEADERS, ...expanded];
  const calls = { append: 0 };
  return {
    sheet,
    calls,
    async getTimeZone() {
      return 'America/Mexico_City';
    },
    async readHeaders() {
      return sheet[0];
    },
    async readColumn(index) {
      return sheet.map((r) => String(r[index] ?? ''));
    },
    async readRows(nums) {
      return nums.map((n) => sheet[n - 1]);
    },
    async appendRow(row) {
      calls.append += 1;
      if (confirm.updatedRows === 1) sheet.push(row);
      return {
        ...confirm,
        updatedRange: `'Respuestas de formulario 1'!A${sheet.length}:${columnLetter(row.length - 1)}${sheet.length}`,
      };
    },
  };
}

test('row follows live headers and persists answers as Si/No', () => {
  const s = submission({ answers: answers((i) => i === 0 || i === 19) });
  const row = buildRow(s, '2026-11-18 13:06:10', SCHEMA);
  assert.equal(row.length, HEADERS.length);
  assert.deepEqual(row.slice(0, 4), ['2026-11-18 13:06:10', 'Ana', 'López', s.email]);
  assert.equal(row[SCHEMA.questions.A1], 'Si');
  assert.equal(row[SCHEMA.questions.A2], 'No');
  assert.equal(row[SCHEMA.questions.B10], 'Si');
  assert.equal(row[SCHEMA.tracking.reportStatus], 'Pendiente');
  assert.equal(row[SCHEMA.tracking.reportId], `submission:${s.id}`);
  assert.ok(row.slice(4, 15).every((v, i) => [0, 9].includes(i) || v === ''));
  assert.ok(row.slice(15).every((v) => v === 'Si' || v === 'No'));
});

test('row follows reordered email and question headers without changing answer meaning', () => {
  const headers = [...HEADERS];
  [headers[3], headers[20]] = [headers[20], headers[3]];
  const schema = parseSheetSchema(headers);
  const s = submission({ answers: answers((i) => i === 5) });
  const row = buildRow(s, 'ts', schema);
  assert.equal(row[schema.email], s.email);
  assert.equal(row[schema.questions.A6], 'Si');
  assert.equal(row[schema.questions.A1], 'No');
  assert.equal(row[SCHEMA.tracking.reportId], `submission:${s.id}`);
});

test('email is lower-cased and text is stripped of control characters', () => {
  const row = buildRow(
    submission({ email: ' Ana@Example.COM ', firstName: 'A\nna\t' }),
    'ts',
    SCHEMA,
  );
  assert.equal(row[3], 'ana@example.com');
  assert.equal(row[1], 'A na');
});

test('formula-looking text is neutralised', () => {
  assert.equal(escapeCell('=HYPERLINK("x")'), `'=HYPERLINK("x")`);
  assert.equal(escapeCell('+1'), "'+1");
  assert.equal(escapeCell('Ana'), 'Ana');
  assert.equal(cleanText('x'.repeat(300)).length, 254);
});

test('timestamp is rendered in the given time zone', () => {
  const t = wallClock(new Date('2026-11-18T19:06:10Z'), 'America/Mexico_City');
  assert.equal(t.text, '2026-11-18 13:06:10');
});

test('timestamp works for the spreadsheet time zone (Etc/GMT+6)', () => {
  const t = wallClock(new Date('2026-11-18T19:06:10Z'), 'Etc/GMT+6');
  assert.equal(t.text, '2026-11-18 13:06:10');
});

test('a new submission is appended once and reported as created', async () => {
  const g = fakeGateway();
  const status = await saveSubmission(g, submission());
  assert.equal(status, 'created');
  assert.equal(g.calls.append, 1);
  assert.equal(g.sheet.length, 2);
});

test('success is NOT reported when Google does not confirm the write', async () => {
  const g = fakeGateway({ confirm: { updatedRows: 0, updatedCells: 0 } });
  await assert.rejects(saveSubmission(g, submission()), (error) => {
    // The append happened (Google said so), so this is "saved but not confirmed", with the cause kept.
    assert.ok(error instanceof SavedUnconfirmedError);
    assert.match(String(error.reason?.message), /did not confirm/);
    return true;
  });
});

test('read-back confirms a full row even if updatedCells omits blank placeholders', async () => {
  const g = fakeGateway({ confirm: { updatedRows: 1, updatedCells: 24 } });
  assert.equal(await saveSubmission(g, submission()), 'created');
  assert.equal(g.sheet.length, 2);
});

test('failed writes are not remembered, so a retry can succeed', async () => {
  const s = submission();
  const bad = fakeGateway({ confirm: { updatedRows: 0, updatedCells: 0 } });
  await assert.rejects(saveSubmission(bad, s));
  const good = fakeGateway();
  assert.equal(await saveSubmission(good, s), 'created');
});

test('same submission id retried is a duplicate and not written again', async () => {
  const g = fakeGateway();
  const s = submission();
  assert.equal(await saveSubmission(g, s), 'created');
  assert.equal(await saveSubmission(g, s), 'duplicate');
  assert.equal(g.calls.append, 1);
});

test('submission marker prevents a second row after the dedupe window', async () => {
  const g = fakeGateway();
  const s = submission();
  const now = new Date('2026-11-18T19:00:00Z');
  assert.equal(await saveSubmission(g, s, now), 'created');
  assert.equal(await saveSubmission(g, s, new Date(now.getTime() + 20 * 60_000)), 'duplicate');
  assert.equal(g.calls.append, 1);
});

test('concurrent identical requests produce a single row', async () => {
  const g = fakeGateway();
  const base = submission();
  const results = await Promise.all([
    saveSubmission(g, base),
    saveSubmission(g, { ...base, id: uuid() }),
    saveSubmission(g, { ...base, id: uuid() }),
  ]);
  assert.equal(g.calls.append, 1);
  assert.deepEqual(results.sort(), ['created', 'duplicate', 'duplicate']);
});

test('same email + same answers within 10 minutes is a duplicate (cross-instance)', async () => {
  const s = submission();
  const now = new Date('2026-11-18T19:00:00Z');
  const earlier = wallClock(new Date(now.getTime() - 3 * 60_000), 'America/Mexico_City').serial;
  const existing = [
    earlier,
    'Ana',
    'López',
    s.email,
    ...questionIds.map((id) => (s.answers[id] ? 'Si' : 'No')),
  ];
  const g = fakeGateway({ rows: [existing] });
  assert.equal(await saveSubmission(g, s, now), 'duplicate');
  assert.equal(g.calls.append, 0);
});

test('same answers from the same email long ago is a new submission', async () => {
  const s = submission();
  const now = new Date('2026-11-18T19:00:00Z');
  const old = wallClock(new Date(now.getTime() - 3 * 86_400_000), 'America/Mexico_City').serial;
  const existing = [
    old,
    'Ana',
    'López',
    s.email,
    ...questionIds.map((id) => (s.answers[id] ? 'Si' : 'No')),
  ];
  const g = fakeGateway({ rows: [existing] });
  assert.equal(await saveSubmission(g, s, now), 'created');
});

test('duplicate detection tolerates accent/case differences in stored answers', async () => {
  const s = submission();
  const now = new Date('2026-11-18T19:00:00Z');
  const recent = wallClock(new Date(now.getTime() - 60_000), 'America/Mexico_City').serial;
  const existing = [
    recent,
    'Ana',
    'López',
    s.email,
    ...questionIds.map((id) => (s.answers[id] ? 'Sí' : 'no')),
  ];
  const g = fakeGateway({ rows: [existing] });
  assert.equal(await saveSubmission(g, s, now), 'duplicate');
});

test('same email with different answers recently is a new submission', async () => {
  const s = submission();
  const now = new Date('2026-11-18T19:00:00Z');
  const recent = wallClock(new Date(now.getTime() - 60_000), 'America/Mexico_City').serial;
  const existing = [recent, 'Ana', 'López', s.email, ...questionIds.map(() => 'No')];
  const g = fakeGateway({ rows: [existing] });
  assert.equal(await saveSubmission(g, s, now), 'created');
});

test('existing historical rows are never modified', async () => {
  const historical = [45000.5, 'Luis', 'Pérez', 'luis@example.com', ...questionIds.map(() => 'Si')];
  const g = fakeGateway({ rows: [historical] });
  const snapshot = JSON.stringify(g.sheet[1]);
  await saveSubmission(g, submission());
  assert.equal(JSON.stringify(g.sheet[1]), snapshot);
  assert.equal(g.sheet.length, 3);
});
