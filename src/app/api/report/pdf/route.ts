import { NextResponse } from 'next/server';
import { handlePdfDownload } from '@/lib/report-pdf-handler';
import { renderReportPdf } from '@/lib/pdf/ReportPdf';
import { NO_STORE, reportTokenSecret } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** POST: the report + `x-download-token` issued at submission. Renders the PDF; stores nothing. */
export async function POST(req: Request) {
  const secret = reportTokenSecret();
  if (!secret) return new NextResponse(null, { status: 503, headers: NO_STORE });
  return handlePdfDownload(req, { secret, renderPdf: renderReportPdf });
}
