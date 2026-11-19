import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from '../scripts/lib/env-sync.ts';
import {
  DB_URL,
  IDS,
  SECRETS,
  SECRET_A,
  SECRET_KEY,
  addCalls,
  assertNoSecrets,
  baseEnv,
  calls,
  setKnobs,
  verbs,
  workspace,
} from './helpers/env-sync-fixtures.mjs';

// tsx exposes named exports of a TS module under `default` when loaded from .mjs in some setups.
const {
  NEVER_SYNCED,
  PHRASE_ROTATION,
  PHRASE_STANDARD,
  SYNC_ALLOWLIST,
  SYNC_DEFAULT,
  SYNC_OPT_IN,
  assertEnvFileProtected,
  buildPlan,
  classifyVariable,
  createVercelRunner,
  customEnvironmentsArgs,
  parseCustomEnvironments,
  parseEnvList,
  readProjectState,
  stateFingerprint,
  redact,
  resolveProjectIdentity,
  runSync,
  secretForms,
  selectNames,
} = lib.runSync ? lib : lib.default;

const root = fileURLToPath(new URL('..', import.meta.url));

function harness(ws, extra = {}, envExtra = {}) {
  const lines = [];
  const asked = [];
  return {
    lines,
    asked,
    options: {
      cwd: ws.dir,
      envFile: '.env',
      dryRun: false,
      expectProject: IDS.projectId,
      env: baseEnv(ws, envExtra),
      makeRunner: ({ secrets, env }) =>
        createVercelRunner({ bin: ws.bin, cwd: ws.dir, env, secrets }),
      confirm: async (summary, phrase) => (asked.push({ summary, phrase }), true),
      log: (line) => lines.push(line),
      ...extra,
    },
  };
}

// ----------------------------------------------------------------------------------- allowlist

test('default sync excludes the opt-in secrets; the allowlist never contains forbidden names', () => {
  for (const name of NEVER_SYNCED) assert.ok(!SYNC_ALLOWLIST.includes(name), name);
  for (const name of SYNC_OPT_IN) assert.ok(!SYNC_DEFAULT.includes(name), name);
  assert.deepEqual([...SYNC_OPT_IN].sort(), ['CRON_SECRET', 'REPORT_TOKEN_SECRET']);
  assert.ok(NEVER_SYNCED.includes('REPORT_EMAIL_ENABLED'));
  assert.deepEqual(selectNames(undefined), [...SYNC_DEFAULT]);
  assert.ok(!selectNames(undefined).includes('REPORT_TOKEN_SECRET'));
  assert.ok(!selectNames(undefined).includes('CRON_SECRET'));
});

test('forbidden names are rejected even with the rotation flag', () => {
  for (const name of [
    'REPORT_EMAIL_ENABLED',
    'DATABASE_URL',
    'DATABASE_URL_UNPOOLED',
    'GOOGLE_SHEETS_WEBHOOK_URL',
  ])
    for (const allow of [false, true])
      assert.throws(() => selectNames([name], allow), /Not in the sync allowlist/, name);
});

test('opt-in secrets need both --only and the rotation flag, and the flag needs an opt-in name', () => {
  assert.throws(() => selectNames(['CRON_SECRET']), /opt-in.*--allow-secret-rotation/);
  assert.throws(() => selectNames(['EMAIL_FROM', 'REPORT_TOKEN_SECRET']), /opt-in/);
  assert.throws(() => selectNames(undefined, true), /needs --only naming/);
  assert.throws(() => selectNames(['EMAIL_FROM'], true), /needs --only naming/);
  assert.deepEqual(selectNames(['CRON_SECRET', 'CRON_SECRET'], true), ['CRON_SECRET']);
  assert.deepEqual(selectNames(['EMAIL_FROM', 'REPORT_TOKEN_SECRET'], true), [
    'EMAIL_FROM',
    'REPORT_TOKEN_SECRET',
  ]);
});

// -------------------------------------------------------------------------- listing and classify

const listOf = (envs) => parseEnvList(JSON.stringify({ envs }));
const rec = (key, targets, gitBranch = null, extra = {}) => ({
  key,
  targets,
  gitBranch,
  customEnvironmentIds: [],
  createdAt: null,
  updatedAt: null,
  ...extra,
});
/** A verified project state, as readProjectState would return it. */
const stateOf = (envs, customEnvironments = 0) => ({
  ...listOf(envs),
  customEnvironments,
});

test('parseEnvList keeps metadata only and accepts the shapes the CLI emits', () => {
  const result = listOf([
    { key: 'A', target: ['production'], value: SECRET_A, type: 'encrypted' },
    { key: 'B', target: 'preview', gitBranch: 'feat/x' },
    { key: 'C' },
    { key: 'D', target: null, gitBranch: null },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.records, [
    rec('A', ['production']),
    rec('B', ['preview'], 'feat/x'),
    rec('C', []),
    rec('D', []),
  ]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET_A));
  assert.deepEqual(parseEnvList('{"envs":[]}'), { ok: true, records: [] });
  assert.equal(parseEnvList(`Vercel CLI 50\n${JSON.stringify({ envs: [] })}\n`).ok, true);
});

