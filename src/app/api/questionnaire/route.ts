import { after, NextResponse } from 'next/server';
import { createGoogleSheetsGateway } from '@/lib/google-sheets-client';
import { handleQuestionnaire } from '@/lib/questionnaire-handler';
import { NO_STORE, getPipelineDeps, reportTokenSecret } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Report generation (Claude, up to ~40 s) happens inside this request; email runs after it.
export const maxDuration = 60;

export async function POST(req: Request) {
  const deps = getPipelineDeps();
  const secret = reportTokenSecret();
  const gateway = createGoogleSheetsGateway();
  if (!deps || !secret || !gateway) {
    console.error(
      '[questionnaire] missing configuration (database, report secret or Google Sheets)',
    );
    return NextResponse.json(
      { ok: false, error: 'El servicio aún no está configurado.' },
      { status: 503, headers: NO_STORE },
    );
  }
  return handleQuestionnaire(req, { deps, secret, gateway, schedule: after });
}
