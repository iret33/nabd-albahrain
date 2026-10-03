/**
 * Built-in scheduler: keeps the data fresh without a host crontab.
 *
 * Started from `src/instrumentation.ts` when the Node server boots. It wakes
 * at most every min(interval, 5) minutes and lets the DATABASE decide whether
 * a run is due (`SyncState.lastFullPassAt` older than ~0.9 x the interval), so
 * restarts and multiple app instances are safe: a restart does not reset the
 * schedule, and two instances racing for the same slot are serialized by the
 * sync lock (the loser just logs and moves on).
 *
 * The due-clock is `lastFullPassAt`, NOT `lastCatalogCheckAt`: only an
 * unrestricted catalog-wide run (this scheduler, the admin button, the CLI)
 * advances it. A visitor's public refresh also checks the catalog, but it
 * defers the datasets over PUBLIC_REFRESH_MAX_RECORDS and beyond five per
 * press, so if it counted, a visitor pressing every few hours would keep the
 * scheduled pass (the only automatic path that downloads those) from ever
 * running.
 *
 * The timers are `unref()`'d so they never keep the process alive, and a tick
 * can never throw into the server: every failure is logged and the next wake
 * retries.
 *
 * Heavy runs happen inside the web process here; for a very large catalog run
 * the same engine from the CLI bundle (`dist/sync-cli.cjs`) in a separate
 * container — the lock keeps both safe.
 */

import { prisma } from "@/lib/prisma";
import {
  getAutoSyncFirstDelaySeconds,
  getAutoSyncIntervalMinutes,
} from "./config";
import { runSync } from "./engine";
import { SyncAlreadyRunningError } from "./lock";
import { maybePruneSyncLogs, sweepOrphanedRuns } from "./log";
import { countDatasetsNeedingRecompute, runRecompute } from "./recompute";
import { installShutdownHandlers } from "./runtime";

/** A run is due once the last unrestricted catalog pass is older than this fraction of the interval. */
const DUE_FRACTION = 0.9;
/** After a failed run, wait at least this long (minutes, capped by the interval) before retrying. */
const FAILURE_BACKOFF_MINUTES = 15;
/**
 * A legacy dataset pulls a pass forward only when the last full pass is older
 * than this (minutes, capped at a quarter of the interval): a row that no pass
 * can repair must not turn every 5-minute wake into a full catalog fetch.
 */
const CATCH_UP_MIN_GAP_MINUTES = 15;

/** Minimum gap between two catch-up passes (see CATCH_UP_MIN_GAP_MINUTES). */
function catchUpGapMs(intervalMinutes: number): number {
  return Math.min(CATCH_UP_MIN_GAP_MINUTES, intervalMinutes * 0.25) * 60_000;
}

/**
 * Is any live dataset still in the shape an OLD engine left it in: a dataset
 * that was synced (ok/partial) without a version token, or whose search text
 * was never built? Only a catalog pass repairs those (it re-downloads on the
 * missing token and rewrites the metadata). Deliberately NOT part of this:
 *  - rows in "error" or "pending": the normal pass retries those anyway, and a
 *    row that keeps failing must not make every wake a full pass;
 *  - a stale derivedVersion: the recompute step that runs first in the same
 *    tick repairs every row it is eligible for without network, and what it
 *    cannot repair (capped "partial" rows, empty datasets) a normal pass
 *    would skip too.
 */
export async function hasLegacyDatasets(): Promise<boolean> {
  const row = await prisma.dataset.findFirst({
    where: {
      removedAt: null,
      syncStatus: { in: ["ok", "partial"] },
      OR: [{ syncedVersion: null }, { searchText: "" }],
    },
    select: { id: true },
  });
  return row !== null;
}

export type TickAction ="first-sync" | "recompute" | "sync" | "not-due" | "busy" | "error";

export interface TickResult {
  actions: TickAction[];
  /** True when a run finished with status "failed" (the caller backs off). */
  failed: boolean;
}

/**
 * One scheduler decision. Exported for tests; `startScheduler` calls it from
 * its timer. Never throws.
 *
 * 0. Housekeeping: SyncLog retention (at most hourly, never throws).
 * 1. Empty Dataset table -> a full first sync (a fresh deploy populates itself).
 * 2. Otherwise, datasets whose derived columns are stale (DERIVED_VERSION) are
 *    re-derived locally first (no network, minutes at most).
 * 3. Then a normal incremental sync if the last full pass is old enough, or at
 *    once (CATCH-UP) when a live dataset still has the shape an old engine
 *    left it in (see hasLegacyDatasets), which is how a database written
 *    before the version tokens and search text existed repairs itself.
 */
