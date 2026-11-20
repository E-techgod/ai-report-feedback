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
/** At most this many submissions per email in any rolling SUBMISSION_WINDOW_HOURS. */
export const MAX_SUBMISSIONS_PER_EMAIL = 5;
export const SUBMISSION_WINDOW_HOURS = 24;
export const FALLBACK_TIME_ZONE = 'America/Mexico_City';
/** Status written to a row that lost a concurrent race for the last free slot (see writeOnce). */
export const REJECTED_BY_LIMIT_LABEL = 'Rechazado por límite';

const RECENT_ID_TTL_MS = 15 * 60 * 1000;
// The newest rows of one email are all that both the duplicate check and the limit check need.
const MAX_CANDIDATE_ROWS = MAX_SUBMISSIONS_PER_EMAIL;
const MS_PER_DAY = 86_400_000;

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
}

export type SubmitStatus = 'created' | 'duplicate' | 'limited';
export type SheetSaveResult = {
  status: SubmitStatus;
  rowNumber: number;
  /** Id stored in the row this result refers to: the ORIGINAL submission's id for a duplicate. */
  submissionId: string;
  /** When that row was created, epoch ms (0 when unknown, which callers must treat as "long ago"). */
  submittedAtMs: number;
  /** Only for 'limited': seconds until the oldest counted submission leaves the window. */
  retryAfterSeconds?: number;
};

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

type EmailHistory = {
  /** Newest rows of this email (at most MAX_CANDIDATE_ROWS), oldest first. */
  candidates: number[];
  rows: SheetCell[][];
};

function emailRowNumbers(emails: string[], target: string): number[] {
  const rowNumbers: number[] = [];
  emails.forEach((email, index) => {
    if (index > 0 && cleanText(String(email)).toLowerCase() === target) rowNumbers.push(index + 1);
  });
  return rowNumbers;
}

/** One column read plus one batch read: serves both the duplicate check and the limit check. */
async function readEmailHistory(
  gateway: SheetsGateway,
  schema: SheetSchema,
  email: string,
): Promise<EmailHistory> {
  const emails = await gateway.readColumn(schema.email);
  const candidates = emailRowNumbers(emails, normalizeEmail(email)).slice(-MAX_CANDIDATE_ROWS);
  const rows = candidates.length ? await gateway.readRows(candidates, schema.headers.length) : [];
  return { candidates, rows };
}

function findRecentDuplicate(
  history: EmailHistory,
  schema: SheetSchema,
  submission: Submission,
  nowSerial: number,
): { rowNumber: number; row: SheetCell[] } | null {
  const expected = questionIds.map((id) => normalizeAnswer(submission.answers[id]));
  for (let i = history.rows.length - 1; i >= 0; i--) {
    const row = history.rows[i];
    const timestamp = row[schema.timestamp];
    if (typeof timestamp !== 'number') continue;
    // A row that lost a race for the last slot is not a submission anyone was served: it must not
    // absorb a new attempt as a "duplicate" (that attempt is judged by the limit instead).
    if (
      schema.tracking.reportStatus !== undefined &&
      String(row[schema.tracking.reportStatus] ?? '') === REJECTED_BY_LIMIT_LABEL
    )
      continue;
    const ageMinutes = (nowSerial - timestamp) * 1440;
    if (ageMinutes < -1 || ageMinutes > DUPLICATE_WINDOW_MINUTES) continue;
    if (
      expected.every(
        (answer, n) => foldAnswer(row[schema.questions[questionIds[n]]]) === foldAnswer(answer),
      )
    )
      return { rowNumber: history.candidates[i], row };
  }
  return null;
}

/** Returns the matching row number for this person and answers inside the window. */
export async function hasRecentDuplicate(
  gateway: SheetsGateway,
  schema: SheetSchema,
  submission: Submission,
  nowSerial: number,
): Promise<number | null> {
  const history = await readEmailHistory(gateway, schema, submission.email);
  return findRecentDuplicate(history, schema, submission, nowSerial)?.rowNumber ?? null;
}

/** Seconds until `anchorSerial` (the oldest counted submission) leaves the window; null if past. */
function secondsUntilFree(anchorSerial: unknown, nowSerial: number): number | null {
  if (typeof anchorSerial !== 'number') return null;
  const seconds = Math.ceil((anchorSerial + SUBMISSION_WINDOW_HOURS / 24 - nowSerial) * 86_400);
  return seconds > 0 ? seconds : null;
}

/**
 * Pre-check. The email is over the limit when its MAX_SUBMISSIONS_PER_EMAIL newest rows all fall
 * inside the rolling window, i.e. when the oldest of them (candidates[0]) is still recent.
 * Returns the seconds to wait, or null when a new submission is allowed.
 */
