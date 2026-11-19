import { parseFinalReport, reportHash, type FinalReport } from './final-report';

/**
 * Persistence for finalized reports and email delivery state (Postgres / Neon).
 * All SQL goes through `SqlExecutor`, so the same code runs against Neon in production and an
 * in-process Postgres (PGlite) in tests. Questionnaire responses are NOT stored here.
 */
export type SqlExecutor = (
  text: string,
  params?: unknown[],
) => Promise<Array<Record<string, unknown>>>;

export type EmailStatus =
  | 'disabled'
  | 'pending'
  | 'sending'
  | 'accepted'
  | 'delivered'
  | 'failed'
  | 'failed_final'
  | 'bounced'
  | 'complained';

export type ReportRecord = {
  id: string;
  submissionId: string;
  email: string;
  fingerprint: string;
  report: FinalReport;
  createdAt: Date;
  sheetRowNumber: number | null;
  sheetTrackingExpected: boolean;
  pdfDownloadedAt: Date | null;
  trackingVersion: number;
  sheetSyncedVersion: number;
  sheetSyncLeaseUntil: Date | null;
  sheetSyncFailures: number;
  sheetSyncNextAttemptAt: Date | null;
  emailStatus: EmailStatus;
  emailAttempts: number;
  emailLastAttemptAt: Date | null;
  emailNextAttemptAt: Date | null;
  emailLeaseUntil: Date | null;
  emailProviderMessageId: string | null;
  emailAcceptedAt: Date | null;
  emailDeliveredAt: Date | null;
  emailLastError: string | null;
};

/**
 * Send errors after which the provider MAY have accepted the message (the request was sent but we
 * never saw an answer, or another request with the same key is in flight). Any other recorded
 * error is an HTTP rejection, which means the message was not accepted.
 */
export const AMBIGUOUS_ERRORS = new Set([
  'resend-timeout',
  'resend-network-error',
  'resend-http-409',
]);

export type ProviderEvent = 'delivered' | 'bounced' | 'complained' | 'delayed';

export type ClaimOptions = { maxAttempts: number; leaseMs: number; maxAgeMs: number };

const d = (v: unknown): Date | null => (v == null ? null : new Date(v as string | number | Date));

function toRecord(row: Record<string, unknown>): ReportRecord {
  const report = parseFinalReport(
    typeof row.report === 'string' ? JSON.parse(row.report) : row.report,
  );
  if (reportHash(report) !== row.content_hash)
    throw new Error('Stored report failed its integrity check');
  return {
    id: String(row.id),
    submissionId: String(row.submission_id),
    email: String(row.email),
    fingerprint: String(row.fingerprint),
    report,
    createdAt: d(row.created_at)!,
    sheetRowNumber: row.sheet_row_number == null ? null : Number(row.sheet_row_number),
    sheetTrackingExpected: row.sheet_tracking_expected === true,
    pdfDownloadedAt: d(row.pdf_downloaded_at),
    trackingVersion: Number(row.tracking_version),
    sheetSyncedVersion: Number(row.sheet_synced_version),
    sheetSyncLeaseUntil: d(row.sheet_sync_lease_until),
    sheetSyncFailures: Number(row.sheet_sync_failures),
    sheetSyncNextAttemptAt: d(row.sheet_sync_next_attempt_at),
    emailStatus: row.email_status as EmailStatus,
    emailAttempts: Number(row.email_attempts),
    emailLastAttemptAt: d(row.email_last_attempt_at),
    emailNextAttemptAt: d(row.email_next_attempt_at),
    emailLeaseUntil: d(row.email_lease_until),
    emailProviderMessageId: (row.email_provider_message_id as string | null) ?? null,
    emailAcceptedAt: d(row.email_accepted_at),
    emailDeliveredAt: d(row.email_delivered_at),
    emailLastError: (row.email_last_error as string | null) ?? null,
  };
}

/** Short, content-free error text safe to store and log. */
export function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

