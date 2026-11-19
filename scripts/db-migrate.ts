/**
 * Applies db/schema.sql to DATABASE_URL (Neon). Idempotent (create ... if not exists).
 *
 *   node --env-file=.env --import tsx scripts/db-migrate.ts
 *
 * Only creates the new `reports`, `report_email_events` and `rate_limits` tables. It never touches
 * Google Sheets or the questionnaire responses.
 */
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const client = neon(url);
const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');
const statements = schema
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

for (const statement of statements) {
  await client.query(statement);
}
console.log(`Applied ${statements.length} statements.`);