function limitRetryAfter(
  history: EmailHistory,
  schema: SheetSchema,
  nowSerial: number,
): number | null {
  if (history.rows.length < MAX_SUBMISSIONS_PER_EMAIL) return null;
  return secondsUntilFree(history.rows[0]?.[schema.timestamp], nowSerial);
}

/**
 * Post-check for races. Sheets appends are atomic and ordered, so however many requests passed the
 * pre-check at the same time, each one's row has a distinct position. A row is over the limit when
 * the MAX_SUBMISSIONS_PER_EMAIL rows just before it (same email) are all inside the window. Rows
 * before it always exist already, so every racing request reaches the same verdict about itself.
 */
async function overLimitAfterAppend(
  gateway: SheetsGateway,
  schema: SheetSchema,
  email: string,
  rowNumber: number,
  nowSerial: number,
): Promise<number | null> {
  const emails = await gateway.readColumn(schema.email);
  const upToMine = emailRowNumbers(emails, normalizeEmail(email)).filter((n) => n <= rowNumber);
  if (upToMine.length <= MAX_SUBMISSIONS_PER_EMAIL) return null;
  const anchor = upToMine[upToMine.length - 1 - MAX_SUBMISSIONS_PER_EMAIL];
  const [row] = await gateway.readRows([anchor], schema.headers.length);
  return secondsUntilFree(row?.[schema.timestamp], nowSerial);
}

/** Epoch ms of a row's timestamp, derived from how old it is on the sheet's own clock. */
function rowTimeMs(nowMs: number, nowSerial: number, timestamp: unknown): number {
  return typeof timestamp === 'number'
    ? Math.round(nowMs - (nowSerial - timestamp) * MS_PER_DAY)
    : 0;
}

/** The submission id this app stored in the row ("submission:<uuid>"), else `fallback`. */
function storedSubmissionId(row: SheetCell[] | undefined, schema: SheetSchema, fallback: string) {
  const column = schema.tracking.reportId;
  const marker = column === undefined ? '' : String(row?.[column] ?? '');
  const match = /^submission:([0-9a-fA-F-]{36})$/.exec(marker);
  return match ? match[1] : fallback;
}

const inflight = new Map<string, Promise<SheetSaveResult>>();
const recentIds = new Map<
  string,
  { expires: number; rowNumber: number; submissionId: string; submittedAtMs: number }
>();

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
  const nowMs = now.getTime();
  const schema = parseSheetSchema(await gateway.readHeaders());
  if (
    schema.tracking.reportId === undefined ||
    schema.tracking.reportStatus === undefined ||
    schema.tracking.emailStatus === undefined
  )
    throw new Error('Required report tracking headers are missing');
  const timeZone = await gateway.getTimeZone().catch(() => FALLBACK_TIME_ZONE);
  const { text, serial } = wallClock(now, timeZone);
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
    // A request that lost a concurrent race for the last free slot left its row behind. Retrying
    // with the same id must not turn that row into a harmless "duplicate": judge it by its position.
    const retryAfterSeconds = await overLimitAfterAppend(
      gateway,
      schema,
      submission.email,
      rowNumber,
      serial,
    );
    if (retryAfterSeconds !== null)
      return {
        status: 'limited',
        rowNumber,
        submissionId: submission.id,
        submittedAtMs: rowTimeMs(nowMs, serial, row?.[schema.timestamp]),
        retryAfterSeconds,
      };
    return {
      status: 'duplicate',
      rowNumber,
      submissionId: submission.id,
      submittedAtMs: rowTimeMs(nowMs, serial, row?.[schema.timestamp]),
    };
  }

  // One read of this email's newest rows serves the duplicate check AND the limit check, and both
  // run before anything is appended (and, in the caller, before any AI call or report generation).
  const history = await readEmailHistory(gateway, schema, submission.email);
  const existing = findRecentDuplicate(history, schema, submission, serial);
  if (existing)
    return {
      status: 'duplicate',
      rowNumber: existing.rowNumber,
      submissionId: storedSubmissionId(existing.row, schema, submission.id),
      submittedAtMs: rowTimeMs(nowMs, serial, existing.row[schema.timestamp]),
    };
  const waitSeconds = limitRetryAfter(history, schema, serial);
  if (waitSeconds !== null)
    return {
      status: 'limited',
      rowNumber: 0,
      submissionId: submission.id,
      submittedAtMs: nowMs,
      retryAfterSeconds: waitSeconds,
    };

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

  // Concurrency: requests for the same email that raced past the pre-check are ranked by row order.
  const lostRace = await overLimitAfterAppend(gateway, schema, submission.email, rowNumber, serial);
  if (lostRace !== null) {
    // Keep the row (the lead is not lost) but label it so it is not mistaken for a pending report.
    await gateway
      .writeCells(rowNumber, [
        { index: schema.tracking.reportStatus, value: REJECTED_BY_LIMIT_LABEL },
      ])
      .catch(() => undefined);
    return {
      status: 'limited',
      rowNumber,
      submissionId: submission.id,
      submittedAtMs: nowMs,
      retryAfterSeconds: lostRace,
    };
  }
  return { status: 'created', rowNumber, submissionId: submission.id, submittedAtMs: nowMs };
}

