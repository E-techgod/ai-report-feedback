import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const SECRET_A = 'sk-ant-SECRET-VALUE-1234567890';
export const SECRET_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nABCDEFGHIJKLMNOP\n-----END PRIVATE KEY-----\n';
export const SECRET_WEBHOOK = 'whsec_TOPSECRETWEBHOOK';
export const SECRET_CRON = 'cron-secret-value-xyz';
export const SECRET_TOKEN = 'report-token-secret-value-123';
export const DB_URL = 'postgres://user:dbpassword-9999@host/db';
export const SECRETS = [
  SECRET_A,
  SECRET_KEY.trim(),
  SECRET_WEBHOOK,
  SECRET_CRON,
  SECRET_TOKEN,
  'dbpassword-9999',
];
export const IDS = { projectId: 'prj_test123', orgId: 'team_test456' };

/**
 * A fake `vercel` that records every invocation (argv, stdin and the project identity it was given)
 * and can be told to misbehave. FAKE_RECORDS is a JSON array of env records; FAKE_EXISTING is a
 * comma list of Production-only variables. Like the real CLI, `env ls --format json` emits only
 * { envs } (no custom-environment membership, no hidden count, no pagination). Knobs:
 *   FAKE_LS_SEQ      JSON array of record arrays; the Nth `env ls` call returns entry N (last repeats)
 *   FAKE_HIDDEN      comma list of variables that exist but are not shown by `env ls`
 *   FAKE_LS_EXTRA    JSON object merged into the `env ls` document (hiddenProductionEnvCount, pagination)
 *   FAKE_CUSTOM_ENVS JSON array returned as `environments` by the custom-environments API call
 *   FAKE_API_FAIL / FAKE_API_RAW   make the custom-environments call fail / print raw text
 * `env add` without --force refuses an existing variable in the same target (or a hidden record).
 * Successful adds persist fake records unless FAKE_NO_PERSIST is set; that models a CLI exit 0
 * without a Vercel write. The fake requires the CLI 66.2.0 --environment/--project flags.
 */
