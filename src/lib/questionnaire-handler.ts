import { NextResponse } from 'next/server';
import { submissionSchema } from './validation';
import { saveSubmissionWithRow, type SheetsGateway } from './sheets';
import { issueDownloadGrant } from './download-grant';
import { generateReport, type ReportDeps } from './generate-report';
import { NO_STORE } from './services';

const MAX_BODY_BYTES = 10_000;

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: NO_STORE });

/**
 * 1) validates the submission (consent is mandatory), 2) appends a header-mapped Sheet row,
 * 3) generates the ONE finalized report (AI narrative + rules), 4) issues a 5-minute download grant.
 * The Sheet is the only store: the report is returned to the browser and never persisted, and a
 * grant is issued only after BOTH the Sheet write and the report generation succeeded.
 */
export async function handleQuestionnaire(
  req: Request,
  {
    deps,
    secret,
    gateway,
  }: {
    deps: ReportDeps;
    secret: string;
    gateway: SheetsGateway;
  },
) {
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
  let duplicate = false;
  try {
    const saved = await saveSubmissionWithRow(gateway, submission);
    duplicate = saved.status === 'duplicate';
  } catch (error) {
    // Log only a short message: Google client errors can embed request details.
    const message = error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
    console.error('[questionnaire] Google Sheets write failed:', message);
    return json(
      { ok: false, error: 'No se pudo guardar tu diagnóstico. Intenta nuevamente.' },
      502,
    );
  }

  // Step 2: the finalized report and its download grant. Retrying the same submission id is safe:
  // the Sheet already has the row, so only the report is produced again.
  try {
    const report = await generateReport(deps, submission);
    const grant = issueDownloadGrant(report, secret, deps.now?.());
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
