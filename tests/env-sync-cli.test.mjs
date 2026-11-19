import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as cliModule from '../scripts/env-sync-production.ts';
import {
  IDS,
  addCalls,
  assertNoSecrets,
  baseEnv,
  calls,
  workspace,
} from './helpers/env-sync-fixtures.mjs';

const { createConfirm, main, parseArgs } = cliModule.main ? cliModule : cliModule.default;
const root = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(root, 'scripts', 'env-sync-production.ts');
const tsxLoader = import.meta.resolve('tsx');

const STD = 'sync production';
const ROT = 'rotate production secrets';

/** A fake terminal: PassThrough streams that claim to be TTYs, fed by the test. */
function terminal({ stdinTty = true, stdoutTty = true } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.isTTY = stdinTty;
  stdout.isTTY = stdoutTty;
  let printed = '';
  stdout.on('data', (chunk) => (printed += chunk));
  return {
    io: { stdin, stdout },
    answer: (text) => stdin.write(`${text}\n`),
    printed: () => printed,
  };
}

/** Waits until the confirmation prompt is on screen, so an answer can never race ahead of it. */
async function prompted(term) {
  for (let i = 0; i < 400; i += 1) {
    if (term.printed().includes('to continue')) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the confirmation prompt never appeared');
}

async function ask(phrase, typed) {
  const term = terminal();
  const pending = createConfirm(term.io)('summary text', phrase);
  term.answer(typed);
  return { ok: await pending, printed: term.printed() };
}

// --------------------------------------------------------------------------------- arguments

test('parseArgs reads every flag', () => {
  assert.deepEqual(parseArgs([]), {
    dryRun: false,
    offline: false,
    allowRotation: false,
    envFile: '.env',
  });
  assert.deepEqual(
    parseArgs([
      '--dry-run',
      '--offline',
      '--allow-secret-rotation',
      '--env-file',
      'x.env',
      '--only',
      'A, B,,C',
      '--expect-project',
      'prj_1',
      '--expect-org',
      'team_1',
    ]),
    {
      dryRun: true,
      offline: true,
      allowRotation: true,
      envFile: 'x.env',
      only: ['A', 'B', 'C'],
      expectProject: 'prj_1',
      expectOrg: 'team_1',
    },
  );
});

test('parseArgs rejects unknown options and missing values, including a flag used as a value', () => {
  assert.throws(() => parseArgs(['--bogus']), /Unknown option: --bogus/);
  assert.throws(() => parseArgs(['--yes']), /Unknown option/); // there is no non-interactive bypass
  assert.throws(() => parseArgs(['--force']), /Unknown option/);
  for (const flag of ['--env-file', '--only', '--expect-project', '--expect-org']) {
    assert.throws(() => parseArgs([flag]), /needs a value/, flag);
    assert.throws(() => parseArgs([flag, '--dry-run']), /needs a value/, flag);
  }
});

// ---------------------------------------------------------------------------- the confirmation

test('confirmation requires interactive terminals on both stdin and stdout', async () => {
  for (const flags of [
    { stdinTty: false },
    { stdoutTty: false },
    { stdinTty: false, stdoutTty: false },
  ]) {
    const term = terminal(flags);
    await assert.rejects(createConfirm(term.io)('s', STD), /needs an interactive terminal/);
    assert.equal(term.printed(), '', 'nothing is prompted without a terminal');
  }
});

test('only the exact phrase confirms', async () => {
  const good = await ask(STD, STD);
  assert.equal(good.ok, true);
  assert.match(good.printed, /summary text/);
  assert.match(good.printed, /Type "sync production" to continue/);
  assert.equal((await ask(STD, `  ${STD}  `)).ok, true); // surrounding whitespace only
  for (const wrong of [
    '',
    ' ',
    'y',
    'yes',
    'sync',
    'production',
    'SYNC PRODUCTION',
    'Sync Production',
    'sync  production',
    'sync production now',
    'please sync production',
    ROT,
  ])
    assert.equal((await ask(STD, wrong)).ok, false, JSON.stringify(wrong));
});

test('the rotation phrase is distinct: the standard phrase does not confirm a rotation', async () => {
  assert.equal((await ask(ROT, ROT)).ok, true);
  assert.equal((await ask(ROT, STD)).ok, false);
  assert.equal((await ask(ROT, 'rotate secrets')).ok, false);
  assert.match((await ask(ROT, ROT)).printed, /Type "rotate production secrets"/);
});

// ------------------------------------------------------------------------- main (in process)

function run(ws, argv, { env = {}, term = terminal() } = {}) {
  const out = [];
  const err = [];
  return {
    out,
    err,
    term,
    done: main(argv, {
      cwd: ws.dir,
      env: baseEnv(ws, env),
      io: term.io,
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    }),
  };
}

test('apply with the right project and phrase writes through the CLI with the expected arguments', async () => {
  const ws = workspace();
  const r = run(ws, ['--expect-project', IDS.projectId, '--expect-org', IDS.orgId]);
  await prompted(r.term);
  r.term.answer(STD);
  assert.equal(await r.done, 0, r.err.join('\n'));
  assert.deepEqual(
    addCalls(ws).map((c) => c.argv),
    ['GOOGLE_PRIVATE_KEY', 'ANTHROPIC_API_KEY', 'RESEND_WEBHOOK_SECRET'].map((name) => [
      'env',
      'add',
      name,
      'production', // a create never carries --force
    ]),
  );
  assertNoSecrets(assert, r.out.join('\n') + r.term.printed() + r.err.join('\n'));
});

test('a wrong phrase or a blank answer writes nothing', async () => {
  for (const typed of ['no', '', 'SYNC PRODUCTION']) {
    const ws = workspace();
    const r = run(ws, ['--expect-project', IDS.projectId]);
    await prompted(r.term);
    r.term.answer(typed);
    assert.equal(await r.done, 0);
    assert.equal(addCalls(ws).length, 0, JSON.stringify(typed));
    assert.match(r.out.join('\n'), /Not confirmed/);
  }
});

test('without a terminal an apply fails after planning and writes nothing', async () => {
  const ws = workspace();
  const r = run(ws, ['--expect-project', IDS.projectId], { term: terminal({ stdinTty: false }) });
  assert.equal(await r.done, 1);
  assert.match(r.err.join('\n'), /interactive terminal/);
  assert.equal(addCalls(ws).length, 0);
});

test('apply without --expect-project or with a wrong one fails before touching Vercel', async () => {
  for (const argv of [
    [],
    ['--expect-project', 'prj_wrong'],
    ['--expect-project', IDS.projectId, '--expect-org', 'team_wrong'],
  ]) {
    const ws = workspace();
    const r = run(ws, argv);
    assert.equal(await r.done, 1);
    assert.match(r.err.join('\n'), /--expect-(project|org)/);
    assert.equal(calls(ws).length, 0);
  }
});

test('an environment override that conflicts with the link blocks an apply', async () => {
  const ws = workspace();
  const r = run(ws, ['--expect-project', IDS.projectId], {
    env: { VERCEL_PROJECT_ID: 'prj_other', VERCEL_ORG_ID: IDS.orgId },
  });
  assert.equal(await r.done, 1);
  assert.match(r.err.join('\n'), /do not match \.vercel\/project\.json/);
  assert.equal(calls(ws).length, 0);
});

test('rotating a secret through the CLI needs the flag and the rotation phrase', async () => {
  const ws = workspace();
  const r = run(ws, [
    '--only',
    'CRON_SECRET',
    '--allow-secret-rotation',
    '--expect-project',
    IDS.projectId,
  ]);
  await prompted(r.term);
  r.term.answer(STD); // the ordinary phrase must not be enough
  assert.equal(await r.done, 0);
  assert.equal(addCalls(ws).length, 0);

  const ws2 = workspace();
  const r2 = run(ws2, [
    '--only',
    'CRON_SECRET',
    '--allow-secret-rotation',
    '--expect-project',
    IDS.projectId,
  ]);
  await prompted(r2.term);
  r2.term.answer(ROT);
  assert.equal(await r2.done, 0);
  assert.deepEqual(
    addCalls(ws2).map((c) => c.argv[2]),
    ['CRON_SECRET'],
  );

  const ws3 = workspace();
  const r3 = run(ws3, ['--only', 'CRON_SECRET', '--expect-project', IDS.projectId]);
  assert.equal(await r3.done, 1);
  assert.match(r3.err.join('\n'), /opt-in/);
  assert.equal(calls(ws3).length, 0);
});

test('forbidden variables cannot be requested through the CLI', async () => {
  for (const name of ['REPORT_EMAIL_ENABLED', 'DATABASE_URL', 'GOOGLE_SHEETS_WEBHOOK_URL']) {
    const ws = workspace();
    const r = run(ws, ['--dry-run', '--only', name]);
    assert.equal(await r.done, 1);
    assert.match(r.err.join('\n'), /Not in the sync allowlist/);
    assert.equal(calls(ws).length, 0);
  }
});

test('dry run exit codes: 0 when clean, 1 when an apply would be refused', async () => {
  const clean = workspace();
  assert.equal(await run(clean, ['--dry-run']).done, 0);
  assert.equal(addCalls(clean).length, 0);

  const shared = workspace();
  const records = JSON.stringify([
    { key: 'ANTHROPIC_API_KEY', target: ['production', 'development'] },
  ]);
  const r = run(shared, ['--dry-run'], { env: { FAKE_RECORDS: records } });
  assert.equal(await r.done, 1);
  assert.match(r.out.join('\n'), /BLOCKED/);
  assert.equal(addCalls(shared).length, 0);

  const down = workspace();
  assert.equal(await run(down, ['--dry-run'], { env: { FAKE_LS_FAIL: '1' } }).done, 1);
});

// ---------------------------------------------------------- the real entry point as a subprocess

function spawnCli(ws, argv, env = {}) {
  return spawnSync(process.execPath, ['--import', tsxLoader, script, ...argv], {
    cwd: ws.dir,
    env: baseEnv(ws, env),
    input: '', // stdin is a pipe, never a TTY
    encoding: 'utf8',
    timeout: 60_000,
  });
}

test('spawned dry run prints the project and names only, and exits 0 without writing', () => {
  const ws = workspace();
  const result = spawnCli(ws, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`projectId=${IDS.projectId} orgId=${IDS.orgId}`));
  assert.match(result.stdout, /value: <hidden>/);
  assertNoSecrets(assert, result.stdout + result.stderr);
  assert.equal(addCalls(ws).length, 0);
  assert.deepEqual(calls(ws)[0].argv, ['env', 'ls', '--format', 'json']);
});

test('spawned apply with piped stdin is refused: no terminal, no writes, no secrets printed', () => {
  const ws = workspace();
  const result = spawnCli(ws, ['--expect-project', IDS.projectId]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /interactive terminal/);
  assert.equal(addCalls(ws).length, 0);
  assertNoSecrets(assert, result.stdout + result.stderr);
});

test('spawned CLI reports usage errors with a non-zero exit', () => {
  const ws = workspace();
  const unknown = spawnCli(ws, ['--bogus']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option: --bogus[\s\S]*Usage:/);
  const missing = spawnCli(ws, ['--only']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /needs a value/);
  assert.equal(calls(ws).length, 0);
});