test('parseEnvList rejects malformed or unexpected output instead of guessing', () => {
  const bad = [
    '',
    'not json',
    '{"envs": "nope"}',
    '{"variables": []}',
    '[]',
    'null',
    '{"envs":[null]}',
    '{"envs":["x"]}',
    '{"envs":[{"target":["production"]}]}',
    '{"envs":[{"key":""}]}',
    '{"envs":[{"key":"A","target":[1]}]}',
    '{"envs":[{"key":"A","target":{"p":1}}]}',
    '{"envs":[{"key":"A","gitBranch":7}]}',
    '{"envs":[{"key":"A"},',
    'name   value   environments\nA   Encrypted   Production',
  ];
  for (const text of bad) {
    const result = parseEnvList(text);
    assert.equal(result.ok, false, JSON.stringify(text));
    assert.match(result.reason, /unexpected output/);
  }
});

test('classification is fail-closed: only absent or Production-only variables are writable', () => {
  assert.deepEqual(classifyVariable('X', [], 0), { kind: 'create' });
  assert.deepEqual(classifyVariable('X', [rec('OTHER', ['production', 'preview'])], 0), {
    kind: 'create',
  });
  assert.deepEqual(classifyVariable('X', [rec('X', ['production'])], 0), { kind: 'update' });
  assert.deepEqual(classifyVariable('X', [rec('X', ['production', 'production'])], 0), {
    kind: 'update',
  });
  const blockedCases = {
    shared: [rec('X', ['production', 'preview', 'development'])],
    sharedWithPreview: [rec('X', ['production', 'preview'])],
    previewOnly: [rec('X', ['preview'])],
    developmentOnly: [rec('X', ['development'])],
    noStandardTarget: [rec('X', [])],
    customEnvironment: [rec('X', ['staging'])],
    branchScoped: [rec('X', ['production'], 'main')],
    split: [rec('X', ['production']), rec('X', ['preview'])],
    duplicate: [rec('X', ['production']), rec('X', ['production'])],
  };
  for (const [label, records] of Object.entries(blockedCases))
    assert.equal(classifyVariable('X', records, 0).kind, 'blocked', label);
  assert.match(classifyVariable('X', blockedCases.shared, 0).reason, /preview, development/);
});

test('the plan has names and operations only, and marks blocked and unverified variables', () => {
  const local = {
    ANTHROPIC_API_KEY: SECRET_A,
    GOOGLE_SHEET_ID: 'sheet',
    EMAIL_FROM: '  ',
    APP_URL: 'u',
  };
  const list = stateOf([
    { key: 'GOOGLE_SHEET_ID', target: ['production'] },
    { key: 'APP_URL', target: ['production', 'preview'] },
    { key: 'DATABASE_URL', target: ['production'] },
  ]);
  const plan = buildPlan(local, list);
  const op = Object.fromEntries(plan.map((item) => [item.name, item.operation]));
  assert.equal(op.ANTHROPIC_API_KEY, 'create');
  assert.equal(op.GOOGLE_SHEET_ID, 'update');
  assert.equal(op.APP_URL, 'blocked');
  assert.equal(op.EMAIL_FROM, 'skip');
  assert.equal(op.RESEND_API_KEY, 'skip');
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(SECRET_A));
  const unverified = buildPlan(local, { ok: false, reason: 'x' });
  assert.equal(unverified.find((i) => i.name === 'ANTHROPIC_API_KEY').operation, 'upsert');
  assert.equal(buildPlan(local, null).find((i) => i.name === 'APP_URL').operation, 'upsert');
});

// ------------------------------------------------------------------------------------ redaction

test('redact removes plain, JSON, URL, base64, newline and per-line forms of a secret', () => {
  const pem = SECRET_KEY.trim();
  const text = [
    SECRET_A,
    JSON.stringify(pem),
    pem,
    pem.replace(/\n/g, '\\n'),
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
    encodeURIComponent(SECRET_A),
    Buffer.from(SECRET_A).toString('base64'),
    'password is dbpassword-9999',
  ].join(' | ');
  const out = redact(text, [SECRET_A, pem, DB_URL]);
  assert.doesNotMatch(out, /sk-ant|MIIEvQ|ABCDEFGHIJKLMNOP|dbpassword|c2stYW50/);
  assert.match(out, /\[redacted\]/);
  assert.ok(out.includes('|'));
});

test('redaction ignores short and generic values so ordinary messages are not mangled', () => {
  const message = 'Error: invalid value for production; expected true, got no. Please retry';
  assert.equal(redact(message, ['true', 'production', 'no', 'Please', 'abc1234']), message);
  assert.deepEqual(secretForms(['true', '', '   ', 'short']), []);
  // PEM boundary lines are public text and are not treated as secrets.
  assert.ok(!secretForms([SECRET_KEY]).some((form) => form === '-----BEGIN PRIVATE KEY-----'));
  assert.equal(redact('-----BEGIN PRIVATE KEY-----', [SECRET_KEY]), '-----BEGIN PRIVATE KEY-----');
});

