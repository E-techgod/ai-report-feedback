import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FinalReport } from './final-report';
import { renderEmailHtml } from './email-html';
import { buildReportContent } from './report-content';
import { emailLogoUrl } from './site-url';
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

export function pdfFilename(firstName: string): string {
  const slug = firstName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `Diagnostico-Patrimonial-Quiron${slug ? `-${slug}` : ''}.pdf`;
}

/**
 * The three "most important" lines of the email. Everything comes from the stored report's top
 * priority (the same finding / area / action the web view and the PDF show), never from new text.
 */
export function emailHighlights(c: ReturnType<typeof buildReportContent>) {
  const top = c.priorities.items[0];
  if (top) {
    return [
      { label: 'Tu principal hallazgo:', value: top.finding },
      { label: 'Área prioritaria:', value: top.title },
      { label: 'Siguiente paso:', value: top.action },
    ];
  }
  // No weak areas: the report's own "nothing to strengthen" message is the finding.
  return c.priorities.empty
    ? [
        { label: 'Tu principal hallazgo:', value: c.priorities.empty.title },
        { label: 'Siguiente paso:', value: c.priorities.empty.text },
      ]
    : [];
}

export function buildEmail(
  report: FinalReport,
  opts: { siteUrl?: string | null; attachmentName?: string } = {},
) {
  const c = buildReportContent(report);
  const name = report.firstName || 'cliente';
  const subject = `${name}, tu diagnóstico patrimonial de Quirón`;
  const { score } = c.hero;
  const highlights = emailHighlights(c);
  const attachmentName = opts.attachmentName ?? pdfFilename(report.firstName);
  const bookingLabel = 'Agenda una asesoría con Quirón';
  const logoUrl = emailLogoUrl(opts.siteUrl);
  const html = renderEmailHtml({
    content: c,
    name,
    percent: report.model.score.protection,
    highlights,
    attachmentName,
    logoUrl,
  });

  const text = [
    'Tu diagnóstico patrimonial está listo',
    '',
    `Hola, ${name}.`,
    '',
    'Gracias por completar el cuestionario de Blindaje Patrimonial. Aquí tienes lo más importante de tus resultados.',
    '',
    `${score.label}: ${score.value}`,
    score.levelLabel,
    `${c.hero.weak.value} ${c.hero.weak.of} ${c.hero.weak.label}`,
    '',
    'Lo más relevante',
    ...highlights.map((h) => `${h.label} ${h.value}`),
    '',
    `Informe completo adjunto: ${attachmentName}`,
    '',
    'Un asesor de Quirón puede ayudarte a convertir estos hallazgos en un plan personalizado.',
    c.cta.url ? `${bookingLabel}: ${c.cta.url}` : c.cta.unavailableNote,
    '',
    c.legal,
  ].join('\n');

  return { subject, html, text };
}

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 20_000;
const ERROR_BODY_TIMEOUT_MS = 2_000;

/**
 * The code stored for a failed send. A permanent 4xx adds Resend's machine-readable error `name`
 * (for example `validation_error`), the one field that tells an unverified sender domain from a bad
 * key. Never Resend's message: it can contain the recipient address. Retryable failures keep the
 * bare status because AMBIGUOUS_ERRORS matches 'resend-http-409' exactly.
 */
async function failureCode(response: Response, retryable: boolean): Promise<string> {
  const base = `resend-http-${response.status}`;
  if (retryable) return base;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = await Promise.race([
      response.json() as Promise<{ name?: unknown }>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(reject, ERROR_BODY_TIMEOUT_MS);
      }),
    ]);
    const name = body?.name;
    return typeof name === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(name)
      ? `${base}:${name}`
      : base;
  } catch {
    return base;
  } finally {
    clearTimeout(timer);
  }
}

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
        throw new MailError(await failureCode(response, retryable), retryable);
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