/**
 * Saves a submission at most once, and at most MAX_SUBMISSIONS_PER_EMAIL times per rolling
 * SUBMISSION_WINDOW_HOURS per email:
 *  - same submission id retried  -> 'duplicate' (in-memory, per instance; the Sheet marker
 *    answers it on any other instance)
 *  - identical concurrent request -> shares the in-flight write
 *  - same email + same answers within DUPLICATE_WINDOW_MINUTES -> 'duplicate' (checked in the sheet);
 *    duplicates never add a row, so they never count toward the limit
 *  - otherwise, over the limit -> 'limited' (nothing is appended unless a race is lost, see writeOnce)
 * The result always says which row and original submission it refers to, and when that was created.
 */
export async function saveSubmissionWithRow(
  gateway: SheetsGateway,
  submission: Submission,
  now: Date = new Date(),
): Promise<SheetSaveResult> {
  const nowMs = now.getTime();
  pruneRecentIds(nowMs);
  const prior = recentIds.get(submission.id);
  if (prior)
    return {
      status: 'duplicate',
      rowNumber: prior.rowNumber,
      submissionId: prior.submissionId,
      submittedAtMs: prior.submittedAtMs,
    };

  const key = fingerprint(submission);
  const running = inflight.get(key);
  if (running)
    return running.then((result) =>
      result.status === 'created' ? { ...result, status: 'duplicate' as const } : result,
    );

  const promise = writeOnce(gateway, submission, now);
  inflight.set(key, promise);
  try {
    const result = await promise;
    // A refusal is never remembered: it must be re-judged on every attempt.
    if (result.status !== 'limited')
      recentIds.set(submission.id, {
        expires: nowMs + RECENT_ID_TTL_MS,
        rowNumber: result.rowNumber,
        submissionId: result.submissionId,
        submittedAtMs: result.submittedAtMs,
      });
    return result;
  } finally {
    inflight.delete(key);
  }
}

export const REPORT_GENERATED_LABEL = 'Generado';

/**
 * After the report exists, sets ONLY this row's `Estado Reporte` cell to "Generado". Nothing else
 * is touched: other rows, answers, formatting and the email/download tracking cells stay as they are.
 * The row number was learned moments ago, but rows can be inserted or removed in between, so the
 * row is re-read and must still hold this person's email and all 20 answers; otherwise nothing is
 * written. Returns whether a cell was written. Throws on Google/API failures (callers log and go on).
 */
export async function markReportGenerated(
  gateway: SheetsGateway,
  submission: Submission,
  rowNumber: number,
  timeoutMs?: number,
): Promise<boolean> {
  const schema = parseSheetSchema(await gateway.readHeaders(timeoutMs));
  const statusColumn = schema.tracking.reportStatus;
  if (statusColumn === undefined) throw new Error('Required report tracking headers are missing');
  const row = (await gateway.readRows([rowNumber], schema.headers.length, timeoutMs))[0];
  const matches =
    row !== undefined &&
    normalizeEmail(String(row[schema.email] ?? '')) === normalizeEmail(submission.email) &&
    questionIds.every(
      (id) =>
        foldAnswer(row[schema.questions[id]]) ===
        foldAnswer(normalizeAnswer(submission.answers[id])),
    );
  if (!matches) throw new Error('Spreadsheet row no longer matches this submission');
  if (String(row[statusColumn] ?? '') === REPORT_GENERATED_LABEL) return false;
  await gateway.writeCells(
    rowNumber,
    [{ index: statusColumn, value: REPORT_GENERATED_LABEL }],
    timeoutMs,
  );
  return true;
}

/** Compatibility wrapper for callers that only need the dedupe outcome. */
export async function saveSubmission(
  gateway: SheetsGateway,
  submission: Submission,
  now: Date = new Date(),
): Promise<SubmitStatus> {
  return (await saveSubmissionWithRow(gateway, submission, now)).status;
}
