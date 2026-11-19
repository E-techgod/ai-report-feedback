import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LIMIT_WINDOW_SECONDS,
  applyProblems,
  endpointOf,
  inspectLimit,
  limitKey,
  pinnedBranch,
  resetLimit,
  testAddresses,
} from '../scripts/lib/dev-reset-email-limit.ts';
import { DEFAULT_CONFIG, createReport, deliverReportEmail } from '../src/lib/pipeline.ts';
import { questionIds } from '../src/lib/questions.ts';
import { answersOf } from './helpers/fixtures.mjs';
import { T0, harness, submission } from './helpers/pipeline-harness.mjs';

// The harness runs on a fixed clock; inspect with the same one.
const AT = new Date(T0 + 60_000);

const sqlOf =
  (store) =>
  async (text, params = []) =>
    (await store.raw(text, params)).rows;
const limit = DEFAULT_CONFIG.maxReportsPerEmailPerDay;
/** n distinct answer sets, so each one is a NEW report (and consumes the allowance). */
const answerSet = (i) => answersOf(questionIds.slice(0, i + 1));
async function fillAllowance(deps, email) {
  for (let i = 0; i < limit; i += 1)
    await createReport(deps, submission({ email, answers: answerSet(i) }));
}
const snapshot = async (sql, table, order) => sql(`select * from ${table} order by ${order}`);

test('limitKey is exactly the key createReport() counts against, whatever the address casing', async () => {
  const { store, deps } = await harness().build();
  await createReport(deps, submission({ email: 'Test.User@Example.com' }));
  const keys = (await sqlOf(store)("select key from rate_limits where key like 'email:%'")).map(
    (r) => r.key,
  );
  assert.deepEqual(keys, [limitKey('test.user@example.com')]);
  assert.equal(limitKey('  TEST.USER@EXAMPLE.COM '), limitKey('test.user@example.com'));
  assert.match(limitKey('a@b.co'), /^email:[0-9a-f]{64}$/);
});

test('inspectLimit reads count, window_start and resets_at; an expired window is not blocking', async () => {
  const { store, deps } = await harness().build();
  const sql = sqlOf(store);
  assert.deepEqual(await inspectLimit(sql, limitKey('nobody@example.com'), AT), {
    found: false,
    key: limitKey('nobody@example.com'),
  });
  await fillAllowance(deps, 'full@example.com');
  const state = await inspectLimit(sql, limitKey('full@example.com'), AT);
  assert.equal(state.found, true);
  assert.equal(state.count, limit);
  assert.equal(state.blocked, true);
  assert.equal(state.expired, false);
  assert.equal(
    new Date(state.resetsAt).getTime() - new Date(state.windowStart).getTime(),
    LIMIT_WINDOW_SECONDS * 1000,
  );
  await sql(
    "update rate_limits set window_start = $2::timestamptz - interval '25 hours' where key = $1",
    [state.key, AT.toISOString()],
  );
  const stale = await inspectLimit(sql, state.key, AT);
  assert.equal(stale.expired, true);
  assert.equal(stale.blocked, false, 'the next request would start a fresh window');
});

test('reset deletes exactly one row; reports, email history, dedupe and other limits are untouched', async () => {
  const h = harness();
  const { store, deps } = await h.build();
  const sql = sqlOf(store);
  await fillAllowance(deps, 'target@example.com');
  const other = await createReport(deps, submission({ email: 'other@example.com' }));
  await deliverReportEmail(deps, other.record.id);
  await store.hit('ip:submit:203.0.113.9', 60, new Date());

  const before = {
    reports: await snapshot(sql, 'reports', 'id'),
    events: await snapshot(sql, 'report_email_events', 'id'),
    limits: await snapshot(sql, 'rate_limits', 'key'),
  };
  assert.ok(before.events.length > 0, 'the fixture has delivery history to protect');
  const target = limitKey('target@example.com');

  const deleted = await resetLimit(sql, target);
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].key, target);

  assert.deepEqual(await snapshot(sql, 'reports', 'id'), before.reports);
  assert.deepEqual(await snapshot(sql, 'report_email_events', 'id'), before.events);
  assert.deepEqual(
    await snapshot(sql, 'rate_limits', 'key'),
    before.limits.filter((row) => row.key !== target),
  );
  assert.equal((await resetLimit(sql, target)).length, 0, 'a second reset is a no-op');

  // The limit is lifted, and dedupe still protects the stored reports.
  const sixth = await createReport(
    deps,
    submission({ email: 'target@example.com', answers: answerSet(limit) }),
  );
  assert.equal(sixth.created, true);
  const again = await createReport(
    deps,
    submission({ email: 'target@example.com', answers: answerSet(limit) }),
  );
  assert.equal(again.created, false);
});

