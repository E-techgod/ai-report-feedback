import { NextResponse } from 'next/server';
import { parseWebhookEvent, verifyWebhookSignature } from '@/lib/email';
import { NO_STORE, getPipelineDeps } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const reply = (status: number) => new NextResponse(null, { status, headers: NO_STORE });

/**
 * Resend delivery events (delivered / bounced / complained). This is what upgrades an email from
 * "accepted by the provider" to "delivered". Signature-verified; no report data is logged.
 */
export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const deps = getPipelineDeps();
  if (!secret || !deps) return reply(503);

  const body = await req.text();
  const valid = verifyWebhookSignature({
    body,
    id: req.headers.get('svix-id'),
    timestamp: req.headers.get('svix-timestamp'),
    signature: req.headers.get('svix-signature'),
    secret,
  });
  if (!valid) return reply(401);

  const event = parseWebhookEvent(body);
  if (!event) return reply(200); // an event type we do not track
  const known = await deps.store.applyProviderEvent(event.messageId, event.event, new Date());
  // 404 makes the provider retry: the event can arrive before we recorded the message id.
  return reply(known ? 200 : 404);
}