// ----------------------------------------------------------------------------- project identity

test('identity resolves from the link and reports env overrides', () => {
  const ws = workspace();
  const ok = resolveProjectIdentity(ws.dir, {});
  assert.deepEqual(ok, { ok: true, identity: IDS, notes: [] });
  const same = resolveProjectIdentity(ws.dir, {
    VERCEL_ORG_ID: IDS.orgId,
    VERCEL_PROJECT_ID: IDS.projectId,
    VERCEL_TOKEN: 'tok',
  });
  assert.equal(same.ok, true);
  assert.equal(same.notes.length, 2);
  assert.doesNotMatch(JSON.stringify(same), /"tok"/);
});

test('identity fails on missing, malformed or conflicting configuration', () => {
  const unlinked = workspace({ link: false });
  assert.match(resolveProjectIdentity(unlinked.dir, {}).reason, /not linked/);

  const broken = workspace();
  writeFileSync(path.join(broken.dir, '.vercel', 'project.json'), '{not json');
  assert.match(resolveProjectIdentity(broken.dir, {}).reason, /not valid JSON/);
  for (const bad of [
    '{}',
    '{"projectId":"prj_1"}',
    '{"projectId":"a b","orgId":"team_x"}',
    '[]',
    'null',
    '{"projectId":1,"orgId":2}',
  ]) {
    writeFileSync(path.join(broken.dir, '.vercel', 'project.json'), bad);
    assert.match(resolveProjectIdentity(broken.dir, {}).reason, /no valid projectId\/orgId/, bad);
  }

  const ws = workspace();
  const conflicts = [
    { VERCEL_PROJECT_ID: 'prj_other', VERCEL_ORG_ID: IDS.orgId },
    { VERCEL_PROJECT_ID: IDS.projectId, VERCEL_ORG_ID: 'team_other' },
    { VERCEL_PROJECT_ID: IDS.projectId }, // only one of the pair
    { VERCEL_ORG_ID: IDS.orgId },
    { NOW_PROJECT_ID: 'prj_legacy', NOW_ORG_ID: IDS.orgId },
  ];
  for (const env of conflicts)
    assert.match(
      resolveProjectIdentity(ws.dir, env).reason,
      /do not match \.vercel\/project\.json/,
      JSON.stringify(env),
    );
});

// -------------------------------------------------------------------------------------- dry run

test('dry run prints the project and names, never values, and only reads', async () => {
  const ws = workspace();
  const { options, lines } = harness(
    ws,
    { dryRun: true },
    { FAKE_EXISTING: 'ANTHROPIC_API_KEY,KEEP_ME' },
  );
  const result = await runSync(options);
  const output = lines.join('\n');
  assert.equal(result.modified, false);
  assert.deepEqual(result.problems, []);
  assert.match(output, new RegExp(`projectId=${IDS.projectId} orgId=${IDS.orgId}`));
  assert.match(output, /update\s+ANTHROPIC_API_KEY/);
  assert.match(output, /create\s+GOOGLE_PRIVATE_KEY/);
  assert.match(output, /skip\s+EMAIL_FROM/);
  assert.match(output, /DRY RUN/);
  assertNoSecrets(assert, output);
  assert.deepEqual(verbs(ws), ['env ls', `api ${customEnvironmentsArgs(IDS.projectId)[1]}`]); // reads only: listing + custom environments
  assert.deepEqual(calls(ws)[0].argv, ['env', 'ls', '--format', 'json']);
  assert.ok(!output.includes('REPORT_TOKEN_SECRET'), 'opt-in secrets are not even planned');
});

test('dry run reports blocked variables and unverifiable state as problems without failing', async () => {
  const ws = workspace();
  const shared = JSON.stringify([{ key: 'ANTHROPIC_API_KEY', target: ['production', 'preview'] }]);
  const a = harness(ws, { dryRun: true }, { FAKE_RECORDS: shared });
  const blocked = await runSync(a.options);
  assert.deepEqual(blocked.blocked, ['ANTHROPIC_API_KEY']);
  assert.match(blocked.problems.join(), /blocked: ANTHROPIC_API_KEY/);
  assert.match(a.lines.join('\n'), /blocked\s+ANTHROPIC_API_KEY.*preview/);
  assert.match(a.lines.join('\n'), /would be REFUSED/);

  for (const env of [{ FAKE_LS_FAIL: '1' }, { FAKE_LS_RAW: 'garbage' }]) {
    const b = harness(ws, { dryRun: true }, env);
    const unverified = await runSync(b.options);
    assert.match(unverified.problems.join(), /not verified/);
    assert.match(b.lines.join('\n'), /upsert\s+ANTHROPIC_API_KEY/);
  }
  assert.equal(addCalls(ws).length, 0);
});

