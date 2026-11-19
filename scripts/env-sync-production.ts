/**
 * Synchronize an allowlist of variables from the local `.env` to Vercel PRODUCTION.
 *
 *   npm run env:sync:production -- --dry-run     # names and operations only, modifies nothing
 *   npm run env:sync:production                  # shows the plan, asks you to type a confirmation
 *
 * Options: --dry-run  --offline (skip the read-only `vercel env ls`)  --env-file <path>
 *          --only NAME[,NAME]  (subset of the allowlist)
 *
 * Needs the official Vercel CLI, logged in and linked (`vercel link`). Values go to the CLI on
 * stdin only; they are never printed. No deployment is triggered. See README "Environment sync".
 */
import readline from 'node:readline/promises';
import { createVercelRunner, runSync } from './lib/env-sync';

type Args = { dryRun: boolean; offline: boolean; envFile: string; only?: string[] };

const USAGE =
  'Usage: npm run env:sync:production -- [--dry-run] [--offline] [--env-file <path>] [--only A,B]';

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, offline: false, envFile: '.env' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--offline') args.offline = true;
    else if (flag === '--env-file' || flag === '--only') {
      const value = argv[(i += 1)];
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
      if (flag === '--env-file') args.envFile = value;
      else args.only = value.split(',').map((name) => name.trim()).filter(Boolean);
    } else throw new Error(`Unknown option: ${flag}\n${USAGE}`);
  }
  return args;
}

async function confirmInteractively(summary: string): Promise<boolean> {
  // A pipe, CI job or script cannot confirm on a human's behalf.
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Confirmation needs an interactive terminal. Use --dry-run to preview.');
  console.log(`\n${summary}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question('Type "sync production" to continue: ')).trim() === 'sync production';
  } finally {
    rl.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const bin = process.env.VERCEL_BIN || 'vercel';
  await runSync({
    cwd,
    envFile: args.envFile,
    dryRun: args.dryRun,
    offline: args.offline,
    only: args.only,
    makeRunner: (secrets) => createVercelRunner({ bin, cwd, secrets }),
    confirm: confirmInteractively,
    log: (line) => console.log(line),
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Environment sync failed');
  process.exitCode = 1;
});
