/**
 * Coarse, privacy-safe classification of a failure from Google (or the network) so callers can
 * answer sensibly and log a reason without ever logging the error text, which can embed request
 * details.
 *  - quota:   Google rate limit (HTTP 429, "Quota exceeded for ... per minute per user")
 *  - timeout: the request did not finish. The write MAY still have been applied by Google.
 *  - other:   everything else
 */
export type SheetsFailure = 'quota' | 'timeout' | 'other';

const NETWORK_TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN']);

export function classifySheetsError(error: unknown): SheetsFailure {
  const e = (error ?? {}) as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    response?: { status?: unknown };
  };
  const status = Number(e.response?.status ?? e.status ?? e.code);
  const message = typeof e.message === 'string' ? e.message : '';
  if (status === 429 || /quota|rate.?limit|too many requests/i.test(message)) return 'quota';
  if (
    status === 408 ||
    NETWORK_TIMEOUT_CODES.has(String(e.code)) ||
    /timeout|timed out|socket hang up|aborted/i.test(message)
  )
    return 'timeout';
  return 'other';
}
