import test from 'node:test';
import assert from 'node:assert/strict';
import { MailError } from '../src/lib/email.ts';
import {
  DEFAULT_CONFIG,
  GenerationInProgressError,
  createReport,
  deliverReportEmail,
  RecipientLimitError,
  SubmissionConflictError,
  maskEmail,
  parseEmailAllowlist,
  processDueEmails,
  recipientAllowed,
  publicEmailStatus,
} from '../src/lib/pipeline.ts';
import { fallbackNarrative } from '../src/lib/report.ts';
import { extractText, getDocumentProxy } from 'unpdf';
import { renderReportPdf } from '../src/lib/pdf/ReportPdf.tsx';
import { buildReportContent } from '../src/lib/report-content.ts';
import { answersOf } from './helpers/fixtures.mjs';
import { harness, submission } from './helpers/pipeline-harness.mjs';

test('success: one report, one email to the stored address with the PDF attached', async () => {
  const h = harness();
  const { store, deps } = await h.build();
  const { record, created } = await createReport(deps, submission());
  assert.equal(created, true);
  assert.equal(record.email, 'ana.perez@example.com');
  assert.equal(record.report.narrativeSource, 'ai');
  assert.equal(record.emailStatus, 'pending');

  const result = await deliverReportEmail(deps, record.id);
  assert.equal(result.outcome, 'accepted');
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].to, 'ana.perez@example.com');
  assert.equal(h.sent[0].attachments[0].content.toString(), '%PDF-fake');
  assert.match(h.sent[0].attachments[0].filename, /^Diagnostico-Patrimonial-Quiron-Ana\.pdf$/);
  // The email is a concise summary: the long AI-written text lives in the attached PDF only.
  assert.ok(!h.sent[0].html.includes('Texto redactado por Claude.'));
  const after = await store.getById(record.id);
  assert.equal(after.emailStatus, 'accepted');
  assert.equal(after.emailProviderMessageId, 'em_1');
  assert.ok(after.emailAcceptedAt);
  assert.equal(after.emailDeliveredAt, null, 'acceptance is not delivery');
  assert.deepEqual(publicEmailStatus(after), { state: 'sent', to: 'a••••••••@example.com' });
});

test('the stored report is returned unchanged without calling Claude again', async () => {
  const h = harness();
  const { deps } = await h.build();
  const s = submission();
  const first = await createReport(deps, s);
  const again = await createReport(deps, s);
  assert.equal(again.created, false);
  assert.deepEqual(again.record.report, first.record.report);
  assert.equal(h.narrativeCalls.length, 1);
});

test('a retry links its existing Neon report to the confirmed Sheet row', async () => {
  const h = harness({ emailEnabled: false });
  const { deps } = await h.build();
  const s = submission();
  const first = await createReport(deps, s);
  assert.equal(first.record.sheetRowNumber, null);
  const retry = await createReport(deps, s, 22);
  assert.equal(retry.created, false);
  assert.equal(retry.record.sheetRowNumber, 22);
  assert.equal(retry.record.id, first.record.id);
  assert.equal(h.narrativeCalls.length, 1);
});

test('a reused submission id with different answers cannot access the stored report', async () => {
  const h = harness({ emailEnabled: false });
  const { deps } = await h.build();
  const s = submission();
  await createReport(deps, s);
  await assert.rejects(
    () => createReport(deps, { ...s, answers: answersOf(['A1']) }),
    SubmissionConflictError,
  );
  assert.equal(h.narrativeCalls.length, 1);
});

test('duplicates: same id, same person+answers with a new id, and concurrent calls make ONE report and ONE email', async () => {
  const h = harness();
  const { store, deps } = await h.build();
  const s = submission();
  const a = await createReport(deps, s);
  const b = await createReport(deps, submission({ email: 'ANA.PEREZ@example.com ' }));
  assert.equal(b.created, false);
  assert.equal(b.record.id, a.record.id);
  const results = await Promise.all([1, 2, 3, 4].map(() => deliverReportEmail(deps, a.record.id)));
  assert.equal(results.filter((r) => r.outcome === 'accepted').length, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.narrativeCalls.length, 1);
  assert.equal((await store.raw('select count(*)::int as n from reports')).rows[0].n, 1);
});

test('a second request for the same person while the first is still generating is told to wait', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = harness({
    narrative: async (model) => {
      await gate;
      return { narrative: fallbackNarrative(model), source: 'template', failureReason: 'timeout' };
    },
  });
  const { deps } = await h.build();
  const first = createReport(deps, submission());
  await new Promise((r) => setTimeout(r, 200));
  await assert.rejects(() => createReport(deps, submission()), GenerationInProgressError);
  release();
  const { record } = await first;
  const retry = await createReport(deps, submission());
  assert.equal(retry.record.id, record.id);
});

