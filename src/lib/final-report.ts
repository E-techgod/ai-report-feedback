import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { questionIds } from './questions';
import { buildReportModel, type Narrative } from './report';
import type { Answers } from './scoring';

/**
 * The finalized report: the ONE object the website, the PDF and the email are rendered from.
 * It is built once on the server, stored, and never regenerated or edited afterwards.
 * Everything customer-visible (see report-content.ts) is a pure function of this object.
 */
export const REPORT_VERSION = 1;

const areaSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['solid', 'review']),
  yes: z.number().int(),
  total: z.number().int(),
});

export const finalReportSchema = z.object({
  version: z.literal(REPORT_VERSION),
  reportId: z.string().uuid(),
  submissionId: z.string().uuid(),
  firstName: z.string(),
  generatedAt: z.string(),
  model: z.object({
    score: z.object({
      yes: z.number(),
      no: z.number(),
      protection: z.number(),
      gap: z.number(),
      personalYes: z.number(),
      businessYes: z.number(),
      personalPercent: z.number(),
      businessPercent: z.number(),
      category: z.string(),
      missing: z.array(z.string()),
    }),
    level: z.string(),
    levelTone: z.enum(['low', 'mid', 'high']),
    weakCount: z.number().int(),
    personalAreas: z.array(areaSchema),
    businessAreas: z.array(areaSchema),
    priorities: z.array(
      z.object({
        rank: z.number().int(),
        themeId: z.string(),
        title: z.string(),
        finding: z.string(),
        action: z.string(),
        context: z.string(),
      }),
    ),
    focus: z.string(),
    plan: z.array(z.object({ stage: z.string(), title: z.string(), text: z.string() })),
  }),
  narrative: z.object({
    executiveSummary: z.string(),
    priorityContexts: z.array(z.string()),
  }),
  /** 'ai' only when Claude's output passed the schema; otherwise 'template' (stated in the report). */
  narrativeSource: z.enum(['ai', 'template']),
  aiFailureReason: z.string().nullable(),
  /** Frozen at generation so web, PDF and email always point to the same booking page. */
  bookingUrl: z.string().url().nullable(),
});
export type FinalReport = z.infer<typeof finalReportSchema>;

export type NarrativeOutcome = {
  narrative: Narrative;
  source: 'ai' | 'template';
  failureReason: string | null;
};

export function buildFinalReport(input: {
  reportId: string;
  submissionId: string;
  firstName: string;
  answers: Answers;
  outcome: NarrativeOutcome;
  bookingUrl: string | null;
  now: Date;
}): FinalReport {
  const model = buildReportModel(input.answers);
  return deepFreeze(
    finalReportSchema.parse({
      version: REPORT_VERSION,
      reportId: input.reportId,
      submissionId: input.submissionId,
      firstName: input.firstName,
      generatedAt: input.now.toISOString(),
      model,
      narrative: input.outcome.narrative,
      narrativeSource: input.outcome.source,
      aiFailureReason: input.outcome.source === 'ai' ? null : input.outcome.failureReason,
      bookingUrl: input.bookingUrl,
    }),
  );
}

/** Parses a stored report; throws if it was tampered with or has an unknown shape. */
export function parseFinalReport(value: unknown): FinalReport {
  return deepFreeze(finalReportSchema.parse(value));
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : 1,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Stable SHA-256 of the report; stored with it so tampering/corruption is detectable. */
export function reportHash(report: FinalReport): string {
  return createHash('sha256').update(canonical(report)).digest('hex');
}

/** Identifies "same person, same answers" regardless of the client-generated submission id. */
export function submissionFingerprint(email: string, answers: Answers): string {
  const bits = questionIds.map((id) => (answers[id] ? '1' : '0')).join('');
  return createHash('sha256').update(`${email.trim().toLowerCase()}|${bits}`).digest('hex');
}

export function emailKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/**
 * Access token for one report: HMAC(secret, reportId). Returned only to the browser that created
 * the report; it is recomputed (not stored) to authorize reading the report or its PDF.
 */
export function reportAccessToken(reportId: string, secret: string): string {
  return createHmac('sha256', secret).update(`report:${reportId}`).digest('hex');
}

export function verifyReportAccessToken(reportId: string, token: string, secret: string): boolean {
  const expected = Buffer.from(reportAccessToken(reportId, secret));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
