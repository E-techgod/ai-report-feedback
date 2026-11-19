import { z } from 'zod';
import { NextResponse } from 'next/server';
import { verifyReportAccessToken } from '@/lib/final-report';
import { publicEmailStatus } from '@/lib/pipeline';
import { NO_STORE, getPipelineDeps, ipLimited, reportTokenSecret } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: NO_STORE });

/**
 * Returns the stored finalized report and the real email status. Never calls Claude.
 * Requires the access token issued with the report; unknown ids and wrong tokens look identical.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const deps = getPipelineDeps();
  const secret = reportTokenSecret();
  if (!deps || !secret) return json({ ok: false }, 503);

  const { id } = await params;
  // Header only (never the URL), so the token stays out of logs, history and referrers.
  const token = req.headers.get('x-report-token') ?? '';
  if (!z.string().uuid().safeParse(id).success) return json({ ok: false }, 404);
  if (await ipLimited(deps.store, req, 'report', 120, 60)) return json({ ok: false }, 429);
  if (!verifyReportAccessToken(id, token, secret)) return json({ ok: false }, 404);

  const record = await deps.store.getById(id);
  if (!record) return json({ ok: false }, 404);
  return json({ ok: true, report: record.report, email: publicEmailStatus(record, deps.config) });
}
