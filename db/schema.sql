-- Quirón Shield: finalized reports + email delivery state (Neon Postgres).
-- Separate from the questionnaire responses, which stay in Google Sheets (A:X, untouched).
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