export async function runSchedulerTick(intervalMinutes: number, now = Date.now()): Promise<TickResult> {
  const actions: TickAction[] = [];
  let failed = false;

  try {
    await maybePruneSyncLogs();

    const datasetCount = await prisma.dataset.count();
    if (datasetCount === 0) {
      console.log("[scheduler] No datasets yet; running the first full sync.");
      const result = await runSync({ trigger: "auto" });
      actions.push("first-sync");
      failed = result.status === "failed";
      return { actions, failed };
    }

    if ((await countDatasetsNeedingRecompute()) > 0) {
      console.log("[scheduler] Derived data is out of date; recomputing from stored records.");
      const result = await runRecompute({ trigger: "auto" });
      actions.push("recompute");
      if (result.status === "failed") failed = true;
    }

    const state = await prisma.syncState.findUnique({ where: { id: 1 }, select: { lastFullPassAt: true } });
    const last = state?.lastFullPassAt?.getTime();
    let due = last === undefined || now - last >= DUE_FRACTION * intervalMinutes * 60_000;
    if (!due && last !== undefined && now - last >= catchUpGapMs(intervalMinutes) && (await hasLegacyDatasets())) {
      console.log("[scheduler] Legacy dataset rows found; catching up with a full pass now.");
      due = true;
    }
    if (!due) {
      if (actions.length === 0) actions.push("not-due");
      return { actions, failed };
    }

    console.log("[scheduler] Catalog check is due; starting an incremental sync.");
    const result = await runSync({ trigger: "auto" });
    actions.push("sync");
    if (result.status === "failed") failed = true;
    return { actions, failed };
  } catch (err) {
    if (err instanceof SyncAlreadyRunningError) {
      // Another instance (or an admin/CLI run) holds the lock: nothing to do.
      actions.push("busy");
      return { actions, failed };
    }
    console.error("[scheduler] Tick failed:", err);
    actions.push("error");
    return { actions, failed: true };
  }
}

interface SchedulerHandle {
  intervalMinutes: number;
  stop(): void;
}

const g = globalThis as unknown as { __nabdScheduler?: SchedulerHandle };

function jitter(ms: number, fraction: number): number {
  return Math.round(ms * (1 + (Math.random() * 2 - 1) * fraction));
}

/**
 * Start the scheduler (idempotent per process). Always runs the boot sweep
 * and installs the shutdown hook; the timer only starts when
 * AUTO_SYNC_INTERVAL_MINUTES is positive. Never throws.
 */
export function startScheduler(): SchedulerHandle | null {
  if (g.__nabdScheduler) return g.__nabdScheduler;

  // Release the lock and mark the run "aborted" on SIGTERM/SIGINT. By default
  // Next installs its own handler that calls process.exit(0) without waiting
  // for us, so this is best-effort and the heartbeat + 10-minute stale window
  // is the real guarantee. With NEXT_MANUAL_SIG_HANDLE set, Next installs no
  // handler: we own the shutdown, wait (bounded) for the run to finalize its
  // log and release the lock, then exit — a redeploy mid-sync then clears the
  // "running" state immediately.
  installShutdownHandlers({ exit: Boolean(process.env.NEXT_MANUAL_SIG_HANDLE) });

  // A previous process may have died mid-run, leaving a SyncLog row "running".
  sweepOrphanedRuns().catch((err) => console.error("[scheduler] Boot sweep failed:", err));

  const intervalMinutes = getAutoSyncIntervalMinutes();
  if (intervalMinutes <= 0) {
    console.log("[scheduler] AUTO_SYNC_INTERVAL_MINUTES is 0/unset: automatic sync is off.");
    g.__nabdScheduler = {
      intervalMinutes: 0,
      stop() {
        g.__nabdScheduler = undefined;
      },
    };
    return g.__nabdScheduler;
  }

  const wakeMs = Math.min(intervalMinutes, 5) * 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      const result = await runSchedulerTick(intervalMinutes);
      const backoffMs = Math.min(intervalMinutes, FAILURE_BACKOFF_MINUTES) * 60_000;
      schedule(jitter(result.failed ? Math.max(wakeMs, backoffMs) : wakeMs, 0.1));
    }, delayMs);
    timer.unref();
  };

  const firstDelayMs = getAutoSyncFirstDelaySeconds() * 1000 + Math.round(Math.random() * 15_000);
  console.log(
    `[scheduler] Automatic sync every ${intervalMinutes} min (checking every ${wakeMs / 60_000} min); ` +
      `first check in ~${Math.round(firstDelayMs / 1000)}s.`,
  );
  schedule(firstDelayMs);

  g.__nabdScheduler = {
    intervalMinutes,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      g.__nabdScheduler = undefined;
    },
  };
  return g.__nabdScheduler;
}
