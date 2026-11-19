import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FinalReport } from './final-report';
import { buildReportContent } from './report-content';
import type { ProviderEvent } from './store';

/**
 * Transactional email for the finalized report. The message is rendered from the same
 * buildReportContent() as the web view and the PDF, and the PDF is attached to it.
 * Provider acceptance ("queued by Resend") is NOT delivery: delivery is confirmed later by webhook.
 */
export type Attachment = { filename: string; content: Buffer };
export type OutgoingEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments: Attachment[];
  /** Stable per report: a retry after a lost response can never produce a second email. */
  idempotencyKey: string;
};
export type Mailer = { send(message: OutgoingEmail): Promise<{ messageId: string | null }> };

export class MailError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function pdfFilename(firstName: string): string {
  const slug = firstName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `Diagnostico-Patrimonial-Quiron${slug ? `-${slug}` : ''}.pdf`;
}

export function buildEmail(report: FinalReport, opts: { siteUrl?: string | null } = {}) {
  const c = buildReportContent(report);
  const name = report.firstName || 'cliente';
  const subject = `${name}, tu diagnóstico patrimonial de Quirón`;
  const { score } = c.hero;
  const logo = opts.siteUrl ? `${opts.siteUrl.replace(/\/$/, '')}/images/quiron-logo.png` : null;
  const button = c.cta.url
    ? `<a href="${esc(c.cta.url)}" style="display:inline-block;background:#be925a;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:6px;font-size:15px">${esc(c.cta.buttonLabel)}</a>`
    : `<p style="margin:0;color:#dfe9e2;font-size:13px">${esc(c.cta.unavailableNote)}</p>`;

  const html = `<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#f4f3ee;font-family:Arial,Helvetica,sans-serif;color:#162a20">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f3ee"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="padding:14px 32px;background:#000000">${
    logo
      ? `<img src="${esc(logo)}" alt="Quirón Arquitectos Financieros" width="120" style="display:block;border:0">`
      : `<strong style="letter-spacing:2px;color:#ffffff;font-size:18px">QUIRÓN</strong>`
  }</td></tr>
<tr><td style="padding:28px 32px 8px">
<p style="margin:0 0 6px;font-size:12px;letter-spacing:1.5px;color:#be925a;text-transform:uppercase">${esc(c.brand)}</p>
<h1 style="margin:0 0 12px;font-size:24px;line-height:1.2;color:#143b2c">Hola, ${esc(name)}. Tu diagnóstico está listo.</h1>
<p style="margin:0;font-size:15px;line-height:1.6;color:#63756a">Adjuntamos el informe completo en PDF. Aquí tienes un resumen.</p>
</td></tr>
<tr><td style="padding:16px 32px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f3ee;border-radius:8px"><tr><td style="padding:18px 20px">
<div style="font-size:12px;letter-spacing:1px;color:#63756a;text-transform:uppercase">${esc(score.label)}</div>
<div style="font-size:38px;font-weight:bold;color:#143b2c;line-height:1.2">${esc(score.value)}</div>
<div style="font-size:14px;font-weight:bold;color:#9a6626">${esc(score.levelLabel)}</div>
</td></tr></table></td></tr>
<tr><td style="padding:8px 32px 8px">
<h2 style="margin:0 0 8px;font-size:16px;color:#143b2c">${esc(c.executive.title)}</h2>
<p style="margin:0;font-size:15px;line-height:1.65">${esc(c.executive.summaryText)}</p>
</td></tr>
<tr><td style="padding:20px 32px 28px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#143b2c;border-radius:8px"><tr><td style="padding:22px 24px">
<h2 style="margin:0 0 6px;font-size:17px;color:#ffffff">${esc(c.cta.title)}</h2>
<p style="margin:0 0 14px;font-size:14px;line-height:1.55;color:#dfe9e2">${esc(c.cta.text)}</p>
${button}
</td></tr></table></td></tr>
<tr><td style="padding:0 32px 28px;font-size:11px;line-height:1.5;color:#63756a">${esc(c.legal)}</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    `Hola, ${name}. Tu diagnóstico está listo.`,
    '',
    `${score.label}: ${score.value}`,
    score.levelLabel,
    '',
    c.executive.title,
    c.executive.summaryText,
    '',
    'Adjuntamos el informe completo en PDF.',
    c.cta.url ? `${c.cta.buttonLabel}: ${c.cta.url}` : c.cta.unavailableNote,
    '',
    c.legal,
  ].join('\n');

  return { subject, html, text };
}

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 20_000;

export type MailerConfig = {
  apiKey: string;
  from: string;
  replyTo?: string;
  fetchImpl?: typeof fetch;
};

export function createResendMailer(config: MailerConfig): Mailer {
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    async send(message) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetchImpl(RESEND_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': message.idempotencyKey,
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.to],
            reply_to: config.replyTo,
            subject: message.subject,
            html: message.html,
            text: message.text,
            attachments: message.attachments.map((a) => ({
              filename: a.filename,
              content: a.content.toString('base64'),
            })),
          }),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'AbortError';
        throw new MailError(timedOut ? 'resend-timeout' : 'resend-network-error', true);
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        // 409 = same idempotency key still in flight; 429/5xx are transient. Other 4xx will not
        // succeed on retry (bad address, unverified domain, invalid key...).
        const retryable =
          response.status === 409 || response.status === 429 || response.status >= 500;
        throw new MailError(`resend-http-${response.status}`, retryable);
      }
      const data = (await response.json().catch(() => ({}))) as { id?: unknown };
      return { messageId: typeof data.id === 'string' ? data.id : null };
    },
  };
}

/** Returns a mailer when RESEND_API_KEY and EMAIL_FROM are set, otherwise null. */
export function mailerFromEnv(): Mailer | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) return null;
  return createResendMailer({ apiKey, from, replyTo: process.env.EMAIL_REPLY_TO || undefined });
}

/* ---------------- Resend webhooks (Svix signature scheme) ---------------- */

const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export function verifyWebhookSignature(input: {
  body: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  now?: Date;
}): boolean {
  const { body, id, timestamp, signature, secret } = input;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  return signature.split(' ').some((part) => {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

const EVENT_MAP: Record<string, ProviderEvent> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.delivery_delayed': 'delayed',
};

/** Extracts the provider message id and our event name; null for events we do not track. */
export function parseWebhookEvent(
  body: string,
): { messageId: string; event: ProviderEvent } | null {
  try {
    const payload = JSON.parse(body) as { type?: unknown; data?: { email_id?: unknown } };
    const event = typeof payload.type === 'string' ? EVENT_MAP[payload.type] : undefined;
    const messageId = payload.data?.email_id;
    return event && typeof messageId === 'string' ? { messageId, event } : null;
  } catch {
    return null;
  }
}