test('dry run without a link still works, reports it, and never calls the CLI', async () => {
  const ws = workspace({ link: false });
  const { options, lines } = harness(ws, { dryRun: true });
  const result = await runSync(options);
  assert.match(lines.join('\n'), /UNRESOLVED.*not linked/);
  assert.ok(result.problems.length > 0);
  assert.equal(calls(ws).length, 0);
});

// --------------------------------------------------------------------------- apply: preconditions

test('apply refuses before any CLI call or prompt when identity requirements are not met', async () => {
  const cases = [
    [{ link: false }, {}, {}, /not linked/],
    [{}, { expectProject: undefined }, {}, /requires --expect-project/],
    [{}, { expectProject: 'prj_wrong' }, {}, /does not match the linked Vercel project/],
    [{}, { expectOrg: 'team_wrong' }, {}, /does not match the linked Vercel organization/],
    [{}, { offline: true }, {}, /--offline cannot be combined/],
    [{}, {}, { VERCEL_PROJECT_ID: 'prj_other', VERCEL_ORG_ID: IDS.orgId }, /do not match/],
  ];
  for (const [wsOptions, extra, env, pattern] of cases) {
    const ws = workspace(wsOptions);
    const h = harness(ws, extra, env);
    await assert.rejects(runSync(h.options), pattern, String(pattern));
    assert.equal(calls(ws).length, 0, String(pattern));
    assert.equal(h.asked.length, 0);
  }
});

test('apply accepts the matching expected project and organization', async () => {
  const ws = workspace();
  const h = harness(ws, { expectOrg: IDS.orgId });
  const result = await runSync(h.options);
  assert.equal(result.modified, true);
});

test('apply is refused, with nothing written, when existing variables cannot be verified', async () => {
  for (const env of [
    { FAKE_LS_FAIL: '1' },
    { FAKE_LS_RAW: 'not json' },
    { FAKE_LS_RAW: '{"envs": {"a": 1}}' },
    { FAKE_LS_RAW: '' },
  ]) {
    const ws = workspace();
    const h = harness(ws, {}, env);
    await assert.rejects(runSync(h.options), /Cannot verify existing variables/);
    assert.equal(addCalls(ws).length, 0);
    assert.equal(h.asked.length, 0);
    assertNoSecrets(assert, h.lines.join('\n'));
  }
});

test('apply is refused entirely when ANY variable is ambiguous (fail closed, no partial writes)', async () => {
  const ws = workspace();
  const records = JSON.stringify([
    { key: 'ANTHROPIC_API_KEY', target: ['production', 'preview', 'development'] },
    { key: 'RESEND_WEBHOOK_SECRET', target: ['production'] },
  ]);
  const h = harness(ws, {}, { FAKE_RECORDS: records });
  await assert.rejects(runSync(h.options), /Refusing to apply: ANTHROPIC_API_KEY ambiguous/);
  assert.equal(addCalls(ws).length, 0);
  assert.equal(h.asked.length, 0);
  assert.match(h.lines.join('\n'), /BLOCKED/);
});

// ------------------------------------------------------------------------------- apply: happy path

test('apply sends values on stdin only, pins the project, and touches nothing else', async () => {
  const ws = workspace();
  const h = harness(ws, {}, { FAKE_EXISTING: 'ANTHROPIC_API_KEY,UNRELATED_REMOTE' });
  const result = await runSync(h.options);
  const recorded = calls(ws);
  const adds = addCalls(ws);
  assert.deepEqual(
    adds.map((c) => c.argv[2]),
    ['GOOGLE_PRIVATE_KEY', 'ANTHROPIC_API_KEY', 'RESEND_WEBHOOK_SECRET'],
  );
  for (const call of adds) {
    // only the pre-existing, proven Production-only variable is overwritten with --force
    const expected = ['env', 'add', call.argv[2], 'production'];
    if (call.argv[2] === 'ANTHROPIC_API_KEY') expected.push('--force');
    assert.deepEqual(call.argv, expected);
    for (const secret of SECRETS)
      assert.ok(!call.argv.join(' ').includes(secret), 'secret in argv');
  }
  assert.equal(adds.find((c) => c.argv[2] === 'ANTHROPIC_API_KEY').stdin, SECRET_A);
  assert.equal(adds.find((c) => c.argv[2] === 'GOOGLE_PRIVATE_KEY').stdin, SECRET_KEY.trim());
  // The CLI is pinned to the identity that was displayed and confirmed.
  for (const call of recorded)
    assert.deepEqual([call.project, call.org], [IDS.projectId, IDS.orgId]);
  assert.ok(
    recorded.every((c) =>
      ['env ls', 'env add', `api ${customEnvironmentsArgs(IDS.projectId)[1]}`].includes(
        `${c.argv[0]} ${c.argv[1]}`,
      ),
    ),
  );
  const touched = adds.map((c) => c.argv[2]);
  for (const forbidden of [
    'REPORT_EMAIL_ENABLED',
    'DATABASE_URL',
    'UNRELATED_LOCAL_VAR',
    'EMAIL_FROM',
    'UNRELATED_REMOTE',
    'REPORT_TOKEN_SECRET',
    'CRON_SECRET',
  ])
    assert.ok(!touched.includes(forbidden), forbidden);
  const output = h.lines.join('\n');
  assertNoSecrets(assert, output);
  assert.match(output, /NO deployment was triggered/);
  assert.equal(result.modified, true);
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0].phrase, PHRASE_STANDARD);
  assert.match(h.asked[0].summary, new RegExp(`projectId ${IDS.projectId}, orgId ${IDS.orgId}`));
});

