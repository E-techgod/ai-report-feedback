import test from 'node:test';
import assert from 'node:assert/strict';
import { freshStore, sampleReport, fingerprintOf } from './helpers/fixtures.mjs';

const OPTS = { maxAttempts: 3, leaseMs: 60_000, maxAgeMs: 12 * 3600_000 };
const t0 = new Date('2026-11-18T15:00:00Z');
const plus = (ms) => new Date(t0.getTime() + ms);

async function seed(store, emailStatus = 'pending') {
  const report = sampleReport();
  const { record } = await store.insertReport({
    report,
    email: 'a@b.com',
    fingerprint: fingerprintOf('a@b.com'),
    emailStatus,
    now: t0,
  });
  return record;
}

test('insertReport is idempotent per submission id and returns the original report', async () => {
  const store = await freshStore();
  const report = sampleReport();
  const input = { report, email: 'a@b.com', fingerprint: 'fp', emailStatus: 'pending', now: t0 };
  const first = await store.insertReport(input);
  const second = await store.insertReport({
    ...input,
    report: { ...report, reportId: crypto.randomUUID() },
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.record.id, first.record.id);
  assert.deepEqual(second.record.report, report);
  assert.ok(Object.isFrozen(second.record.report));
});

test('a stored report that was tampered with fails its integrity check', async () => {
  const store = await freshStore();
  const record = await seed(store);
  await store.raw(
    `update reports set report = jsonb_set(report, '{model,level}', '"Excelente"') where id = $1`,
    [record.id],
  );
  await assert.rejects(() => store.getById(record.id), /integrity/);
});

test('sheet row linkage and tracking versions are idempotent and guarded', async () => {
  const store = await freshStore();
  const original = await seed(store, 'disabled');
  assert.equal(original.sheetRowNumber, null);
  const linked = await store.linkSheetRow(original.id, 17);
  assert.equal(linked.sheetRowNumber, 17);
  assert.equal((await store.linkSheetRow(original.id, 17)).trackingVersion, linked.trackingVersion);
  await assert.rejects(() => store.linkSheetRow(original.id, 18), /different spreadsheet row/);
  assert.deepEqual(await store.listUnsynced(10), [original.id]);
  await store.markPdfDownloaded(original.id, plus(1000));
  const downloaded = await store.getById(original.id);
  assert.equal(downloaded.pdfDownloadedAt.toISOString(), plus(1000).toISOString());
  await store.markPdfDownloaded(original.id, plus(2000));
  assert.equal((await store.getById(original.id)).trackingVersion, downloaded.trackingVersion);
  assert.equal(await store.markSheetSynced(original.id, linked.trackingVersion), false);
  assert.equal(await store.markSheetSynced(original.id, downloaded.trackingVersion), true);
  assert.deepEqual(await store.listUnsynced(10), []);
});

test('claimEmail lets exactly one concurrent caller win', async () => {
  const store = await freshStore();
  const { id } = await seed(store);
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => store.claimEmail(id, t0, OPTS)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.find(Boolean).emailStatus, 'sending');
  assert.equal(results.find(Boolean).emailAttempts, 1);
});

test('accepted emails cannot be claimed again; disabled ones never are', async () => {
  const store = await freshStore();
  const { id } = await seed(store);
  await store.claimEmail(id, t0, OPTS);
  await store.markAccepted(id, 'msg_1', plus(1000));
  assert.equal(await store.claimEmail(id, plus(10 * 60_000), OPTS), null);
  const other = await freshStore();
  const off = await seed(other, 'disabled');
  assert.equal(await other.claimEmail(off.id, t0, OPTS), null);
});

test('failed attempts respect backoff, max attempts and a stale lease can be reclaimed', async () => {
  const store = await freshStore();
  const { id } = await seed(store);
  await store.claimEmail(id, t0, OPTS);
  await store.markFailed(id, 'boom', plus(5 * 60_000), plus(1000));
  assert.equal(await store.claimEmail(id, plus(60_000), OPTS), null, 'too early');
  assert.equal((await store.listDueForEmail(plus(60_000), 10, OPTS)).length, 0);
  assert.deepEqual(await store.listDueForEmail(plus(6 * 60_000), 10, OPTS), [id]);
  const second = await store.claimEmail(id, plus(6 * 60_000), OPTS);
  assert.equal(second.emailAttempts, 2);
  // crashed worker: lease expires, another worker may reclaim (attempt 3 = last allowed)
  const third = await store.claimEmail(id, plus(8 * 60_000), OPTS);
  assert.equal(third.emailAttempts, 3);
  assert.equal(
    await store.claimEmail(id, plus(20 * 60_000), OPTS),
    null,
    'attempt budget exhausted',
  );
});

test('markFailed without a next attempt is final', async () => {
  const store = await freshStore();
  const { id } = await seed(store);
  await store.claimEmail(id, t0, OPTS);
  await store.markFailed(id, 'permanent', null, plus(1000));
  const rec = await store.getById(id);
  assert.equal(rec.emailStatus, 'failed_final');
  assert.equal(rec.emailLastError, 'permanent');
});

test('reports older than the retry window are not retried', async () => {
  const store = await freshStore();
  const { id } = await seed(store);
  assert.equal(await store.claimEmail(id, plus(13 * 3600_000), OPTS), null);
});

test('provider events: accepted -> delivered; bounce is never overwritten by delivered', async () => {
  const store = await freshStore();
  const a = await seed(store);
  await store.claimEmail(a.id, t0, OPTS);
  await store.markAccepted(a.id, 'msg_a', plus(1000));
  assert.equal((await store.getById(a.id)).emailStatus, 'accepted');
  assert.equal(await store.applyProviderEvent('msg_a', 'delivered', plus(5000)), true);
  const delivered = await store.getById(a.id);
  assert.equal(delivered.emailStatus, 'delivered');
  assert.ok(delivered.emailDeliveredAt);

  const b = sampleReport();
  await store.insertReport({
    report: b,
    email: 'c@d.com',
    fingerprint: 'x',
    emailStatus: 'pending',
    now: t0,
  });
  await store.claimEmail(b.reportId, t0, OPTS);
  await store.markAccepted(b.reportId, 'msg_b', plus(1000));
  await store.applyProviderEvent('msg_b', 'bounced', plus(2000));
  await store.applyProviderEvent('msg_b', 'delivered', plus(3000));
  assert.equal((await store.getById(b.reportId)).emailStatus, 'bounced');
  assert.equal(await store.applyProviderEvent('unknown', 'delivered', plus(1)), false);
});

test('findRecentByFingerprint only matches inside the window', async () => {
  const store = await freshStore();
  await seed(store);
  const fp = fingerprintOf('a@b.com');
  assert.ok(await store.findRecentByFingerprint(fp, plus(-60_000)));
  assert.equal(await store.findRecentByFingerprint(fp, plus(60_000)), null);
});

test('rate limit counter is shared and resets after the window', async () => {
  const store = await freshStore();
  assert.equal(await store.hit('k', 60, t0), 1);
  assert.equal(await store.hit('k', 60, plus(1000)), 2);
  assert.equal(await store.hit('k', 60, plus(61_000)), 1);
  assert.equal(await store.hit('other', 60, plus(61_000)), 1);
});