test('same person with DIFFERENT answers is a different report', async () => {
  const h = harness();
  const { deps } = await h.build();
  const a = await createReport(deps, submission());
  const b = await createReport(deps, submission({ answers: answersOf(['A1']) }));
  assert.notEqual(a.record.id, b.record.id);
});

test('AI failure: the report is finalized as a labelled template, persisted, and still emailed', async () => {
  const h = harness({
    narrative: async (model) => ({
      narrative: fallbackNarrative(model),
      source: 'template',
      failureReason: 'timeout',
    }),
  });
  const { store, deps } = await h.build();
  const { record } = await createReport(deps, submission());
  assert.equal(record.report.narrativeSource, 'template');
  assert.equal(record.report.aiFailureReason, 'timeout');
  assert.equal((await deliverReportEmail(deps, record.id)).outcome, 'accepted');
  assert.equal((await store.getById(record.id)).report.narrativeSource, 'template');
});

test('provider failure: retryable error is retried later with the SAME idempotency key; success is recorded', async () => {
  const h = harness({
    mailerBehavior: async (_m, n) => {
      if (n === 0) throw new MailError('resend-http-503', true);
    },
  });
  const { store, deps } = await h.build();
  const { record } = await createReport(deps, submission());

  const first = await deliverReportEmail(deps, record.id);
  assert.deepEqual(first, { outcome: 'failed', error: 'resend-http-503', willRetry: true });
  assert.equal((await store.getById(record.id)).emailStatus, 'failed');
  assert.equal(
    publicEmailStatus(await store.getById(record.id)).state,
    'retrying',
    'retry pending: not shown as sending and not shown as failed',
  );

  assert.equal(
    (await deliverReportEmail(deps, record.id)).outcome,
    'not-claimed',
    'backoff not elapsed',
  );
  h.clock.t += 61_000;
  assert.equal((await deliverReportEmail(deps, record.id)).outcome, 'accepted');
  assert.equal(h.sent.length, 1);
  const after = await store.getById(record.id);
  assert.equal(after.emailAttempts, 2);
  assert.equal(after.emailLastError, null);
});

test('provider failure: a permanent error is final, shown as failed, and never retried', async () => {
  const h = harness({
    mailerBehavior: async () => {
      throw new MailError('resend-http-422', false);
    },
  });
  const { store, deps } = await h.build();
  const { record } = await createReport(deps, submission());
  assert.equal((await deliverReportEmail(deps, record.id)).willRetry, false);
  const after = await store.getById(record.id);
  assert.equal(after.emailStatus, 'failed_final');
  assert.equal(publicEmailStatus(after).state, 'failed');
  h.clock.t += 3 * 3_600_000;
  assert.equal((await deliverReportEmail(deps, record.id)).outcome, 'not-claimed');
  assert.deepEqual(await processDueEmails(deps), {
    expired: 0,
    due: 0,
    accepted: 0,
    failed: 0,
    skipped: 0,
  });
});

test('provider failure: attempts are bounded', async () => {
  const h = harness({
    mailerBehavior: async () => {
      throw new MailError('resend-http-500', true);
    },
  });
  const { store, deps } = await h.build();
  const { record } = await createReport(deps, submission());
  for (let i = 0; i < 8; i += 1) {
    await deliverReportEmail(deps, record.id);
    h.clock.t += 61 * 60_000;
  }
  const after = await store.getById(record.id);
  assert.equal(after.emailAttempts, DEFAULT_CONFIG.maxAttempts);
  assert.equal(after.emailStatus, 'failed_final');
});

test('lost provider response: a crashed worker is recovered after the lease and reuses the idempotency key', async () => {
  const h = harness();
  const { store, deps } = await h.build();
  const { record } = await createReport(deps, submission());
  // The provider accepted the message but we crashed before recording it.
  const realMark = store.markAccepted;
  store.markAccepted = async () => {
    throw new Error('connection lost');
  };
  await assert.rejects(() => deliverReportEmail(deps, record.id), /connection lost/);
  store.markAccepted = realMark;
  assert.equal((await store.getById(record.id)).emailStatus, 'sending');
  assert.equal(
    (await deliverReportEmail(deps, record.id)).outcome,
    'not-claimed',
    'lease still held',
  );

  h.clock.t += DEFAULT_CONFIG.leaseMs + 1000;
  assert.equal((await deliverReportEmail(deps, record.id)).outcome, 'accepted');
  const keys = h.sent.map((m) => m.idempotencyKey);
  assert.equal(keys.length, 2);
  assert.equal(
    new Set(keys).size,
    1,
    'both attempts use the same key so the provider de-duplicates',
  );
});