test('declining the confirmation leaves Production untouched', async () => {
  const ws = workspace();
  const h = harness(ws, { confirm: async () => false });
  const result = await runSync(h.options);
  assert.equal(result.modified, false);
  assert.equal(addCalls(ws).length, 0);
  assert.match(h.lines.join('\n'), /Not confirmed/);
});

// ------------------------------------------------------------------------------ opt-in rotation

test('rotating secrets is opt-in, warned about, and needs a different confirmation phrase', async () => {
  const ws = workspace();
  const h = harness(ws, { only: ['REPORT_TOKEN_SECRET', 'CRON_SECRET'], allowRotation: true });
  const result = await runSync(h.options);
  const output = h.lines.join('\n');
  assert.deepEqual(result.applied, ['REPORT_TOKEN_SECRET', 'CRON_SECRET']);
  assert.match(
    output,
    /WARNING REPORT_TOKEN_SECRET: .*INVALIDATES all previously issued report links/,
  );
  assert.match(output, /WARNING CRON_SECRET: .*no separate cron setting/);
  assert.equal(h.asked[0].phrase, PHRASE_ROTATION);
  assert.match(h.asked[0].summary, /SECRETS THAT CHANGE LIVE BEHAVIOUR/);
  assertNoSecrets(assert, output);
  assert.deepEqual(
    addCalls(ws).map((c) => c.argv[2]),
    ['REPORT_TOKEN_SECRET', 'CRON_SECRET'],
  );
});

test('rotating secrets without the flag is refused before anything runs', async () => {
  const ws = workspace();
  const h = harness(ws, { only: ['REPORT_TOKEN_SECRET'] });
  await assert.rejects(runSync(h.options), /opt-in/);
  assert.equal(calls(ws).length, 0);
});

// ------------------------------------------------------------------------------------- failures

test('a CLI failure is redacted, stops the run, shows the real error line and names what was written', async () => {
  const ws = workspace();
  const h = harness(ws, {}, { FAKE_FAIL_ON: 'ANTHROPIC_API_KEY', FAKE_LEAK: '1' });
  await assert.rejects(runSync(h.options), /Synchronization failed/);
  const output = h.lines.join('\n');
  assert.match(output, /FAILED ANTHROPIC_API_KEY: Error: rejected \[redacted\]/);
  assert.doesNotMatch(output, /FAILED .*Vercel CLI/); // banner skipped in favour of the error line
  assert.match(output, /Already written: GOOGLE_PRIVATE_KEY/);
  assertNoSecrets(assert, output, 'error output');
  assert.deepEqual(
    addCalls(ws).map((c) => c.argv[2]),
    ['GOOGLE_PRIVATE_KEY', 'ANTHROPIC_API_KEY'], // stopped: later ones not sent
  );
});

test('a missing CLI binary fails cleanly without leaking or writing', async () => {
  const ws = workspace();
  const h = harness(ws, {
    makeRunner: ({ secrets, env }) =>
      createVercelRunner({ bin: path.join(ws.dir, 'no-such-vercel'), cwd: ws.dir, env, secrets }),
  });
  await assert.rejects(runSync(h.options), /Cannot verify existing variables.*Could not run/);
  assertNoSecrets(assert, h.lines.join('\n'));
});

// ------------------------------------------------------------------------------- env file guard

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

test('an env file outside the repository is refused', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'env-outside-'));
  mkdirSync(path.join(dir, 'repo'));
  spawnSync('git', ['init', '-q'], { cwd: path.join(dir, 'repo') });
  writeFileSync(path.join(dir, 'secrets.env'), 'X=1\n');
  assert.throws(() => assertEnvFileProtected('../secrets.env', path.join(dir, 'repo')));
});

// ------------------------------------- B1/B2: create vs update, hidden, custom environments, TOCTOU

const only = (names) => ({ only: names });
const withAdds = (ws) => addCalls(ws).map((c) => [c.argv[2], c.argv.includes('--force')]);

