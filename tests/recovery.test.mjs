import test from 'node:test';
import assert from 'node:assert/strict';
import { MailError } from '../src/lib/email.ts';
import { trackingAttemptBudget, trackingDeadline } from '../src/lib/cron-budget.ts';
import {
  DEFAULT_CONFIG,
  createReport,
  deliverReportEmail,
  processDueEmails,
  publicEmailStatus,
} from '../src/lib/pipeline.ts';
import { harness, submission } from './helpers/pipeline-harness.mjs';

/**
 * Vercel Hobby runs the recovery cron once a day. These tests drive an explicit clock around a
 * daily sweep at 12:00 UTC (06:00 Mexico City) and check what each report ends up as.
 */
const DAY = 86_400_000;
const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 10, 18); // 2026-11-18 00:00 UTC = day 0
const at = (day, hh, mm = 0, ss = 0) => BASE + day * DAY + hh * HOUR + mm * 60_000 + ss * 1000;
const sweepAt = (day, hh = 12, mm = 0) => at(day, hh, mm);

const fails =
  (message, retryable = true, times = 1) =>
  async (_m, n) => {
    if (n < times) throw new MailError(message, retryable);
  };

async function setup(opts) {
  const h = harness(opts);
  const built = await h.build();
  return { h, ...built };
}

async function submitAt(ctx, time, n = 0) {
  ctx.h.clock.t = time;
  const { record } = await createReport(ctx.deps, submission({ email: `cliente${n}@example.com` }));
  return record;
}

test('config: 47 h retry window, kept below the cron+idempotency limits', () => {
  assert.equal(DEFAULT_CONFIG.maxAgeMs, 47 * HOUR);
  assert.ok(DEFAULT_CONFIG.idempotencyWindowMs < 24 * HOUR);
});

// A report created at any time of day, whose first send failed, is reached by a daily sweep.
for (const [label, hh, mm] of [
  ['00:00', 0, 0],
  ['06:00', 6, 0],
  ['11:59 (a minute before the sweep)', 11, 59],
  ['12:01 (a minute after the sweep)', 12, 1],
  ['18:00', 18, 0],
  ['23:59', 23, 59],
]) {
  test(`daily sweep recovers a report created at ${label} UTC whose first send failed`, async () => {
    const ctx = await setup({ mailerBehavior: fails('resend-http-503', true, 1) });
    const record = await submitAt(ctx, at(0, hh, mm));
    assert.equal((await deliverReportEmail(ctx.deps, record.id)).outcome, 'failed');

    // Next 12:00 UTC sweep after creation (day 0 if still ahead, otherwise day 1).
    const next = at(0, hh, mm) < sweepAt(0) ? sweepAt(0) : sweepAt(1);
    assert.ok(next - at(0, hh, mm) < 47 * HOUR);
    ctx.h.clock.t = next;
    const summary = await processDueEmails(ctx.deps);
    assert.equal(summary.accepted, 1, JSON.stringify(summary));
    assert.equal(ctx.h.sent.length, 1);
    assert.equal(
      publicEmailStatus(await ctx.store.getById(record.id), ctx.deps.config, new Date(next)).state,
      'sent',
    );
  });
}

test('a late cron run (12:59, or hours late) inside the window still recovers the report', async () => {
  const ctx = await setup({ mailerBehavior: fails('resend-http-503', true, 1) });
  const record = await submitAt(ctx, at(0, 12, 1));
  await deliverReportEmail(ctx.deps, record.id);
  ctx.h.clock.t = at(2, 11, 0); // 46 h 59 min after creation: the day-1 run was skipped entirely
  assert.equal((await processDueEmails(ctx.deps)).accepted, 1);
  assert.equal(ctx.h.sent.length, 1);
});

