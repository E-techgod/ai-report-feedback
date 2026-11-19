/**
 * End-to-end smoke test helper for the Neon Postgres wiring. It never touches Google Sheets,
 * Claude or email: the narrative is stubbed and the report is created with email disabled.
 *
 *   node --env-file=.env --import tsx scripts/neon-smoke.ts check
 *   REPORT_TOKEN_SECRET=<32+ chars> node --env-file=.env --import tsx scripts/neon-smoke.ts seed
 *   node --env-file=.env --import tsx scripts/neon-smoke.ts cleanup <reportId> <sinceISO>
 *
 * `seed` writes ONE clearly marked synthetic row ("PRUEBA NEON", @example.invalid).
 * `cleanup` removes exactly that row, its audit events, and the rate-limit counters created since.
 */
import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { reportAccessToken } from '../src/lib/final-report';
import { questionIds } from '../src/lib/questions';
import { DEFAULT_CONFIG, createReport } from '../src/lib/pipeline';
import { fallbackNarrative } from '../src/lib/report';
import { createReportStore } from '../src/lib/db';

const [command, arg1, arg2] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const sql = neon(url);
const host = new URL(url).hostname;

// Wrapped in main(): tsx compiles scripts as CommonJS, which has no top-level await.
async function main() {
if (command === 'check') {
  const version = await sql.query('select version() as v, current_database() as db');
  const tables = await sql.query(
    "select table_name from information_schema.tables where table_schema = 'public' order by 1",
  );
  console.log(JSON.stringify({ host, db: version[0].db, version: String(version[0].v).slice(0, 40), tables: tables.map((t) => t.table_name) }));
} else if (command === 'seed') {
  const secret = process.env.REPORT_TOKEN_SECRET;
  if (!secret || secret.length < 32) throw new Error('REPORT_TOKEN_SECRET (>= 32 chars) is required');
  const store = createReportStore();
  if (!store) throw new Error('store unavailable');
  const yes = new Set(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B5']);
  const submission = {
    id: randomUUID(),
    firstName: 'PRUEBA',
    lastName: 'NEON',
    email: `prueba-neon-${Date.now()}@example.invalid`,
    privacyAccepted: true as const,
    answers: Object.fromEntries(questionIds.map((id) => [id, yes.has(id)])),
  };
  const { record, created } = await createReport(
    {
      store,
      mailer: null, // email can never be sent from this script
      generateNarrative: async (model) => ({ narrative: fallbackNarrative(model), source: 'template', failureReason: 'smoke-test' }),
      renderPdf: async () => Buffer.alloc(0),
      config: { ...DEFAULT_CONFIG, bookingUrl: null, emailEnabled: false, siteUrl: null },
    },
    submission,
  );
  console.log(JSON.stringify({ id: record.id, created, emailStatus: record.emailStatus, token: reportAccessToken(record.id, secret), since: new Date(Date.now() - 60_000).toISOString() }));
} else if (command === 'cleanup') {
  if (!arg1 || !arg2) throw new Error('usage: cleanup <reportId> <sinceISO>');
  // Only ever deletes the synthetic row created by `seed` (guarded by its reserved address).
  const guard = "email like 'prueba-neon-%@example.invalid'";
  const events = await sql.query(
    `delete from report_email_events where report_id = $1 and exists (select 1 from reports where id = $1 and ${guard}) returning id`,
    [arg1],
  );
  const reports = await sql.query(`delete from reports where id = $1 and ${guard} returning id`, [arg1]);
  const limits = await sql.query(
    "delete from rate_limits where window_start >= $1 and (key like 'ip:report:%' or key like 'ip:pdf:%' or key like 'gen:%' or key like 'email:%') returning key",
    [arg2],
  );
  console.log(JSON.stringify({ deletedEvents: events.length, deletedReports: reports.length, deletedRateLimitKeys: limits.length }));
} else {
  throw new Error('usage: check | seed | cleanup <reportId> <sinceISO>');
}
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
