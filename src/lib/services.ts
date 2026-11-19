import { getBookingUrl } from './booking';
import { generateNarrative } from './narrative';
import type { ReportDeps } from './generate-report';

/** Production dependencies for report generation, from environment variables. */
export function getReportDeps(): ReportDeps {
  return {
    generateNarrative,
    bookingUrl: getBookingUrl(process.env.NEXT_PUBLIC_BOOKING_URL),
  };
}

/** Signs download grants. Same variable as before, so no new secret is needed. */
export function reportTokenSecret(): string | null {
  const secret = process.env.REPORT_TOKEN_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

export const NO_STORE = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } as const;
