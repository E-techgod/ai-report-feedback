import { DOWNLOAD_WINDOW_MS } from './download-grant';
import type { FinalReport } from './final-report';

/**
 * Short-lived, per-instance memory of reports that were just generated, so a repeated submission
 * (a retry after a lost response, a double submit) inside the SAME 5-minute download window gets the
 * same report back instead of paying for another AI call.
 *
 * This is an optimization, never a source of truth or a retrieval mechanism:
 *  - an entry dies when its download window ends (nothing can be recovered afterwards);
 *  - it lives only in this function instance's memory (never written anywhere);
 *  - a miss (another instance, a cold start) is always handled: the duplicate gets the approved
 *    template text, still with no AI call (see questionnaire-handler.ts).
 */
export type CachedReport = {
  report: FinalReport;
  /** When the download window of this report opened (epoch ms). */
  startedAtMs: number;
};

export type ReportCache = {
  get(submissionId: string, nowMs: number): CachedReport | undefined;
  set(submissionId: string, entry: CachedReport): void;
};

export function createReportCache(maxEntries = 200): ReportCache {
  const entries = new Map<string, CachedReport>();
  return {
    get(submissionId, nowMs) {
      const entry = entries.get(submissionId);
      if (!entry) return undefined;
      if (entry.startedAtMs + DOWNLOAD_WINDOW_MS <= nowMs) {
        entries.delete(submissionId);
        return undefined;
      }
      return entry;
    },
    set(submissionId, entry) {
      entries.set(submissionId, entry);
      // Bound the memory: drop the oldest entries (Map keeps insertion order).
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
    },
  };
}

/** The cache the production route uses (one per function instance). */
export const defaultReportCache = createReportCache();
