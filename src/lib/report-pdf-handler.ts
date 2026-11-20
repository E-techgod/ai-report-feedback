import { NextResponse } from 'next/server';
import { downloadLedgerKey, grantExpiresAt, verifyDownloadGrant } from './download-grant';
import { MAX_DOWNLOADS_PER_SUBMISSION, type DownloadLimiter } from './download-ledger';
import { finalReportSchema, deepFreeze, type FinalReport } from './final-report';
import { errorFacts, logSecurityEvent } from './security-log';
import { classifySheetsError } from './sheets-errors';
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
 *   429 this submission already had its MAX_DOWNLOADS_PER_SUBMISSION successful downloads
 *   503 the download ledger could not be reached (fails closed: see download-ledger.ts)
 * Only requests that pass verification ever touch the ledger, so unauthorized or expired calls
 * cost nothing but the signature check.
 */
export async function handlePdfDownload(
  req: Request,
  {
    secret,
    renderPdf,
    limiter,
    now,
    trackDownload,
    schedule,
  }: {
    secret: string;
    renderPdf: (report: FinalReport) => Promise<Buffer>;
    limiter: DownloadLimiter;
    now?: () => Date;
    /** Records a delivered download in the response row (best effort, runs after the response). */
    trackDownload?: (report: FinalReport, at: Date) => Promise<unknown>;
    /** Runs a task after the response (Next's `after`), so a slow Sheet never delays the download. */
    schedule?: (task: () => Promise<void>) => void;
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

  const token = req.headers.get('x-download-token') ?? '';
  const clock = now?.() ?? new Date();
  const check = verifyDownloadGrant(report, token, secret, clock);
  if (check === 'expired') {
    logSecurityEvent('download_expired');
    return fail(410, 'Tu sesión de descarga ha expirado.');
  }
  if (check !== 'ok') {
    logSecurityEvent('download_unauthorized', {
      reason: token ? 'invalid_grant' : 'missing_grant',
    });
    return fail(401, 'Descarga no autorizada.');
  }

  // Verified: this submission may download up to MAX_DOWNLOADS_PER_SUBMISSION times while the grant lives.
  const key = downloadLedgerKey(report, secret);
  const grant = key.slice(3, 11); // opaque, for correlating log lines only
  let outcome;
  try {
    outcome = await limiter.deliver(key, grantExpiresAt(token), clock, () => renderPdf(report));
  } catch (error) {
    // Diagnosable without report content: a coarse reason, the error class and its code, never its text
    // (a render error could quote the report). A render failure never uses one of the downloads.
    const text = error instanceof Error ? error.message : '';
    logSecurityEvent('pdf_render_failed', {
      grant,
      reason: /ENOENT|MODULE_NOT_FOUND|Cannot find module|font/i.test(text)
        ? 'missing_asset'
        : 'render_error',
      ...errorFacts(error),
    });
    return fail(500, 'No se pudo generar el PDF.');
  }
  if (outcome.kind === 'limit') {
    logSecurityEvent('download_limit_reached', { grant, limit: MAX_DOWNLOADS_PER_SUBMISSION });
    return fail(
      429,
      `Alcanzaste el límite de ${MAX_DOWNLOADS_PER_SUBMISSION} descargas de este informe.`,
    );
  }
  if (outcome.kind === 'unavailable') {
    logSecurityEvent('download_limit_unavailable', { grant, reason: outcome.reason });
    return fail(503, 'No pudimos verificar tu descarga en este momento. Intenta nuevamente.');
  }
  logSecurityEvent('download_served', {
    grant,
    ordinal: outcome.ordinal,
    limit: MAX_DOWNLOADS_PER_SUBMISSION,
  });
  if (trackDownload && schedule) {
    // Best effort: a failure here never affects the customer's download.
    try {
      schedule(async () => {
        try {
          await trackDownload(report, clock);
        } catch (error) {
          logSecurityEvent('status_update_failed', {
            grant,
            reason: classifySheetsError(error),
            outcome: 'pdf_download',
            ...errorFacts(error),
          });
        }
      });
    } catch {
      logSecurityEvent('status_update_failed', {
        grant,
        reason: 'schedule_failed',
        outcome: 'pdf_download',
      });
    }
  }
  const pdf = outcome.value;
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      ...NO_STORE,
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${pdfFilename(report.firstName)}"`,
    },
  });
}
