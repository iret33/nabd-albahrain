/**
 * The one honest sentence the hero and the footer show next to the freshness
 * timestamps when something is off. Pure, so the wording and the thresholds
 * are testable and identical on every page that shows them.
 *
 * "Off" means one of two things, deliberately kept separate:
 *  - the latest sync run did not complete (failed, or aborted by a crash or a
 *    restart): the data on screen is the last good copy, and we say so;
 *  - the last SUCCESSFUL run is older than `staleAfterMs` (the same rule as
 *    GET /api/freshness `stale`: twice the auto-sync interval, 48h when the
 *    scheduler is off): the scheduler may have silently stopped.
 *
 * A run that is still "running" or finished "partial" raises no notice here.
 * "partial" means the run completed but some individual datasets FAILED (a
 * deferred large dataset never changes a run's status); a persistently failing
 * dataset is surfaced per dataset and by /api/health/ready, because a banner on
 * every page for one sticky failure would cry wolf.
 */

export interface FreshnessNoticeInput {
  /** Status of the most recent sync run, if any ("running" | "success" | "partial" | "failed" | "aborted"). */
  latestRunStatus: string | null | undefined;
  /** Last time a run finished with success/partial; null = never. */
  lastSuccessAt: Date | null | undefined;
  now: Date;
  staleAfterMs: number;
}

export const FAILED_RUN_NOTICE = "آخر محاولة تحديث لم تكتمل — تُعرض آخر بيانات محفوظة بنجاح";
export const STALE_NOTICE = "قد تكون البيانات قديمة — لم تنجح مزامنة جديدة منذ فترة";
export const FAILED_AND_STALE_NOTICE = "آخر محاولة تحديث لم تكتمل، وقد تكون البيانات قديمة";

/** True when the last successful run is older than `staleAfterMs`. Never synced is NOT stale here: that is the empty state. */
export function isDataStale(lastSuccessAt: Date | null | undefined, now: Date, staleAfterMs: number): boolean {
  if (!lastSuccessAt) return false;
  return now.getTime() - lastSuccessAt.getTime() > staleAfterMs;
}

export function freshnessNotice(input: FreshnessNoticeInput): string | null {
  const failed = input.latestRunStatus === "failed" || input.latestRunStatus === "aborted";
  const stale = isDataStale(input.lastSuccessAt, input.now, input.staleAfterMs);
  if (failed && stale) return FAILED_AND_STALE_NOTICE;
  if (failed) return FAILED_RUN_NOTICE;
  if (stale) return STALE_NOTICE;
  return null;
}
