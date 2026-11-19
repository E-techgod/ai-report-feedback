/**
 * Local `.env` -> Vercel Production synchronization (library; CLI in scripts/env-sync-production.ts).
 *
 * Safety properties, all covered by tests/env-sync*.test.mjs:
 *  - only an explicit allowlist of variable names is ever read or written; two high-impact secrets
 *    are opt-in and need an extra flag, an extra warning and a different confirmation phrase;
 *  - values travel to the Vercel CLI through its stdin, never through argv, a shell, a log or a
 *    printed plan; all CLI output is redacted before it is shown;
 *  - nothing is deleted (no `env rm`) and no deployment is triggered;
 *  - FAIL CLOSED on ambiguity: a variable is only written when it either does not exist at all or
 *    exists as exactly one Production-only record. A variable shared with Preview/Development, split
 *    across records, branch-scoped or of unknown scope is never touched (we cannot prove that an
 *    upsert would leave the other environments alone);
 *  - the Vercel project is identified (projectId/orgId) before any write, pinned for the child
 *    process, and an apply must name the expected projectId;
 *  - the local env file must be git-ignored and untracked, or the run aborts;
 *  - Production is only modified after an explicit typed confirmation; `--dry-run` never writes.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

/** Variables synchronized by default. */
export const SYNC_DEFAULT = [
  'GOOGLE_SHEET_ID',
  'GOOGLE_CLIENT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'EMAIL_FROM',
  'EMAIL_REPLY_TO',
  'APP_URL',
  'NEXT_PUBLIC_BOOKING_URL',
] as const;

/**
 * Opt-in only. Replacing either one changes live behaviour, so they are never part of a default run:
 * they must be named with `--only` AND `--allow-secret-rotation`, and the confirmation phrase changes.
 */
export const SYNC_OPT_IN = ['REPORT_TOKEN_SECRET', 'CRON_SECRET'] as const;

/** Every name this workflow may ever write. */
export const SYNC_ALLOWLIST = [...SYNC_DEFAULT, ...SYNC_OPT_IN] as const;

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

export const PHRASE_STANDARD = 'sync production';
export const PHRASE_ROTATION = 'rotate production secrets';

const OPT_IN_WARNINGS: Record<string, string> = {
  REPORT_TOKEN_SECRET:
    'signs every report access token: replacing it INVALIDATES all previously issued report links and downloads',
  CRON_SECRET:
    'Vercel sends the project CRON_SECRET as the bearer to /api/cron/*, so there is no separate cron setting; ' +
    'the new value applies from the next deployment and the cron endpoint rejects any other bearer',
};

const PLAN_NOTES: Record<string, string> = {
  NEXT_PUBLIC_BOOKING_URL: 'inlined at build time: needs a rebuild, not only a restart',
};

export type Operation = 'create' | 'update' | 'upsert' | 'skip' | 'blocked';
export type PlanItem = { name: string; operation: Operation; note?: string };

export function readEnvFile(file: string): Record<string, string> {
  return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
}

// ---------------------------------------------------------------------------------------------
// Existing Production variables (from `vercel env ls --format json`), parsed defensively.
// ---------------------------------------------------------------------------------------------

/** Only metadata is ever kept from the listing; values are never read. */
export type EnvRecord = { key: string; targets: string[]; gitBranch: string | null };
export type ListResult = { ok: true; records: EnvRecord[] } | { ok: false; reason: string };

export function parseEnvList(stdout: string): ListResult {
  const text = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Tolerate stray non-JSON lines around the document, nothing more.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    try {
      parsed = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : undefined;
    } catch {
      parsed = undefined;
    }
  }
  const envs = (parsed as { envs?: unknown } | null | undefined)?.envs;
  if (!Array.isArray(envs)) return { ok: false, reason: 'unexpected output (no "envs" array)' };
  const records: EnvRecord[] = [];
  for (const entry of envs) {
    if (typeof entry !== 'object' || entry === null)
      return { ok: false, reason: 'unexpected output (malformed record)' };
    const { key, target, gitBranch } = entry as Record<string, unknown>;
    if (typeof key !== 'string' || key === '')
      return { ok: false, reason: 'unexpected output (record without a key)' };
    let targets: string[];
    if (target === undefined || target === null) targets = [];
    else if (typeof target === 'string') targets = [target];
    else if (Array.isArray(target) && target.every((item) => typeof item === 'string'))
      targets = target as string[];
    else return { ok: false, reason: 'unexpected output (malformed target)' };
    if (gitBranch !== undefined && gitBranch !== null && typeof gitBranch !== 'string')
      return { ok: false, reason: 'unexpected output (malformed gitBranch)' };
    records.push({ key, targets, gitBranch: (gitBranch as string | null | undefined) ?? null });
  }
  return { ok: true, records };
}

