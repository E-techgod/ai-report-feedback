import { after, NextResponse } from 'next/server';
import { createDownloadLimiter, createSheetLedger } from '@/lib/download-ledger';
import { createGoogleLedgerGateway, createGoogleSheetsGateway } from '@/lib/google-sheets-client';
import { handlePdfDownload } from '@/lib/report-pdf-handler';
import { renderReportPdf } from '@/lib/pdf/ReportPdf';
import { markPdfDownloaded } from '@/lib/sheets';
import { NO_STORE, reportTokenSecret } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// One limiter per function instance. Its memory (a per-grant queue and an "already exhausted"
// memo) only saves work; the count that enforces the limit lives in the spreadsheet ledger.
let limiter: ReturnType<typeof createDownloadLimiter> | undefined;

function getLimiter() {
  if (!limiter) {
    const gateway = createGoogleLedgerGateway();
    if (gateway) limiter = createDownloadLimiter(createSheetLedger(gateway));
  }
  return limiter;
}

// One Google client per function instance, used only to record the download in the response row.
let sheetsGateway: ReturnType<typeof createGoogleSheetsGateway>;

/**
 * POST: the report + `x-download-token` issued at submission. Renders the PDF; stores no PDF.
 * Each submission may download its report at most 5 times (counted in the Sheet, see
 * src/lib/download-ledger.ts). Without Google credentials the limit cannot be enforced, so the
 * route refuses (503) instead of silently serving unlimited downloads.
 */
export async function POST(req: Request) {
  const secret = reportTokenSecret();
  const activeLimiter = getLimiter();
  if (!secret || !activeLimiter) return new NextResponse(null, { status: 503, headers: NO_STORE });
  sheetsGateway ??= createGoogleSheetsGateway();
  const gateway = sheetsGateway;
  return handlePdfDownload(req, {
    secret,
    renderPdf: renderReportPdf,
    limiter: activeLimiter,
    // Marks `Estado Descarga PDF` / `Fecha Descarga PDF` in the submission's row, after the response.
    trackDownload: gateway
      ? (report, at) => markPdfDownloaded(gateway, report.submissionId, at, 8_000)
      : undefined,
    schedule: after,
  });
}