test('resetLimit refuses anything that is not one exact email key (no wildcards, no other limits)', async () => {
  const { store } = await harness().build();
  const sql = sqlOf(store);
  for (const key of [
    'ip:submit:1.2.3.4',
    'gen:abc',
    'email:%',
    'email:abc',
    "email:' or 1=1 --",
    '',
  ]) {
    await assert.rejects(() => resetLimit(sql, key), /not an email limit key/);
  }
});

const OK = {
  emails: ['Elias@Example.com'],
  allowlist: ['elias@example.com'],
  env: {},
  endpoint: 'ep-dev-123',
  branch: 'dev-elias',
  confirmEndpoint: 'ep-dev-123',
  confirmEmail: 'elias@example.com',
};

test('apply is allowed only when every guard passes', () => {
  assert.deepEqual(applyProblems(OK), []);
});

test('apply fails closed on each production or unverifiable signal', () => {
  const refused = (over, pattern) =>
    assert.match(applyProblems({ ...OK, ...over }).join('\n'), pattern, JSON.stringify(over));
  for (const branch of ['production', 'Production', 'main', 'prod', 'master'])
    refused({ branch }, /protected/);
  refused({ branch: null }, /branch is unknown/);
  refused({ env: { NODE_ENV: 'production' } }, /production environment/);
  refused({ env: { VERCEL_ENV: 'production' } }, /production environment/);
  refused({ env: { VERCEL: '1' } }, /production environment/);
  refused({ endpoint: null, confirmEndpoint: undefined }, /not a recognizable Neon endpoint/);
  refused({ confirmEndpoint: undefined }, /--confirm-endpoint/);
  refused({ confirmEndpoint: 'ep-other' }, /--confirm-endpoint/);
  refused({ allowlist: [] }, /REPORT_EMAIL_ALLOWLIST/);
  refused({ allowlist: ['someone-else@example.com'] }, /REPORT_EMAIL_ALLOWLIST/);
  refused({ confirmEmail: undefined }, /--confirm-email/);
  refused({ confirmEmail: 'x@example.com' }, /--confirm-email/);
  refused({ emails: [] }, /exactly one/);
  refused({ emails: ['elias@example.com', 'b@example.com'] }, /exactly one/);
});

test('helpers: endpoint extraction never leaks credentials; pinned branch and allowlist parsing', () => {
  assert.equal(
    endpointOf('postgresql://u:secret@ep-cool-name-abc123-pooler.us-east-2.aws.neon.tech/db'),
    'ep-cool-name-abc123',
  );
  assert.equal(
    endpointOf('postgresql://u:secret@ep-cool-name-abc123.us-east-2.aws.neon.tech/db'),
    'ep-cool-name-abc123',
  );
  assert.equal(endpointOf('postgresql://u:secret@localhost/db'), null);
  assert.equal(endpointOf('not a url'), null);
  assert.equal(endpointOf(undefined), null);

  const dir = mkdtempSync(join(tmpdir(), 'reset-'));
  writeFileSync(join(dir, '.neon'), JSON.stringify({ branch: 'dev-x', projectId: 'p' }));
  assert.equal(pinnedBranch(join(dir, '.neon')), 'dev-x');
  assert.equal(pinnedBranch(join(dir, 'missing')), null);
  writeFileSync(join(dir, 'bad'), '{nope');
  assert.equal(pinnedBranch(join(dir, 'bad')), null);

  assert.deepEqual(testAddresses(' A@x.com; b@y.com\nnot-an-address '), ['a@x.com', 'b@y.com']);
  assert.deepEqual(testAddresses(undefined), []);
});

test('the CLI refuses to apply on a protected branch, changes nothing and prints no connection string', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reset-cli-'));
  writeFileSync(join(dir, '.neon'), JSON.stringify({ branch: 'production' }));
  const url = 'postgresql://someuser:s3cr3tpw@ep-test-abc123.us-east-2.aws.neon.tech/neondb';
  const run = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/dev-reset-email-limit.ts',
      '--email',
      'a@example.com',
      '--apply',
      '--confirm-endpoint',
      'ep-test-abc123',
      '--confirm-email',
      'a@example.com',
      '--neon-context',
      join(dir, '.neon'),
    ],
    {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        DATABASE_URL: url,
        REPORT_EMAIL_ALLOWLIST: 'a@example.com',
        NODE_ENV: 'test',
      },
      encoding: 'utf8',
    },
  );
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 2);
  assert.match(output, /REFUSED, nothing was changed/);
  assert.match(output, /protected/);
  assert.ok(!output.includes('s3cr3tpw') && !output.includes('postgresql://'));
});
