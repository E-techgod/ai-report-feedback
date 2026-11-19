import { NextResponse } from 'next/server';
import { parseWebhookEvent, verifyWebhookSignature } from './email';
import { NO_STORE } from './services';
import type { PipelineDeps } from './pipeline';

const reply = (status: number) => new NextResponse(null, { status, headers: NO_STORE });

/** Acknowledge the persisted provider event before projecting it to Google Sheets. */
export async function handleResendWebhook(
  req: Request,
  deps: PipelineDeps,
  secret: string,
  schedule: (task: () => Promise<void>) => void,
) {
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
  if (!event) return reply(200);
  const known = await deps.store.applyProviderEvent(event.messageId, event.event, new Date());
  if (known && deps.syncTracking)
    schedule(async () => {
      try {
        const record = await deps.store.getByProviderMessageId(event.messageId);
        if (record) await deps.syncTracking?.(record.id, 8_000);
      } catch {
        console.error('[webhook] tracking sync failed');
      }
    });
  // 404 asks Resend to retry an event that arrived before its message ID was recorded.
  return reply(known ? 200 : 404);
}
