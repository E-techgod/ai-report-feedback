import { randomUUID } from 'node:crypto';
import { MAX_AI_SHARE, aiShare } from './ai-share';
import { buildFinalReport, type FinalReport, type NarrativeOutcome } from './final-report';
import { buildReportModel, fallbackNarrative, type ReportModel } from './report';
import type { Submission } from './validation';

export type ReportDeps = {
  generateNarrative: (model: ReportModel) => Promise<NarrativeOutcome>;
  bookingUrl: string | null;
  now?: () => Date;
  newId?: () => string;
};

/**
 * Builds the ONE finalized report for a submission: rules-based model + AI narrative (or the
 * approved template text when the AI is unavailable). Nothing is persisted; the report is returned
 * to the browser, which holds it for the download window.
 */
export async function generateReport(
  deps: ReportDeps,
  submission: Submission,
): Promise<FinalReport> {
  const now = () => (deps.now ?? (() => new Date()))();
  const model = buildReportModel(submission.answers);
  const outcome = await deps.generateNarrative(model);
  const reportId = (deps.newId ?? randomUUID)();
  const build = (narrativeOutcome: NarrativeOutcome) =>
    buildFinalReport({
      reportId,
      submissionId: submission.id,
      firstName: submission.firstName.trim(),
      answers: submission.answers,
      outcome: narrativeOutcome,
      bookingUrl: deps.bookingUrl,
      now: now(),
    });
  const report = build(outcome);
  // Hard guard: AI text may never exceed 15% of the visible report. If it does (a provider
  // ignoring the word limits), the report is finalized with the approved template text instead.
  if (report.narrativeSource === 'ai' && aiShare(report) > MAX_AI_SHARE) {
    console.warn('[narrative] AI share above limit: using template text');
    return build({
      narrative: fallbackNarrative(model),
      source: 'template',
      failureReason: 'ai-share-exceeded',
    });
  }
  return report;
}
