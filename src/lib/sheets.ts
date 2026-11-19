import { questionIds } from './questions';
import { parseSheetSchema, type SheetSchema } from './sheet-schema';
import type { Submission } from './validation';

/**
 * Pure submission logic for the existing "Respuestas de formulario 1" tab.
 * The response tab contains tracking fields between email and the 20 questions. Every
 * read/write uses the current header row, so inserted columns cannot shift answers.
 * All Google API access goes through `SheetsGateway`, so this module is testable
 * without credentials and never touches the network by itself.
 */
export const SHEET_TAB = 'Respuestas de formulario 1';
export const DUPLICATE_WINDOW_MINUTES = 10;
export const FALLBACK_TIME_ZONE = 'America/Mexico_City';

const RECENT_ID_TTL_MS = 15 * 60 * 1000;
const MAX_CANDIDATE_ROWS = 5;

export type SheetCell = string | number;

export interface SheetsGateway {
  /** IANA time zone of the spreadsheet (so new timestamps match Form-generated ones). */
  getTimeZone(timeoutMs?: number): Promise<string>;
  readHeaders(timeoutMs?: number): Promise<string[]>;
  /** Values of the named email column, index 0 = row 1. Read-only. */
  readColumn(index: number, timeoutMs?: number): Promise<string[]>;
  /** Full rows through the last header; dates as serial numbers. Read-only. */
  readRows(rowNumbers: number[], width: number, timeoutMs?: number): Promise<SheetCell[][]>;
  /** Appends one full row and returns Google's updated range. */
  appendRow(
    row: string[],
  ): Promise<{ updatedRows: number; updatedCells: number; updatedRange: string }>;
  /** Writes only the named tracking cells in an existing response row. */
  writeCells(
    rowNumber: number,
    cells: Array<{ index: number; value: string | number }>,
    timeoutMs?: number,
  ): Promise<number>;
  /** Dashboard B/H for the matching response row; used only by dry-run cutover review. */
  readDashboardEmailState?(rowNumber: number): Promise<{ email: string; status: string }>;
}

export type SubmitStatus = 'created' | 'duplicate';
export type SheetSaveResult = { status: SubmitStatus; rowNumber: number };

/** Collapses control characters and whitespace runs, trims, and caps length. */
export function cleanText(value: string, max = 254): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Neutralises spreadsheet formula injection (values are written USER_ENTERED). */
export function escapeCell(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

/**
 * Answers are persisted as "Si"/"No" (no accent) to match the historical Google Form data.
 * The UI still shows "Sí". The Dashboard formulas accept both spellings.
 */
export function normalizeAnswer(value: boolean): 'Si' | 'No' {
  return value ? 'Si' : 'No';
}

/** Compares stored answers regardless of case or accent ("Sí", "si", "SI" -> "si"). */
function foldAnswer(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

export function normalizeEmail(email: string): string {
  return cleanText(email).toLowerCase();
}

export function wallClock(now: Date, timeZone: string): { text: string; serial: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const text = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  const serial =
    Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) /
      86_400_000 +
    25_569;
  return { text, serial };
}

export function buildRow(
  submission: Submission,
  timestampText: string,
  schema: SheetSchema,
): string[] {
  const row = Array<string>(schema.headers.length).fill('');
  row[schema.timestamp] = timestampText;
  row[schema.firstName] = escapeCell(cleanText(submission.firstName, 100));
  row[schema.lastName] = escapeCell(cleanText(submission.lastName, 100));
  row[schema.email] = escapeCell(normalizeEmail(submission.email));
  if (schema.tracking.reportStatus !== undefined) row[schema.tracking.reportStatus] = 'Pendiente';
  if (schema.tracking.reportId !== undefined)
    row[schema.tracking.reportId] = `submission:${submission.id}`;
  for (const id of questionIds) row[schema.questions[id]] = normalizeAnswer(submission.answers[id]);
  return row;
}

/** Returns the matching row number for this person and answers inside the window. */
export async function hasRecentDuplicate(
  gateway: SheetsGateway,
  schema: SheetSchema,
  submission: Submission,
  nowSerial: number,
): Promise<number | null> {
  const target = normalizeEmail(submission.email);
  const emails = await gateway.readColumn(schema.email);
  const rowNumbers: number[] = [];
  emails.forEach((email, index) => {
    if (index > 0 && cleanText(String(email)).toLowerCase() === target) rowNumbers.push(index + 1);
  });
  if (rowNumbers.length === 0) return null;

  const candidates = rowNumbers.slice(-MAX_CANDIDATE_ROWS);
  const rows = await gateway.readRows(candidates, schema.headers.length);
  const expected = questionIds.map((id) => normalizeAnswer(submission.answers[id]));
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const timestamp = row[schema.timestamp];
    if (typeof timestamp !== 'number') continue;
    const ageMinutes = (nowSerial - timestamp) * 1440;
    if (ageMinutes < -1 || ageMinutes > DUPLICATE_WINDOW_MINUTES) continue;
    if (
      expected.every(
        (answer, n) => foldAnswer(row[schema.questions[questionIds[n]]]) === foldAnswer(answer),
      )
    )
      return candidates[i];
  }
  return null;
}

