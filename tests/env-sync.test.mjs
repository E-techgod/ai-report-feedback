import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NEVER_SYNCED,
  SYNC_ALLOWLIST,
  assertEnvFileProtected,
  buildPlan,
  createVercelRunner,
  redact,
  runSync,
  selectNames,
} from '../scripts/lib/env-sync.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const SECRET_A = 'sk-ant-SECRET-VALUE-1234567890';
const SECRET_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\n';
const SECRETS = [SECRET_A, SECRET_KEY.trim(), 'whsec_TOPSECRETWEBHOOK', 'cron-secret-value-xyz'];

/** A fake `vercel` that records every invocation (argv + stdin) and can be told to misbehave. */
function fakeVercel(dir) {
  const bin = path.join(dir, 'fake-vercel.mjs');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
let stdin = '';
if (!process.stdin.isTTY) for await (const chunk of process.stdin) stdin += chunk;
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, stdin }) + '\\n');
if (argv[0] === 'env' && argv[1] === 'ls') {
  if (process.env.FAKE_LS_FAIL) { console.error('Error: not logged in'); process.exit(1); }
  console.log('Retrieving project...');
  console.log('name                    value        environments    created');
  for (const name of (process.env.FAKE_EXISTING ?? '').split(',').filter(Boolean))
    console.log(name.padEnd(24) + 'Encrypted    Production      5d ago');
  process.exit(0);
}
if (argv[0] === 'env' && argv[1] === 'add' && process.env.FAKE_FAIL_ON === argv[2]) {
  console.error('Error: rejected ' + (process.env.FAKE_LEAK ? stdin : ''));
  process.exit(1);
}
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function workspace({ link = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'env-sync-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(path.join(dir, '.gitignore'), '.env\n.vercel\n');
  writeFileSync(
    path.join(dir, '.env'),
    [
      `ANTHROPIC_API_KEY=${SECRET_A}`,
      `GOOGLE_PRIVATE_KEY="${SECRET_KEY.trim().replace(/\n/g, '\\n')}"`,
      'RESEND_WEBHOOK_SECRET=whsec_TOPSECRETWEBHOOK',
      'CRON_SECRET=cron-secret-value-xyz',
      'EMAIL_FROM=',
      'REPORT_EMAIL_ENABLED=true',
      'DATABASE_URL=postgres://user:dbpassword@host/db',
      'UNRELATED_LOCAL_VAR=should-never-travel',
    ].join('\n'),
  );
  if (link) {
    mkdirSync(path.join(dir, '.vercel'));
    writeFileSync(path.join(dir, '.vercel', 'project.json'), '{}');
  }
  const log = path.join(dir, 'fake.log');
  writeFileSync(log, '');
  return { dir, log, bin: fakeVercel(dir) };
}

const calls = (log) =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

function harness(ws, extra = {}, env = {}) {
  Object.assign(process.env, { FAKE_LOG: ws.log, FAKE_EXISTING: '', ...env });
  const lines = [];
  return {
    lines,
    options: {
      cwd: ws.dir,
      envFile: '.env',
      dryRun: false,
      makeRunner: (secrets) => createVercelRunner({ bin: ws.bin, cwd: ws.dir, secrets }),
      confirm: async () => true,
      log: (line) => lines.push(line),
      ...extra,
    },
  };
}

const cleanEnv = () => {
  for (const key of ['FAKE_EXISTING', 'FAKE_LS_FAIL', 'FAKE_FAIL_ON', 'FAKE_LEAK'])
    delete process.env[key];
};

test('the plan has names and operations only, and skips missing or empty values', () => {
  const plan = buildPlan(
    { ANTHROPIC_API_KEY: SECRET_A, GOOGLE_SHEET_ID: 'sheet', EMAIL_FROM: '  ' },
    new Set(['GOOGLE_SHEET_ID', 'DATABASE_URL']),
  );
  const byName = Object.fromEntries(plan.map((item) => [item.name, item.operation]));
  assert.equal(byName.ANTHROPIC_API_KEY, 'create');
  assert.equal(byName.GOOGLE_SHEET_ID, 'update');
  assert.equal(byName.EMAIL_FROM, 'skip');
  assert.equal(byName.RESEND_API_KEY, 'skip');
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(SECRET_A));
  // When Production cannot be read, a present variable is an upsert.
  assert.equal(
    buildPlan({ ANTHROPIC_API_KEY: SECRET_A }, null).find((i) => i.name === 'ANTHROPIC_API_KEY')
      .operation,
    'upsert',
  );
});

