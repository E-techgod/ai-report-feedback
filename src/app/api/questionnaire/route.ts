import { after, NextResponse } from 'next/server';
import { createGoogleSheetsGateway } from '@/lib/google-sheets-client';
import { handleQuestionnaire } from '@/lib/questionnaire-handler';
import { NO_STORE, getReportDeps, reportTokenSecret } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Report generation (AI narrative, up to ~40 s) happens inside this request.
export const maxDuration = 60;

// One Google client per function instance (not per request): it keeps the spreadsheet time zone and
// the parsed header row, so a warm instance does not re-read them. Nothing here is trusted state: the
// header row is re-validated inside every request's batched read (see src/lib/sheets.ts).
let sheetsGateway: ReturnType<typeof createGoogleSheetsGateway>;

export async function POST(req: Request) {
  const secret = reportTokenSecret();
  sheetsGateway ??= createGoogleSheetsGateway();
  const gateway = sheetsGateway;
  if (!secret || !gateway) {
    console.error('[questionnaire] missing configuration (report secret or Google Sheets)');
    return NextResponse.json(
      { ok: false, error: 'El servicio aún no está configurado.' },
      { status: 503, headers: NO_STORE },
    );
  }
  return handleQuestionnaire(req, { deps: getReportDeps(), secret, gateway, schedule: after });
}
