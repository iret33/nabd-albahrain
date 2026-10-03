/**
 * Shared run lifecycle for the two kinds of run that take the sync lock:
 * network syncs (engine.ts) and no-network derived-field recomputes
 * (recompute.ts).
 *
 *   beginRun  acquire the lock (or adopt a pre-acquired handle), mark orphans
 *             of crashed runs as aborted, create the SyncLog row, wire up
 *             abort handling.
 *   endRun    finalize the SyncLog row and SyncState, tell the web app to drop
 *             its caches, and ONLY THEN release the lock. Every step is
 *             guarded so one failing never masks the original error or skips
 *             the release.
 *
 * Ordering matters: the public status endpoint reports `running` while the
 * lock is held, so a polling browser only sees "done" after the cache
 * invalidation request has been answered.
 */

import { SyncAbortedError, describeError } from "./errors";
import { clearFreshnessMemo } from "./freshness";
import {
  abortOrphanedRuns,
  createRunLog,
  finalizeRunLog,
  maybePruneSyncLogs,
  updateRunProgress,
  updateSyncState,
  type ChangedSets,
  type RunCounters,
  type RunFailure,
  type RunStatus,
  type SyncStatePatch,
} from "./log";
import { acquireLock, type SyncLockHandle } from "./lock";
import { notifyAppToRevalidate } from "./notify";
import { registerActiveRun } from "./runtime";

export interface RunContext {
  trigger: string;
  scope: string;
  lock: SyncLockHandle;
  logId: number;
  /** Aborted by a shutdown signal, an external signal, or a lost lock. */
  abort: AbortController;
  /** Resolves when endRun has finished (log finalized, lock released). */
  done: Promise<void>;
  resolveDone: () => void;
  unregister: () => void;
}

export async function beginRun(input: {
  trigger: string;
  scope: string;
  /** A lock the caller already acquired (ownership passes to the run). */
  lock?: SyncLockHandle;
  /** External cancellation (e.g. a CLI signal handler). */
  signal?: AbortSignal;
}): Promise<RunContext> {
  const lock = input.lock ?? (await acquireLock());
  try {
    // We hold the lock, so any other row still "running" belongs to a dead process.
    await abortOrphanedRuns();
    const logId = await createRunLog({ trigger: input.trigger, scope: input.scope });

    const abort = new AbortController();
    const abortWith = (reason: unknown) => {
      if (!abort.signal.aborted) {
        abort.abort(reason instanceof SyncAbortedError ? reason : new SyncAbortedError(String(reason ?? "aborted")));
      }
    };
    const onExternal = () => abortWith(input.signal?.reason ?? "Stopped");
    if (input.signal) {
      if (input.signal.aborted) onExternal();
      else input.signal.addEventListener("abort", onExternal, { once: true });
    }
    const onLockLost = () => abortWith(lock.signal.reason ?? "Sync lock was lost");
    if (lock.signal.aborted) onLockLost();
    else lock.signal.addEventListener("abort", onLockLost, { once: true });

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const unregister = registerActiveRun({ logId, abort: (reason) => abortWith(reason), done });
    // The lock and the "running" row exist now: a freshness snapshot cached a
    // moment ago still says "idle" and would make a poller miss the run.
    clearFreshnessMemo();

    return {
      trigger: input.trigger,
      scope: input.scope,
      lock,
      logId,
      abort,
      done,
      resolveDone,
      unregister,
    };
  } catch (err) {
    await lock.release();
    throw err;
  }
}

export interface RunOutcome {
  status: Exclude<RunStatus, "running">;
  error: string | null;
  counters: RunCounters;
  failures: RunFailure[];
  changed: ChangedSets;
  /** SyncState columns to bump. */
  statePatch: SyncStatePatch;
  /** Dataset ids whose cached pages must be dropped. */
  notifyIds: string[];
}

export async function endRun(ctx: RunContext, outcome: RunOutcome): Promise<void> {
  try {
    try {
      await finalizeRunLog(ctx.logId, outcome);
    } catch (err) {
      console.error(`[sync] Could not finalize SyncLog #${ctx.logId}:`, err);
    }
    try {
      await updateSyncState(outcome.statePatch);
    } catch (err) {
      console.error("[sync] Could not update SyncState:", err);
    }
    try {
      // Always, even after a failed or aborted run: catalog metadata may
      // already have changed, and the SyncLog/SyncState the public pages
      // render were just rewritten.
      await notifyAppToRevalidate({ datasetIds: outcome.notifyIds });
    } catch (err) {
      console.error("[sync] Cache invalidation request failed:", err);
    }
    // Retention runs after every kind of run (the CLI and external-cron
    // deployments never start the in-process scheduler); throttled to hourly
    // and never throwing.
    await maybePruneSyncLogs();
  } finally {
    await ctx.lock.release();
    // After the release: a snapshot read between the two would still say "running".
    clearFreshnessMemo();
    ctx.unregister();
    ctx.resolveDone();
  }
}

/** Convert whatever a run threw into the status/error stored on its SyncLog row. */
export function statusFromError(
  err: unknown,
  signal: AbortSignal,
): { status: "failed" | "aborted"; error: string } {
  const described = describeError(err);
  if (described.kind !== "aborted") {
    // Full detail only in the server log; the database gets the sanitized text.
    console.error("[sync] Run failed:", err);
  }
  return {
    status: signal.aborted || described.kind === "aborted" ? "aborted" : "failed",
    error: described.message,
  };
}

/**
 * Throttled progress writer: at most one UPDATE every ~1.5s and never two in
 * flight, so a 512-dataset run costs a few hundred cheap writes, not 512.
 */
export function createProgressWriter(logId: number, counters: RunCounters) {
  let last = 0;
  let inFlight = false;
  const write = () => {
    inFlight = true;
    last = Date.now();
    return updateRunProgress(logId, { ...counters })
      .catch((err) => console.error("[sync] Progress update failed:", err))
      .finally(() => {
        inFlight = false;
      });
  };
  return {
    /** Write now (awaited), e.g. once the scope and totals are known. */
    flush: () => write(),
    /** Write if the throttle window has passed. */
    tick: () => {
      if (inFlight || Date.now() - last < 1500) return;
      void write();
    },
  };
}
