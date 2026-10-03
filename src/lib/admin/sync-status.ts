/**
 * Pure helpers that turn raw `SyncLog` rows into what the admin dashboard
 * shows. No Prisma/Next imports so they are unit-testable.
 *
 * Since the freshness migration a run is created as `running` and finalized to
 * `success | partial | failed | aborted` in a `finally` block, so a healthy
 * database never needs the fallbacks below. They exist because two kinds of
 * rows can still carry a misleading stored status:
 *   - rows written by the pre-migration engine AFTER the migration ran (the
 *     column default is `running`, but `finishedAt` is set), and
 *   - a run whose process died before finalizing (status stays `running`
 *     forever, `finishedAt` null) — shown as aborted once nothing holds the lock.
 */

export type SyncRunStatus = "running" | "success" | "partial" | "failed" | "aborted";

export const SYNC_RUN_STATUS_LABEL: Record<SyncRunStatus, string> = {
  running: "قيد التنفيذ",
  success: "نجحت",
  partial: "جزئية",
  failed: "فشلت",
  aborted: "أُوقفت",
};

/** Badge colours, matching the dataset-status palette in the dashboard. */
export const SYNC_RUN_STATUS_COLOR: Record<SyncRunStatus, string> = {
  running: "#2f6f8f",
  success: "#3e8e7e",
  partial: "#c9a961",
  failed: "#a6473f",
  aborted: "#7b6a4d",
};

const FINAL_STATUSES: readonly string[] = ["success", "partial", "failed", "aborted"];

export interface SyncLogStatusInput {
  status: string;
  finishedAt: Date | string | null;
  processed: number;
  succeeded: number;
  failed: number;
}

/**
 * The status to display for a log row. `isLatest` + `lockRunning` say whether a
 * live run could plausibly own a still-`running` row; only the newest row can.
 * Returns null for a status string this code does not know (render it raw).
 */
export function resolveSyncRunStatus(
  log: SyncLogStatusInput,
  ctx: { isLatest: boolean; lockRunning: boolean },
): SyncRunStatus | null {
  if (FINAL_STATUSES.includes(log.status)) return log.status as SyncRunStatus;
  if (log.status !== "running") return null;

  if (log.finishedAt) {
    // Same classification the migration used for legacy rows.
    if (log.failed > 0 && log.succeeded > 0) return "partial";
    if (log.failed > 0) return "failed";
    return "success";
  }
  return ctx.isLatest && ctx.lockRunning ? "running" : "aborted";
}

const TRIGGER_LABEL: Record<string, string> = {
  cli: "سطر الأوامر",
  api: "الواجهة البرمجية",
  auto: "تلقائي (مجدول)",
  public: "زر التحديث العام",
};

export function describeTrigger(trigger: string): string {
  return TRIGGER_LABEL[trigger] ?? trigger;
}

/** "all" | "changed" | "dataset:<id>" | "recompute" | null (legacy rows). */
export function describeScope(scope: string | null | undefined): string | null {
  if (!scope) return null;
  if (scope === "all") return "كل المجموعات";
  if (scope === "changed") return "المتغيّر فقط";
  if (scope === "recompute") return "إعادة حساب المخططات";
  if (scope.startsWith("dataset:")) return `مجموعة: ${scope.slice("dataset:".length)}`;
  return scope;
}

/**
 * Which "last run" banner (if any) to show. Failed is a red alarm; aborted is
 * an amber warning (usually a restart mid-run); a still-running or healthy
 * latest run shows nothing.
 */
export function lastRunAlert(status: SyncRunStatus | null): "failed" | "aborted" | null {
  return status === "failed" || status === "aborted" ? status : null;
}
