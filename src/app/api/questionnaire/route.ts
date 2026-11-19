import { NextResponse } from 'next/server';
import { submissionSchema } from '@/lib/validation';
import { saveSubmission } from '@/lib/sheets';
import { createGoogleSheetsGateway } from '@/lib/google-sheets-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 10_000;
const RATE_LIMIT = 10; // requests per IP per minute (best effort, per server instance)
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(req: Request): boolean {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const now = Date.now();
  if (hits.size > 1000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  const entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

export async function POST(req: Request) {
  if (rateLimited(req)) {
    return NextResponse.json({ ok: false, error: 'Demasiadas solicitudes.' }, { status: 429 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'Solicitud demasiado grande.' }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: 'Solicitud inválida.' }, { status: 400 });
  }

  const parsed = submissionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Datos incompletos o incorrectos.' },
      { status: 400 },
    );
  }

  const gateway = createGoogleSheetsGateway();
  if (!gateway) {
    console.error('[questionnaire] Google Sheets credentials are not configured');
    return NextResponse.json(
      { ok: false, error: 'El servicio de registro aún no está configurado.' },
      { status: 503 },
    );
  }

  try {
    const status = await saveSubmission(gateway, parsed.data);
    return NextResponse.json({ ok: true, duplicate: status === 'duplicate' });
  } catch (error) {
    // Log only a short message: Google client errors can embed request details.
    const message = error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
    console.error('[questionnaire] Google Sheets write failed:', message);
    return NextResponse.json(
      { ok: false, error: 'No se pudo guardar tu diagnóstico. Intenta nuevamente.' },
      { status: 502 },
    );
  }
}
