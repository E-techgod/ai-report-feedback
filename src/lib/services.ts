import { randomUUID, timingSafeEqual } from 'node:crypto';
import { getBookingUrl } from './booking';
import { createReportStore } from './db';
import { mailerFromEnv } from './email';
import { generateNarrative } from './narrative';
import { DEFAULT_CONFIG, parseEmailAllowlist, type PipelineDeps } from './pipeline';
import { renderReportPdf } from './pdf/ReportPdf';
import { createGoogleSheetsGateway } from './google-sheets-client';
import { syncReportTracking } from './sheet-tracking';
import type { ReportStore } from './store';

/** Builds the production dependencies from environment variables. Null when no database. */
export function getPipelineDeps(): PipelineDeps | null {
  const store = createReportStore();
  if (!store) return null;
  const sheet = createGoogleSheetsGateway();
  return {
    store,
    syncTracking: sheet
      ? (id, budgetMs) => syncReportTracking(store, sheet, id, budgetMs)
      : undefined,
    mailer: mailerFromEnv(),
    generateNarrative,
    renderPdf: renderReportPdf,
    newId: randomUUID,
    config: {
      ...DEFAULT_CONFIG,
      bookingUrl: getBookingUrl(process.env.NEXT_PUBLIC_BOOKING_URL),
      // Master switch: nothing is emailed until this is explicitly "true".
      emailEnabled: process.env.REPORT_EMAIL_ENABLED === 'true',
      // Optional test gate: when set, only these addresses are ever emailed.
      emailAllowlist: parseEmailAllowlist(process.env.REPORT_EMAIL_ALLOWLIST),
      siteUrl: process.env.APP_URL || null,
    },
  };
}

export function reportTokenSecret(): string | null {
  const secret = process.env.REPORT_TOKEN_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

/** Best-effort client IP (Vercel sets these headers; they cannot be spoofed by the browser there). */
export function clientIp(req: Request): string {
  return (
    req.headers.get('x-vercel-forwarded-for') ||
    req.headers.get('x-real-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

/** True when this client exceeded `limit` requests in `windowSeconds` (counter shared via the DB). */
export async function ipLimited(
  store: ReportStore,
  req: Request,
  scope: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const count = await store.hit(`ip:${scope}:${clientIp(req)}`, windowSeconds, new Date());
  return count > limit;
}

/** Constant-time comparison of a presented secret against the expected one. */
export function secretMatches(given: string | null, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const NO_STORE = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } as const;