test('PDF render failure is retried like any other delivery failure', async () => {
  const h = harness();
  const { deps } = await h.build();
  let fail = true;
  deps.renderPdf = async () => {
    if (fail) throw new Error('render boom');
    return Buffer.from('%PDF');
  };
  const { record } = await createReport(deps, submission());
  assert.equal((await deliverReportEmail(deps, record.id)).outcome, 'failed');
  assert.equal(h.sent.length, 0, 'never sends an email without its PDF');
  fail = false;
  h.clock.t += 61_000;
  assert.equal((await deliverReportEmail(deps, record.id)).outcome, 'accepted');
});

test('email disabled or no mailer: report works, status is disabled, nothing is ever sent', async () => {
  for (const opts of [{ emailEnabled: false }, { withMailer: false }]) {
    const h = harness(opts);
    const { store, deps } = await h.build();
    const { record } = await createReport(deps, submission());
    assert.equal(record.emailStatus, 'disabled');
    assert.equal((await deliverReportEmail(deps, record.id)).outcome, 'not-claimed');
    assert.deepEqual(await processDueEmails(deps), {
      expired: 0,
      due: 0,
      accepted: 0,
      failed: 0,
      skipped: 0,
    });
    assert.equal(h.sent.length, 0);
    assert.equal(publicEmailStatus(await store.getById(record.id)).state, 'off');
  }
});

test('master switch stops pending sends and cron until deliberately re-enabled', async () => {
  const h = harness();
  const { deps } = await h.build();
  const { record } = await createReport(deps, submission());
  deps.config.emailEnabled = false;
  assert.equal((await deliverReportEmail(deps, record.id)).outcome, 'not-claimed');
  assert.equal((await processDueEmails(deps)).due, 0);
  assert.equal(h.sent.length, 0);
  deps.config.emailEnabled = true;
  assert.equal((await deliverReportEmail(deps, record.id)).outcome, 'accepted');
  assert.equal(h.sent.length, 1);
});

test('processDueEmails recovers reports whose email was never attempted (e.g. instance died)', async () => {
  const h = harness();
  const { deps } = await h.build();
  const a = await createReport(deps, submission());
  const b = await createReport(deps, submission({ email: 'otro@example.com' }));
  assert.deepEqual(await processDueEmails(deps), {
    expired: 0,
    due: 2,
    accepted: 2,
    failed: 0,
    skipped: 0,
  });
  assert.deepEqual(h.sent.map((m) => m.to).sort(), ['ana.perez@example.com', 'otro@example.com']);
  assert.deepEqual(await processDueEmails(deps), {
    expired: 0,
    due: 0,
    accepted: 0,
    failed: 0,
    skipped: 0,
  });
  assert.ok(a.record.id && b.record.id);
});

test('maskEmail hides the local part', () => {
  assert.equal(maskEmail('ab@x.com'), 'a•@x.com');
  assert.equal(maskEmail('a@x.com'), 'a•@x.com');
});

test('a recipient address cannot be used to request unlimited reports', async () => {
  const h = harness();
  const { deps } = await h.build();
  const limit = DEFAULT_CONFIG.maxReportsPerEmailPerDay;
  for (let i = 0; i < limit; i += 1) {
    const yes = Object.keys(answersOf([])).slice(0, i + 1);
    await createReport(deps, submission({ answers: answersOf(yes) }));
  }
  await assert.rejects(
    () => createReport(deps, submission({ answers: answersOf(['B10', 'B9']) })),
    RecipientLimitError,
  );
  // retries of an existing report are unaffected
  const again = await createReport(
    deps,
    submission({ answers: answersOf(Object.keys(answersOf([])).slice(0, 1)) }),
  );
  assert.equal(again.created, false);
});

test('score, level, finding, action and PDF attachment all come from the SAME stored report', async () => {
  const h = harness();
  const { store, deps } = await h.build();
  deps.renderPdf = renderReportPdf; // the real renderer, as in production
  const { record } = await createReport(deps, submission());
  const narrativeCallsBefore = h.narrativeCalls.length;
  assert.equal((await deliverReportEmail(deps, record.id)).outcome, 'accepted');
  assert.equal(
    h.narrativeCalls.length,
    narrativeCallsBefore,
    'sending never regenerates the report',
  );

  const stored = (await store.getById(record.id)).report;
  const c = buildReportContent(stored);
  const top = c.priorities.items[0];
  const [mail] = h.sent;
  const htmlText = mail.html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ');
  const norm = (v) => v.replace(/\s+/g, '').toLowerCase();
  const pdf = await getDocumentProxy(new Uint8Array(mail.attachments[0].content));
  const pdfText = norm((await extractText(pdf, { mergePages: true })).text);
  assert.equal(mail.attachments[0].content.subarray(0, 5).toString(), '%PDF-');

  for (const fact of [
    c.hero.score.value,
    c.hero.score.levelLabel,
    top.title,
    top.finding,
    top.action,
  ]) {
    assert.ok(mail.text.includes(fact), `email text missing: ${fact}`);
    assert.ok(htmlText.includes(fact), `email html missing: ${fact}`);
    assert.ok(pdfText.includes(norm(fact)), `attached PDF missing: ${fact}`);
  }
  assert.ok(mail.text.includes(mail.attachments[0].filename), 'email names the attached file');
  assert.ok(mail.html.includes(`href="${stored.bookingUrl}"`));
});