export type Classification =
  | { kind: 'create' }
  | { kind: 'update' }
  | { kind: 'blocked'; reason: string };

/**
 * Fail closed. Safe to write only when the variable is absent everywhere, or is exactly one
 * Production-only record without a branch. Anything else could be rewritten for other environments.
 */
export function classifyVariable(name: string, records: readonly EnvRecord[]): Classification {
  const mine = records.filter((record) => record.key === name);
  if (mine.length === 0) return { kind: 'create' };
  if (mine.length > 1)
    return {
      kind: 'blocked',
      reason: `${mine.length} separate records exist; resolve them in the dashboard first`,
    };
  const [record] = mine;
  if (record.gitBranch) return { kind: 'blocked', reason: 'branch-scoped record' };
  const targets = [...new Set(record.targets)];
  if (targets.length === 1 && targets[0] === 'production') return { kind: 'update' };
  const where = targets.length ? targets.join(', ') : 'no standard environment (custom?)';
  return {
    kind: 'blocked',
    reason: `not Production-only (${where}); a Production update cannot be guaranteed to leave the other environments alone. Split it in the dashboard first`,
  };
}

/**
 * `list` = null or not ok means existing variables could not be verified: a present variable is then
 * an `upsert` (and an apply is refused). The plan contains names and operations, never values.
 */
export function buildPlan(
  local: Record<string, string>,
  list: ListResult | null,
  names: readonly string[] = SYNC_DEFAULT,
): PlanItem[] {
  return names.map((name): PlanItem => {
    const value = local[name];
    if (value === undefined) return { name, operation: 'skip', note: 'not set in the local file' };
    if (value.trim() === '') return { name, operation: 'skip', note: 'empty value' };
    const note = PLAN_NOTES[name];
    if (!list || !list.ok) return { name, operation: 'upsert', note: note ?? 'unverified' };
    const verdict = classifyVariable(name, list.records);
    if (verdict.kind === 'blocked') return { name, operation: 'blocked', note: verdict.reason };
    return { name, operation: verdict.kind, note };
  });
}

export function selectNames(
  only: readonly string[] | undefined,
  allowRotation = false,
): string[] {
  const optIn = new Set<string>(SYNC_OPT_IN);
  if (!only || only.length === 0) {
    if (allowRotation)
      throw new Error(
        '--allow-secret-rotation needs --only naming REPORT_TOKEN_SECRET and/or CRON_SECRET',
      );
    return [...SYNC_DEFAULT];
  }
  const allowed = new Set<string>(SYNC_ALLOWLIST);
  const rejected = only.filter((name) => !allowed.has(name));
  if (rejected.length) throw new Error(`Not in the sync allowlist: ${rejected.join(', ')}`);
  const names = [...new Set(only)];
  const rotating = names.filter((name) => optIn.has(name));
  if (rotating.length && !allowRotation)
    throw new Error(
      `${rotating.join(', ')} is opt-in and can change live behaviour: add --allow-secret-rotation to confirm you mean it`,
    );
  if (allowRotation && rotating.length === 0)
    throw new Error(
      '--allow-secret-rotation needs --only naming REPORT_TOKEN_SECRET and/or CRON_SECRET',
    );
  return names;
}

export function formatPlan(plan: readonly PlanItem[]): string {
  const width = Math.max(...plan.map((item) => item.name.length));
  return plan
    .map(
      (item) =>
        `  ${item.operation.padEnd(7)} ${item.name.padEnd(width)}  value: <hidden>` +
        (item.note ? `  (${item.note})` : ''),
    )
    .join('\n');
}

// ---------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------

/** Values too short or too generic to be credible secrets; replacing them only mangles messages. */
const BENIGN = new Set([
  'true',
  'false',
  'production',
  'preview',
  'development',
  'yes',
  'no',
  'null',
]);
const MIN_SECRET_LENGTH = 8;

