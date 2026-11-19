import { after, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { submissionSchema } from '@/lib/validation';
import { saveSubmissionWithRow } from '@/lib/sheets';
import { createGoogleSheetsGateway } from '@/lib/google-sheets-client';
import { reportAccessToken } from '@/lib/final-report';
import { submissionFingerprint } from '@/lib/final-report';
import {
  GenerationInProgressError,
  RecipientLimitError,
  SubmissionConflictError,
  createReport,
  deliverReportEmail,
  publicEmailStatus,
} from '@/lib/pipeline';
import { NO_STORE, getPipelineDeps, ipLimited, reportTokenSecret } from '@/lib/services';
import { normalizeEmail } from '@/lib/sheets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Report generation (Claude, up to ~40 s) happens inside this request; email is sent after it.
export const maxDuration = 60;

const MAX_BODY_BYTES = 10_000;
const IP_LIMIT = 10; // submissions per IP per minute

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: NO_STORE });

/**
 * 1) validates the submission (consent is mandatory), 2) appends the row to Google Sheets A:X,
 * 3) creates the ONE finalized report (Claude + rules) and persists it, 4) schedules the email.
 * The response carries the finalized report; the browser never builds its own narrative.
 */
export async function POST(req: Request) {
  const deps = getPipelineDeps();
  const secret = reportTokenSecret();
  const gateway = createGoogleSheetsGateway();
  if (!deps || !secret || !gateway) {
    console.error(
      '[questionnaire] missing configuration (database, report secret or Google Sheets)',
    );
    return json({ ok: false, error: 'El servicio aún no está configurado.' }, 503);
  }

  try {
    if (await ipLimited(deps.store, req, 'submit', IP_LIMIT, 60)) {
      return json({ ok: false, error: 'Demasiadas solicitudes.' }, 429);
    }
  } catch {
    return json({ ok: false, error: 'Servicio no disponible. Intenta nuevamente.' }, 503);
  }

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

  // Step 1: the response row. Once Google confirms it, the lead can no longer be lost.
  let sheetRowNumber: number | undefined;
  let duplicate = false;
  try {
    // A same-id retry after the ten-minute Sheet dedupe window must not append another row.
    const prior = await deps.store.getBySubmissionId(submission.id);
    if (prior) {
      if (
        prior.fingerprint !==
        submissionFingerprint(normalizeEmail(submission.email), submission.answers)
      )
        return json({ ok: false, error: 'El identificador de envío ya está en uso.' }, 409);
      duplicate = true;
      sheetRowNumber = prior.sheetRowNumber ?? undefined;
    } else {
      const fingerprint = submissionFingerprint(
        normalizeEmail(submission.email),
        submission.answers,
      );
      const token = randomUUID();
      if (!(await deps.store.acquireSheetAppend(fingerprint, token, new Date())))
        return json({ ok: false, retry: true, error: 'Estamos guardando tu diagnóstico.' }, 409);
      try {
        const saved = await saveSubmissionWithRow(gateway, submission);
        duplicate = saved.status === 'duplicate';
        sheetRowNumber = saved.rowNumber;
      } finally {
        try {
          await deps.store.releaseSheetAppend(fingerprint, token);
        } catch {
          console.error('[questionnaire] Sheet append lease release failed');
        }
      }
    }
  } catch (error) {
    // Log only a short message: Google client errors can embed request details.
    const message = error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
    console.error('[questionnaire] Google Sheets write failed:', message);
    return json(
      { ok: false, error: 'No se pudo guardar tu diagnóstico. Intenta nuevamente.' },
      502,
    );
  }

  // Step 2: the finalized report. Safe to retry: the same submission id returns the same report.
  try {
    const { record } = await createReport(deps, submission, sheetRowNumber);
    try {
      await deps.syncTracking?.(record.id);
    } catch {
      console.error(`[tracking] report ${record.id}: sync-failed`);
    }
    if (record.emailStatus === 'pending') {
      // Runs after the response; the cron sweep recovers it if this instance dies first.
      after(async () => {
        try {
          await deliverReportEmail(deps, record.id);
        } catch (error) {
          console.error(
            '[questionnaire] email delivery crashed:',
            error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          );
        }
      });
    }
    return json({
      ok: true,
      duplicate,
      reportId: record.id,
      accessToken: reportAccessToken(record.id, secret),
      report: record.report,
      email: publicEmailStatus(record, deps.config),
    });
  } catch (error) {
    if (error instanceof GenerationInProgressError) {
      return json({ ok: false, retry: true, error: 'Estamos preparando tu informe.' }, 409);
    }
    if (error instanceof RecipientLimitError) {
      return json(
        {
          ok: false,
          error: 'Se alcanzó el límite de informes para este correo. Intenta más tarde.',
        },
        429,
      );
    }
    if (error instanceof SubmissionConflictError)
      return json({ ok: false, error: 'El identificador de envío ya está en uso.' }, 409);
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