test('the allowlist never contains the email switch, database URLs or legacy webhook vars', () => {
  for (const name of NEVER_SYNCED) assert.ok(!SYNC_ALLOWLIST.includes(name), name);
  assert.ok(NEVER_SYNCED.includes('REPORT_EMAIL_ENABLED'));
  assert.throws(() => selectNames(['REPORT_EMAIL_ENABLED']), /Not in the sync allowlist/);
  assert.throws(() => selectNames(['DATABASE_URL']), /Not in the sync allowlist/);
  assert.deepEqual(selectNames(['EMAIL_FROM', 'EMAIL_FROM']), ['EMAIL_FROM']);
});

test('redact removes plain, trimmed and JSON-escaped secret forms', () => {
  const text = `a ${SECRET_A} b ${JSON.stringify(SECRET_KEY)} c ${SECRET_KEY.trim()}`;
  const out = redact(text, [SECRET_A, SECRET_KEY]);
  assert.doesNotMatch(out, /sk-ant|BEGIN PRIVATE|MIIEvQ/);
});

test('dry run prints names and operations, never values, and modifies nothing', async () => {
  const ws = workspace();
  const { options, lines } = harness(
    ws,
    { dryRun: true },
    { FAKE_EXISTING: 'ANTHROPIC_API_KEY,KEEP_ME' },
  );
  const result = await runSync(options);
  const output = lines.join('\n');
  assert.equal(result.modified, false);
  assert.match(output, /update\s+ANTHROPIC_API_KEY/);
  assert.match(output, /create\s+GOOGLE_PRIVATE_KEY/);
  assert.match(output, /skip\s+EMAIL_FROM/);
  assert.match(output, /DRY RUN/);
  for (const secret of SECRETS) assert.ok(!output.includes(secret));
  assert.ok(!output.includes('should-never-travel'));
  // Only the read-only listing ran: no `env add` at all.
  assert.deepEqual(
    calls(ws.log).map((c) => c.argv.slice(0, 2).join(' ')),
    ['env ls'],
  );
  cleanEnv();
});

test('apply sends each value on stdin only, never in argv, and never touches other variables', async () => {
  const ws = workspace();
  const { options, lines } = harness(
    ws,
    {},
    { FAKE_EXISTING: 'ANTHROPIC_API_KEY,UNRELATED_REMOTE' },
  );
  const result = await runSync(options);
  const recorded = calls(ws.log);
  const adds = recorded.filter((c) => c.argv[1] === 'add');
  assert.deepEqual(adds.map((c) => c.argv[2]).sort(), [
    'ANTHROPIC_API_KEY',
    'CRON_SECRET',
    'GOOGLE_PRIVATE_KEY',
    'RESEND_WEBHOOK_SECRET',
  ]);
  for (const call of adds) {
    assert.deepEqual(call.argv, ['env', 'add', call.argv[2], 'production', '--force']);
    for (const secret of SECRETS)
      assert.ok(!call.argv.join(' ').includes(secret), 'secret in argv');
  }
  assert.equal(adds.find((c) => c.argv[2] === 'ANTHROPIC_API_KEY').stdin, SECRET_A);
  assert.equal(adds.find((c) => c.argv[2] === 'GOOGLE_PRIVATE_KEY').stdin, SECRET_KEY.trim());
  // Nothing outside the allowlist, no deletions, no deployments, no linking.
  const verbs = recorded.map((c) => c.argv[0] + ' ' + c.argv[1]);
  assert.ok(
    verbs.every((verb) => ['env ls', 'env add'].includes(verb)),
    verbs.join(','),
  );
  const touched = adds.map((c) => c.argv[2]);
  for (const forbidden of [
    'REPORT_EMAIL_ENABLED',
    'DATABASE_URL',
    'UNRELATED_LOCAL_VAR',
    'EMAIL_FROM',
  ])
    assert.ok(!touched.includes(forbidden), forbidden);
  const output = lines.join('\n');
  for (const secret of SECRETS) assert.ok(!output.includes(secret));
  assert.match(output, /NO deployment was triggered/);
  assert.equal(result.modified, true);
  cleanEnv();
});

