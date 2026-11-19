/**
 * Local `.env` -> Vercel Preview or Production synchronization.
 *
 * Safety properties, all covered by tests/env-sync*.test.mjs:
 *  - default updates use an explicit allowlist; new local names are proposed only when absent
 *    remotely and need --approve-new before creation; two high-impact secrets are opt-in and need
 *    an extra flag, an extra warning and a different confirmation phrase;
 *  - values travel to the Vercel CLI through its stdin, never through argv, a shell, a log or a
 *    printed plan; all CLI output is redacted before it is shown;
 *  - nothing is deleted (no `env rm`) and no deployment is triggered;
 *  - FAIL CLOSED on ambiguity: a variable is only written when absent from its target and safely
 *    creatable, or when it exists as exactly one target-only record and an update is confirmed.
 *    Preview creation beside one Production-only record needs --approve-new. Shared, split,
 *    branch-scoped or unknown scopes are never changed;
 *  - a CREATE never uses `--force`, so the CLI/API refuses it if the variable exists after all (for
 *    example a Production record the listing did not show); `--force` is only used to overwrite a
 *    record that was proven to be a lone Production-only one;
 *  - `vercel env ls --format json` does not report custom-environment membership, so a record with
 *    one target could also belong to a custom environment. The project's custom
 *    environments are therefore read as well: if they cannot be read, nothing is written; if any
 *    exist, no existing variable is overwritten;
 *  - the existing-variable state is read again after the operator confirms and before the first
 *    write; if it differs from the plan that was shown, nothing is written;
 *  - each create is followed by a fresh listing; no `ok` is logged until one independent target
 *    record appears and the pre-existing records for that name retain their metadata;
 *  - the Vercel project is identified (projectId/orgId) before any write, pinned for the child
 *    process, and an apply must name the expected projectId;
 *  - the local env file must be git-ignored and untracked, or the run aborts;
 *  - a target is only modified after an explicit typed confirmation; `--dry-run` never writes.
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

/** Names approved for updates or explicit secret rotation. New names can be approved for creation. */
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
  'REPORT_EMAIL_ALLOWLIST',
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'GOOGLE_SHEETS_WEBHOOK_URL',
  'GOOGLE_SHEETS_WEBHOOK_SECRET',
] as const;

export const PHRASE_STANDARD = 'sync production';
export const PHRASE_ROTATION = 'rotate production secrets';
export type SyncTarget = 'preview' | 'production';

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

export type Operation =
  | 'create'
  | 'update'
  | 'upsert'
  | 'propose'
  | 'propose-preview'
  | 'skip'
  | 'blocked';
export type PlanItem = { name: string; operation: Operation; note?: string };

export function readEnvFile(file: string): Record<string, string> {
  return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
}

// ---------------------------------------------------------------------------------------------
// Existing Production variables (from `vercel env ls --format json`), parsed defensively.
// ---------------------------------------------------------------------------------------------

/** Only metadata is ever kept from the listing; values are never read. */
export type EnvRecord = {
  key: string;
  targets: string[];
  gitBranch: string | null;
  /**
   * Custom environments the record belongs to. The current CLI never reports this (so it is empty
   * even when the record is shared with one); it is honoured if a CLI version starts emitting it.
   */
  customEnvironmentIds: string[];
  /** Change stamps, used only to notice that a record was modified between plan and apply. */
  createdAt: number | null;
  updatedAt: number | null;
};
export type ListResult = { ok: true; records: EnvRecord[] } | { ok: false; reason: string };