const inflight = new Map<string, Promise<SheetSaveResult>>();
const recentIds = new Map<string, { expires: number; rowNumber: number }>();

function fingerprint(submission: Submission): string {
  const bits = questionIds.map((id) => (submission.answers[id] ? '1' : '0')).join('');
  return `${normalizeEmail(submission.email)}|${bits}`;
}

function pruneRecentIds(now: number) {
  for (const [id, value] of recentIds) if (value.expires <= now) recentIds.delete(id);
}

async function writeOnce(
  gateway: SheetsGateway,
  submission: Submission,
  now: Date,
): Promise<SheetSaveResult> {
  const schema = parseSheetSchema(await gateway.readHeaders());
  if (
    schema.tracking.reportId === undefined ||
    schema.tracking.reportStatus === undefined ||
    schema.tracking.emailStatus === undefined
  )
    throw new Error('Required report tracking headers are missing');
  const markers = await gateway.readColumn(schema.tracking.reportId);
  const marker = `submission:${submission.id}`;
  const markedRows = markers.flatMap((value, index) =>
    index > 0 && value === marker ? [index + 1] : [],
  );
  if (markedRows.length > 1) throw new Error('Duplicate spreadsheet submission marker');
  if (markedRows.length === 1) {
    const rowNumber = markedRows[0];
    const row = (await gateway.readRows([rowNumber], schema.headers.length))[0];
    const matchingEmail =
      normalizeEmail(String(row?.[schema.email] ?? '')) === normalizeEmail(submission.email);
    const matchingAnswers = questionIds.every(
      (id) =>
        foldAnswer(row?.[schema.questions[id]]) ===
        foldAnswer(normalizeAnswer(submission.answers[id])),
    );
    if (!matchingEmail || !matchingAnswers)
      throw new Error('Submission marker does not match its spreadsheet row');
    return { status: 'duplicate', rowNumber };
  }
  const timeZone = await gateway.getTimeZone().catch(() => FALLBACK_TIME_ZONE);
  const { text, serial } = wallClock(now, timeZone);
  const existingRow = await hasRecentDuplicate(gateway, schema, submission, serial);
  if (existingRow) return { status: 'duplicate', rowNumber: existingRow };

  await gateway.appendRow(buildRow(submission, text, schema));
  // Google's updatedCells counts updated cells, not a promise that every empty tracking
  // placeholder was stored. Read back the unique marker and meaningful fields instead.
  const after = await gateway.readColumn(schema.tracking.reportId);
  const matches = after.flatMap((value, index) =>
    index > 0 && value === marker ? [index + 1] : [],
  );
  if (matches.length !== 1) throw new Error('Google Sheets did not confirm the write');
  const rowNumber = matches[0];
  const row = (await gateway.readRows([rowNumber], schema.headers.length))[0];
  if (
    !row ||
    normalizeEmail(String(row[schema.email] ?? '')) !== normalizeEmail(submission.email) ||
    questionIds.some(
      (id) =>
        foldAnswer(row[schema.questions[id]]) !==
        foldAnswer(normalizeAnswer(submission.answers[id])),
    )
  )
    throw new Error('Google Sheets did not confirm the write');
  return { status: 'created', rowNumber };
}

/**
 * Saves a submission at most once:
 *  - same submission id retried  -> 'duplicate' (in-memory, per instance)
 *  - identical concurrent request -> shares the in-flight write
 *  - same email + same answers within DUPLICATE_WINDOW_MINUTES -> 'duplicate' (checked in the sheet)
 */
export async function saveSubmissionWithRow(
  gateway: SheetsGateway,
  submission: Submission,
  now: Date = new Date(),
): Promise<SheetSaveResult> {
  const nowMs = now.getTime();
  pruneRecentIds(nowMs);
  const prior = recentIds.get(submission.id);
  if (prior) return { status: 'duplicate', rowNumber: prior.rowNumber };

  const key = fingerprint(submission);
  const running = inflight.get(key);
  if (running) return running.then((result) => ({ ...result, status: 'duplicate' as const }));

  const promise = writeOnce(gateway, submission, now);
  inflight.set(key, promise);
  try {
    const status = await promise;
    recentIds.set(submission.id, {
      expires: nowMs + RECENT_ID_TTL_MS,
      rowNumber: status.rowNumber,
    });
    return status;
  } finally {
    inflight.delete(key);
  }
}

/** Compatibility wrapper for callers that only need the dedupe outcome. */
export async function saveSubmission(
  gateway: SheetsGateway,
  submission: Submission,
  now: Date = new Date(),
): Promise<SubmitStatus> {
  return (await saveSubmissionWithRow(gateway, submission, now)).status;
}
