import { after, NextResponse } from 'next/server';
import { handleResendWebhook } from '@/lib/resend-webhook-handler';
import { NO_STORE, getPipelineDeps } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Resend delivery events are persisted before ack; Sheet tracking runs after. */
export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const deps = getPipelineDeps();
  if (!secret || !deps) return new NextResponse(null, { status: 503, headers: NO_STORE });
  return handleResendWebhook(req, deps, secret, after);
}
