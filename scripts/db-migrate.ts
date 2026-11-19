/**
 * Applies db/schema.sql to DATABASE_URL (Neon). Idempotent (create ... if not exists).
 *
 *   node --env-file=.env --import tsx scripts/db-migrate.ts
 *
 * Creates/extends the report tables. It never touches Google Sheets or questionnaire responses.
 */
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

// Migrations use the DIRECT (non-pooled) connection when available: the pooler runs in transaction
// mode and does not support session-level operations. Falls back to DATABASE_URL.
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL_UNPOOLED / DATABASE_URL is not set');
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

// Wrapped in main(): tsx compiles scripts as CommonJS, which has no top-level await.
async function main() {
  for (const statement of statements) {
    await client.query(statement);
  }
  console.log(`Applied ${statements.length} statements.`);
}

main().catch((error) => {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