/** Every form in which a secret could plausibly be echoed back, longest first. */
export function secretForms(secrets: Iterable<string>): string[] {
  const forms = new Set<string>();
  const add = (form: string | undefined) => {
    if (form && form.trim().length >= MIN_SECRET_LENGTH) forms.add(form);
  };
  for (const raw of secrets) {
    const secret = raw.trim();
    if (secret.length < MIN_SECRET_LENGTH || BENIGN.has(secret.toLowerCase())) continue;
    add(raw);
    add(secret);
    add(JSON.stringify(secret).slice(1, -1));
    add(encodeURIComponent(secret));
    add(Buffer.from(secret).toString('base64'));
    const real = secret.replace(/\\n/g, '\n'); // key stored with literal "\n" vs real newlines
    const escaped = secret.replace(/\r?\n/g, '\\n');
    add(real);
    add(escaped);
    for (const line of real.split('\n')) {
      const piece = line.trim();
      if (piece.length >= MIN_SECRET_LENGTH && !piece.startsWith('-----')) add(piece);
    }
    try {
      const { password } = new URL(secret); // credentials embedded in a connection string
      if (password) add(decodeURIComponent(password));
    } catch {
      /* not a URL */
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/** Removes every secret value, in every plausible encoding, from text that may be shown or logged. */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const form of secretForms(secrets)) out = out.split(form).join('[redacted]');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Vercel CLI runner
// ---------------------------------------------------------------------------------------------

export interface VercelRunner {
  /** Existing variables of the linked project (metadata only), or why they could not be read. */
  listRecords(): Promise<ListResult>;
  /** Create or overwrite one Production variable; the value is passed on stdin only. */
  setVariable(name: string, value: string): Promise<void>;
}

function run(
  bin: string,
  args: string[],
  input: string | null,
  options: { cwd: string; env: NodeJS.ProcessEnv; secrets: Iterable<string>; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const secrets = [...options.secrets];
  return new Promise((resolve, reject) => {
    // No shell: arguments are passed as an array, so nothing is interpreted or logged by a shell.
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        new Error(`Could not run "${bin}": ${(error as NodeJS.ErrnoException).code ?? 'error'}`),
      );
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? (signal ? 124 : null),
        stdout: redact(stdout, secrets),
        stderr: redact(stderr, secrets),
      });
    });
    child.stdin.on('error', () => undefined); // the CLI may exit before reading stdin
    child.stdin.end(input ?? undefined);
  });
}

/** The most informative single line of CLI output, skipping banners. */
function reasonLine(result: { code: number | null; stdout: string; stderr: string }): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.replace(/^[>\s]+/, '').trim())
    .filter(Boolean);
  const line =
    lines.find((candidate) => /^error\b/i.test(candidate)) ??
    lines.find((candidate) => !/^vercel cli\b/i.test(candidate));
  return (line ?? `exit ${result.code}`).slice(0, 200);
}

