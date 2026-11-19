import { after, NextResponse } from 'next/server';
import { handlePdfDownload } from '@/lib/report-pdf-handler';
import { NO_STORE, getPipelineDeps, reportTokenSecret } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** The PDF is rendered from the stored report; Sheet tracking runs after the response. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const deps = getPipelineDeps();
  const secret = reportTokenSecret();
  if (!deps || !secret) return new NextResponse(null, { status: 503, headers: NO_STORE });
  const { id } = await params;
  return handlePdfDownload(req, id, deps, secret, after);
}
