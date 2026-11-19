import { NextResponse } from 'next/server';
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

  const summary = await processDueEmails(deps);
  await deps.store.purgeRateLimits(new Date(Date.now() - 2 * 86_400_000));
  return NextResponse.json({ ok: true, ...summary }, { headers: NO_STORE });
}
