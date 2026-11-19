-- Quirón Shield: finalized reports + email delivery state (Neon Postgres).
-- Questionnaire responses remain in Google Sheets; only a row reference is stored here.
-- Idempotent: safe to run repeatedly (npm run db:migrate).

create table if not exists reports (
  id                         uuid primary key,
  submission_id              uuid not null unique,
  fingerprint                text not null,
  email                      text not null,
  report                     jsonb not null,
  content_hash               text not null,
  narrative_source           text not null check (narrative_source in ('ai', 'template')),
  ai_failure_reason          text,
  created_at                 timestamptz not null,
  sheet_row_number           int,
  sheet_tracking_expected    boolean not null default false,
  pdf_downloaded_at          timestamptz,
  tracking_version           bigint not null default 1,
  sheet_synced_version       bigint not null default 0,
  sheet_sync_lease_until     timestamptz,
  sheet_sync_failures        int not null default 0,
  sheet_sync_next_attempt_at timestamptz,

  email_status               text not null check (email_status in
                               ('disabled', 'pending', 'sending', 'accepted', 'delivered',
                                'failed', 'failed_final', 'bounced', 'complained')),
  email_attempts             int  not null default 0,
  email_last_attempt_at      timestamptz,
  email_next_attempt_at      timestamptz,
  email_lease_until          timestamptz,
  email_provider_message_id  text,
  email_accepted_at          timestamptz,
  email_delivered_at         timestamptz,
  email_last_error           text,
  email_updated_at           timestamptz not null
);

-- Safe for existing installations. Historical reports have no linked Sheet row until reviewed.
alter table reports add column if not exists sheet_row_number int;
alter table reports add column if not exists sheet_tracking_expected boolean not null default false;
alter table reports add column if not exists pdf_downloaded_at timestamptz;
alter table reports add column if not exists tracking_version bigint not null default 1;
alter table reports add column if not exists sheet_synced_version bigint not null default 0;
alter table reports add column if not exists sheet_sync_lease_until timestamptz;
alter table reports add column if not exists sheet_sync_failures int not null default 0;
alter table reports add column if not exists sheet_sync_next_attempt_at timestamptz;
-- Row numbers are hints. Sorting/inserting rows can reuse a number for a different report.
drop index if exists reports_sheet_row_idx;
create index if not exists reports_sheet_sync_due_idx
  on reports (sheet_sync_next_attempt_at, created_at)
  where (sheet_tracking_expected or sheet_row_number is not null)
    and tracking_version > sheet_synced_version;

create index if not exists reports_fingerprint_idx on reports (fingerprint, created_at desc);
create index if not exists reports_email_due_idx on reports (email_status, email_next_attempt_at);
create unique index if not exists reports_provider_message_idx
  on reports (email_provider_message_id) where email_provider_message_id is not null;

-- Append-only audit trail (attempts, provider acceptance, webhook events). No report content.
create table if not exists report_email_events (
  id         bigserial primary key,
  report_id  uuid not null references reports (id),
  at         timestamptz not null,
  event      text not null,
  detail     text
);
create index if not exists report_email_events_report_idx on report_email_events (report_id, at);

-- Shared (cross-instance) rate limiting counters.
create table if not exists rate_limits (
  key          text primary key,
  window_start timestamptz not null,
  count        int not null
);

-- Prevent two serverless requests from appending the same response row concurrently.
create table if not exists sheet_append_leases (
  fingerprint text primary key,
  token uuid not null,
  expires_at timestamptz not null
);