/** JSON document from CLI output, tolerating stray non-JSON lines around it and nothing more. */
function extractJson(stdout: string): unknown {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    try {
      return start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * A listing that says it is partial must never be trusted as "the variable does not exist".
 * The Vercel API reports `hiddenProductionEnvCount` (Production records the caller cannot see) and a
 * `pagination` cursor; the current CLI strips both from its JSON, but if either ever shows up as
 * "more exists" we stop instead of guessing.
 */
function incompleteReason(document: unknown): string | null {
  const { hiddenProductionEnvCount, pagination } = (document ?? {}) as Record<string, unknown>;
  if (hiddenProductionEnvCount !== undefined && hiddenProductionEnvCount !== null) {
    if (typeof hiddenProductionEnvCount !== 'number' || !Number.isFinite(hiddenProductionEnvCount))
      return 'unexpected output (malformed hiddenProductionEnvCount)';
    if (hiddenProductionEnvCount !== 0)
      return `incomplete listing: ${hiddenProductionEnvCount} Production variable(s) are hidden from this account`;
  }
  if (pagination !== undefined && pagination !== null) {
    if (typeof pagination !== 'object') return 'unexpected output (malformed pagination)';
    const { next } = pagination as Record<string, unknown>;
    if (next !== undefined && next !== null) return 'incomplete listing: more pages are available';
  }
  return null;
}

export function parseEnvList(stdout: string): ListResult {
  const parsed = extractJson(stdout);
  const envs = (parsed as { envs?: unknown } | null | undefined)?.envs;
  if (!Array.isArray(envs)) return { ok: false, reason: 'unexpected output (no "envs" array)' };
  const incomplete = incompleteReason(parsed);
  if (incomplete) return { ok: false, reason: incomplete };
  const records: EnvRecord[] = [];
  for (const entry of envs) {
    if (typeof entry !== 'object' || entry === null)
      return { ok: false, reason: 'unexpected output (malformed record)' };
    const { key, target, gitBranch, createdAt, updatedAt, customEnvironmentIds } = entry as Record<
      string,
      unknown
    >;
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
    if (
      customEnvironmentIds !== undefined &&
      customEnvironmentIds !== null &&
      !(
        Array.isArray(customEnvironmentIds) &&
        customEnvironmentIds.every((id) => typeof id === 'string')
      )
    )
      return { ok: false, reason: 'unexpected output (malformed customEnvironmentIds)' };
    const stamp = (value: unknown) => (typeof value === 'number' ? value : null);
    records.push({
      key,
      targets,
      gitBranch: (gitBranch as string | null | undefined) ?? null,
      customEnvironmentIds: (customEnvironmentIds as string[] | null | undefined) ?? [],
      createdAt: stamp(createdAt),
      updatedAt: stamp(updatedAt),
    });
  }
  return { ok: true, records };
}

export type CustomEnvResult = { ok: true; count: number } | { ok: false; reason: string };

/** Output of `vercel api /v9/projects/<id>/custom-environments`: `{ environments: [...] }`. */
export function parseCustomEnvironments(stdout: string): CustomEnvResult {
  const parsed = extractJson(stdout);
  const environments = (parsed as { environments?: unknown } | null | undefined)?.environments;
  if (!Array.isArray(environments))
    return { ok: false, reason: 'unexpected output (no "environments" array)' };
  const incomplete = incompleteReason(parsed);
  if (incomplete) return { ok: false, reason: incomplete };
  return { ok: true, count: environments.length };
}

/** Everything about the project's variables that a write decision depends on. */
export type ProjectState =
  | { ok: true; records: EnvRecord[]; customEnvironments: number }
  | { ok: false; reason: string };

export type Classification =
  | { kind: 'create' }
  | { kind: 'update' }
  | { kind: 'propose-preview' }
  | { kind: 'blocked'; reason: string };

/**
 * Fail closed. A Preview entry may be created beside one Production-only record without --force.
 * Updates require exactly one target-only record without a branch AND no custom environments
 * (the CLI listing cannot say whether such a record also belongs to a custom environment).
 */
export function classifyVariable(
  name: string,
  records: readonly EnvRecord[],
  customEnvironments: number,
  target: SyncTarget = 'production',
): Classification {
  if (!Number.isInteger(customEnvironments) || customEnvironments < 0)
    return { kind: 'blocked', reason: 'custom environments could not be verified' };
  const mine = records.filter((record) => record.key === name);
  if (mine.length === 0) {
    if (target === 'preview' && customEnvironments > 0)
      return {
        kind: 'blocked',
        reason: 'custom environments exist; an independent Preview-only record cannot be verified',
      };
    return { kind: 'create' };
  }
  if (mine.length > 1)
    return {
      kind: 'blocked',
      reason: `${mine.length} separate records exist; resolve them in the dashboard first`,
    };
  const [record] = mine;
  if (record.gitBranch) return { kind: 'blocked', reason: 'branch-scoped record' };
  if (record.customEnvironmentIds.length > 0)
    return {
      kind: 'blocked',
      reason: `shared with ${record.customEnvironmentIds.length} custom environment(s); split it in the dashboard first`,
    };
  const targets = [...new Set(record.targets)];
  if (
    target === 'preview' &&
    targets.length === 1 &&
    targets[0] === 'production' &&
    customEnvironments === 0
  )
    return { kind: 'propose-preview' };
  if (targets.length === 1 && targets[0] === target) {
    if (customEnvironments > 0)
      return {
        kind: 'blocked',
        reason:
          `the project has ${customEnvironments} custom environment(s) and the CLI listing does not show ` +
          'which of them this variable belongs to; overwriting it could change them too',
      };
    return { kind: 'update' };
  }
  const where = targets.length ? targets.join(', ') : 'no standard environment (custom?)';
  return {
    kind: 'blocked',
    reason: `not ${target}-only (${where}); a ${target} update cannot be guaranteed to leave the other environments alone. Split it in the dashboard first`,
  };
}

/**
 * Identifies the metadata a write decision rests on, for the given names only: matching records
 * (with change stamps) and the number of custom environments. Never contains values.
 */
export function stateFingerprint(names: readonly string[], state: ProjectState): string {
  if (!state.ok) return `unverified:${state.reason}`;
  const wanted = new Set(names);
  const records = state.records
    .filter((record) => wanted.has(record.key))
    .map((record) => [
      record.key,
      [...new Set(record.targets)].sort(),
      record.gitBranch,
      [...record.customEnvironmentIds].sort(),
      record.createdAt,
      record.updatedAt,
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({ customEnvironments: state.customEnvironments, records });
}

/**
 * `state` = null or not ok means existing variables or custom environments could not be verified: a
 * present variable is then an `upsert` (and an apply is refused). The plan contains names and
 * operations, never values.
 */
export function buildPlan(
  local: Record<string, string>,
  state: ProjectState | null,
  names: readonly string[] = SYNC_DEFAULT,
  target: SyncTarget = 'production',
): PlanItem[] {
  return names.map((name): PlanItem => {
    const value = local[name];
    if (value === undefined) return { name, operation: 'skip', note: 'not set in the local file' };
    if (value.trim() === '') return { name, operation: 'skip', note: 'empty value' };
    const note = PLAN_NOTES[name];
    if (!state || !state.ok) return { name, operation: 'upsert', note: note ?? 'unverified' };
    const verdict = classifyVariable(name, state.records, state.customEnvironments, target);
    if (verdict.kind === 'blocked') return { name, operation: 'blocked', note: verdict.reason };
    if (verdict.kind === 'propose-preview')
      return {
        name,
        operation: 'propose-preview',
        note: 'Production-only exists; create a separate Preview-only entry with --approve-new',
      };
    return { name, operation: verdict.kind, note };
  });
}

/** Eligible local names outside the fixed allowlist can be proposed for create-only approval. */
export function isNewVariableCandidate(name: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  if ((SYNC_ALLOWLIST as readonly string[]).includes(name)) return false;
  if ((NEVER_SYNCED as readonly string[]).includes(name)) return false;
  if (/^(DATABASE_URL|GOOGLE_SHEETS_WEBHOOK_|REPORT_EMAIL_|VERCEL_|NOW_)/.test(name))
    return false;
  return !['NODE_ENV', 'NEXT_RUNTIME', 'CI', 'PORT'].includes(name);
}

export function buildNewVariablePlan(
  local: Record<string, string>,
  state: ProjectState,
  approved: readonly string[] = [],
  target: SyncTarget = 'production',
): PlanItem[] {
  const approvedSet = new Set(approved);
  return Object.keys(local)
    .filter(
      (name) =>
        (isNewVariableCandidate(name) ||
          (approvedSet.has(name) && (SYNC_DEFAULT as readonly string[]).includes(name))) &&
        local[name].trim() !== '',
    )
    .sort()
    .flatMap((name): PlanItem[] => {
      if (!state.ok)
        return approvedSet.has(name)
          ? [{ name, operation: 'blocked', note: 'Vercel records could not be verified' }]
          : [];
      const verdict = classifyVariable(name, state.records, state.customEnvironments, target);
      if (verdict.kind === 'blocked' || verdict.kind === 'update')
        return approvedSet.has(name)
          ? [{ name, operation: 'blocked', note: 'target already exists or scope is ambiguous' }]
          : [];
      return [
        {
          name,
          operation: approvedSet.has(name) ? 'create' : verdict.kind === 'propose-preview' ? 'propose-preview' : 'propose',
          note:
            verdict.kind === 'propose-preview'
              ? 'Production-only exists; create a separate Preview-only entry without overwriting it'
              : 'new local name; create only, never overwrite',
        },
      ];
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
  const operationWidth = Math.max(...plan.map((item) => item.operation.length));
  return plan
    .map(
      (item) =>
        `  ${item.operation.padEnd(operationWidth)} ${item.name.padEnd(width)}  value: <hidden>` +
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
  /** How many custom environments the project has, or why that could not be established. */
  listCustomEnvironments(): Promise<CustomEnvResult>;
  /** Add a target variable that must not exist in that target (no `--force`); value on stdin only. */
  createVariable(name: string, value: string): Promise<void>;
  /** Overwrite a proven target-only variable (`--force`); value on stdin only. */
  updateVariable(name: string, value: string): Promise<void>;
}

/** Everything a write decision needs, read in one go. Any failure means "unverified". */
export async function readProjectState(runner: VercelRunner): Promise<ProjectState> {
  const list = await runner.listRecords();
  if (!list.ok) return list;
  const custom = await runner.listCustomEnvironments();
  if (!custom.ok) return { ok: false, reason: `custom environments: ${custom.reason}` };
  return { ok: true, records: list.records, customEnvironments: custom.count };
}

/** Metadata-only proof that a create added one independent target record and left old scopes intact. */
export function verifyCreatedVariable(
  name: string,
  target: SyncTarget,
  before: ProjectState,
  after: ProjectState,
): string | null {
  if (!before.ok || !after.ok) return 'the fresh Vercel listing could not be verified';
  if (before.customEnvironments !== after.customEnvironments)
    return 'custom environments changed during the write';
  const oldRecords = before.records.filter((record) => record.key === name);
  const newRecords = after.records.filter((record) => record.key === name);
  const independent = newRecords.filter(
    (record) =>
      record.targets.length === 1 &&
      record.targets[0] === target &&
      !record.gitBranch &&
      record.customEnvironmentIds.length === 0,
  );
  if (independent.length !== 1 || newRecords.length !== oldRecords.length + 1)
    return `no new independent ${target}-only record was found`;
  const metadata = (records: EnvRecord[]) =>
    JSON.stringify(
      records
        .map((record) => [
          record.key,
          [...record.targets].sort(),
          record.gitBranch,
          [...record.customEnvironmentIds].sort(),
          record.createdAt,
          record.updatedAt,
        ])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
  if (metadata(newRecords.filter((record) => record !== independent[0])) !== metadata(oldRecords))
    return 'an existing record changed during the create';
  return null;
}

class UnverifiedCreateError extends Error {}

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

/** Arguments for reading a project's custom environments through the CLI's raw API command. */
export const customEnvironmentsArgs = (projectId: string): string[] => [
  'api',
  `/v9/projects/${encodeURIComponent(projectId)}/custom-environments`,
];

export function createVercelRunner(options: {
  bin: string;
  cwd: string;
  target?: SyncTarget;
  /** Environment for the child; carries the pinned project identity. */
  env: NodeJS.ProcessEnv;
  secrets: () => Iterable<string>;
}): VercelRunner {
  const { bin, cwd, env, secrets, target = 'production' } = options;
  const read = async <T extends { ok: boolean }>(
    args: string[],
    label: string,
    parse: (stdout: string) => T,
  ): Promise<T | { ok: false; reason: string }> => {
    try {
      const result = await run(bin, args, null, { cwd, env, secrets: secrets() });
      if (result.code !== 0) return { ok: false, reason: `${label} failed: ${reasonLine(result)}` };
      return parse(result.stdout);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'could not run vercel' };
    }
  };
  const write = async (value: string, args: string[]) => {
    const result = await run(bin, args, value, { cwd, env, secrets: secrets() });
    if (result.code !== 0) throw new Error(reasonLine(result));
    const response = extractJson(`${result.stdout}\n${result.stderr}`) as
      | { status?: unknown; reason?: unknown }
      | undefined;
    if (response?.status === 'action_required')
      throw new Error(
        `Vercel CLI requested further action (${typeof response.reason === 'string' ? response.reason : 'unspecified'})`,
      );
  };
  const projectId = env.VERCEL_PROJECT_ID;
  return {
    listRecords: () => read(['env', 'ls', '--format', 'json'], 'vercel env ls', parseEnvList),
    listCustomEnvironments() {
      if (!projectId) return Promise.resolve({ ok: false, reason: 'project identity not pinned' });
      return read(
        customEnvironmentsArgs(projectId),
        'vercel api (custom environments)',
        parseCustomEnvironments,
      );
    },
    // No `--force`: a same-target value cannot be overwritten.
    createVariable: (name, value) => {
      if (!projectId) throw new Error('project identity not pinned');
      return write(value, ['env', 'add', name, '--environment', target, '--project', projectId]);
    },
    // `--force` overwrites the target record; the caller has proven it is a lone target-only
    // record in a project without custom environments. Nothing else is touched. Never `env rm`.
    updateVariable: (name, value) => {
      if (!projectId) throw new Error('project identity not pinned');
      return write(value, [
        'env', 'add', name, '--environment', target, '--project', projectId, '--force',
      ]);
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
  | { ok: true; identity: ProjectIdentity; source: string; notes: string[] }
  | { ok: false; reason: string };

const ID_PATTERN = /^[A-Za-z0-9_-]{3,128}$/;

/**
 * Which Vercel project would the CLI write to? The link is `.vercel/project.json` in older CLI
 * versions and a root-directory entry in `.vercel/repo.json` in CLI 66.2.0. The CLI also honours
 * VERCEL_ORG_ID + VERCEL_PROJECT_ID from the environment, which silently win over the link. Any
 * disagreement between the two is an error, never a guess.
 */
export function resolveProjectIdentity(cwd: string, env: NodeJS.ProcessEnv): IdentityResult {
  const legacyFile = path.join(cwd, '.vercel', 'project.json');
  const repoFile = path.join(cwd, '.vercel', 'repo.json');
  if (!existsSync(legacyFile) && !existsSync(repoFile))
    return {
      ok: false,
      reason: 'Project is not linked to Vercel: run `vercel link` first (this tool never links)',
    };
  const parseFile = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
  const validIdentity = (projectId: unknown, orgId: unknown): projectId is string =>
    typeof projectId === 'string' &&
    typeof orgId === 'string' &&
    ID_PATTERN.test(projectId) &&
    ID_PATTERN.test(orgId);
  let legacy: ProjectIdentity | undefined;
  if (existsSync(legacyFile)) {
    let parsed: unknown;
    try {
      parsed = parseFile(legacyFile);
    } catch {
      return { ok: false, reason: '.vercel/project.json is not valid JSON' };
    }
    const { projectId, orgId } = (parsed ?? {}) as Record<string, unknown>;
    if (!validIdentity(projectId, orgId))
      return { ok: false, reason: '.vercel/project.json has no valid projectId/orgId' };
    legacy = { projectId, orgId: orgId as string };
  }
  let repository: ProjectIdentity | undefined;
  if (existsSync(repoFile)) {
    let parsed: unknown;
    try {
      parsed = parseFile(repoFile);
    } catch {
      return { ok: false, reason: '.vercel/repo.json is not valid JSON' };
    }
    const projects = (parsed as { projects?: unknown } | null)?.projects;
    if (!Array.isArray(projects))
      return { ok: false, reason: '.vercel/repo.json has no valid projects array' };
    const root = path.resolve(cwd);
    const matching = projects.filter(
      (project): project is Record<string, unknown> =>
        typeof project === 'object' &&
        project !== null &&
        typeof project.directory === 'string' &&
        path.resolve(root, project.directory) === root,
    );
    if (matching.length !== 1)
      return { ok: false, reason: '.vercel/repo.json must have exactly one project for this repository root' };
    const { id, orgId } = matching[0];
    if (!validIdentity(id, orgId))
      return { ok: false, reason: '.vercel/repo.json root project has no valid id/orgId' };
    repository = { projectId: id, orgId: orgId as string };
  }
  if (
    legacy && repository &&
    (legacy.projectId !== repository.projectId || legacy.orgId !== repository.orgId)
  )
    return { ok: false, reason: '.vercel/project.json and .vercel/repo.json disagree; refusing to guess the target' };
  const { projectId, orgId } = repository ?? legacy!;
  const source = repository ? '.vercel/repo.json' : '.vercel/project.json';

  const notes: string[] = [];
  const envOrg = env.VERCEL_ORG_ID ?? env.NOW_ORG_ID;
  const envProject = env.VERCEL_PROJECT_ID ?? env.NOW_PROJECT_ID;
  if (envOrg !== undefined || envProject !== undefined) {
    if (envOrg !== orgId || envProject !== projectId)
      return {
        ok: false,
        reason:
          `VERCEL_ORG_ID / VERCEL_PROJECT_ID in the environment do not match ${source} ` +
          '(the CLI would use the environment values): unset them or fix the link',
      };
    notes.push('VERCEL_ORG_ID / VERCEL_PROJECT_ID are set in the environment and match the link');
  }
  if (env.VERCEL_TOKEN) notes.push('VERCEL_TOKEN from the environment will authenticate the CLI');
  return { ok: true, identity: { projectId, orgId }, source, notes };
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export type SyncOptions = {
  cwd: string;
  envFile: string;
  dryRun: boolean;
  target?: SyncTarget;
  only?: string[];
  /** Explicitly approve local names outside the fixed allowlist for creation only. */
  approveNew?: string[];
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
  makeRunner: (context: { secrets: () => string[]; env: NodeJS.ProcessEnv; target: SyncTarget }) => VercelRunner;
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
  const target = options.target ?? 'production';
  const baseEnv = options.env ?? process.env;
  const defaultNames = selectNames(options.only, options.allowRotation);
  const file = path.resolve(cwd, envFile);
  if (!existsSync(file)) throw new Error(`Env file not found: ${path.relative(cwd, file)}`);
  (options.assertProtected ?? assertEnvFileProtected)(envFile, cwd);
  const local = readEnvFile(file);
  const approvedNew = [...new Set(options.approveNew ?? [])];
  if (options.only && approvedNew.length)
    throw new Error('--only cannot be combined with --approve-new; run separate focused commands');
  for (const name of approvedNew) {
    if (
      !(isNewVariableCandidate(name) || (SYNC_DEFAULT as readonly string[]).includes(name)) ||
      !local[name]?.trim()
    )
      throw new Error(`--approve-new ${name} is not an eligible nonempty local variable`);
  }
  // A new-name approval is a focused create run; it cannot update default allowlisted variables.
  const names = approvedNew.length ? [] : defaultNames;

  const problems: string[] = [];
  const identityResult = resolveProjectIdentity(cwd, baseEnv);
  log(`Source: ${path.relative(cwd, file)} (git-ignored)   Target: Vercel ${target}`);
  if (identityResult.ok) {
    log(
      `Vercel project: projectId=${identityResult.identity.projectId} orgId=${identityResult.identity.orgId} (${identityResult.source})`,
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

  const secrets = () => Object.values(local).filter((value) => value.trim() !== '');
  const childEnv: NodeJS.ProcessEnv = identityResult.ok
    ? {
        ...baseEnv,
        // Pin the CLI to exactly the project that was displayed and confirmed.
        VERCEL_ORG_ID: identityResult.identity.orgId,
        VERCEL_PROJECT_ID: identityResult.identity.projectId,
      }
    : { ...baseEnv };
  const runner = options.makeRunner({ secrets, env: childEnv, target });

  let list: ProjectState;
  if (options.offline) list = { ok: false, reason: '--offline' };
  else if (!identityResult.ok) list = { ok: false, reason: 'project identity unresolved' };
  else list = await readProjectState(runner);

  if (list.ok)
    log(
      `Existing variables read: ${list.records.length} record(s) (local names are compared); ` +
        `custom environments: ${list.customEnvironments}.`,
    );
  else {
    log(`Existing variables could not be verified (${list.reason}): operations show as "upsert".`);
    if (identityResult.ok || options.offline)
      problems.push(`existing variables not verified: ${list.reason}`);
  }

  const plan = [
    ...buildPlan(local, list, names, target),
    ...(options.only ? [] : buildNewVariablePlan(local, list, approvedNew, target)),
  ];
  log(formatPlan(plan));
  const todo = plan.filter((item) => ['create', 'update', 'upsert'].includes(item.operation));
  const skipped = plan.filter((item) => item.operation === 'skip').map((item) => item.name);
  const blocked = plan.filter((item) => item.operation === 'blocked').map((item) => item.name);
  const proposed = plan
    .filter((item) => item.operation === 'propose' || item.operation === 'propose-preview')
    .map((item) => item.name);
  if (proposed.length)
    log(
      `  PROPOSED (not applied): ${proposed.join(', ')}. ` +
        `To create, rerun with --approve-new ${proposed.join(',')}.`,
    );
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
      `Refusing to apply: ${blocked.join(', ')} ambiguous in ${target}; nothing was written`,
    );
  if (todo.length === 0) {
    log('\nNothing to synchronize.');
    return { applied: [], skipped, blocked, problems, modified: false };
  }

  const rotating = todo.some((item) => (SYNC_OPT_IN as readonly string[]).includes(item.name));
  if (!identityResult.ok) throw new Error(identityResult.reason); // unreachable: checked above
  const { projectId, orgId } = identityResult.identity;
  const summary =
    `${todo.length} variable(s) will be created or overwritten in Vercel ${target.toUpperCase()} ` +
    `(projectId ${projectId}, orgId ${orgId}). Other variables are untouched.` +
    (rotating ? '\nThis includes SECRETS THAT CHANGE LIVE BEHAVIOUR (see WARNING above).' : '');
  const phrase = rotating ? `rotate ${target} secrets` : `sync ${target}`;
  if (!(await options.confirm(summary, phrase))) {
    log(`\nNot confirmed: ${target} was not modified.`);
    return { applied: [], skipped, blocked, problems, modified: false };
  }

  // Time of check vs time of use: the operator may have taken a while to answer. Read the metadata
  // again and write only if it still supports exactly the plan that was shown and confirmed.
  const fresh = await readProjectState(runner);
  if (!fresh.ok)
    throw new Error(`Cannot re-verify existing variables (${fresh.reason}); nothing was written`);
  const freshPlan = [
    ...buildPlan(local, fresh, names, target),
    ...(options.only ? [] : buildNewVariablePlan(local, fresh, approvedNew, target)),
  ];
  const signature = (items: readonly PlanItem[]) =>
    JSON.stringify(items.map((item) => [item.name, item.operation]));
  const todoNames = todo.map((item) => item.name);
  if (
    signature(freshPlan) !== signature(plan) ||
    stateFingerprint(todoNames, fresh) !== stateFingerprint(todoNames, list)
  )
    throw new Error(
      'Existing variables or custom environments changed after the plan was shown; nothing was written. Re-run to review the new plan',
    );

  const applied: string[] = [];
  let verifiedState: ProjectState = fresh;
  for (const item of todo) {
    try {
      // `create` never overwrites (no --force); only a confirmed target-only `update` does.
      if (item.operation === 'create') {
        await runner.createVariable(item.name, local[item.name]);
        const after = await readProjectState(runner);
        const failure = verifyCreatedVariable(item.name, target, verifiedState, after);
        if (failure)
          throw new UnverifiedCreateError(
            `CLI exited successfully, but ${failure}. This create may have taken effect.`,
          );
        verifiedState = after;
      }
      else if (item.operation === 'update')
        await runner.updateVariable(item.name, local[item.name]);
      else throw new Error(`refusing to write a variable planned as "${item.operation}"`);
      applied.push(item.name);
      log(`  ok     ${item.name}`);
    } catch (error) {
      if (error instanceof UnverifiedCreateError) {
        log(`  UNVERIFIED ${item.name}: ${error.message}`);
        log(`\nStopped immediately. Check Vercel before retrying. Earlier verified writes: ${applied.join(', ') || 'none'}.`);
      } else {
        log(`  FAILED ${item.name}: ${error instanceof Error ? error.message : 'error'}`);
        log(`\nStopped after a failure. Already written: ${applied.join(', ') || 'none'}.`);
      }
      throw new Error('Synchronization failed');
    }
  }
  log(`\nWrote ${applied.length} variable(s). NO deployment was triggered:`);
  log(`redeploy ${target} for the new values to take effect.`);
  return { applied, skipped, blocked, problems, modified: applied.length > 0 };
}