test('a skipped cron run can cost the report: past 47 h it is finalized as failed and never sent', async () => {
  const ctx = await setup({ mailerBehavior: fails('resend-http-503', true, 1) });
  const record = await submitAt(ctx, at(0, 12, 1));
  await deliverReportEmail(ctx.deps, record.id);
  ctx.h.clock.t = sweepAt(2); // 47 h 59 min later (the day-1 run never happened)
  const summary = await processDueEmails(ctx.deps);
  assert.deepEqual(summary, { expired: 1, due: 0, accepted: 0, failed: 0, skipped: 0 });
  const after = await ctx.store.getById(record.id);
  assert.equal(after.emailStatus, 'failed_final');
  assert.equal(after.emailLastError, 'expired');
  assert.equal(ctx.h.sent.length, 0);
  assert.equal(publicEmailStatus(after, ctx.deps.config, new Date(sweepAt(2))).state, 'failed');
});

test('expiry boundary: 46 h 59 min is still retryable, 47 h 01 min is not', async () => {
  const ctx = await setup();
  const record = await submitAt(ctx, at(0, 10, 0)); // never attempted: the instance died before after()
  const status = (t) => publicEmailStatus(record, ctx.deps.config, new Date(t)).state;
  assert.equal(status(at(0, 10, 0) + 46 * HOUR + 59 * 60_000), 'sending');
  assert.equal(
    status(at(0, 10, 0) + 47 * HOUR + 60_000),
    'failed',
    'terminal as soon as it is read',
  );

  // ...even though the database row has not been finalized yet, and nothing is ever sent for it.
  ctx.h.clock.t = at(0, 10, 0) + 47 * HOUR + 60_000;
  assert.equal((await ctx.store.getById(record.id)).emailStatus, 'pending');
  assert.equal((await deliverReportEmail(ctx.deps, record.id)).outcome, 'not-claimed');
  assert.equal((await processDueEmails(ctx.deps)).expired, 1);
  assert.equal((await ctx.store.getById(record.id)).emailStatus, 'failed_final');
  assert.equal(ctx.h.sent.length, 0);
});

test('a failed attempt that will be retried reads as "retrying", never "sending" or an error', async () => {
  const ctx = await setup({ mailerBehavior: fails('resend-http-503', true, 1) });
  const record = await submitAt(ctx, at(0, 15, 0));
  assert.equal(publicEmailStatus(record, ctx.deps.config, new Date(at(0, 15, 0))).state, 'sending');
  await deliverReportEmail(ctx.deps, record.id);
  const failed = await ctx.store.getById(record.id);
  assert.equal(
    publicEmailStatus(failed, ctx.deps.config, new Date(at(0, 16, 0))).state,
    'retrying',
  );
});

test('exhausted attempts are terminal immediately', async () => {
  const ctx = await setup({ mailerBehavior: fails('resend-http-503', true, 99) });
  ctx.deps.config = { ...ctx.deps.config, maxAttempts: 2 };
  const record = await submitAt(ctx, at(0, 8, 0));
  await deliverReportEmail(ctx.deps, record.id);
  ctx.h.clock.t = sweepAt(0);
  const summary = await processDueEmails(ctx.deps);
  assert.equal(summary.failed, 1);
  const after = await ctx.store.getById(record.id);
  assert.equal(after.emailStatus, 'failed_final');
  assert.equal(after.emailAttempts, 2);
  assert.equal(publicEmailStatus(after, ctx.deps.config, new Date(sweepAt(0))).state, 'failed');
  ctx.h.clock.t = sweepAt(1);
  assert.deepEqual(await processDueEmails(ctx.deps), {
    expired: 0,
    due: 0,
    accepted: 0,
    failed: 0,
    skipped: 0,
  });
  assert.equal(ctx.h.sent.length, 0);
});

