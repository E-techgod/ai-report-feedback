import { NextResponse } from 'next/server';
import { verifyDownloadGrant } from './download-grant';
import { finalReportSchema, deepFreeze, type FinalReport } from './final-report';
import { NO_STORE } from './services';

// A finalized report is ~10-15 KB of JSON; anything near this is not one.
const MAX_BODY_BYTES = 100_000;

const fail = (status: number, error: string) =>
  NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });

export function pdfFilename(firstName: string): string {
  const slug = firstName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `Diagnostico-Patrimonial-Quiron${slug ? `-${slug}` : ''}.pdf`;
}

/**
 * Renders the PDF for a report the browser presents together with its download grant.
 * Nothing is looked up or stored: the grant's signature covers the report's content hash and the
 * expiry, so the server only has to verify it (any instance can) and render. The report travels
 * in the POST body, never in a URL, and the response is not cacheable.
 *   401 invalid/tampered grant or a report that does not match it
 *   410 grant genuinely issued for this report, but past its 5-minute window
 */
export async function handlePdfDownload(
  req: Request,
  {
    secret,
    renderPdf,
    now,
  }: {
    secret: string;
    renderPdf: (report: FinalReport) => Promise<Buffer>;
    now?: () => Date;
  },
) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return fail(413, 'Solicitud demasiado grande.');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, 'Solicitud inválida.');
  }
  const parsed = finalReportSchema.safeParse(body);
  if (!parsed.success) return fail(400, 'Solicitud inválida.');
  const report = deepFreeze(parsed.data);

  const check = verifyDownloadGrant(
    report,
    req.headers.get('x-download-token') ?? '',
    secret,
    now?.(),
  );
  if (check === 'expired') return fail(410, 'Your download session has expired.');
  if (check !== 'ok') return fail(401, 'Descarga no autorizada.');

  let pdf: Buffer;
  try {
    pdf = await renderPdf(report);
  } catch (error) {
    // Named log line (no report content) so a runtime packaging/render failure is diagnosable.
    console.error(
      `[pdf] render-failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`,
    );
    return fail(500, 'No se pudo generar el PDF.');
  }
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      ...NO_STORE,
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${pdfFilename(report.firstName)}"`,
    },
  });
}
