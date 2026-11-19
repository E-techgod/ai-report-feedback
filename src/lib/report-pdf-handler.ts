import { z } from 'zod';
import { NextResponse } from 'next/server';
import { pdfFilename } from './email';
import { verifyReportAccessToken } from './final-report';
import { NO_STORE, ipLimited } from './services';
import type { PipelineDeps } from './pipeline';
import { safeError } from './store';

const fail = (status: number) => new NextResponse(null, { status, headers: NO_STORE });

/** Render the stored report; project download status to Sheets after the response. */
export async function handlePdfDownload(
  req: Request,
  id: string,
  deps: PipelineDeps,
  secret: string,
  schedule: (task: () => Promise<void>) => void,
) {
  const token = req.headers.get('x-report-token') ?? '';
  if (!z.string().uuid().safeParse(id).success) return fail(404);
  if (await ipLimited(deps.store, req, 'pdf', 20, 60)) return fail(429);
  if (!verifyReportAccessToken(id, token, secret)) return fail(404);

  const record = await deps.store.getById(id);
  if (!record) return fail(404);
  let pdf: Buffer;
  try {
    pdf = await deps.renderPdf(record.report);
  } catch (error) {
    // Named log line (no report content) so a runtime packaging/render failure is diagnosable
    // from the function logs; nothing is recorded as downloaded.
    console.error(`[pdf] report ${id}: render-failed: ${safeError(error)}`);
    return fail(500);
  }
  try {
    // Persist the event before returning; Sheets remains an asynchronous projection.
    await deps.store.markPdfDownloaded(id, new Date());
  } catch {
    console.error(`[tracking] report ${id}: pdf-status-failed`);
  }

  const response = new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      ...NO_STORE,
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${pdfFilename(record.report.firstName)}"`,
    },
  });
  if (deps.syncTracking)
    schedule(async () => {
      try {
        await deps.syncTracking?.(id, 8_000);
      } catch {
        console.error(`[tracking] report ${id}: sync-failed`);
      }
    });
  return response;
}
