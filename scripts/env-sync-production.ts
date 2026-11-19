/**
 * Synchronize an allowlist of variables from the local `.env` to one Vercel environment.
 *
 *   npm run env:sync:production -- --dry-run
 *       names, operations and the resolved Vercel project; modifies nothing
 *   npm run env:sync:production -- --expect-project <projectId>
 *       shows the plan, then asks you to type a confirmation phrase in a terminal
 *
 * Options:
 *   --dry-run                 preview only (exit 1 if an apply would be refused)
 *   --expect-project <id>     REQUIRED to apply; must equal the linked projectId (see --dry-run)
 *   --expect-org <id>         optional extra check against the linked orgId
 *   --only A,B                subset of the allowlist
 *   --allow-secret-rotation   needed (with --only) to touch REPORT_TOKEN_SECRET / CRON_SECRET
 *   --offline                 dry run without calling the Vercel CLI
 *   --env-file <path>         source file (default .env; must be git-ignored)
 *
 * Needs the official Vercel CLI, logged in and linked (`vercel link`). Values go to the CLI on
 * stdin only; they are never printed. No deployment is triggered. See README "Environment sync".
 */
import readline from 'node:readline/promises';
import { createVercelRunner, runSync, type SyncTarget } from './lib/env-sync';

export type Args = {
  dryRun: boolean;
  check: boolean;
  target: SyncTarget;
  offline: boolean;
  allowRotation: boolean;
  envFile: string;
  only?: string[];
  expectProject?: string;
  expectOrg?: string;
};

export const USAGE =
  'Usage: npm run env:check | npm run env:sync:preview | npm run env:sync:production -- ' +
  '[--target preview|production] [--dry-run] [--expect-project <projectId>] [--expect-org <orgId>] ' +
  '[--only A,B] [--allow-secret-rotation] [--offline] [--env-file <path>]';

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    check: false,
    target: 'production',
    offline: false,
    allowRotation: false,
    envFile: '.env',
  };
  let targetSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--check') {
      args.check = true;
      args.dryRun = true;
    }
    else if (flag === '--target') {
      if (targetSeen) throw new Error('--target may only be specified once');
      targetSeen = true;
      const value = argv[(i += 1)];
      if (value !== 'preview' && value !== 'production')
        throw new Error(`--target must be preview or production\n${USAGE}`);
      args.target = value;
    } else if (flag === '--offline') args.offline = true;
    else if (flag === '--allow-secret-rotation') args.allowRotation = true;
    else if (
      flag === '--env-file' ||
      flag === '--only' ||
      flag === '--expect-project' ||
      flag === '--expect-org'
    ) {
      const value = argv[(i += 1)];
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
      if (flag === '--env-file') args.envFile = value;
      else if (flag === '--expect-project') args.expectProject = value;
      else if (flag === '--expect-org') args.expectOrg = value;
      else
        args.only = value
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean);
    } else throw new Error(`Unknown option: ${flag}\n${USAGE}`);
  }
  if (args.check && targetSeen) throw new Error('--check compares both targets; omit --target');
  return args;
}

type InputLike = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: unknown };
type OutputLike = NodeJS.WritableStream & { isTTY?: boolean };
export type Io = { stdin: InputLike; stdout: OutputLike };

/**
 * Asks for an exact phrase. A pipe, CI job or script cannot confirm on a human's behalf: both
 * stdin and stdout must be terminals.
 */
export function createConfirm(io: Io) {
  return async (summary: string, phrase: string): Promise<boolean> => {
    if (!io.stdin.isTTY || !io.stdout.isTTY)
      throw new Error('Confirmation needs an interactive terminal. Use --dry-run to preview.');
    io.stdout.write(`\n${summary}\n`);
    const rl = readline.createInterface({
      input: io.stdin,
      output: io.stdout,
      terminal: typeof io.stdin.setRawMode === 'function',
    });
    try {
      return (await rl.question(`Type "${phrase}" to continue: `)).trim() === phrase;
    } finally {
      rl.close();
    }
  };
}

export type MainDeps = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io?: Io;
  /** Receives every printed line; defaults to console.log. */
  log?: (line: string) => void;
  error?: (line: string) => void;
};

/** Returns the process exit code. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  try {
    const args = parseArgs(argv);
    const cwd = deps.cwd ?? process.cwd();
    const env = deps.env ?? process.env;
    const io = deps.io ?? { stdin: process.stdin, stdout: process.stdout };
    const bin = env.VERCEL_BIN || 'vercel';
    const runTarget = (target: SyncTarget) => runSync({
      cwd,
      env,
      envFile: args.envFile,
      dryRun: args.dryRun,
      target,
      offline: args.offline,
      only: args.only,
      allowRotation: args.allowRotation,
      expectProject: args.expectProject,
      expectOrg: args.expectOrg,
      makeRunner: ({ secrets, env: childEnv, target: selectedTarget }) =>
        createVercelRunner({ bin, cwd, env: childEnv, secrets, target: selectedTarget }),
      confirm: createConfirm(io),
      log,
    });
    if (args.check) {
      const results = [await runTarget('preview'), await runTarget('production')];
      return results.some((result) => result.problems.length > 0) ? 1 : 0;
    }
    const result = await runTarget(args.target);
    // A dry run that reveals an apply would be refused must not look like a clean success.
    return args.dryRun && result.problems.length > 0 ? 1 : 0;
  } catch (caught) {
    error(caught instanceof Error ? caught.message : 'Environment sync failed');
    return 1;
  }
}

if (process.argv[1]?.endsWith('env-sync-production.ts'))
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
