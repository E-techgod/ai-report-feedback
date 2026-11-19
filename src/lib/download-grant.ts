import { createHmac, timingSafeEqual } from 'node:crypto';
import { reportHash, type FinalReport } from './final-report';

/**
 * Time-boxed permission to download ONE finalized report as a PDF. Nothing is stored anywhere:
 * the grant is an HMAC over (report content hash, expiry), so any function instance can verify it
 * with only REPORT_TOKEN_SECRET, and the expiry cannot be changed without invalidating it.
 *
 *   token = "<expiresAtMs>.<hex HMAC-SHA256(secret, 'download:v1.<reportHash>.<expiresAtMs>')>"
 *
 * Binding the signature to the report's content hash (which covers its reportId, submissionId,
 * answers-derived model and AI narrative) means a token only works with the exact report it was
 * issued for: another client's report, or an edited copy of this one, fails verification.
 */
export const DOWNLOAD_WINDOW_MS = 5 * 60_000;

export type DownloadGrant = {
  /** Opaque; send it in the `x-download-token` header. */
  token: string;
  /** Epoch ms after which the server refuses it. */
  expiresAt: number;
  /** Remaining window at issue time, so the browser can count down without trusting its clock. */
  expiresInMs: number;
};

export type GrantCheck = 'ok' | 'invalid' | 'expired';

const sign = (report: FinalReport, expiresAt: number, secret: string) =>
  createHmac('sha256', secret)
    .update(`download:v1.${reportHash(report)}.${expiresAt}`)
    .digest('hex');

/**
 * `startedAt` is when the window opens (default: `now`). A repeated submission passes the ORIGINAL
 * submission's time so that retrying can never push the deadline further out.
 */
export function issueDownloadGrant(
  report: FinalReport,
  secret: string,
  now: Date = new Date(),
  startedAt: Date | number = now,
): DownloadGrant {
  const start = typeof startedAt === 'number' ? startedAt : startedAt.getTime();
  const expiresAt = start + DOWNLOAD_WINDOW_MS;
  return {
    token: `${expiresAt}.${sign(report, expiresAt, secret)}`,
    expiresAt,
    expiresInMs: Math.max(0, expiresAt - now.getTime()),
  };
}

/** Epoch ms deadline carried by a token (call only after `verifyDownloadGrant` returned 'ok'). */
export function grantExpiresAt(token: string): number {
  return Number(token.split('.')[0]);
}

/**
 * Opaque key of the download budget of one submission (all grants issued for the same submission
 * share it, so repeating the survey cannot multiply downloads). A keyed hash, so the ledger tab in
 * the spreadsheet holds no email, name or token. The "dl_" prefix stops Sheets reading it as a number.
 */
export function downloadLedgerKey(report: FinalReport, secret: string): string {
  return `dl_${createHmac('sha256', secret)
    .update(`download-ledger:v1.${report.submissionId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

/**
 * The signature is checked first, so an expired answer is only ever given for a token this server
 * really issued for this report. A request exactly at the deadline is already expired.
 */
export function verifyDownloadGrant(
  report: FinalReport,
  token: string,
  secret: string,
  now: Date = new Date(),
): GrantCheck {
  const match = /^(\d{1,15})\.([0-9a-f]{64})$/.exec(token);
  if (!match) return 'invalid';
  const expiresAt = Number(match[1]);
  const expected = Buffer.from(sign(report, expiresAt, secret));
  const given = Buffer.from(match[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
  return now.getTime() >= expiresAt ? 'expired' : 'ok';
}
