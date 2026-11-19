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
  /**
   * Reports older than this are never retried and are finalized as failed. 47 h lets the daily
   * recovery sweep (Vercel Hobby) reach every report at least once; see docs/report-email.md.
   */
  maxAgeMs: number;
  /**
   * Resend remembers an idempotency key for 24 h. After this long since the first attempt a retry
   * is no longer de-duplicated by the provider, so it is only allowed when no earlier attempt
   * could have reached the provider (see AMBIGUOUS_ERRORS). Kept under 24 h as a safety margin.
   */
  idempotencyWindowMs: number;
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
  maxAgeMs: 47 * 3_600_000,
  idempotencyWindowMs: 23 * 3_600_000,
  backoffMs: [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000],
  dedupeWindowMs: 10 * 60_000,
  generationLockSeconds: 90,
  maxReportsPerEmailPerDay: 5,
};

export type PipelineDeps = {
  store: ReportStore;
  /** Best-effort projection of the latest Neon state into the linked Sheet row. */
  syncTracking?: (reportId: string, budgetMs?: number) => Promise<boolean>;
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

/** A client reused a submission id with different recipient or answers. */
export class SubmissionConflictError extends Error {}

/**
 * Creates (or returns the existing) finalized report for a submission.
 * Idempotent per submission id, and per person+answers inside the dedupe window.
 */
export async function createReport(
  deps: PipelineDeps,
  submission: Submission,
  sheetRowNumber?: number,
): Promise<{ record: ReportRecord; created: boolean }> {
  const { store, config } = deps;
  const now = clock(deps);
  const email = normalizeEmail(submission.email);
  const fingerprint = submissionFingerprint(email, submission.answers);

  const byId = await store.getBySubmissionId(submission.id);
  if (byId) {
    if (byId.fingerprint !== fingerprint) throw new SubmissionConflictError();
    return {
      record:
        sheetRowNumber && !byId.sheetRowNumber
          ? await store.linkSheetRow(byId.id, sheetRowNumber)
          : byId,
      created: false,
    };
  }
  const since = new Date(now.getTime() - config.dedupeWindowMs);
  const recent = await store.findRecentByFingerprint(fingerprint, since);
  if (recent)
    return {
      record:
        sheetRowNumber && !recent.sheetRowNumber
          ? await store.linkSheetRow(recent.id, sheetRowNumber)
          : recent,
      created: false,
    };

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
  const saved = await store.insertReport({
    report,
    email,
    fingerprint,
    emailStatus: config.emailEnabled && deps.mailer ? 'pending' : 'disabled',
    sheetRowNumber,
    now: clock(deps),
  });
  if (!saved.created && sheetRowNumber && !saved.record.sheetRowNumber)
    return { record: await store.linkSheetRow(saved.record.id, sheetRowNumber), created: false };
  return saved;
}

async function syncSafely(deps: PipelineDeps, reportId: string) {
  try {
    await deps.syncTracking?.(reportId, 8_000);
  } catch {
    console.error(`[tracking] report ${reportId}: sync-failed`);
  }
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
  options: { syncTracking?: boolean } = {},
): Promise<DeliveryResult> {
  const { store, config, mailer } = deps;
  const project = options.syncTracking !== false;
  if (!config.emailEnabled || !mailer) return { outcome: 'not-claimed' };
  const claimed = await store.claimEmail(reportId, clock(deps), {
    maxAttempts: config.maxAttempts,
    leaseMs: config.leaseMs,
    maxAgeMs: config.maxAgeMs,
  });
  if (!claimed) return { outcome: 'not-claimed' };

  // Retrying past the provider's idempotency window after an unknown outcome could send a second
  // copy. In that case we stop and report a terminal failure instead of guessing.
  if (claimed.emailAttempts > 1) {
    const history = await store.attemptHistory(claimed.id);
    const sinceFirst = history.firstAttemptAt
      ? clock(deps).getTime() - history.firstAttemptAt.getTime()
      : 0;
    if (history.ambiguous && sinceFirst >= config.idempotencyWindowMs) {
      const reason = 'unknown-outcome-after-idempotency-window';
      console.error(`[email] report ${claimed.id} not retried: ${reason}`);
      await store.markFailed(claimed.id, reason, null, clock(deps));
      if (project) await syncSafely(deps, reportId);
      return { outcome: 'failed', error: reason, willRetry: false };
    }
  }

  let messageId: string | null;
  try {
    const pdf = await deps.renderPdf(claimed.report);
    const filename = pdfFilename(claimed.report.firstName);
    const message = buildEmail(claimed.report, {
      siteUrl: config.siteUrl,
      attachmentName: filename,
    });
    ({ messageId } = await mailer.send({
      to: claimed.email,
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: [{ filename, content: pdf }],
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
    if (project) await syncSafely(deps, reportId);
    return { outcome: 'failed', error: message, willRetry };
  }

  // The provider has the message. If recording that fails we must NOT mark the send as failed:
  // the row stays 'sending', its lease expires, and the retry re-sends with the same idempotency
  // key, which the provider de-duplicates. The error is rethrown so it stays visible.
  try {
    await store.markAccepted(claimed.id, messageId, clock(deps));
    if (project) await syncSafely(deps, reportId);
  } catch (error) {
    console.error(`[email] report ${claimed.id} accepted but not recorded: ${safeError(error)}`);
    throw error;
  }
  return { outcome: 'accepted', messageId };
}

/**
 * Recovery sweep (daily cron). First finalizes reports that can no longer be retried, then works
 * through EVERYTHING that is due in batches until the time budget runs out (a daily sweep must not
 * leave a backlog for the next day). Safe to run concurrently: each send is claimed atomically.
 */
export async function processDueEmails(
  deps: PipelineDeps,
  options: { batchSize?: number; budgetMs?: number; wallNow?: () => number } = {},
) {
  const { batchSize = 25, budgetMs = 45_000, wallNow = Date.now } = options;
  const { config } = deps;
  const opts = {
    maxAttempts: config.maxAttempts,
    leaseMs: config.leaseMs,
    maxAgeMs: config.maxAgeMs,
  };
  const started = wallNow();
  if (!config.emailEnabled) return { expired: 0, due: 0, accepted: 0, failed: 0, skipped: 0 };
  const expired = await deps.store.expireStale(clock(deps), opts);
  const summary = { expired: expired.length, due: 0, accepted: 0, failed: 0, skipped: 0 };
  const seen = new Set<string>();
  while (wallNow() - started < budgetMs) {
    const due = await deps.store.listDueForEmail(clock(deps), batchSize, opts, [...seen]);
    if (due.length === 0) break;
    for (const id of due) {
      if (wallNow() - started >= budgetMs) return summary;
      seen.add(id);
      summary.due += 1;
      // The cron projects Sheet state in its separate, bounded tracking phase.
      const result = await deliverReportEmail(deps, id, { syncTracking: false });
      if (result.outcome === 'accepted') summary.accepted += 1;
      else if (result.outcome === 'failed') summary.failed += 1;
      else summary.skipped += 1;
    }
  }
  return summary;
}

/* ---------------- what the browser is allowed to know ---------------- */

export type PublicEmailState =
  'off' | 'sending' | 'retrying' | 'sent' | 'delivered' | 'failed' | 'bounced';

const STATE: Record<EmailStatus, PublicEmailState> = {
  disabled: 'off',
  pending: 'sending',
  sending: 'sending',
  accepted: 'sent',
  delivered: 'delivered',
  failed: 'retrying',
  failed_final: 'failed',
  bounced: 'bounced',
  complained: 'sent',
};

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

/**
 * What the customer sees. Derived at read time too, so a report that can no longer be retried
 * (too old, or out of attempts) shows a terminal failure immediately, even before the next sweep
 * persists it. 'retrying' = a later automatic attempt is still possible.
 */
export function publicEmailStatus(
  record: ReportRecord,
  config: Pick<PipelineConfig, 'maxAgeMs' | 'maxAttempts'> = DEFAULT_CONFIG,
  now: Date = new Date(),
) {
  const unfinished = ['pending', 'failed', 'sending'].includes(record.emailStatus);
  const leaseActive =
    record.emailStatus === 'sending' && (record.emailLeaseUntil?.getTime() ?? 0) >= now.getTime();
  const expired =
    unfinished &&
    !leaseActive &&
    (now.getTime() - record.createdAt.getTime() > config.maxAgeMs ||
      record.emailAttempts >= config.maxAttempts);
  let state: PublicEmailState = expired ? 'failed' : STATE[record.emailStatus];
  if (state === 'sending' && record.emailStatus === 'sending' && !leaseActive) state = 'retrying';
  return { state, to: maskEmail(record.email) };
}