// ------------------------------------------------------------------ test recipient allowlist

test('parseEmailAllowlist: unset/empty means no restriction; anything else fails closed', () => {
  assert.equal(parseEmailAllowlist(undefined), null);
  assert.equal(parseEmailAllowlist(''), null);
  assert.deepEqual(parseEmailAllowlist(' A@Example.com, b@example.com;a@example.com\n'), [
    'a@example.com',
    'b@example.com',
  ]);
  // a set-but-unusable value restricts to NOBODY instead of opening sending to everyone
  for (const raw of [' ', ',', 'not-an-address', 'a@b', '@example.com', 'a b@example.com'])
    assert.deepEqual(parseEmailAllowlist(raw), [], JSON.stringify(raw));
  assert.equal(recipientAllowed({ emailAllowlist: null }, 'anyone@example.com'), true);
  assert.equal(recipientAllowed({}, 'anyone@example.com'), true);
  assert.equal(recipientAllowed({ emailAllowlist: [] }, 'anyone@example.com'), false);
  assert.equal(recipientAllowed({ emailAllowlist: ['a@example.com'] }, ' A@EXAMPLE.com '), true);
  assert.equal(recipientAllowed({ emailAllowlist: ['a@example.com'] }, 'b@example.com'), false);
});

test('allowlist: a listed recipient is emailed exactly as before', async () => {
  const h = harness({ emailAllowlist: ['ana.perez@example.com'] });
  const { store, deps } = await h.build();
  const { record } = await createReport(deps, submission());
  assert.equal(record.emailStatus, 'pending');
  assert.equal((await deliverReportEmail(deps, record.id)).outcome, 'accepted');
  assert.equal(h.sent.length, 1);
  assert.equal((await store.getById(record.id)).emailStatus, 'accepted');
});

test('allowlist: any other recipient gets a normal report but is stored disabled and never emailed', async () => {
  const h = harness({ emailAllowlist: ['someone.else@example.com'] });
  const { store, deps } = await h.build();
  const { record } = await createReport(deps, submission());
  assert.equal(record.emailStatus, 'disabled');
  assert.equal(record.report.narrativeSource, 'ai', 'the report itself is unaffected');
  assert.equal((await deliverReportEmail(deps, record.id)).outcome, 'not-claimed');
  assert.equal(h.sent.length, 0);
  assert.equal((await store.getById(record.id)).emailAttempts, 0);
});

test('allowlist: an empty (fail-closed) list emails nobody', async () => {
  const h = harness({ emailAllowlist: [] });
  const { deps } = await h.build();
  const { record } = await createReport(deps, submission());
  assert.equal(record.emailStatus, 'disabled');
  assert.equal((await deliverReportEmail(deps, record.id)).outcome, 'not-claimed');
  assert.equal(h.sent.length, 0);
});

test('allowlist: a report created before the gate was set is refused at send time, consuming no attempt', async () => {
  const open = harness();
  const { store, deps } = await open.build();
  const { record } = await createReport(deps, submission());
  assert.equal(record.emailStatus, 'pending');
  // the gate is switched on afterwards (same store): the pending report must not go out
  const gated = { ...deps, config: { ...deps.config, emailAllowlist: ['other@example.com'] } };
  assert.equal((await deliverReportEmail(gated, record.id)).outcome, 'not-claimed');
  assert.equal(open.sent.length, 0);
  const after = await store.getById(record.id);
  assert.equal(after.emailAttempts, 0);
  assert.equal(after.emailStatus, 'pending');
  // the cron sweep goes through the same gate
  const swept = await processDueEmails(gated, { budgetMs: 5_000 });
  assert.equal(swept.accepted, 0);
  assert.equal(open.sent.length, 0);
});

test('allowlist: without the setting nothing changes', async () => {
  const h = harness();
  const { deps } = await h.build();
  assert.equal(deps.config.emailAllowlist, undefined);
  const { record } = await createReport(deps, submission({ email: 'anyone@example.com' }));
  assert.equal(record.emailStatus, 'pending');
});
