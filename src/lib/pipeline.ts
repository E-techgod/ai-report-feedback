import { randomUUID } from 'node:crypto';
import { buildEmail, pdfFilename, type Mailer } from './email';
import {
  buildFinalReport,
  emailKey,
  submissionFingerprint,
  type FinalReport,
  type NarrativeOutcome,
} from './final-report';
import { buildReportModel, type ReportModel } from './report';
import { normalizeEmail } from './sheets';
import { safeError, type EmailStatus, type ReportRecord, type ReportStore } from './store';
import type { Submission } from './validation';

/**
 * Orchestration: submission -> ONE finalized report (persisted) -> ONE email with the PDF.
 * Dependencies are injected so every failure path (AI, PDF, provider, DB races) is testable.
 */
export type PipelineConfig = {
  bookingUrl: string | null;
  /** False keeps reports working but never sends email (status 'disabled'). */
  emailEnabled: boolean;
  siteUrl: string | null;
  maxAttempts: number;
  leaseMs: number;
  /** Reports older than this are never retried (provider idempotency keys last 24 h). */
  maxAgeMs: number;
  /** Delay before attempt n+1 after attempt n failed. */
  backoffMs: number[];
  /** Same person + same answers inside this window reuse the existing report. */
  dedupeWindowMs: number;
  /** In-flight generation lock; must outlast one generation (AI budget + persistence). */
  generationLockSeconds: number;
  /** Caps new reports (and therefore emails) per recipient address per 24 h. */
  maxReportsPerEmailPerDay: number;
};

export const DEFAULT_CONFIG: Omit<PipelineConfig, 'bookingUrl' | 'emailEnabled' | 'siteUrl'> = {
  maxAttempts: 5,
  leaseMs: 5 * 60_000,
  maxAgeMs: 12 * 3_600_000,
  backoffMs: [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000],
  dedupeWindowMs: 10 * 60_000,
  generationLockSeconds: 90,
  maxReportsPerEmailPerDay: 5,
};

export type PipelineDeps = {
  store: ReportStore;
  generateNarrative: (model: ReportModel) => Promise<NarrativeOutcome>;
  renderPdf: (report: FinalReport) => Promise<Buffer>;
  mailer: Mailer | null;
  config: PipelineConfig;
  now?: () => Date;
  newId?: () => string;
};

const clock = (deps: PipelineDeps) => (deps.now ?? (() => new Date()))();

/** Another request for the same person/answers is generating the report right now. */
export class GenerationInProgressError extends Error {}

/** Too many new reports requested for the same recipient address. */
export class RecipientLimitError extends Error {}

/**
 * Creates (or returns the existing) finalized report for a submission.
 * Idempotent per submission id, and per person+answers inside the dedupe window.
 */
export async function createReport(
  deps: PipelineDeps,
  submission: Submission,
): Promise<{ record: ReportRecord; created: boolean }> {
  const { store, config } = deps;
  const now = clock(deps);

  const byId = await store.getBySubmissionId(submission.id);
  if (byId) return { record: byId, created: false };

  const email = normalizeEmail(submission.email);
  const fingerprint = submissionFingerprint(email, submission.answers);
  const since = new Date(now.getTime() - config.dedupeWindowMs);
  const recent = await store.findRecentByFingerprint(fingerprint, since);
  if (recent) return { record: recent, created: false };

  // Cross-instance lock so two simultaneous requests cannot both generate (and email) a report.
  const holders = await store.hit(`gen:${fingerprint}`, config.generationLockSeconds, now);
  if (holders > 1) {
    const raced = await store.findRecentByFingerprint(fingerprint, since);
    if (raced) return { record: raced, created: false };
    throw new GenerationInProgressError();
  }

  // Only genuinely new reports count, so retries and duplicates never consume the allowance.
  const perEmail = await store.hit(`email:${emailKey(email)}`, 86_400, now);
  if (perEmail > config.maxReportsPerEmailPerDay) throw new RecipientLimitError();

  const model = buildReportModel(submission.answers);
  const outcome = await deps.generateNarrative(model);
  const report = buildFinalReport({
    reportId: (deps.newId ?? randomUUID)(),
    submissionId: submission.id,
    firstName: submission.firstName.trim(),
    answers: submission.answers,
    outcome,
    bookingUrl: config.bookingUrl,
    now: clock(deps),
  });
  return store.insertReport({
    report,
    email,
    fingerprint,
    emailStatus: config.emailEnabled && deps.mailer ? 'pending' : 'disabled',
    now: clock(deps),
  });
}