test('parseEnvList refuses a listing that says it is incomplete (hidden records, pagination)', () => {
  const doc = (extra) => JSON.stringify({ envs: [{ key: 'A', target: ['production'] }], ...extra });
  assert.equal(parseEnvList(doc({ hiddenProductionEnvCount: 0 })).ok, true);
  assert.equal(parseEnvList(doc({ pagination: { count: 1, next: null } })).ok, true);
  const hidden = parseEnvList(doc({ hiddenProductionEnvCount: 2 }));
  assert.equal(hidden.ok, false);
  assert.match(hidden.reason, /2 Production variable\(s\) are hidden/);
  const paged = parseEnvList(doc({ pagination: { count: 1, next: 1700000000000 } }));
  assert.equal(paged.ok, false);
  assert.match(paged.reason, /more pages/);
  for (const extra of [{ hiddenProductionEnvCount: 'x' }, { pagination: 'x' }])
    assert.match(parseEnvList(doc(extra)).reason, /unexpected output/);
});

test('parseEnvList keeps customEnvironmentIds when emitted and rejects a malformed value', () => {
  const ok = listOf([{ key: 'A', target: ['production'], customEnvironmentIds: ['env_1'] }]);
  assert.deepEqual(ok.records[0].customEnvironmentIds, ['env_1']);
  assert.deepEqual(listOf([{ key: 'A' }]).records[0].customEnvironmentIds, []);
  for (const bad of ['env_1', [1], { a: 1 }])
    assert.match(
      listOf([{ key: 'A', customEnvironmentIds: bad }]).reason,
      /malformed customEnvironmentIds/,
    );
});

test('parseCustomEnvironments counts environments and fails closed on anything else', () => {
  assert.deepEqual(parseCustomEnvironments('{"environments":[]}'), { ok: true, count: 0 });
  assert.deepEqual(parseCustomEnvironments('{"environments":[{"id":"a"},{"id":"b"}]}'), {
    ok: true,
    count: 2,
  });
  assert.equal(parseCustomEnvironments(`Vercel CLI\n{"environments":[]}\n`).ok, true);
  for (const bad of ['', 'nope', '[]', '{}', '{"environments":{"a":1}}', 'null'])
    assert.match(parseCustomEnvironments(bad).reason, /unexpected output/, JSON.stringify(bad));
  assert.equal(parseCustomEnvironments('{"environments":[],"pagination":{"next":5}}').ok, false);
});

test('with custom environments an existing Production-only variable is never an update', () => {
  const production = [rec('X', ['production'])];
  assert.equal(classifyVariable('X', production, 0).kind, 'update');
  const blocked = classifyVariable('X', production, 1);
  assert.equal(blocked.kind, 'blocked');
  assert.match(blocked.reason, /1 custom environment\(s\)/);
  // a variable that does not exist can still be created: a create writes Production only
  assert.deepEqual(classifyVariable('X', [], 3), { kind: 'create' });
  // a record the listing itself ties to a custom environment is blocked even with a zero count
  const shared = classifyVariable(
    'X',
    [rec('X', ['production'], null, { customEnvironmentIds: ['e1'] })],
    0,
  );
  assert.equal(shared.kind, 'blocked');
  assert.match(shared.reason, /custom environment/);
  // unknown or nonsensical counts are "unverified", never "zero"
  for (const count of [undefined, null, -1, 1.5, Number.NaN, '0'])
    assert.equal(classifyVariable('X', production, count).kind, 'blocked', String(count));
});

test('the state fingerprint covers matching records, change stamps and custom environments only', () => {
  const base = stateOf([
    { key: 'A', target: ['production'], updatedAt: 1 },
    { key: 'Z', target: ['preview'] },
  ]);
  const fp = (state, names = ['A']) => stateFingerprint(names, state);
  assert.equal(fp(base), fp(stateOf([{ key: 'A', target: ['production'], updatedAt: 1 }])));
  assert.notEqual(fp(base), fp(stateOf([{ key: 'A', target: ['production'], updatedAt: 2 }])));
  assert.notEqual(
    fp(base),
    fp(stateOf([{ key: 'A', target: ['production', 'preview'], updatedAt: 1 }])),
  );
  assert.notEqual(fp(base), fp(stateOf([], 0)));
  assert.notEqual(fp(base), fp({ ...base, customEnvironments: 1 }));
  assert.equal(
    fp(base, ['A']),
    fp(
      stateOf([
        { key: 'A', target: ['production'], updatedAt: 1 },
        { key: 'Z', target: [] },
      ]),
    ),
  );
  assert.notEqual(fp(base), fp({ ok: false, reason: 'x' }));
});

test('readProjectState needs both the listing and the custom environments', async () => {
  const runner = (list, custom) => ({
    listRecords: async () => list,
    listCustomEnvironments: async () => custom,
  });
  const good = await readProjectState(runner({ ok: true, records: [] }, { ok: true, count: 2 }));
  assert.deepEqual(good, { ok: true, records: [], customEnvironments: 2 });
  const noList = await readProjectState(
    runner({ ok: false, reason: 'boom' }, { ok: true, count: 0 }),
  );
  assert.deepEqual(noList, { ok: false, reason: 'boom' });
  const noCustom = await readProjectState(
    runner({ ok: true, records: [] }, { ok: false, reason: 'nope' }),
  );
  assert.deepEqual(noCustom, { ok: false, reason: 'custom environments: nope' });
});

