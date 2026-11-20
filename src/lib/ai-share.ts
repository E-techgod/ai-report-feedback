import { finalReportSchema, REPORT_VERSION, type FinalReport } from './final-report';
import { buildReportContent, flattenContent } from './report-content';
import {
  MAX_CONTEXT_WORDS,
  MAX_SUMMARY_WORDS,
  wordCount,
  type ReportModel,
  type Narrative,
} from './report';

/**
 * AI text may be at most 15% of the report's user-visible words. "Visible words" are the words
 * of every string in buildReportContent() (the single source of the web view, PDF and email).
 * Words are counted with wordCount(), the same function that enforces the per-slot limits.
 */
export const MAX_AI_SHARE = 0.15;

/** Words the AI wrote in this report (0 for template text, which is never counted as AI). */
export function aiWordCount(report: FinalReport): number {
  if (report.narrativeSource !== 'ai') return 0;
  const { executiveSummary, priorityContexts } = report.narrative;
  return wordCount(executiveSummary) + priorityContexts.reduce((n, c) => n + wordCount(c), 0);
}

export function visibleWordCount(report: FinalReport): number {
  return flattenContent(buildReportContent(report)).reduce((n, s) => n + wordCount(s), 0);
}

export function aiShare(report: FinalReport): number {
  const total = visibleWordCount(report);
  return total === 0 ? 0 : aiWordCount(report) / total;
}

export function exceedsAiShare(report: FinalReport): boolean {
  return aiShare(report) > MAX_AI_SHARE;
}

export type AiWordLimits = { summary: number; context: number; total?: number };

export const DEFAULT_LIMITS: AiWordLimits = {
  summary: MAX_SUMMARY_WORDS,
  context: MAX_CONTEXT_WORDS,
};

const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

/**
 * Combined word budget that keeps the AI at or under 15% for THIS report. The deterministic words
 * (everything except the AI slots) are counted from a draft report with empty AI slots, no first
 * name and a booking link: the smallest the fixed text can be, so the limit is conservative
 * (a longer name or a missing link only adds fixed words). Zod enforces both field caps and total.
 */
export function aiWordLimits(model: ReportModel): AiWordLimits {
  const empty: Narrative = {
    executiveSummary: '',
    priorityContexts: model.priorities.map(() => ''),
  };
  const draft = finalReportSchema.parse({
    version: REPORT_VERSION,
    reportId: PLACEHOLDER_ID,
    submissionId: PLACEHOLDER_ID,
    firstName: '',
    generatedAt: new Date(0).toISOString(),
    model,
    narrative: empty,
    narrativeSource: 'ai',
    aiFailureReason: null,
    bookingUrl: 'https://example.com',
  });
  const fixedWords = visibleWordCount(draft);
  const budget = Math.floor((MAX_AI_SHARE / (1 - MAX_AI_SHARE)) * fixedWords);
  return {
    summary: Math.min(MAX_SUMMARY_WORDS, budget),
    context: model.priorities.length === 0 ? 0 : Math.min(MAX_CONTEXT_WORDS, budget),
    total: budget,
  };
}

/** What the prompt asks for: a little under the enforced limit so a valid answer is not rejected. */
export function promptWordTarget(limit: number): number {
  if (limit === 0) return 0;
  return Math.max(1, Math.floor(limit * 0.85));
}