export type DeliveryResult =
  | { outcome: 'not-claimed' }
  | { outcome: 'accepted'; messageId: string | null }
  | { outcome: 'failed'; error: string; willRetry: boolean };

/**
 * Sends the report email once. The send is claimed atomically in the database first, so a
 * duplicate call (double request, cron overlap, retry) returns 'not-claimed' and sends nothing.
 * The recipient is ALWAYS the address stored with the submission.
 */
export async function deliverReportEmail(
  deps: PipelineDeps,
  reportId: string,
): Promise<DeliveryResult> {
  const { store, config, mailer } = deps;
  if (!mailer) return { outcome: 'not-claimed' };
  const claimed = await store.claimEmail(reportId, clock(deps), {
    maxAttempts: config.maxAttempts,
    leaseMs: config.leaseMs,
    maxAgeMs: config.maxAgeMs,
  });
  if (!claimed) return { outcome: 'not-claimed' };

  let messageId: string | null;
  try {
    const pdf = await deps.renderPdf(claimed.report);
    const message = buildEmail(claimed.report, { siteUrl: config.siteUrl });
    ({ messageId } = await mailer.send({
      to: claimed.email,
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: [{ filename: pdfFilename(claimed.report.firstName), content: pdf }],
      idempotencyKey: `report-email/${claimed.id}`,
    }));
  } catch (error) {
    // Duck-typed (not instanceof) so it holds across duplicated module instances.
    const flag = (error as { retryable?: unknown } | null)?.retryable;
    const retryable = typeof flag === 'boolean' ? flag : true;
    const attempts = claimed.emailAttempts;
    const delay = config.backoffMs[Math.min(attempts - 1, config.backoffMs.length - 1)] ?? 0;
    const willRetry = retryable && attempts < config.maxAttempts;
    const message = safeError(error);
    // Log a short, content-free line: never the report, the address or provider payloads.
    console.error(`[email] report ${claimed.id} attempt ${attempts} failed: ${message}`);
    await store.markFailed(
      claimed.id,
      message,
      willRetry ? new Date(clock(deps).getTime() + delay) : null,
      clock(deps),
    );
    return { outcome: 'failed', error: message, willRetry };
  }

  // The provider has the message. If recording that fails we must NOT mark the send as failed:
  // the row stays 'sending', its lease expires, and the retry re-sends with the same idempotency
  // key, which the provider de-duplicates. The error is rethrown so it stays visible.
  try {
    await store.markAccepted(claimed.id, messageId, clock(deps));
  } catch (error) {
    console.error(`[email] report ${claimed.id} accepted but not recorded: ${safeError(error)}`);
    throw error;
  }
  return { outcome: 'accepted', messageId };
}

/** Recovery sweep (cron): retries emails that are due, bounded by `limit` and the time budget. */
export async function processDueEmails(
  deps: PipelineDeps,
  options: { limit?: number; budgetMs?: number } = {},
) {
  const { limit = 10, budgetMs = 45_000 } = options;
  const { config } = deps;
  const started = Date.now();
  const due = await deps.store.listDueForEmail(clock(deps), limit, {
    maxAttempts: config.maxAttempts,
    leaseMs: config.leaseMs,
    maxAgeMs: config.maxAgeMs,
  });
  const summary = { due: due.length, accepted: 0, failed: 0, skipped: 0 };
  for (const id of due) {
    if (Date.now() - started > budgetMs) break;
    const result = await deliverReportEmail(deps, id);
    if (result.outcome === 'accepted') summary.accepted += 1;
    else if (result.outcome === 'failed') summary.failed += 1;
    else summary.skipped += 1;
  }
  return summary;
}

/* ---------------- what the browser is allowed to know ---------------- */

export type PublicEmailState = 'off' | 'sending' | 'sent' | 'delivered' | 'failed' | 'bounced';

const STATE: Record<EmailStatus, PublicEmailState> = {
  disabled: 'off',
  pending: 'sending',
  sending: 'sending',
  accepted: 'sent',
  delivered: 'delivered',
  failed: 'sending', // an automatic retry is scheduled
  failed_final: 'failed',
  bounced: 'bounced',
  complained: 'sent',
};

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

export function publicEmailStatus(record: ReportRecord) {
  return { state: STATE[record.emailStatus], to: maskEmail(record.email) };
}
