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

export function issueDownloadGrant(
  report: FinalReport,
  secret: string,
  now: Date = new Date(),
): DownloadGrant {
  const expiresAt = now.getTime() + DOWNLOAD_WINDOW_MS;
  return {
    token: `${expiresAt}.${sign(report, expiresAt, secret)}`,
    expiresAt,
    expiresInMs: DOWNLOAD_WINDOW_MS,
  };
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
