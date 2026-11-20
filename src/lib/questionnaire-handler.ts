import { NextResponse } from 'next/server';
import { submissionSchema } from './validation';
import {
  DUPLICATE_WINDOW_MINUTES,
  MAX_SUBMISSIONS_PER_EMAIL,
  SUBMISSION_WINDOW_HOURS,
  markReportGenerated,
  saveSubmissionWithRow,
  type SheetsGateway,
} from './sheets';
import { DOWNLOAD_WINDOW_MS, issueDownloadGrant } from './download-grant';
import type { FinalReport } from './final-report';
import { generateReport, type ReportDeps } from './generate-report';
import { defaultReportCache, type ReportCache } from './report-cache';
import { logSecurityEvent, subjectFingerprint } from './security-log';
import { classifySheetsError } from './sheets-errors';
import { NO_STORE } from './services';

const MAX_BODY_BYTES = 10_000;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });

/** "en 25 minutos" / "en aproximadamente 3 horas": a friendly wait, rounded up. */
export function waitText(seconds: number): string {
  if (seconds < 3600) {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
  }
  const hours = Math.ceil(seconds / 3600);
  return `aproximadamente ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
}

export const limitMessage = (seconds: number) =>
  `Has alcanzado el límite de ${MAX_SUBMISSIONS_PER_EMAIL} diagnósticos en ${SUBMISSION_WINDOW_HOURS} horas con este correo. ` +
  `Por favor inténtalo de nuevo en ${waitText(seconds)}.`;

/**
 * 1) validates the submission (consent is mandatory), 2) applies the per-email limit and the
 * duplicate check against the Sheet BEFORE any AI call, 3) appends a header-mapped Sheet row,
 * 4) generates the ONE finalized report (AI narrative + rules), 5) issues a 5-minute download grant
 * and, after the response, marks the row's `Estado Reporte` as "Generado".
 * The Sheet is the only store: the report is returned to the browser and never persisted, and a
 * grant is issued only after BOTH the Sheet write and the report generation succeeded.
 *
 * Duplicates (same submission id, or same email + answers within DUPLICATE_WINDOW_MINUTES) never
 * call the AI again, never produce different feedback and never open a new download window:
 *  - if this instance still holds the report it generated (`reportCache`, in memory, only for the
 *    5-minute window) the duplicate gets exactly that report and the same deadline;
 *  - otherwise the original cannot be reproduced without persistent storage, so the duplicate is
 *    refused with a clear 409 (there is no template or regenerated substitute);
 *  - once the window is over it is refused too: nothing can be retrieved or regenerated afterwards.
 */
export async function handleQuestionnaire(
  req: Request,
  {
    deps,
    secret,
    gateway,
    schedule,
    reportCache = defaultReportCache,
  }: {
    deps: ReportDeps;
    secret: string;
    gateway: SheetsGateway;
    /** Runs after the response (Next's `after`), so a slow Sheet never delays the download. */
    schedule: (task: () => Promise<void>) => void;
    reportCache?: ReportCache;
  },
) {
  const clock = () => (deps.now ?? (() => new Date()))();
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES)
    return json({ ok: false, error: 'Solicitud demasiado grande.' }, 413);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'Solicitud inválida.' }, 400);
  }
  const parsed = submissionSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: 'Datos incompletos o incorrectos.' }, 400);
  const submission = parsed.data;
  // Keyed short hash of the email for the logs; the address itself is never logged.
  const subject = subjectFingerprint(submission.email, secret);

  // Step 1: the response row (or a refusal). Once Google confirms it, the lead can no longer be lost.
  let saved;
  try {
    saved = await saveSubmissionWithRow(gateway, submission, clock());
  } catch (error) {
    // Log only a short message: Google client errors can embed request details.
    const message = error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
    console.error('[questionnaire] Google Sheets write failed:', message);
    const failure = classifySheetsError(error);
    logSecurityEvent('sheets_unavailable', { subject, reason: failure, outcome: 'submission' });
    if (failure === 'quota')
      return json(
        {
          ok: false,
          code: 'service_busy',
          error: 'Estamos recibiendo muchas solicitudes. Inténtalo de nuevo en unos minutos.',
        },
        503,
        { 'retry-after': '60' },
      );
    return json(
      { ok: false, error: 'No se pudo guardar tu diagnóstico. Intenta nuevamente.' },
      502,
    );
  }

  // Rate limit: refused here, before the AI or the report generator are ever reached.
  if (saved.status === 'limited') {
    const retryAfterSeconds = saved.retryAfterSeconds ?? 3600;
    logSecurityEvent('submission_rate_limited', {
      subject,
      reason: 'email_24h',
      limit: MAX_SUBMISSIONS_PER_EMAIL,
      retryAfterSeconds,
    });
    return json(
      {
        ok: false,
        code: 'rate_limited',
        retryAfterSeconds,
        error: limitMessage(retryAfterSeconds),
      },
      429,
      { 'retry-after': String(retryAfterSeconds) },
    );
  }

  // Step 2: the finalized report and its download grant.
  try {
    const duplicate = saved.status === 'duplicate';
    const nowMs = clock().getTime();
    const cached = duplicate ? reportCache.get(saved.submissionId, nowMs) : undefined;

    // A repeated submission is only ever answered with the ORIGINAL report (same text, same
    // deadline, same download budget). Reports are not stored, so if this instance does not hold
    // it there is nothing safe to hand back: no new AI call, no different feedback, no new window.
    if (duplicate && !cached) {
      const windowOver = saved.submittedAtMs + DOWNLOAD_WINDOW_MS <= nowMs;
      logSecurityEvent('submission_duplicate', {
        subject,
        outcome: windowOver ? 'refused_window_over' : 'refused_report_unavailable',
      });
      const waitSeconds = Math.ceil(
        (saved.submittedAtMs + DUPLICATE_WINDOW_MINUTES * 60_000 - nowMs) / 1000,
      );
      const next =
        waitSeconds > 0
          ? `Podrás generar un informe nuevo en ${waitText(waitSeconds)}.`
          : 'Actualiza la página y vuelve a enviar el cuestionario para generar un informe nuevo.';
      return json(
        {
          ok: false,
          duplicate: true,
          code: windowOver ? 'duplicate_window_over' : 'duplicate_report_unavailable',
          error: windowOver
            ? `Ya recibimos este diagnóstico y su ventana de descarga de 5 minutos terminó. ${next}`
            : 'Ya recibimos este diagnóstico, pero no podemos volver a mostrarte el mismo informe desde aquí. ' +
              'Si todavía tienes abierta la página con tu informe, puedes seguir descargándolo hasta que ' +
              `termine su ventana de 5 minutos. ${next}`,
        },
        409,
      );
    }

    let report: FinalReport;
    // Where the download window opens. Fresh report: when it is ready (set below). Cached report:
    // wherever the original's window opened, so repeating never extends the deadline.
    let windowStartMs = nowMs;
    if (cached) {
      report = cached.report;
      windowStartMs = cached.startedAtMs;
      logSecurityEvent('submission_duplicate', { subject, outcome: 'served_cached_report' });
    } else {
      report = await generateReport(deps, submission);
      // The window opens when the report is READY, so a slow AI call never eats into it.
      windowStartMs = clock().getTime();
      reportCache.set(saved.submissionId, { report, startedAtMs: windowStartMs });
    }

    const grant = issueDownloadGrant(report, secret, clock(), windowStartMs);
    if (!cached) {
      // Best effort and after the response: a failure here never affects the customer's download.
      try {
        schedule(async () => {
          try {
            await markReportGenerated(gateway, submission, saved.rowNumber, 8_000);
          } catch (error) {
            const message = error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
            console.error('[questionnaire] could not set Estado Reporte:', message);
          }
        });
      } catch {
        console.error('[questionnaire] could not schedule the Estado Reporte update');
      }
    }
    return json({
      ok: true,
      duplicate,
      report,
      download: { token: grant.token, expiresInMs: grant.expiresInMs },
    });
  } catch (error) {
    console.error(
      '[questionnaire] report generation failed:',
      error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    );
    return json(
      {
        ok: false,
        saved: true,
        error:
          'Tus respuestas se guardaron, pero no pudimos generar el informe. Espera unos minutos y vuelve a enviar el cuestionario.',
      },
      502,
    );
  }
}
