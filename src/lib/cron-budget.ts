/** Keep an eight-second reserve below the 60-second route limit for DB cleanup/response. */
export const CRON_EMAIL_BUDGET_MS = 25_000;
export const CRON_TRACKING_BUDGET_MS = 12_000;
export const CRON_WORK_DEADLINE_MS = 52_000;
export const TRACKING_ATTEMPT_MAX_MS = 8_000;

export function trackingDeadline(startedAt: number, trackingStartedAt: number): number {
  return Math.min(startedAt + CRON_WORK_DEADLINE_MS, trackingStartedAt + CRON_TRACKING_BUDGET_MS);
}

export function trackingAttemptBudget(deadline: number, now: number): number {
  return Math.max(0, Math.min(TRACKING_ATTEMPT_MAX_MS, deadline - now));
}