test('a worker that crashed on its LAST attempt is finalized by the next sweep (not stuck "sending")', async () => {
  const ctx = await setup({ mailerBehavior: fails('resend-http-503', true, 1) });
  ctx.deps.config = { ...ctx.deps.config, maxAttempts: 2 };
  const record = await submitAt(ctx, at(0, 8, 0));
  await deliverReportEmail(ctx.deps, record.id); // attempt 1: 503
  const realMark = ctx.store.markAccepted;
  ctx.store.markAccepted = async () => {
    throw new Error('connection lost');
  };
  ctx.h.clock.t = sweepAt(0);
  await assert.rejects(() => processDueEmails(ctx.deps), /connection lost/); // attempt 2 crashes
  ctx.store.markAccepted = realMark;
  assert.equal((await ctx.store.getById(record.id)).emailStatus, 'sending');

  ctx.h.clock.t = sweepAt(1);
  const summary = await processDueEmails(ctx.deps);
  assert.equal(summary.expired, 1);
  const after = await ctx.store.getById(record.id);
  assert.equal(after.emailStatus, 'failed_final');
  assert.equal(after.emailLastError, 'attempts-exhausted');
  assert.equal(publicEmailStatus(after, ctx.deps.config, new Date(sweepAt(1))).state, 'failed');
});

test('an in-progress send (active lease) is never expired or shown as failed', async () => {
  const ctx = await setup();
  const record = await submitAt(ctx, at(0, 9, 0));
  const claimed = await ctx.store.claimEmail(record.id, new Date(at(0, 9, 0)), {
    maxAttempts: 5,
    leaseMs: 5 * 60_000,
    maxAgeMs: 47 * HOUR,
  });
  assert.equal(claimed.emailStatus, 'sending');
  assert.deepEqual(
    await ctx.store.expireStale(new Date(at(0, 9, 1)), { maxAttempts: 1, leaseMs: 0, maxAgeMs: 1 }),
    [],
  );
  assert.equal(publicEmailStatus(claimed, ctx.deps.config, new Date(at(0, 9, 1))).state, 'sending');
});

/* ---- idempotency: Resend forgets a key after 24 h ---- */

test('unknown outcome (timeout) + retry past the idempotency window is refused, not re-sent', async () => {
  const ctx = await setup({ mailerBehavior: fails('resend-timeout', true, 1) });
  const record = await submitAt(ctx, at(0, 10, 0));
  await deliverReportEmail(ctx.deps, record.id); // timed out: the provider may have accepted it
  assert.equal(ctx.h.sent.length, 0);

  ctx.h.clock.t = at(1, 12, 0); // 26 h later: the key has expired at the provider
  const summary = await processDueEmails(ctx.deps);
  assert.equal(summary.failed, 1);
  assert.equal(summary.accepted, 0);
  assert.equal(ctx.h.sent.length, 0, 'no second copy can be sent');
  const after = await ctx.store.getById(record.id);
  assert.equal(after.emailStatus, 'failed_final');
  assert.equal(after.emailLastError, 'unknown-outcome-after-idempotency-window');
  assert.equal(publicEmailStatus(after, ctx.deps.config, new Date(at(1, 12, 0))).state, 'failed');
});

test('unknown outcome + retry INSIDE the idempotency window is sent with the same key', async () => {
  const ctx = await setup({ mailerBehavior: fails('resend-timeout', true, 1) });
  const record = await submitAt(ctx, at(0, 10, 0));
  await deliverReportEmail(ctx.deps, record.id);
  ctx.h.clock.t = at(0, 12, 0); // 2 h later
  assert.equal((await processDueEmails(ctx.deps)).accepted, 1);
  assert.equal(ctx.h.sent.length, 1);
  assert.equal(ctx.h.sent[0].idempotencyKey, `report-email/${record.id}`);
});

test('a definitive provider rejection can be retried after the idempotency window', async () => {
  const ctx = await setup({ mailerBehavior: fails('resend-http-503', true, 1) });
  const record = await submitAt(ctx, at(0, 10, 0));
  await deliverReportEmail(ctx.deps, record.id); // HTTP 503: the provider did NOT accept it
  ctx.h.clock.t = at(1, 12, 0); // 26 h later
  assert.equal((await processDueEmails(ctx.deps)).accepted, 1);
  assert.equal(ctx.h.sent.length, 1);
});

