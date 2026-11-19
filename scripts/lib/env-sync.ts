/**
 * Local `.env` -> Vercel Production synchronization (library; CLI in scripts/env-sync-production.ts).
 *
 * Safety properties, all covered by tests/env-sync.test.mjs:
 *  - only an explicit allowlist of variable names is ever read or written;
 *  - values travel to the Vercel CLI through its stdin, never through argv, a shell, a log or a
 *    printed plan; every line of CLI output is redacted before it is shown;
 *  - nothing is deleted (no `env rm`) and no deployment is triggered;
 *  - the local env file must be git-ignored and untracked, or the run aborts;
 *  - Production is only modified after an explicit confirmation (`dry-run` never modifies it).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

/** Application variables this workflow may create or update in Vercel Production. */
export const SYNC_ALLOWLIST = [
  'GOOGLE_SHEET_ID',
  'GOOGLE_CLIENT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'REPORT_TOKEN_SECRET',
  'CRON_SECRET',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'EMAIL_FROM',
  'EMAIL_REPLY_TO',
  'APP_URL',
  'NEXT_PUBLIC_BOOKING_URL',
] as const;

/**
 * Deliberately NOT synchronized (a request to sync one of these is rejected):
 *  - REPORT_EMAIL_ENABLED: the master email switch is flipped on purpose in the Vercel dashboard,
 *    never as a side effect of copying a local file;
 *  - DATABASE_URL / DATABASE_URL_UNPOOLED: owned by the Neon integration, and the local value may
 *    point at a different branch;
 *  - the legacy GOOGLE_SHEETS_WEBHOOK_* variables.
 */
export const NEVER_SYNCED = [
  'REPORT_EMAIL_ENABLED',
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'GOOGLE_SHEETS_WEBHOOK_URL',
  'GOOGLE_SHEETS_WEBHOOK_SECRET',
] as const;

/** Updating these invalidates already issued links / cron credentials; shown in the plan. */
const ROTATION_NOTES: Record<string, string> = {
  REPORT_TOKEN_SECRET: 'changing it invalidates every issued report access link',
  CRON_SECRET: 'must match the secret Vercel Cron is configured with',
  NEXT_PUBLIC_BOOKING_URL: 'inlined at build time: needs a rebuild, not only a restart',
};

export type Operation = 'create' | 'update' | 'upsert' | 'skip';
export type PlanItem = { name: string; operation: Operation; note?: string };

export function readEnvFile(file: string): Record<string, string> {
  return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
}

/**
 * `existing` = names already present in Vercel Production, or null when that could not be read
 * (then a present variable is an `upsert`: created or overwritten, we cannot tell which).
 * The plan contains names and operations only, never values.
 */
export function buildPlan(
  local: Record<string, string>,
  existing: ReadonlySet<string> | null,
  names: readonly string[] = SYNC_ALLOWLIST,
): PlanItem[] {
  return names.map((name): PlanItem => {
    const value = local[name];
    if (value === undefined) return { name, operation: 'skip', note: 'not set in the local file' };
    if (value.trim() === '') return { name, operation: 'skip', note: 'empty value' };
    const operation: Operation = existing === null ? 'upsert' : existing.has(name) ? 'update' : 'create';
    const note = operation === 'create' ? undefined : ROTATION_NOTES[name];
    return { name, operation, note };
  });
}

export function selectNames(only: readonly string[] | undefined): string[] {
  if (!only || only.length === 0) return [...SYNC_ALLOWLIST];
  const allowed = new Set<string>(SYNC_ALLOWLIST);
  const rejected = only.filter((name) => !allowed.has(name));
  if (rejected.length)
    throw new Error(`Not in the sync allowlist: ${rejected.join(', ')}`);
  return [...new Set(only)];
}

export function formatPlan(plan: readonly PlanItem[]): string {
  const width = Math.max(...plan.map((item) => item.name.length));
  return plan
    .map(
      (item) =>
        `  ${item.operation.padEnd(6)} ${item.name.padEnd(width)}  value: <hidden>` +
        (item.note ? `  (${item.note})` : ''),
    )
    .join('\n');
}

/** Removes every secret value (and its JSON-escaped form) from text that may be shown or logged. */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    for (const form of new Set([secret, secret.trim(), JSON.stringify(secret).slice(1, -1)]))
      if (form) out = out.split(form).join('[redacted]');
  }
  return out;
}

export interface VercelRunner {
  /** Names already defined in Production, or null if they could not be read. */
  listNames(): Promise<Set<string> | null>;
  /** Create or overwrite one Production variable; the value is passed on stdin only. */
  setVariable(name: string, value: string): Promise<void>;
}

function run(
  bin: string,
  args: string[],
  input: string | null,
  cwd: string,
  secrets: Iterable<string>,
  timeoutMs = 60_000,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    // No shell: arguments are passed as an array, so nothing is interpreted or logged by a shell.
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not run "${bin}": ${(error as NodeJS.ErrnoException).code ?? 'error'}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = redact(`${stdout}\n${stderr}`, secrets);
      resolve({ code, stdout: code === 0 ? redact(stdout, secrets) : text });
    });
    child.stdin.on('error', () => undefined); // the CLI may exit before reading stdin
    child.stdin.end(input ?? undefined);
  });
}

