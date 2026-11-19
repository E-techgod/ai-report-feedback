import { createHmac } from 'node:crypto';

/**
 * Privacy-safe, structured security logs (one JSON line each, readable in Vercel Logs).
 *
 * Nothing sensitive can be logged through this module:
 *  - only allow-listed field names are written;
 *  - a string value must look like a short machine token (letters, digits, `_ - . :`), so an email
 *    address, a name, a token or free text is replaced by "[redacted]" even if a caller passes one;
 *  - callers never pass questionnaire answers, emails, IPs or tokens in the first place. To tell
 *    "the same person again" apart, `subjectFingerprint` gives a short keyed hash of the email.
 */
export type SecurityEvent =
  | 'submission_rate_limited'
  | 'submission_duplicate'
  | 'download_served'
  | 'download_limit_reached'
  | 'download_limit_unavailable'
  | 'download_expired'
  | 'download_unauthorized';

const ALLOWED_FIELDS = new Set([
  'subject',
  'grant',
  'reason',
  'outcome',
  'retryAfterSeconds',
  'ordinal',
  'limit',
]);

const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;

export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type LogSink = Pick<Console, 'info' | 'warn'>;

/** Events that mean "someone is being refused" log at warn; routine outcomes at info. */
const WARN_EVENTS = new Set<SecurityEvent>([
  'submission_rate_limited',
  'download_limit_reached',
  'download_limit_unavailable',
  'download_expired',
  'download_unauthorized',
]);

export function sanitizeFields(
  fields: LogFields,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key) || value === undefined) continue;
    if (typeof value === 'string') out[key] = SAFE_STRING.test(value) ? value : '[redacted]';
    else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : null;
    else out[key] = value;
  }
  return out;
}

export function logSecurityEvent(
  event: SecurityEvent,
  fields: LogFields = {},
  sink: LogSink = console,
): void {
  const line = JSON.stringify({ app: 'bp-questionnaire', event, ...sanitizeFields(fields) });
  (WARN_EVENTS.has(event) ? sink.warn : sink.info).call(sink, line);
}

/**
 * Short keyed fingerprint (10 hex chars) of a normalized email. It lets an operator see that the
 * same address keeps hitting a limit without the address itself ever reaching the logs; it cannot
 * be reversed or matched without REPORT_TOKEN_SECRET.
 */
export function subjectFingerprint(email: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`log-subject:v1.${email.trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 10);
}
