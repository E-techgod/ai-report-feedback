/**
 * Validates the public booking URL (NEXT_PUBLIC_BOOKING_URL).
 * Returns the normalized href for a well-formed https URL, otherwise null so the UI can fall back
 * to a disabled button. Only https is accepted (rejects javascript:, data:, http:, bare text).
 */
export function getBookingUrl(raw: string | undefined | null): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
