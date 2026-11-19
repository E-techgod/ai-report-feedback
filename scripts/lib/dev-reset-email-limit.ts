import { readFileSync } from 'node:fs';
import { emailKey } from '../../src/lib/final-report';
import { DEFAULT_CONFIG } from '../../src/lib/pipeline';
import { normalizeEmail } from '../../src/lib/sheets';

/**
 * Development-only reset of the per-recipient report limit (see createReport() in pipeline.ts).
 *
 * The limit is ONE row of `rate_limits`, key `email:<sha256(normalized address)>`. Resetting it
 * means deleting exactly that row; the next request then starts a fresh 24 h window. Nothing else
 * is ever touched: not `reports`, `report_email_events`, the dedupe fingerprints, the IP limits,
 * the generation locks or any other `rate_limits` row.
 *
 * Reading (the default) is always allowed. Deleting is refused unless EVERY guard below passes.
 */
export const LIMIT_WINDOW_SECONDS = 86_400;

/** Neon branch names that are never mutated, whatever flags are passed. */
export const PROTECTED_BRANCHES = ['production', 'prod', 'main', 'master'] as const;

export type Sql = (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

export function limitKey(email: string): string {
  return `email:${emailKey(normalizeEmail(email))}`;
}

/** The Neon endpoint id (`ep-...`) of a connection string, without exposing anything else. */
export function endpointOf(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null;
  try {
    const match = new URL(databaseUrl).hostname.match(/^(ep-[a-z0-9-]+?)(?:-pooler)?\./);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Branch pinned by `neon checkout` in the local `.neon` file; null if absent or unreadable. */
export function pinnedBranch(contextFile: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(contextFile, 'utf8')) as { branch?: unknown };
    return typeof parsed.branch === 'string' ? parsed.branch : null;
  } catch {
    return null;
  }
}

/** Addresses allowed for a reset: the existing test gate REPORT_EMAIL_ALLOWLIST, nothing else. */
export function testAddresses(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,;\n]+/)
    .map(normalizeEmail)
    .filter((address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address));
}

export type GuardInput = {
  emails: string[];
  allowlist: string[];
  env: Record<string, string | undefined>;
  endpoint: string | null;
  branch: string | null;
  confirmEndpoint?: string;
  confirmEmail?: string;
};

/**
 * Reasons an APPLY must be refused (empty = allowed). Fails closed: anything that cannot be
 * verified (unknown branch, unknown endpoint, missing confirmation) is a reason to refuse.
 */
export function applyProblems(input: GuardInput): string[] {
  const { emails, allowlist, env, endpoint, branch } = input;
  const problems: string[] = [];
  if (env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production' || env.VERCEL === '1')
    problems.push('running in a production environment (NODE_ENV/VERCEL_ENV/VERCEL)');
  if (!branch)
    problems.push('the Neon branch is unknown: no readable .neon file (run `neon checkout <dev branch>`)');
  else if ((PROTECTED_BRANCHES as readonly string[]).includes(branch.toLowerCase()))
    problems.push(`the pinned Neon branch "${branch}" is protected; use a development branch`);
  if (!endpoint) problems.push('DATABASE_URL is not a recognizable Neon endpoint');
  else if (input.confirmEndpoint !== endpoint)
    problems.push(`--confirm-endpoint must equal the database endpoint (${endpoint})`);
  if (emails.length !== 1) problems.push('apply takes exactly one --email');
  else {
    const email = normalizeEmail(emails[0]);
    if (!allowlist.includes(email))
      problems.push('the address is not in REPORT_EMAIL_ALLOWLIST (test addresses only)');
    if (!input.confirmEmail || normalizeEmail(input.confirmEmail) !== email)
      problems.push('--confirm-email must repeat the address');
  }
  return problems;
}

export type LimitState =
  | { found: false; key: string }
  | {
      found: true;
      key: string;
      count: number;
      windowStart: string;
      resetsAt: string;
      /** The window already expired: the next request starts a fresh one, so nothing blocks it. */
      expired: boolean;
      blocked: boolean;
      limit: number;
    };

/** Read-only. Compares against the database clock unless `now` is given (tests with a fake clock). */
export async function inspectLimit(sql: Sql, key: string, now?: Date): Promise<LimitState> {
  const rows = await sql(
    `select count, window_start, window_start + make_interval(secs => $2::int) as resets_at,
            window_start <= coalesce($3::timestamptz, now()) - make_interval(secs => $2::int) as expired
       from rate_limits where key = $1`,
    [key, LIMIT_WINDOW_SECONDS, now ? now.toISOString() : null],
  );
  if (rows.length === 0) return { found: false, key };
  const row = rows[0];
  const limit = DEFAULT_CONFIG.maxReportsPerEmailPerDay;
  const expired = row.expired === true;
  const count = Number(row.count);
  return {
    found: true,
    key,
    count,
    windowStart: new Date(String(row.window_start)).toISOString(),
    resetsAt: new Date(String(row.resets_at)).toISOString(),
    expired,
    blocked: !expired && count >= limit,
    limit,
  };
}

/** The ONLY mutation: delete the single row with this exact key. Returns the deleted rows. */
export async function resetLimit(sql: Sql, key: string) {
  if (!/^email:[0-9a-f]{64}$/.test(key)) throw new Error('refusing: not an email limit key');
  return sql('delete from rate_limits where key = $1 returning key, count, window_start', [key]);
}