export function createVercelRunner(options: {
  bin: string;
  cwd: string;
  /** Environment for the child; carries the pinned project identity. */
  env: NodeJS.ProcessEnv;
  secrets: () => Iterable<string>;
}): VercelRunner {
  const { bin, cwd, env, secrets } = options;
  return {
    async listRecords() {
      try {
        const result = await run(bin, ['env', 'ls', '--format', 'json'], null, {
          cwd,
          env,
          secrets: secrets(),
        });
        if (result.code !== 0)
          return { ok: false, reason: `vercel env ls failed: ${reasonLine(result)}` };
        return parseEnvList(result.stdout);
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : 'could not run vercel',
        };
      }
    },
    async setVariable(name, value) {
      // `--force` upserts the Production record; the caller has already proven the variable is
      // absent or Production-only. Nothing else is touched. Never `env rm`.
      const result = await run(bin, ['env', 'add', name, 'production', '--force'], value, {
        cwd,
        env,
        secrets: secrets(),
      });
      if (result.code !== 0) throw new Error(reasonLine(result));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Guards: env file protection and project identity
// ---------------------------------------------------------------------------------------------

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

export type ProjectIdentity = { projectId: string; orgId: string };
export type IdentityResult =
  | { ok: true; identity: ProjectIdentity; notes: string[] }
  | { ok: false; reason: string };

const ID_PATTERN = /^[A-Za-z0-9_-]{3,128}$/;

/**
 * Which Vercel project would the CLI write to? `.vercel/project.json` is the link; the CLI also honours
 * VERCEL_ORG_ID + VERCEL_PROJECT_ID from the environment, which silently win over the link. Any
 * disagreement between the two is an error, never a guess.
 */
export function resolveProjectIdentity(cwd: string, env: NodeJS.ProcessEnv): IdentityResult {
  const file = path.join(cwd, '.vercel', 'project.json');
  if (!existsSync(file))
    return {
      ok: false,
      reason: 'Project is not linked to Vercel: run `vercel link` first (this tool never links)',
    };
  let link: unknown;
  try {
    link = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, reason: '.vercel/project.json is not valid JSON' };
  }
  const { projectId, orgId } = (link ?? {}) as Record<string, unknown>;
  if (
    typeof projectId !== 'string' ||
    typeof orgId !== 'string' ||
    !ID_PATTERN.test(projectId) ||
    !ID_PATTERN.test(orgId)
  )
    return { ok: false, reason: '.vercel/project.json has no valid projectId/orgId' };

  const notes: string[] = [];
  const envOrg = env.VERCEL_ORG_ID ?? env.NOW_ORG_ID;
  const envProject = env.VERCEL_PROJECT_ID ?? env.NOW_PROJECT_ID;
  if (envOrg !== undefined || envProject !== undefined) {
    if (envOrg !== orgId || envProject !== projectId)
      return {
        ok: false,
        reason:
          'VERCEL_ORG_ID / VERCEL_PROJECT_ID in the environment do not match .vercel/project.json ' +
          '(the CLI would use the environment values): unset them or fix the link',
      };
    notes.push('VERCEL_ORG_ID / VERCEL_PROJECT_ID are set in the environment and match the link');
  }
  if (env.VERCEL_TOKEN) notes.push('VERCEL_TOKEN from the environment will authenticate the CLI');
  return { ok: true, identity: { projectId, orgId }, notes };
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export type SyncOptions = {
  cwd: string;
  envFile: string;
  dryRun: boolean;
  only?: string[];
  /** Required to touch REPORT_TOKEN_SECRET / CRON_SECRET (together with naming them in `only`). */
  allowRotation?: boolean;
  /** Apply requires the projectId the operator expects; it must equal the resolved link. */
  expectProject?: string;
  expectOrg?: string;
  /** Skip every Vercel call (dry run only; an apply cannot be verified offline and is refused). */
  offline?: boolean;
  /** Process environment used for identity checks and passed to the CLI; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Builds the Vercel runner; `secrets` lists every value that must be redacted from output. */
  makeRunner: (context: { secrets: () => string[]; env: NodeJS.ProcessEnv }) => VercelRunner;
  /** Must return true only after the operator typed exactly `phrase` in an interactive terminal. */
  confirm: (summary: string, phrase: string) => Promise<boolean>;
  log: (line: string) => void;
  /** Overridable for tests; defaults to the git check above. */
  assertProtected?: (file: string, cwd: string) => void;
};

export type SyncResult = {
  applied: string[];
  skipped: string[];
  /** Variables left alone because their scope is ambiguous. */
  blocked: string[];
  /** Reasons an apply would be refused (dry run) — empty when everything is verified. */
  problems: string[];
  modified: boolean;
};

export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const { cwd, envFile, log } = options;
  const baseEnv = options.env ?? process.env;
  const names = selectNames(options.only, options.allowRotation);
  const file = path.resolve(cwd, envFile);
  if (!existsSync(file)) throw new Error(`Env file not found: ${path.relative(cwd, file)}`);
  (options.assertProtected ?? assertEnvFileProtected)(envFile, cwd);

  const problems: string[] = [];
  const identityResult = resolveProjectIdentity(cwd, baseEnv);
  log(`Source: ${path.relative(cwd, file)} (git-ignored)   Target: Vercel Production`);
  if (identityResult.ok) {
    log(
      `Vercel project: projectId=${identityResult.identity.projectId} orgId=${identityResult.identity.orgId} (.vercel/project.json)`,
    );
    for (const note of identityResult.notes) log(`  note: ${note}`);
  } else {
    log(`Vercel project: UNRESOLVED (${identityResult.reason})`);
    problems.push(identityResult.reason);
  }

  if (!options.dryRun) {
    if (!identityResult.ok) throw new Error(identityResult.reason);
    if (options.offline)
      throw new Error('--offline cannot be combined with an apply: existing variables must be verified');
    if (!options.expectProject)
      throw new Error('An apply requires --expect-project <projectId> (shown above and by --dry-run)');
    if (options.expectProject !== identityResult.identity.projectId)
      throw new Error('--expect-project does not match the linked Vercel project; nothing was written');
    if (options.expectOrg && options.expectOrg !== identityResult.identity.orgId)
      throw new Error('--expect-org does not match the linked Vercel organization; nothing was written');
  }

  const local = readEnvFile(file);
  const secrets = () => Object.values(local).filter((value) => value.trim() !== '');
  const childEnv: NodeJS.ProcessEnv = identityResult.ok
    ? {
        ...baseEnv,
        // Pin the CLI to exactly the project that was displayed and confirmed.
        VERCEL_ORG_ID: identityResult.identity.orgId,
        VERCEL_PROJECT_ID: identityResult.identity.projectId,
      }
    : { ...baseEnv };
  const runner = options.makeRunner({ secrets, env: childEnv });

  let list: ListResult;
  if (options.offline) list = { ok: false, reason: '--offline' };
  else if (!identityResult.ok) list = { ok: false, reason: 'project identity unresolved' };
  else list = await runner.listRecords();

  if (list.ok)
    log(`Existing variables read: ${list.records.length} record(s) (only allowlisted names are compared).`);
  else {
    log(`Existing variables could not be verified (${list.reason}): operations show as "upsert".`);
    if (identityResult.ok || options.offline)
      problems.push(`existing variables not verified: ${list.reason}`);
  }

  const plan = buildPlan(local, list, names);
  log(formatPlan(plan));
  const todo = plan.filter((item) => item.operation !== 'skip' && item.operation !== 'blocked');
  const skipped = plan.filter((item) => item.operation === 'skip').map((item) => item.name);
  const blocked = plan.filter((item) => item.operation === 'blocked').map((item) => item.name);
  for (const item of todo) {
    const warning = OPT_IN_WARNINGS[item.name];
    if (warning) log(`  WARNING ${item.name}: ${warning}`);
  }
  if (blocked.length) {
    log(`  BLOCKED (left untouched, fail closed): ${blocked.join(', ')}`);
    problems.push(`blocked: ${blocked.join(', ')}`);
  }

  if (options.dryRun) {
    log(
      `\nDRY RUN: ${todo.length} variable(s) would be written` +
        (problems.length ? `; an apply would be REFUSED (${problems.length} problem(s) above)` : '') +
        '. Nothing was modified.',
    );
    return { applied: [], skipped, blocked, problems, modified: false };
  }

  if (!list.ok)
    throw new Error(`Cannot verify existing variables (${list.reason}); nothing was written`);
  if (blocked.length)
    throw new Error(
      `Refusing to apply: ${blocked.join(', ')} ambiguous in Production; nothing was written`,
    );
  if (todo.length === 0) {
    log('\nNothing to synchronize.');
    return { applied: [], skipped, blocked, problems, modified: false };
  }

  const rotating = todo.some((item) => (SYNC_OPT_IN as readonly string[]).includes(item.name));
  if (!identityResult.ok) throw new Error(identityResult.reason); // unreachable: checked above
  const { projectId, orgId } = identityResult.identity;
  const summary =
    `${todo.length} variable(s) will be created or overwritten in Vercel PRODUCTION ` +
    `(projectId ${projectId}, orgId ${orgId}). Other variables are untouched.` +
    (rotating ? '\nThis includes SECRETS THAT CHANGE LIVE BEHAVIOUR (see WARNING above).' : '');
  if (!(await options.confirm(summary, rotating ? PHRASE_ROTATION : PHRASE_STANDARD))) {
    log('\nNot confirmed: Production was not modified.');
    return { applied: [], skipped, blocked, problems, modified: false };
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
  return { applied, skipped, blocked, problems, modified: applied.length > 0 };
}