test('the custom-environments request names the pinned project and carries no secrets', async () => {
  assert.deepEqual(customEnvironmentsArgs('prj_x'), [
    'api',
    '/v9/projects/prj_x/custom-environments',
  ]);
  assert.deepEqual(customEnvironmentsArgs('a/b c'), [
    'api',
    '/v9/projects/a%2Fb%20c/custom-environments',
  ]);
  const ws = workspace();
  const h = harness(ws, { dryRun: true });
  await runSync(h.options);
  const api = calls(ws).find((c) => c.argv[0] === 'api');
  assert.deepEqual(api.argv, customEnvironmentsArgs(IDS.projectId));
  assert.deepEqual([api.project, api.org], [IDS.projectId, IDS.orgId]);
  assert.equal(api.stdin, '');
});

test('B1: a create never passes --force; only a proven Production-only update does', async () => {
  const ws = workspace();
  const h = harness(ws, {}, { FAKE_EXISTING: 'ANTHROPIC_API_KEY' });
  await runSync(h.options);
  assert.deepEqual(withAdds(ws), [
    ['GOOGLE_PRIVATE_KEY', false],
    ['ANTHROPIC_API_KEY', true],
    ['RESEND_WEBHOOK_SECRET', false],
  ]);
});

test('B1: a Production record hidden from the listing makes the create fail instead of being overwritten', async () => {
  const ws = workspace();
  const h = harness(ws, {}, { FAKE_HIDDEN: 'GOOGLE_PRIVATE_KEY' });
  await assert.rejects(runSync(h.options), /Synchronization failed/);
  // planned as a create (the listing never showed it): no --force, so the CLI refused it, and the
  // run stopped before touching anything else
  assert.deepEqual(withAdds(ws), [['GOOGLE_PRIVATE_KEY', false]]);
  assert.match(h.lines.join('\n'), /FAILED GOOGLE_PRIVATE_KEY: .*already exists/);
  assert.match(h.lines.join('\n'), /Already written: none/);
});

test('B1: a listing that is incomplete cannot establish absence, so nothing is written', async () => {
  for (const extra of [
    { hiddenProductionEnvCount: 1 },
    { pagination: { count: 20, next: 1700000000000 } },
  ]) {
    const ws = workspace();
    const h = harness(ws, {}, { FAKE_LS_EXTRA: JSON.stringify(extra) });
    await assert.rejects(
      runSync(h.options),
      /Cannot verify existing variables.*incomplete listing/,
    );
    assert.equal(addCalls(ws).length, 0);
    assert.equal(h.asked.length, 0);

    const dry = harness(workspace(), { dryRun: true }, { FAKE_LS_EXTRA: JSON.stringify(extra) });
    const result = await runSync(dry.options);
    assert.match(result.problems.join(), /incomplete listing/);
    assert.match(dry.lines.join('\n'), /upsert\s+ANTHROPIC_API_KEY/);
  }
});

