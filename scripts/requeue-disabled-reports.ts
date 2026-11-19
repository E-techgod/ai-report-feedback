/**
 * Cutover helper. DRY RUN by default. Reads only explicit report IDs from --ids-file;
 * it never sends mail, changes Apps Script, or discovers historical rows automatically.
 *
 * node --env-file=.env --import tsx scripts/requeue-disabled-reports.ts \
 *   --ids-file reviewed-report-ids.txt --since 2026-11-19T00:00:00Z \
 *   --until 2026-11-19T01:00:00Z
 *
 * After human cutover approval only, add --apply --legacy-off-confirmed
 * --legacy-delivery-audited. The normal email queue then processes the selected reports.
 */
import { readFileSync } from 'node:fs';
import { createReportStore } from '../src/lib/db';
import { DEFAULT_CONFIG } from '../src/lib/pipeline';

function option(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing --${name}`);
  return value;
}

function dateOption(name: string): Date {
  const value = new Date(option(name));
  if (!Number.isFinite(value.getTime())) throw new Error(`Invalid --${name}`);
  return value;
}

export function eligibleForCutover(
  record: {
    emailStatus: string;
    emailAttempts: number;
    emailAcceptedAt: Date | null;
    emailProviderMessageId: string | null;
    sheetRowNumber: number | null;
    createdAt: Date;
  },
  since: Date,
  until: Date,
  now: Date,
): 'eligible' | 'already-queued' | 'reject' {
  if (
    record.createdAt < since ||
    record.createdAt > until ||
    record.createdAt < new Date(now.getTime() - DEFAULT_CONFIG.maxAgeMs) ||
    !record.sheetRowNumber ||
    record.emailAttempts !== 0 ||
    record.emailAcceptedAt ||
    record.emailProviderMessageId
  ) return 'reject';
  if (record.emailStatus === 'pending') return 'already-queued';
  return record.emailStatus === 'disabled' ? 'eligible' : 'reject';
}

async function main() {
  const since = dateOption('since');
  const until = dateOption('until');
  const now = new Date();
  if (since > until || until > now || until.getTime() - since.getTime() > DEFAULT_CONFIG.maxAgeMs)
    throw new Error('Cutover window must be past, ordered and no wider than 47 hours');
  const ids = [...new Set(readFileSync(option('ids-file'), 'utf8').split(/\s+/).filter(Boolean))];
  if (ids.length === 0 || ids.length > 100 || ids.some((id) =>
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))
    throw new Error('IDs file must contain 1–100 UUIDs, one per line');
  const apply = process.argv.includes('--apply');
  if (apply && (
    process.env.REPORT_EMAIL_ENABLED !== 'true' ||
    !process.argv.includes('--legacy-off-confirmed') ||
    !process.argv.includes('--legacy-delivery-audited')
  )) throw new Error('Apply requires email enabled and both legacy safety confirmations');
  const store = createReportStore();
  if (!store) throw new Error('DATABASE_URL is required');
  const candidates = await Promise.all(ids.map(async (id) => ({
    id, record: await store.getById(id),
  })));
  const statuses = candidates.map(({ id, record }) => ({
    id,
    state: record ? eligibleForCutover(record, since, until, now) : 'reject',
  }));
  for (const { id, state } of statuses) console.log(`${id} ${state}`);
  if (statuses.some(({ state }) => state === 'reject'))
    throw new Error('One or more IDs are ineligible; no changes made');
  if (!apply) {
    console.log('DRY RUN: no reports re-queued and no emails sent.');
    return;
  }
  let queued = 0;
  for (const { id, state } of statuses) {
    if (state === 'already-queued') continue;
    if (await store.requeueDisabled(id, since, until, now, DEFAULT_CONFIG.maxAgeMs)) queued += 1;
  }
  console.log(`Re-queued ${queued} reviewed reports. No email was sent by this script.`);
}

if (process.argv[1]?.endsWith('requeue-disabled-reports.ts'))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Cutover failed');
    process.exitCode = 1;
  });
