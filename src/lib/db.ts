import { neon } from '@neondatabase/serverless';
import { createStore, type ReportStore, type SqlExecutor } from './store';

/** Returns the Postgres-backed store, or null when DATABASE_URL is not configured. */
export function createReportStore(): ReportStore | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const client = neon(url);
  const exec: SqlExecutor = async (text, params = []) =>
    (await client.query(text, params)) as Array<Record<string, unknown>>;
  return createStore(exec);
}
