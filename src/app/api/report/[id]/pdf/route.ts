import { z } from 'zod';
import { NextResponse } from 'next/server';
import { pdfFilename } from '@/lib/email';
import { verifyReportAccessToken } from '@/lib/final-report';
import { renderReportPdf } from '@/lib/pdf/ReportPdf';
import { NO_STORE, getPipelineDeps, ipLimited, reportTokenSecret } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const fail = (status: number) => new NextResponse(null, { status, headers: NO_STORE });

/** The PDF is rendered from the STORED finalized report: identical to the web view and the email. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const deps = getPipelineDeps();
  const secret = reportTokenSecret();
  if (!deps || !secret) return fail(503);

  const { id } = await params;
  // Header only (never the URL), so the token stays out of logs, history and referrers.
  const token = req.headers.get('x-report-token') ?? '';
  if (!z.string().uuid().safeParse(id).success) return fail(404);
  if (await ipLimited(deps.store, req, 'pdf', 20, 60)) return fail(429);
  if (!verifyReportAccessToken(id, token, secret)) return fail(404);

  const record = await deps.store.getById(id);
  if (!record) return fail(404);

  const pdf = await renderReportPdf(record.report);
  try {
    await deps.store.markPdfDownloaded(id, new Date());
    await deps.syncTracking?.(id);
  } catch {
    console.error(`[tracking] report ${id}: sync-failed`);
  }
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      ...NO_STORE,
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${pdfFilename(record.report.firstName)}"`,
    },
  });
}
