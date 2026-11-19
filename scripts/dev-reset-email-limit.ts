/**
 * Development-only: inspect or reset the per-email report limit for TEST addresses.
 *
 *   # read-only (default): shows count, window_start, resets_at for each address
 *   node --env-file=.env --import tsx scripts/dev-reset-email-limit.ts --email a@x.com --email b@y.com
 *
 *   # delete exactly one rate_limits row (all guards must pass; see applyProblems())
 *   node --env-file=.env --import tsx scripts/dev-reset-email-limit.ts --email a@x.com --apply \
 *     --confirm-endpoint ep-... --confirm-email a@x.com
 *
 * Never run against production: apply is refused on protected Neon branches, in production
 * environments, for addresses outside REPORT_EMAIL_ALLOWLIST, and without both confirmations.
 * It never prints the connection string. Options: --neon-context <path> (default ./.neon).
 */
import { neon } from '@neondatabase/serverless';
import {
  applyProblems,
  endpointOf,
  inspectLimit,
  limitKey,
  pinnedBranch,
  resetLimit,
  testAddresses,
  type Sql,
} from './lib/dev-reset-email-limit';

function parseArgs(argv: string[]) {
  const args = {
    emails: [] as string[],
    apply: false,
    confirmEndpoint: undefined as string | undefined,
    confirmEmail: undefined as string | undefined,
    neonContext: '.neon',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[(i += 1)];
      if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === '--email') args.emails.push(value());
    else if (flag === '--apply') args.apply = true;
    else if (flag === '--confirm-endpoint') args.confirmEndpoint = value();
    else if (flag === '--confirm-email') args.confirmEmail = value();
    else if (flag === '--neon-context') args.neonContext = value();
    else throw new Error(`unknown option ${flag}`);
  }
  if (args.emails.length === 0) throw new Error('at least one --email is required');
  return args;
}

// Wrapped in main(): tsx compiles scripts as CommonJS, which has no top-level await.
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const endpoint = endpointOf(url);
  const branch = pinnedBranch(args.neonContext);
  console.log(`database endpoint: ${endpoint ?? 'unknown'} | pinned branch: ${branch ?? 'unknown'}`);

  const client = neon(url);
  const sql: Sql = async (text, params = []) =>
    (await client.query(text, params)) as Array<Record<string, unknown>>;

  if (args.apply) {
    const problems = applyProblems({
      emails: args.emails,
      allowlist: testAddresses(process.env.REPORT_EMAIL_ALLOWLIST),
      env: process.env,
      endpoint,
      branch,
      confirmEndpoint: args.confirmEndpoint,
      confirmEmail: args.confirmEmail,
    });
    if (problems.length > 0) {
      console.error('REFUSED, nothing was changed:');
      for (const problem of problems) console.error(` - ${problem}`);
      process.exit(2);
    }
  }

  for (const email of args.emails) {
    const key = limitKey(email);
    const state = await inspectLimit(sql, key);
    console.log(JSON.stringify({ email, ...state }));
    if (args.apply) {
      const deleted = await resetLimit(sql, key);
      console.log(JSON.stringify({ email, deletedRows: deleted.length, deleted }));
    }
  }
  if (!args.apply) console.log('read-only run: nothing was changed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