test('B2: if custom environments cannot be read, nothing is written and nobody is asked', async () => {
  for (const env of [
    { FAKE_API_FAIL: '1' },
    { FAKE_API_RAW: 'garbage' },
    { FAKE_API_RAW: '{"environments": "x"}' },
    { FAKE_API_RAW: '' },
  ]) {
    const ws = workspace();
    const h = harness(ws, {}, env);
    await assert.rejects(
      runSync(h.options),
      /Cannot verify existing variables \(custom environments:/,
    );
    assert.equal(addCalls(ws).length, 0);
    assert.equal(h.asked.length, 0);

    const dry = harness(workspace(), { dryRun: true }, env);
    assert.match((await runSync(dry.options)).problems.join(), /custom environments:/);
  }
});

test('B2: with custom environments an existing variable is blocked, even when it looks Production-only', async () => {
  const ws = workspace();
  const h = harness(
    ws,
    {},
    {
      FAKE_EXISTING: 'ANTHROPIC_API_KEY',
      FAKE_CUSTOM_ENVS: JSON.stringify([{ id: 'env_stg', slug: 'staging' }]),
    },
  );
  await assert.rejects(runSync(h.options), /Refusing to apply: ANTHROPIC_API_KEY ambiguous/);
  assert.match(h.lines.join('\n'), /blocked\s+ANTHROPIC_API_KEY.*1 custom environment/);
  assert.match(h.lines.join('\n'), /custom environments: 1/);
  assert.equal(addCalls(ws).length, 0);
  assert.equal(h.asked.length, 0);
});

test('B2: with custom environments, creating brand-new variables is still allowed (and never forced)', async () => {
  const ws = workspace();
  const h = harness(ws, {}, { FAKE_CUSTOM_ENVS: JSON.stringify([{ id: 'env_stg' }]) });
  const result = await runSync(h.options);
  assert.equal(result.modified, true);
  assert.ok(withAdds(ws).every(([, forced]) => forced === false));
});

test('TOCTOU: the state is read again after the confirmation and before the first write', async () => {
  const ws = workspace();
  const seen = [];
  const h = harness(ws, {
    confirm: async (summary, phrase) => (
      seen.push(calls(ws).length),
      h.asked.push({ summary, phrase }),
      true
    ),
  });
  await runSync(h.options);
  assert.deepEqual(seen, [2]); // one listing + one custom-environment read before the prompt
  assert.deepEqual(
    verbs(ws).map((v) => v.split(' ')[0] + ' ' + v.split(' ')[1].slice(0, 3)),
    ['env ls', 'api /v9', 'env ls', 'api /v9', 'env add', 'env add', 'env add'],
  );
});

test('TOCTOU: declining the prompt does not re-read or write anything', async () => {
  const ws = workspace();
  await runSync(harness(ws, { confirm: async () => false }).options);
  assert.equal(calls(ws).length, 2);
});

test('TOCTOU: a change between plan and apply is rejected and nothing is written', async () => {
  const prod = (extra = {}) => ({ key: 'ANTHROPIC_API_KEY', target: ['production'], ...extra });
  const scenarios = {
    'create became an update': [[], [prod()]],
    'update became shared': [[prod()], [prod({ target: ['production', 'preview'] })]],
    'update was modified': [[prod({ updatedAt: 1 })], [prod({ updatedAt: 2 })]],
    'update was split': [[prod()], [prod(), { key: 'ANTHROPIC_API_KEY', target: ['preview'] }]],
    'update was deleted': [[prod()], []],
    'got a branch scope': [[prod()], [prod({ gitBranch: 'main' })]],
  };
  for (const [label, [first, second]] of Object.entries(scenarios)) {
    const ws = workspace();
    const h = harness(ws, {}, { FAKE_LS_SEQ: JSON.stringify([first, second]) });
    await assert.rejects(
      runSync(h.options),
      /changed after the plan was shown; nothing was written/,
      label,
    );
    assert.equal(addCalls(ws).length, 0, label);
    assert.equal(h.asked.length, 1, label); // the operator was asked once; the re-check then refused
    assertNoSecrets(assert, h.lines.join('\n'), label);
  }
});

test('TOCTOU: custom environments appearing between plan and apply are rejected', async () => {
  const ws = workspace();
  const h = harness(ws, {}, { FAKE_EXISTING: 'ANTHROPIC_API_KEY' });
  h.options.confirm = async () => {
    setKnobs(ws, { FAKE_CUSTOM_ENVS: JSON.stringify([{ id: 'env_new' }]) });
    return true;
  };
  await assert.rejects(runSync(h.options), /changed after the plan was shown/);
  assert.equal(addCalls(ws).length, 0);
});

test('TOCTOU: if the re-read fails, nothing is written', async () => {
  for (const knobs of [{ FAKE_LS_FAIL: '1' }, { FAKE_API_FAIL: '1' }]) {
    const ws = workspace();
    const h = harness(ws);
    h.options.confirm = async () => (setKnobs(ws, knobs), true);
    await assert.rejects(runSync(h.options), /Cannot re-verify existing variables/);
    assert.equal(addCalls(ws).length, 0);
  }
});

test('TOCTOU: an unchanged state passes the re-check (stamps included)', async () => {
  const ws = workspace();
  const same = [{ key: 'ANTHROPIC_API_KEY', target: ['production'], updatedAt: 5, createdAt: 1 }];
  const h = harness(ws, {}, { FAKE_LS_SEQ: JSON.stringify([same, same]) });
  const result = await runSync(h.options);
  assert.equal(result.modified, true);
  assert.deepEqual(
    withAdds(ws).find(([name]) => name === 'ANTHROPIC_API_KEY'),
    ['ANTHROPIC_API_KEY', true],
  );
});

test('the preserved safeguards still hold with the new reads', async () => {
  // opt-in secrets: still need the flag, and rotation still writes through create/update with a warning
  const ws = workspace();
  const h = harness(
    ws,
    { ...only(['CRON_SECRET', 'REPORT_TOKEN_SECRET']), allowRotation: true },
    { FAKE_EXISTING: 'CRON_SECRET' },
  );
  await runSync(h.options);
  assert.equal(h.asked[0].phrase, PHRASE_ROTATION);
  assert.deepEqual(withAdds(ws), [
    ['CRON_SECRET', true],
    ['REPORT_TOKEN_SECRET', false],
  ]);
  for (const name of NEVER_SYNCED)
    assert.throws(() => lib.selectNames?.([name]) ?? selectNames([name]), /allowlist/, name);
  for (const call of calls(ws)) assert.ok(!call.argv.includes('rm'));
});