test('declining the confirmation leaves Production untouched', async () => {
  const ws = workspace();
  const { options, lines } = harness(ws, { confirm: async () => false });
  const result = await runSync(options);
  assert.equal(result.modified, false);
  assert.equal(calls(ws.log).filter((c) => c.argv[1] === 'add').length, 0);
  assert.match(lines.join('\n'), /Not confirmed/);
  cleanEnv();
});

test('apply is refused when the project is not linked, before asking for confirmation', async () => {
  const ws = workspace({ link: false });
  let asked = false;
  const { options } = harness(ws, { confirm: async () => ((asked = true), true) });
  await assert.rejects(runSync(options), /not linked to Vercel/);
  assert.equal(asked, false);
  assert.equal(calls(ws.log).filter((c) => c.argv[1] === 'add').length, 0);
  cleanEnv();
});

test('when Production cannot be listed the dry run still works and shows upserts', async () => {
  const ws = workspace({ link: false });
  const { options, lines } = harness(ws, { dryRun: true }, { FAKE_LS_FAIL: '1' });
  await runSync(options);
  assert.match(lines.join('\n'), /upsert\s+ANTHROPIC_API_KEY/);
  assert.match(lines.join('\n'), /could not be read/);
  cleanEnv();
});

test('a CLI failure is redacted, stops the run, and names what was already written', async () => {
  const ws = workspace();
  const { options, lines } = harness(ws, {}, { FAKE_FAIL_ON: 'ANTHROPIC_API_KEY', FAKE_LEAK: '1' });
  await assert.rejects(runSync(options), /Synchronization failed/);
  const output = lines.join('\n');
  assert.match(output, /FAILED ANTHROPIC_API_KEY/);
  assert.match(output, /Already written: GOOGLE_PRIVATE_KEY/);
  for (const secret of SECRETS)
    assert.ok(!output.includes(secret), 'secret leaked in error output');
  assert.ok(!output.includes('MIIEvQ'));
  const added = calls(ws.log)
    .filter((c) => c.argv[1] === 'add')
    .map((c) => c.argv[2]);
  assert.deepEqual(added, ['GOOGLE_PRIVATE_KEY', 'ANTHROPIC_API_KEY']); // stopped, later ones not sent
  cleanEnv();
});

test('the env file must be git-ignored and untracked', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'env-protect-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(path.join(dir, '.env'), 'X=1\n');
  assert.throws(() => assertEnvFileProtected('.env', dir), /not ignored by git/);
  writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  assert.doesNotThrow(() => assertEnvFileProtected('.env', dir));
  spawnSync('git', ['add', '-f', '.env'], { cwd: dir });
  assert.throws(() => assertEnvFileProtected('.env', dir), /tracked by git/);
});

test('this repository ignores every local secret file but keeps .env.example tracked', () => {
  const ignored = [
    '.env',
    '.env.local',
    '.env.production',
    '.env.production.local',
    '.env.development.local',
    '.env.vercel',
    '.vercel/project.json',
    '.neon',
    'private-key.pem',
  ];
  for (const file of ignored)
    assert.equal(spawnSync('git', ['check-ignore', '-q', file], { cwd: root }).status, 0, file);
  assert.notEqual(
    spawnSync('git', ['check-ignore', '-q', '.env.example'], { cwd: root }).status,
    0,
  );
  assert.equal(
    spawnSync('git', ['ls-files', '--error-unmatch', '.env.example'], { cwd: root }).status,
    0,
  );
});