function fakeVercel(dir) {
  const bin = path.join(dir, 'fake-vercel.mjs');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
// Knobs a test can change while a run is in progress (e.g. between the plan and the apply).
if (existsSync(process.env.FAKE_LOG + '.control'))
  Object.assign(process.env, JSON.parse(readFileSync(process.env.FAKE_LOG + '.control', 'utf8')));
const argv = process.argv.slice(2);
let stdin = '';
if (!process.stdin.isTTY) for await (const chunk of process.stdin) stdin += chunk;
appendFileSync(
  process.env.FAKE_LOG,
  JSON.stringify({ argv, stdin, project: process.env.VERCEL_PROJECT_ID, org: process.env.VERCEL_ORG_ID }) + '\\n',
);
if (argv[0] === 'env' && argv[1] === 'ls') {
  if (process.env.FAKE_LS_FAIL || (process.env.FAKE_LS_FAIL_AFTER_ADD && existsSync(process.env.FAKE_LOG + '.records'))) {
    console.error('Vercel CLI 50.0.0');
    console.error('Error: not logged in');
    process.exit(1);
  }
  if (process.env.FAKE_LS_RAW !== undefined) {
    console.log(process.env.FAKE_LS_RAW);
    process.exit(0);
  }
  console.log(
    JSON.stringify(
      {
        envs: currentRecords().map((r) => ({ type: 'encrypted', value: 'ENCRYPTED-BLOB-do-not-print', ...r })),
        ...JSON.parse(process.env.FAKE_LS_EXTRA ?? '{}'),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (argv[0] === 'api') {
  if (process.env.FAKE_API_FAIL) {
    console.error('Error: api request failed');
    process.exit(1);
  }
  if (process.env.FAKE_API_RAW !== undefined) {
    console.log(process.env.FAKE_API_RAW);
    process.exit(0);
  }
  console.log(JSON.stringify({ environments: JSON.parse(process.env.FAKE_CUSTOM_ENVS ?? '[]') }));
  process.exit(0);
}
if (argv[0] === 'env' && argv[1] === 'add') {
  if (process.env.FAKE_ACTION_REQUIRED) {
    console.log(JSON.stringify({ status: 'action_required', reason: 'git_branch_required' }));
    process.exit(0);
  }
  const targetFlag = argv.indexOf('--environment');
  const projectFlag = argv.indexOf('--project');
  if (targetFlag < 0 || projectFlag < 0) {
    console.log(JSON.stringify({ status: 'action_required', reason: 'environment_required' }));
    process.exit(0);
  }
  if (argv[projectFlag + 1] !== process.env.VERCEL_PROJECT_ID) {
    console.error('Error: wrong project');
    process.exit(1);
  }
  if (process.env.FAKE_FAIL_ON === argv[2]) {
    console.error('Vercel CLI 50.0.0');
    console.error('Error: rejected ' + (process.env.FAKE_LEAK ? stdin : ''));
    process.exit(1);
  }
  const hidden = (process.env.FAKE_HIDDEN ?? '').split(',').filter(Boolean);
  const target = argv[targetFlag + 1];
  const exists = hidden.includes(argv[2]) || currentRecords().some((r) =>
    r.key === argv[2] && (Array.isArray(r.target) ? r.target : [r.target]).includes(target)
  );
  if (exists && !argv.includes('--force')) {
    console.error('Error: A variable with the name ' + argv[2] + ' already exists');
    process.exit(1);
  }
  if (!process.env.FAKE_NO_PERSIST) {
    const records = currentRecords();
    if (argv.includes('--force')) {
      const existing = records.find((r) =>
        r.key === argv[2] && (Array.isArray(r.target) ? r.target : [r.target]).includes(target)
      );
      if (existing) existing.updatedAt = Date.now();
    } else records.push({ key: argv[2], target: [process.env.FAKE_WRONG_TARGET ?? target] });
    writeFileSync(process.env.FAKE_LOG + '.records', JSON.stringify(records));
  }
}
process.exit(0);

function currentRecords() {
  if (existsSync(process.env.FAKE_LOG + '.records'))
    return JSON.parse(readFileSync(process.env.FAKE_LOG + '.records', 'utf8'));
  if (process.env.FAKE_LS_SEQ) {
    const seq = JSON.parse(process.env.FAKE_LS_SEQ);
    const calls = readFileSync(process.env.FAKE_LOG, 'utf8')
      .split('\\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).argv)
      .filter((a) => a[0] === 'env' && a[1] === 'ls').length;
    return seq[Math.min(calls - 1, seq.length - 1)];
  }
  return process.env.FAKE_RECORDS
    ? JSON.parse(process.env.FAKE_RECORDS)
    : (process.env.FAKE_EXISTING ?? '')
        .split(',')
        .filter(Boolean)
        .map((key) => ({ key, target: ['production'] }));
}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

export function workspace({ link = true, ids = IDS, extraEnv = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'env-sync-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(path.join(dir, '.gitignore'), '.env\n.vercel\n');
  writeFileSync(
    path.join(dir, '.env'),
    [
      `ANTHROPIC_API_KEY=${SECRET_A}`,
      `GOOGLE_PRIVATE_KEY="${SECRET_KEY.trim().replace(/\n/g, '\\n')}"`,
      `RESEND_WEBHOOK_SECRET=${SECRET_WEBHOOK}`,
      `CRON_SECRET=${SECRET_CRON}`,
      `REPORT_TOKEN_SECRET=${SECRET_TOKEN}`,
      'EMAIL_FROM=',
      'REPORT_EMAIL_ENABLED=true',
      `DATABASE_URL=${DB_URL}`,
      'UNRELATED_LOCAL_VAR=should-never-travel',
      ...extraEnv,
    ].join('\n'),
  );
  if (link) {
    mkdirSync(path.join(dir, '.vercel'));
    writeFileSync(path.join(dir, '.vercel', 'project.json'), JSON.stringify(ids));
  }
  const log = path.join(dir, 'fake.log');
  writeFileSync(log, '');
  return { dir, log, bin: fakeVercel(dir) };
}

/** Parent environment for a run: no inherited Vercel identity, plus fake-vercel knobs. */
export function baseEnv(ws, extra = {}) {
  const env = { ...process.env, FAKE_LOG: ws.log, VERCEL_BIN: ws.bin, ...extra };
  for (const key of [
    'VERCEL_ORG_ID',
    'VERCEL_PROJECT_ID',
    'NOW_ORG_ID',
    'NOW_PROJECT_ID',
    'VERCEL_TOKEN',
  ])
    if (!(key in extra)) delete env[key];
  return env;
}

/** Changes fake-vercel knobs for every call made from now on. */
export const setKnobs = (ws, knobs) => writeFileSync(ws.log + '.control', JSON.stringify(knobs));

export const calls = (ws) =>
  readFileSync(ws.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

export const addCalls = (ws) => calls(ws).filter((c) => c.argv[0] === 'env' && c.argv[1] === 'add');
export const verbs = (ws) => calls(ws).map((c) => `${c.argv[0]} ${c.argv[1]}`);

export function assertNoSecrets(assert, text, label = 'output') {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `secret leaked in ${label}`);
  assert.ok(!text.includes('should-never-travel'), `unrelated value leaked in ${label}`);
  assert.ok(!text.includes('ENCRYPTED-BLOB'), `listing value leaked in ${label}`);
}
