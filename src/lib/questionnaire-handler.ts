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
import { fallbackNarrative } from './report';
import { defaultReportCache, type ReportCache } from './report-cache';
import { logSecurityEvent, subjectFingerprint } from './security-log';
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
 * call the AI again and never open a new download window:
 *  - the window of a duplicate ends where the original's ended (so repeating cannot extend it);
 *  - inside it, the same instance hands back the report it just generated (`reportCache`),
 *    otherwise the approved template text is used (no AI call, labelled as template);
 *  - once the window is over the duplicate is refused (409): there is no way to retrieve or
 *    regenerate a report afterwards.
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

  // Step 2: the finalized report and its download grant. Retrying the same submission id is safe:
  // the Sheet already has the row, so at most the report is produced again (without the AI).
  try {
    const duplicate = saved.status === 'duplicate';
    const nowMs = clock().getTime();
    const cached = duplicate ? reportCache.get(saved.submissionId, nowMs) : undefined;

    // Where the download window opens. Fresh report: when it is ready (set below). Repeated
    // submission: wherever the original's window opened, so repeating never extends the deadline.
    let windowStartMs = duplicate ? (cached?.startedAtMs ?? saved.submittedAtMs) : nowMs;

    if (duplicate && windowStartMs + DOWNLOAD_WINDOW_MS <= nowMs) {
      logSecurityEvent('submission_duplicate', { subject, outcome: 'refused_window_over' });
      const waitSeconds = Math.ceil(
        (saved.submittedAtMs + DUPLICATE_WINDOW_MINUTES * 60_000 - nowMs) / 1000,
      );
      return json(
        {
          ok: false,
          duplicate: true,
          error:
            'Ya recibimos este diagnóstico y su ventana de descarga de 5 minutos terminó. ' +
            (waitSeconds > 0
              ? `Podrás generar un informe nuevo en ${waitText(waitSeconds)}.`
              : 'Actualiza la página y vuelve a enviar el cuestionario para generar un informe nuevo.'),
        },
        409,
      );
    }

    let report: FinalReport;
    if (cached) {
      report = cached.report;
      logSecurityEvent('submission_duplicate', { subject, outcome: 'served_cached_report' });
    } else if (duplicate) {
      // No AI call for a repeated submission: approved template text, labelled as such. The report
      // keeps the ORIGINAL submission id, so it shares that submission's download budget.
      report = await generateReport(
        {
          ...deps,
          generateNarrative: async (model) => ({
            narrative: fallbackNarrative(model),
            source: 'template',
            failureReason: 'duplicate-submission',
          }),
        },
        { ...submission, id: saved.submissionId },
      );
      logSecurityEvent('submission_duplicate', { subject, outcome: 'served_template_report' });
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
          'Tus respuestas se guardaron, pero no pudimos generar el informe. Intenta nuevamente.',
      },
      502,
    );
  }
}
