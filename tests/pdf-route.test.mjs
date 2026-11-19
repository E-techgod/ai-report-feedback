import test from 'node:test';
import assert from 'node:assert/strict';
import { reportAccessToken } from '../src/lib/final-report.ts';
import { handlePdfDownload } from '../src/lib/report-pdf-handler.ts';
import { fingerprintOf, sampleReport } from './helpers/fixtures.mjs';
import { harness } from './helpers/pipeline-harness.mjs';

test('PDF response uses the stored report and never waits on slow Sheet synchronization', async () => {
  const { deps, store } = await harness({ emailEnabled: false }).build();
  const report = sampleReport();
  const { record } = await store.insertReport({
    report,
    email: 'a@b.com',
    fingerprint: fingerprintOf('a@b.com'),
    emailStatus: 'disabled',
    now: new Date(),
  });
  const tasks = [];
  let release;
  let syncStarted = false;
  deps.syncTracking = () => {
    syncStarted = true;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const secret = 's'.repeat(32);
  const req = new Request('https://example.com/api/report/pdf', {
    headers: { 'x-report-token': reportAccessToken(record.id, secret) },
  });
  const response = await handlePdfDownload(req, record.id, deps, secret, (task) =>
    tasks.push(task),
  );
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), '%PDF-fake');
  assert.ok((await store.getById(record.id)).pdfDownloadedAt);
  assert.equal(syncStarted, false);
  assert.equal(tasks.length, 1);
  const pending = tasks[0]();
  assert.equal(syncStarted, true);
  release(true);
  await pending;
});

test('PDF handler rejects missing access token before reading a report', async () => {
  let reads = 0;
  const deps = {
    store: {
      async hit() {
        return 1;
      },
      async getById() {
        reads += 1;
        return null;
      },
    },
  };
  const response = await handlePdfDownload(
    new Request('https://example.com/api/report/pdf'),
    crypto.randomUUID(),
    deps,
    's'.repeat(32),
    () => {
      throw new Error('must not schedule');
    },
  );
  assert.equal(response.status, 404);
  assert.equal(reads, 0);
});
