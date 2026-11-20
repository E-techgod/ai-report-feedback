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
  | 'download_unauthorized'
  | 'sheets_unavailable'
  | 'report_generation_failed'
  | 'status_update_failed'
  | 'pdf_render_failed';

const ALLOWED_FIELDS = new Set([
  'subject',
  'grant',
  'reason',
  'outcome',
  'retryAfterSeconds',
  'ordinal',
  'limit',
  'cause',
  'code',
]);

const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;

export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type LogSink = Pick<Console, 'info' | 'warn' | 'error'>;

/** Events that mean "someone is being refused" log at warn; routine outcomes at info. */
/** Things that broke on our side (not someone being refused): log at error. */
const ERROR_EVENTS = new Set<SecurityEvent>(['report_generation_failed', 'pdf_render_failed']);

const WARN_EVENTS = new Set<SecurityEvent>([
  'submission_rate_limited',
  'download_limit_reached',
  'download_limit_unavailable',
  'download_expired',
  'download_unauthorized',
  'sheets_unavailable',
  'status_update_failed',
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
  const write = ERROR_EVENTS.has(event)
    ? sink.error
    : WARN_EVENTS.has(event)
      ? sink.warn
      : sink.info;
  write.call(sink, line);
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

/**
 * What may be logged about a caught error: its class name (`GaxiosError`, `TypeError`) and a status or
 * error code (`429`, `ETIMEDOUT`). NEVER its message: Google and library errors can embed request
 * details (ranges, values, URLs), so the text is dropped. Both values still pass `sanitizeFields`.
 */
export function errorFacts(error: unknown): { cause?: string; code?: string | number } {
  if (typeof error !== 'object' || error === null) return {};
  const e = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  const code = e.response?.status ?? e.status ?? e.code;
  return {
    cause: typeof e.name === 'string' ? e.name : undefined,
    code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
  };
}
