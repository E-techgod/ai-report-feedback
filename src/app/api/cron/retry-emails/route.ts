import { NextResponse } from 'next/server';
import { CRON_EMAIL_BUDGET_MS, trackingAttemptBudget, trackingDeadline } from '@/lib/cron-budget';
import { processDueEmails } from '@/lib/pipeline';
import { NO_STORE, getPipelineDeps, secretMatches } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Recovery sweep, called by Vercel Cron with `Authorization: Bearer $CRON_SECRET`.
 * Retries report emails that were never sent or failed (bounded attempts and age), and prunes
 * old rate-limit counters. Safe to run concurrently: each send is claimed atomically.
 */
export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  const bearer = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
  if (!secretMatches(bearer, expected)) {
    return NextResponse.json({ ok: false }, { status: 401, headers: NO_STORE });
  }
  const deps = getPipelineDeps();
  if (!deps) return NextResponse.json({ ok: false }, { status: 503, headers: NO_STORE });

  const started = Date.now();
  const summary = await processDueEmails(deps, { budgetMs: CRON_EMAIL_BUDGET_MS });
  // A failed Sheets write never re-sends an email: retry only the projection from Neon.
  let trackingSynced = 0;
  let trackingFailed = 0;
  const deadline = trackingDeadline(started, Date.now());
  if (deps.syncTracking && trackingAttemptBudget(deadline, Date.now()) > 0) {
    const ids = await deps.store.listUnsynced(25);
    for (const id of ids) {
      const budget = trackingAttemptBudget(deadline, Date.now());
      if (budget <= 0) break;
      try {
        if (await deps.syncTracking(id, budget)) trackingSynced += 1;
      } catch {
        trackingFailed += 1;
        console.error(`[tracking] report ${id}: sync-failed`);
      }
    }
  }
  await deps.store.purgeRateLimits(new Date(Date.now() - 2 * 86_400_000));
  return NextResponse.json(
    { ok: true, ...summary, trackingSynced, trackingFailed },
    { headers: NO_STORE },
  );
}