export function createVercelRunner(options: {
  bin: string;
  cwd: string;
  secrets: () => Iterable<string>;
}): VercelRunner {
  const { bin, cwd, secrets } = options;
  return {
    async listNames() {
      try {
        const result = await run(bin, ['env', 'ls', 'production'], null, cwd, secrets());
        if (result.code !== 0) return null;
        const names = new Set<string>();
        for (const line of result.stdout.split('\n')) {
          const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s{2,}/);
          if (match) names.add(match[1]);
        }
        return names;
      } catch {
        return null;
      }
    },
    async setVariable(name, value) {
      // `--force` overwrites an existing variable; nothing else is touched. Never `env rm`.
      const result = await run(bin, ['env', 'add', name, 'production', '--force'], value, cwd, secrets());
      if (result.code !== 0) {
        const reason = result.stdout.split('\n').find((line) => line.trim()) ?? `exit ${result.code}`;
        throw new Error(reason.trim().slice(0, 200));
      }
    },
  };
}

/** The env file must be git-ignored and untracked, otherwise a later `git add` could publish it. */
export function assertEnvFileProtected(file: string, cwd: string): void {
  const rel = path.relative(cwd, path.resolve(cwd, file));
  // Tracked first: `git check-ignore` reports a tracked file as not ignored.
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd });
  if (tracked.status === 0)
    throw new Error(`${rel} is tracked by git; refusing to read secrets from it`);
  const ignored = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd });
  if (ignored.status !== 0)
    throw new Error(`${rel} is not ignored by git; refusing to read secrets from it`);
}

export type SyncOptions = {
  cwd: string;
  envFile: string;
  dryRun: boolean;
  only?: string[];
  /** Skip the read-only `vercel env ls` lookup (operations then show as `upsert`). */
  offline?: boolean;
  /** Builds the Vercel runner; `secrets` lists every value that must be redacted from output. */
  makeRunner: (secrets: () => string[]) => VercelRunner;
  /** Receives the printable summary; must return true only after an explicit human confirmation. */
  confirm: (summary: string) => Promise<boolean>;
  log: (line: string) => void;
  /** Overridable for tests; defaults to the git check above. */
  assertProtected?: (file: string, cwd: string) => void;
};

export type SyncResult = { applied: string[]; skipped: string[]; modified: boolean };

export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const { cwd, envFile, log } = options;
  const names = selectNames(options.only);
  const file = path.resolve(cwd, envFile);
  if (!existsSync(file)) throw new Error(`Env file not found: ${path.relative(cwd, file)}`);
  (options.assertProtected ?? assertEnvFileProtected)(envFile, cwd);

  const local = readEnvFile(file);
  const runner = options.makeRunner(() =>
    Object.values(local).filter((value) => value.trim() !== ''),
  );
  const existing = options.offline ? null : await runner.listNames();
  const plan = buildPlan(local, existing, names);

  log(`Source: ${path.relative(cwd, file)} (git-ignored)   Target: Vercel Production`);
  log(
    existing === null
      ? 'Existing Production variables could not be read: operations show as "upsert".'
      : `Existing Production variables read: ${existing.size} (only allowlisted names are compared).`,
  );
  log(formatPlan(plan));

  const todo = plan.filter((item) => item.operation !== 'skip');
  const skipped = plan.filter((item) => item.operation === 'skip').map((item) => item.name);
  if (options.dryRun) {
    log(`\nDRY RUN: ${todo.length} variable(s) would be written, nothing was modified.`);
    return { applied: [], skipped, modified: false };
  }
  if (todo.length === 0) {
    log('\nNothing to synchronize.');
    return { applied: [], skipped, modified: false };
  }
  if (!existsSync(path.join(cwd, '.vercel', 'project.json')))
    throw new Error('Project is not linked to Vercel: run `vercel link` first (this tool never links)');

  const summary = `${todo.length} variable(s) will be created or overwritten in Vercel PRODUCTION. Other variables are untouched.`;
  if (!(await options.confirm(summary))) {
    log('\nNot confirmed: Production was not modified.');
    return { applied: [], skipped, modified: false };
  }

  const applied: string[] = [];
  for (const item of todo) {
    try {
      await runner.setVariable(item.name, local[item.name]);
      applied.push(item.name);
      log(`  ok     ${item.name}`);
    } catch (error) {
      log(`  FAILED ${item.name}: ${error instanceof Error ? error.message : 'error'}`);
      log(`\nStopped after a failure. Already written: ${applied.join(', ') || 'none'}.`);
      throw new Error('Synchronization failed');
    }
  }
  log(`\nWrote ${applied.length} variable(s). NO deployment was triggered:`);
  log('redeploy Production for the new values to take effect.');
  return { applied, skipped, modified: applied.length > 0 };
}
