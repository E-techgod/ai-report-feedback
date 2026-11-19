import { NextResponse } from 'next/server';
import { submissionSchema } from '@/lib/validation';
import { scoreAnswers } from '@/lib/scoring';
export const runtime = 'nodejs';
export async function POST(req: Request) {
  try {
    const parsed = submissionSchema.safeParse(await req.json());
    if (!parsed.success)
      return NextResponse.json({ error: 'Datos incompletos o incorrectos.' }, { status: 400 });
    const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
    const secret = process.env.GOOGLE_SHEETS_WEBHOOK_SECRET;
    if (!webhookUrl || !secret)
      return NextResponse.json(
        { error: 'El servicio de registro aún no está configurado.' },
        { status: 503 },
      );
    if (!/^https:\/\/script\.google\.com\/macros\/s\//.test(webhookUrl))
      return NextResponse.json({ error: 'Configuración inválida de Sheets.' }, { status: 503 });
    const data = parsed.data;
    const score = scoreAnswers(data.answers);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const r = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...data, secret, score, submittedAt: new Date().toISOString() }),
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!r.ok) throw new Error('Webhook HTTP error');
      const result = await r.json();
      if (result?.ok !== true) throw new Error('Webhook rejected submission');
      return NextResponse.json({ ok: true, score });
    } catch {
      return NextResponse.json(
        { error: 'No se pudo guardar tu diagnóstico. Intenta nuevamente.' },
        { status: 502 },
      );
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 });
  }
}