test('accepted-but-unrecorded send (crash) is not repeated past the idempotency window', async () => {
  const ctx = await setup();
  const record = await submitAt(ctx, at(0, 10, 0));
  const realMark = ctx.store.markAccepted;
  ctx.store.markAccepted = async () => {
    throw new Error('connection lost');
  };
  await assert.rejects(() => deliverReportEmail(ctx.deps, record.id), /connection lost/);
  ctx.store.markAccepted = realMark;
  assert.equal(ctx.h.sent.length, 1, 'the provider did receive it');

  ctx.h.clock.t = at(1, 12, 0); // 26 h later: lease long expired, key expired too
  const summary = await processDueEmails(ctx.deps);
  assert.equal(ctx.h.sent.length, 1, 'still exactly one email');
  assert.equal(summary.accepted, 0);
  assert.equal((await ctx.store.getById(record.id)).emailStatus, 'failed_final');
});

test('the same crash recovered inside the window is re-sent safely (provider de-duplicates by key)', async () => {
  const ctx = await setup();
  const record = await submitAt(ctx, at(0, 10, 0));
  const realMark = ctx.store.markAccepted;
  ctx.store.markAccepted = async () => {
    throw new Error('connection lost');
  };
  await assert.rejects(() => deliverReportEmail(ctx.deps, record.id), /connection lost/);
  ctx.store.markAccepted = realMark;
  ctx.h.clock.t = at(0, 10, 30);
  assert.equal((await processDueEmails(ctx.deps)).accepted, 1);
  assert.equal(new Set(ctx.h.sent.map((m) => m.idempotencyKey)).size, 1);
  assert.equal((await ctx.store.getById(record.id)).emailStatus, 'accepted');
});

/* ---- a daily sweep must not leave a backlog for tomorrow ---- */

test('one sweep drains a backlog larger than a batch', async () => {
  const ctx = await setup();
  for (let i = 0; i < 60; i += 1) await submitAt(ctx, at(0, 9, 0), i);
  ctx.h.clock.t = sweepAt(0);
  const summary = await processDueEmails(ctx.deps);
  assert.equal(summary.accepted, 60);
  assert.equal(ctx.h.sent.length, 60);
  assert.deepEqual(await processDueEmails(ctx.deps), {
    expired: 0,
    due: 0,
    accepted: 0,
    failed: 0,
    skipped: 0,
  });
});

test('cron sees due reports beyond an entire skipped batch', async () => {
  const ctx = await setup();
  for (let n = 0; n < 30; n++) await submitAt(ctx, at(0, 10), n);
  ctx.deps.mailer = null; // no claim is possible; each row remains due
  ctx.h.clock.t = sweepAt(0);
  const summary = await processDueEmails(ctx.deps);
  assert.equal(summary.skipped, 30);
  assert.equal(summary.due, 30);
});

test('cron email budget stops before another send and defers Sheet projection', async () => {
  const ctx = await setup();
  for (let n = 0; n < 3; n++) await submitAt(ctx, at(0, 10), n);
  let elapsed = 0;
  let sends = 0;
  let sheetCalls = 0;
  ctx.deps.mailer = {
    async send() {
      elapsed += 20;
      sends += 1;
      return { messageId: `em_budget_${sends}` };
    },
  };
  ctx.deps.syncTracking = async () => {
    sheetCalls += 1;
    return true;
  };
  ctx.h.clock.t = sweepAt(0);
  const summary = await processDueEmails(ctx.deps, { budgetMs: 25, wallNow: () => elapsed });
  assert.equal(summary.accepted, 2);
  assert.equal(sends, 2);
  assert.equal(sheetCalls, 0, 'Sheet work belongs to the separate cron phase');
  const remaining = await ctx.store.listDueForEmail(new Date(ctx.h.clock.t), 10, {
    maxAttempts: ctx.deps.config.maxAttempts,
    leaseMs: ctx.deps.config.leaseMs,
    maxAgeMs: ctx.deps.config.maxAgeMs,
  });
  assert.equal(remaining.length, 1);
});

test('tracking deadline preserves cron cleanup reserve after slow email work', () => {
  const deadline = trackingDeadline(0, 48_000);
  assert.equal(deadline, 52_000);
  assert.equal(trackingAttemptBudget(deadline, 48_000), 4_000);
  assert.equal(trackingAttemptBudget(deadline, 53_000), 0);
});