export function createStore(sql: SqlExecutor) {
  async function one(text: string, params: unknown[]): Promise<ReportRecord | null> {
    const rows = await sql(text, params);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async function event(reportId: string, at: Date, name: string, detail?: string) {
    await sql(
      'insert into report_email_events (report_id, at, event, detail) values ($1, $2, $3, $4)',
      [reportId, at.toISOString(), name, detail ?? null],
    );
  }

  return {
    /** Inserts the finalized report once per submission id. `created` is false on a retry. */
    async insertReport(input: {
      report: FinalReport;
      email: string;
      fingerprint: string;
      emailStatus: 'pending' | 'disabled';
      sheetRowNumber?: number | null;
      now: Date;
    }): Promise<{ record: ReportRecord; created: boolean }> {
      const { report } = input;
      const inserted = await sql(
        `insert into reports (id, submission_id, fingerprint, email, report, content_hash,
           narrative_source, ai_failure_reason, created_at, email_status, email_updated_at,
           sheet_row_number, sheet_tracking_expected)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $9, $11, true)
         on conflict (submission_id) do nothing
         returning *`,
        [
          report.reportId,
          report.submissionId,
          input.fingerprint,
          input.email,
          JSON.stringify(report),
          reportHash(report),
          report.narrativeSource,
          report.aiFailureReason,
          input.now.toISOString(),
          input.emailStatus,
          input.sheetRowNumber ?? null,
        ],
      );
      if (inserted[0]) return { record: toRecord(inserted[0]), created: true };
      const existing = await one('select * from reports where submission_id = $1', [
        report.submissionId,
      ]);
      if (!existing) throw new Error('Report insert conflict without an existing row');
      return { record: existing, created: false };
    },

    getById: (id: string) => one('select * from reports where id = $1', [id]),

    getByProviderMessageId: (messageId: string) =>
      one('select * from reports where email_provider_message_id = $1', [messageId]),

    getBySubmissionId: (submissionId: string) =>
      one('select * from reports where submission_id = $1', [submissionId]),

    /** Link a pre-existing report to its verified response row, without changing its content. */
    async linkSheetRow(id: string, rowNumber: number): Promise<ReportRecord> {
      const record = await one(
        `update reports set sheet_row_number = $2, sheet_tracking_expected = true,
           tracking_version = tracking_version + 1
         where id = $1 and sheet_row_number is null returning *`,
        [id, rowNumber],
      );
      if (record) return record;
      const existing = await one('select * from reports where id = $1', [id]);
      if (!existing) throw new Error('Report not found');
      // A row number may have moved since a previous request. The identity scan in
      // syncReportTracking verifies and repairs this hint; it must not fail report creation.
      return existing;
    },

    /** Called only after the report marker and answer fingerprint verify at the new location. */
    async relinkSheetRow(
      id: string,
      previousRow: number | null,
      rowNumber: number,
    ): Promise<ReportRecord> {
      const record = await one(
        `update reports set sheet_row_number = $3, sheet_tracking_expected = true,
           tracking_version = tracking_version + 1
         where id = $1 and sheet_row_number is not distinct from $2 returning *`,
        [id, previousRow, rowNumber],
      );
      if (!record) throw new Error('Spreadsheet row link changed concurrently');
      return record;
    },

    async markPdfDownloaded(id: string, at: Date): Promise<void> {
      await sql(
        `update reports set pdf_downloaded_at = $2, tracking_version = tracking_version + 1
         where id = $1 and pdf_downloaded_at is null`,
        [id, at.toISOString()],
      );
    },

    async markSheetSynced(id: string, version: number): Promise<boolean> {
      const rows = await sql(
        `update reports set sheet_synced_version = $2,
           sheet_sync_failures = 0, sheet_sync_next_attempt_at = null
         where id = $1 and tracking_version = $2 and sheet_synced_version < $2
         returning id`,
        [id, version],
      );
      return rows.length > 0;
    },

    /** A lease serializes Sheets writes for one report across serverless instances. */
    claimSheetSync: (id: string, now: Date, leaseMs = 90_000) =>
      one(
        `update reports set sheet_sync_lease_until = $2
         where id = $1 and (sheet_tracking_expected or sheet_row_number is not null)
           and tracking_version > sheet_synced_version
           and (sheet_sync_lease_until is null or sheet_sync_lease_until < $3)
           and (sheet_sync_next_attempt_at is null or sheet_sync_next_attempt_at <= $3)
         returning *`,
        [id, new Date(now.getTime() + leaseMs).toISOString(), now.toISOString()],
      ),

    async releaseSheetSync(id: string, leaseUntil: Date): Promise<void> {
      await sql(
        'update reports set sheet_sync_lease_until = null where id = $1 and sheet_sync_lease_until = $2',
        [id, leaseUntil.toISOString()],
      );
    },

    async deferSheetSync(id: string, leaseUntil: Date, now: Date): Promise<void> {
      await sql(
        `update reports set sheet_sync_failures = sheet_sync_failures + 1,
           sheet_sync_next_attempt_at = $3::timestamptz +
             (least(86400, 60 * power(2, least(sheet_sync_failures, 10))) * interval '1 second')
         where id = $1 and sheet_sync_lease_until = $2`,
        [id, leaseUntil.toISOString(), now.toISOString()],
      );
    },

    async listUnsynced(limit: number): Promise<string[]> {
      const rows = await sql(
        `select id from reports where (sheet_tracking_expected or sheet_row_number is not null)
           and tracking_version > sheet_synced_version
           and (sheet_sync_lease_until is null or sheet_sync_lease_until < now())
           and (sheet_sync_next_attempt_at is null or sheet_sync_next_attempt_at <= now())
         order by (sheet_sync_failures > 0) asc,
           coalesce(sheet_sync_next_attempt_at, created_at) asc, created_at asc limit $1`,
        [limit],
      );
      return rows.map((row) => String(row.id));
    },

    /** Cutover only: move a reviewed, never-attempted disabled report into the normal queue. */
    async requeueDisabled(
      id: string,
      since: Date,
      until: Date,
      now: Date,
      maxAgeMs: number,
    ): Promise<boolean> {
      const rows = await sql(
        `update reports set email_status = 'pending', email_next_attempt_at = $4,
           email_updated_at = $4, tracking_version = tracking_version + 1
         where id = $1 and email_status = 'disabled' and email_attempts = 0
           and email_accepted_at is null and email_provider_message_id is null
           and sheet_row_number is not null
           and created_at >= $2 and created_at <= $3 and created_at >= $5
         returning id`,
        [
          id,
          since.toISOString(),
          until.toISOString(),
          now.toISOString(),
          new Date(now.getTime() - maxAgeMs).toISOString(),
        ],
      );
      if (rows.length) await event(id, now, 'requeued', 'reviewed-cutover');
      return rows.length > 0;
    },

    async acquireSheetAppend(
      fingerprint: string,
      token: string,
      now: Date,
      leaseMs = 90_000,
    ): Promise<boolean> {
      const rows = await sql(
        `insert into sheet_append_leases (fingerprint, token, expires_at)
         values ($1, $2, $3)
         on conflict (fingerprint) do update set token = $2, expires_at = $3
           where sheet_append_leases.expires_at < $4
         returning token`,
        [fingerprint, token, new Date(now.getTime() + leaseMs).toISOString(), now.toISOString()],
      );
      return rows.length === 1;
    },

    async releaseSheetAppend(fingerprint: string, token: string): Promise<void> {
      await sql('delete from sheet_append_leases where fingerprint = $1 and token = $2', [
        fingerprint,
        token,
      ]);
    },

    /** Same person + same answers recently, even under a different client-side submission id. */
    findRecentByFingerprint: (fingerprint: string, since: Date) =>
      one(
        'select * from reports where fingerprint = $1 and created_at >= $2 order by created_at desc limit 1',
        [fingerprint, since.toISOString()],
      ),

    /**
     * Atomically claims the right to send. Only one caller can win per attempt: the UPDATE only
     * matches a row that is pending/failed and due, or whose previous 'sending' lease expired.
     */
    async claimEmail(id: string, now: Date, opts: ClaimOptions): Promise<ReportRecord | null> {
      const claimed = await one(
        `update reports set
           email_status = 'sending',
           email_attempts = email_attempts + 1,
           email_last_attempt_at = $2,
           email_lease_until = $3,
           email_updated_at = $2,
           tracking_version = tracking_version + 1
         where id = $1
           and email_attempts < $4
           and created_at >= $5
           and (
             (email_status in ('pending', 'failed') and (email_next_attempt_at is null or email_next_attempt_at <= $2))
             or (email_status = 'sending' and email_lease_until < $2)
           )
         returning *`,
        [
          id,
          now.toISOString(),
          new Date(now.getTime() + opts.leaseMs).toISOString(),
          opts.maxAttempts,
          new Date(now.getTime() - opts.maxAgeMs).toISOString(),
        ],
      );
      if (claimed) await event(id, now, 'attempt', `attempt ${claimed.emailAttempts}`);
      return claimed;
    },

    async markAccepted(id: string, messageId: string | null, now: Date) {
      await sql(
        `update reports set email_status = 'accepted', email_provider_message_id = $2,
           email_accepted_at = $3, email_lease_until = null, email_next_attempt_at = null,
           email_last_error = null, email_updated_at = $3
           , tracking_version = tracking_version + 1
         where id = $1 and email_status = 'sending'`,
        [id, messageId, now.toISOString()],
      );
      await event(id, now, 'accepted', messageId ?? undefined);
    },

    async markFailed(id: string, error: string, nextAttemptAt: Date | null, now: Date) {
      await sql(
        `update reports set email_status = $2, email_next_attempt_at = $3, email_lease_until = null,
           email_last_error = $4, email_updated_at = $5,
           tracking_version = tracking_version + 1
         where id = $1 and email_status = 'sending'`,
        [
          id,
          nextAttemptAt ? 'failed' : 'failed_final',
          nextAttemptAt?.toISOString() ?? null,
          error,
          now.toISOString(),
        ],
      );
      await event(id, now, nextAttemptAt ? 'failed' : 'failed_final', error);
    },

    /**
     * Applies a provider webhook event. Precedence: bounced/complained are never overwritten by
     * 'delivered'; 'delivered' is only applied to an accepted message.
     * Returns false when no report has that provider message id (the webhook should be retried).
     */
    async applyProviderEvent(messageId: string, name: ProviderEvent, at: Date): Promise<boolean> {
      const rows = await sql(
        'select id, email_status from reports where email_provider_message_id = $1',
        [messageId],
      );
      const row = rows[0];
      if (!row) return false;
      const id = String(row.id);
      const status = row.email_status as EmailStatus;
      if (name === 'delivered' && (status === 'accepted' || status === 'sending')) {
        await sql(
          `update reports set email_status = 'delivered', email_delivered_at = $2,
             email_updated_at = $2, tracking_version = tracking_version + 1 where id = $1`,
          [id, at.toISOString()],
        );
      } else if ((name === 'bounced' || name === 'complained') && status !== 'complained') {
        await sql(
          `update reports set email_status = $2, email_last_error = $3, email_updated_at = $4,
             tracking_version = tracking_version + 1 where id = $1`,
          [id, name, `provider:${name}`, at.toISOString()],
        );
      }
      await event(id, at, `provider:${name}`);
      return true;
    },

    /** Reports whose email still needs work: never sent, failed and due, or a stuck 'sending'. */
    async listDueForEmail(now: Date, limit: number, opts: ClaimOptions): Promise<string[]> {
      const rows = await sql(
        `select id from reports
         where email_attempts < $2 and created_at >= $3
           and (
             (email_status in ('pending', 'failed') and (email_next_attempt_at is null or email_next_attempt_at <= $1))
             or (email_status = 'sending' and email_lease_until < $1)
           )
         order by created_at asc limit $4`,
        [
          now.toISOString(),
          opts.maxAttempts,
          new Date(now.getTime() - opts.maxAgeMs).toISOString(),
          limit,
        ],
      );
      return rows.map((r) => String(r.id));
    },

    /**
     * Moves reports that can never be retried to the terminal 'failed_final' so they stop showing
     * as "sending": older than the retry window, or out of attempts (including a last attempt whose
     * worker crashed, i.e. an expired 'sending' lease). Active leases are never touched.
     * Returns the ids it finalized.
     */
    async expireStale(now: Date, opts: ClaimOptions): Promise<string[]> {
      const rows = await sql(
        `update reports set
           email_status = 'failed_final',
           email_lease_until = null,
           email_next_attempt_at = null,
           email_last_error = case when email_attempts >= $3 then 'attempts-exhausted' else 'expired' end,
           email_updated_at = $1,
           tracking_version = tracking_version + 1
         where (
           (email_status in ('pending', 'failed') and (created_at < $2 or email_attempts >= $3))
           or (email_status = 'sending' and email_lease_until < $1 and (created_at < $2 or email_attempts >= $3))
         )
         returning id, email_last_error`,
        [
          now.toISOString(),
          new Date(now.getTime() - opts.maxAgeMs).toISOString(),
          opts.maxAttempts,
        ],
      );
      for (const row of rows)
        await event(String(row.id), now, 'failed_final', String(row.email_last_error));
      return rows.map((r) => String(r.id));
    },

    /**
     * What happened in the attempts BEFORE the current one, from the audit trail (no new columns).
     * `ambiguous` = some earlier attempt may have reached the provider without us learning the
     * outcome (no result recorded, or a timeout / network error / in-flight conflict).
     */
    async attemptHistory(id: string): Promise<{ firstAttemptAt: Date | null; ambiguous: boolean }> {
      const rows = await sql(
        `select id, at, event, detail from report_email_events
         where report_id = $1 and event in ('attempt', 'accepted', 'failed', 'failed_final')
         order by id asc`,
        [id],
      );
      // The newest 'attempt' row is the attempt that is running now.
      let last = -1;
      rows.forEach((row, i) => {
        if (row.event === 'attempt') last = i;
      });
      const previous = last >= 0 ? rows.slice(0, last) : rows;
      let firstAttemptAt: Date | null = null;
      let ambiguous = false;
      let open = false; // an attempt with no recorded outcome yet
      for (const row of previous) {
        if (row.event === 'attempt') {
          firstAttemptAt ??= d(row.at);
          if (open) ambiguous = true;
          open = true;
        } else {
          open = false;
          if (row.event === 'failed' && AMBIGUOUS_ERRORS.has(String(row.detail))) ambiguous = true;
        }
      }
      if (open) ambiguous = true;
      return { firstAttemptAt, ambiguous };
    },

    /** Fixed-window counter shared across serverless instances. Returns the count in the window. */
    async hit(key: string, windowSeconds: number, now: Date): Promise<number> {
      const rows = await sql(
        `insert into rate_limits (key, window_start, count) values ($1, $2, 1)
         on conflict (key) do update set
           window_start = case when rate_limits.window_start <= $2::timestamptz - make_interval(secs => $3::int)
                               then $2::timestamptz else rate_limits.window_start end,
           count = case when rate_limits.window_start <= $2::timestamptz - make_interval(secs => $3::int)
                        then 1 else rate_limits.count + 1 end
         returning count`,
        [key, now.toISOString(), windowSeconds],
      );
      return Number(rows[0]?.count ?? 0);
    },

    async purgeRateLimits(olderThan: Date) {
      await sql('delete from rate_limits where window_start < $1', [olderThan.toISOString()]);
    },
  };
}

export type ReportStore = ReturnType<typeof createStore>;
