import { questionIds } from '../../src/lib/questions.ts';
import { createReportCache } from '../../src/lib/report-cache.ts';
import { reportDeps } from './flow-harness.mjs';

export const SECRET = 's'.repeat(32);
export const STATUS = 4; // "Estado Reporte"

export const headers = [
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

const turn = () => new Promise((resolve) => setImmediate(resolve));

/** 'YYYY-MM-DD HH:mm:ss' (sheet wall clock) -> Google serial number, as Sheets stores dates. */
const serialFromText = (text) => {
  const [d, t] = text.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, se] = t.split(':').map(Number);
  return Date.UTC(y, mo - 1, da, h, mi, se) / 86_400_000 + 25_569;
};

/**
 * In-memory Google Sheet. Like the real one: timestamps are numeric serials, an append is atomic
 * (its row number is fixed when it lands), and with `interleave` every call yields to other
 * requests so concurrent submissions genuinely race.
 */
export function fakeSheet({ interleave = false } = {}) {
  // `rows[0]` is the header row; tests may edit it (insert a column) to simulate a changed sheet.
  const rows = [[...headers]];
  const writes = [];
  const calls = { append: 0, read: 0 };
  const wait = () => (interleave ? turn() : Promise.resolve());
  return {
    rows,
    writes,
    calls,
    get appends() {
      return calls.append;
    },
    async readHeaders() {
      await wait();
      return [...rows[0]];
    },
    async getTimeZone() {
      return 'Etc/GMT+6';
    },
    async readColumn(index) {
      calls.read += 1;
      await wait();
      return rows.map((row) => String(row[index] ?? ''));
    },
    async readRows(numbers) {
      calls.read += 1;
      await wait();
      return numbers.map((n) => [...rows[n - 1]]);
    },
    /** Several ranges in ONE request, like values.batchGet (same shapes the Google gateway returns). */
    async batchRead(ranges) {
      calls.read += 1;
      await wait();
      return ranges.map((range) => {
        if (range.kind === 'headers') return [[...rows[0]]];
        if (range.kind === 'column') return rows.map((row) => [String(row[range.index] ?? '')]);
        return [[...(rows[range.row - 1] ?? [])]];
      });
    },
    async appendRow(row) {
      await wait();
      calls.append += 1;
      const stored = [...row];
      stored[0] = serialFromText(row[0]);
      rows.push(stored);
      await wait();
      // Like Google: the A1 range of the row it landed in.
      return {
        updatedRows: 1,
        updatedCells: row.length,
        updatedRange: `'Respuestas de formulario 1'!A${rows.length}:AD${rows.length}`,
      };
    },
    async writeCells(rowNumber, cells) {
      await wait();
      writes.push({ rowNumber, cells });
      for (const cell of cells) rows[rowNumber - 1][cell.index] = String(cell.value);
      return cells.length;
    },
  };
}

/** Everything handleQuestionnaire needs, with a fixed clock and an isolated report cache. */
export function questionnaireContext({ interleave = false, narrative, reportCache } = {}) {
  const h = reportDeps({ narrative });
  const sheet = fakeSheet({ interleave });
  const tasks = [];
  const flush = async () => {
    while (tasks.length) await tasks.shift()();
  };
  return {
    h,
    sheet,
    flush,
    ctx: {
      deps: h.deps,
      secret: SECRET,
      gateway: sheet,
      schedule: (task) => tasks.push(task),
      reportCache: reportCache ?? createReportCache(),
    },
  };
}

/** Distinct answer patterns, so concurrent submissions are not collapsed as identical. */
export const answersPattern = (n) =>
  Object.fromEntries(questionIds.map((id, i) => [id, ((n + 1) >> (i % 10)) % 2 === 1]));

export const post = (data) =>
  new Request('https://example.com/api/questionnaire', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
