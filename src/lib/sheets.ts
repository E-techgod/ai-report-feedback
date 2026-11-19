import { questionIds } from './questions';
import type { Submission } from './validation';

/**
 * Pure submission logic for the existing "Respuestas de formulario 1" tab.
 * Column order (A:X, 24 columns) is fixed by the existing Google Form schema:
 * timestamp, name, surname, email, A1–A10, B1–B10.
 * All Google API access goes through `SheetsGateway`, so this module is testable
 * without credentials and never touches the network by itself.
 */
export const SHEET_TAB = 'Respuestas de formulario 1';
export const SHEET_COLUMNS = 24;
export const DUPLICATE_WINDOW_MINUTES = 10;
export const FALLBACK_TIME_ZONE = 'America/Mexico_City';

const RECENT_ID_TTL_MS = 15 * 60 * 1000;
const MAX_CANDIDATE_ROWS = 5;

export type SheetCell = string | number;

export interface SheetsGateway {
  /** IANA time zone of the spreadsheet (so new timestamps match Form-generated ones). */
  getTimeZone(): Promise<string>;
  /** Values of column D (email), index 0 = row 1. Read-only. */
  readEmails(): Promise<string[]>;
  /** Columns A:X of the given 1-based rows; dates as serial numbers. Read-only. */
  readRows(rowNumbers: number[]): Promise<SheetCell[][]>;
  /** Appends one row to A:X and returns what Google confirmed it wrote. */
  appendRow(row: string[]): Promise<{ updatedRows: number; updatedCells: number }>;
}

export type SubmitStatus = 'created' | 'duplicate';

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

export function buildRow(submission: Submission, timestampText: string): string[] {
  return [
    timestampText,
    escapeCell(cleanText(submission.firstName, 100)),
    escapeCell(cleanText(submission.lastName, 100)),
    escapeCell(normalizeEmail(submission.email)),
    ...questionIds.map((id) => normalizeAnswer(submission.answers[id])),
  ];
}

/** True if this person already has a row with identical answers inside the window. */
export async function hasRecentDuplicate(
  gateway: SheetsGateway,
  submission: Submission,
  nowSerial: number,
): Promise<boolean> {
  const target = normalizeEmail(submission.email);
  const emails = await gateway.readEmails();
  const rowNumbers: number[] = [];
  emails.forEach((email, index) => {
    if (index > 0 && cleanText(String(email)).toLowerCase() === target) rowNumbers.push(index + 1);
  });
  if (rowNumbers.length === 0) return false;

  const rows = await gateway.readRows(rowNumbers.slice(-MAX_CANDIDATE_ROWS));
  const expected = questionIds.map((id) => normalizeAnswer(submission.answers[id]));
  return rows.some((row) => {
    const timestamp = row[0];
    if (typeof timestamp !== 'number') return false;
    const ageMinutes = (nowSerial - timestamp) * 1440;
    if (ageMinutes < -1 || ageMinutes > DUPLICATE_WINDOW_MINUTES) return false;
    return expected.every((answer, i) => foldAnswer(row[4 + i]) === foldAnswer(answer));
  });
}

const inflight = new Map<string, Promise<SubmitStatus>>();
const recentIds = new Map<string, number>();

function fingerprint(submission: Submission): string {
  const bits = questionIds.map((id) => (submission.answers[id] ? '1' : '0')).join('');
  return `${normalizeEmail(submission.email)}|${bits}`;
}

function pruneRecentIds(now: number) {
  for (const [id, expires] of recentIds) if (expires <= now) recentIds.delete(id);
}

async function writeOnce(
  gateway: SheetsGateway,
  submission: Submission,
  now: Date,
): Promise<SubmitStatus> {
  const timeZone = await gateway.getTimeZone().catch(() => FALLBACK_TIME_ZONE);
  const { text, serial } = wallClock(now, timeZone);
  if (await hasRecentDuplicate(gateway, submission, serial)) return 'duplicate';

  const result = await gateway.appendRow(buildRow(submission, text));
  // Success is only reported once Google confirms exactly one full A:X row was written.
  if (result.updatedRows !== 1 || result.updatedCells !== SHEET_COLUMNS) {
    throw new Error('Google Sheets did not confirm the write');
  }
  return 'created';
}

/**
 * Saves a submission at most once:
 *  - same submission id retried  -> 'duplicate' (in-memory, per instance)
 *  - identical concurrent request -> shares the in-flight write
 *  - same email + same answers within DUPLICATE_WINDOW_MINUTES -> 'duplicate' (checked in the sheet)
 */
export async function saveSubmission(
  gateway: SheetsGateway,
  submission: Submission,
  now: Date = new Date(),
): Promise<SubmitStatus> {
  const nowMs = now.getTime();
  pruneRecentIds(nowMs);
  if (recentIds.has(submission.id)) return 'duplicate';

  const key = fingerprint(submission);
  const running = inflight.get(key);
  if (running) return running.then(() => 'duplicate' as const);

  const promise = writeOnce(gateway, submission, now);
  inflight.set(key, promise);
  try {
    const status = await promise;
    recentIds.set(submission.id, nowMs + RECENT_ID_TTL_MS);
    return status;
  } finally {
    inflight.delete(key);
  }
}
