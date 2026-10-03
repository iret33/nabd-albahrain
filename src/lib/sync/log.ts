/**
 * SyncLog lifecycle + SyncState bookkeeping.
 *
 * A SyncLog row is created right after the lock is acquired (status
 * "running"), updated cheaply while the run progresses, and finalized in a
 * `finally` block — so portal outages, schema surprises and crashes all leave
 * a visible "failed" row instead of vanishing (the old code wrote a row only
 * after a fully successful run).
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { LOCK_STALE_MS } from "./lock";

export type RunStatus = "running" | "success" | "partial" | "failed" | "aborted";

/** Ids touched by a run; stored in SyncLog.changedJson (each list capped, see CHANGED_LIST_CAP). */
export interface ChangedSets {
  /** Datasets whose records were re-downloaded and re-derived. */
  updated: string[];
  /** Changed datasets left for a later run (over maxRecords, or beyond maxDatasets). */
  deferred: string[];
  /** Datasets flagged removed (absent from a complete catalog). */
  removed: string[];
  /** Datasets seen for the first time. */
  added: string[];
}

export function emptyChangedSets(): ChangedSets {
  return { updated: [], deferred: [], removed: [], added: [] };
}

/** A first sync lists ~500 ids per list; anything beyond this is cut to keep the row small. */
export const CHANGED_LIST_CAP = 1000;

export interface RunCounters {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  updated: number;
}

export interface RunFailure {
  datasetId: string;
  error: string;
}

const ORPHAN_ERROR = "Process died or was killed before the run finished";

export async function createRunLog(input: { trigger: string; scope: string; total?: number }): Promise<number> {
  const row = await prisma.syncLog.create({
    data: {
      trigger: input.trigger,
      scope: input.scope,
      status: "running",
      total: input.total ?? 0,
      // Explicit (not the column default) so every timestamp we write is the
      // same naive-UTC representation, whatever the database's time zone.
      startedAt: new Date(),
    },
    select: { id: true },
  });
  return row.id;
}

/** Cheap progress write (called at most every ~1.5s by the engine). */
export async function updateRunProgress(logId: number, counters: RunCounters): Promise<void> {
  await prisma.syncLog.update({
    where: { id: logId },
    data: {
      total: counters.total,
      processed: counters.processed,
      succeeded: counters.succeeded,
      failed: counters.failed,
      skipped: counters.skipped,
      updated: counters.updated,
    },
  });
}

export async function finalizeRunLog(
  logId: number,
  input: {
    status: Exclude<RunStatus, "running">;
    error: string | null;
    counters: RunCounters;
    failures: RunFailure[];
    changed: ChangedSets;
  },
): Promise<void> {
  const cap = (ids: string[]) => ids.slice(0, CHANGED_LIST_CAP);
  const changedJson = {
    updated: cap(input.changed.updated),
    deferred: cap(input.changed.deferred),
    removed: cap(input.changed.removed),
    added: cap(input.changed.added),
  };
  await prisma.syncLog.update({
    where: { id: logId },
    data: {
      status: input.status,
      error: input.error ? input.error.slice(0, 2000) : null,
      finishedAt: new Date(),
      total: input.counters.total,
      processed: input.counters.processed,
      succeeded: input.counters.succeeded,
      failed: input.counters.failed,
      skipped: input.counters.skipped,
      updated: input.counters.updated,
      failuresJson: input.failures.slice(0, 500) as unknown as Prisma.InputJsonValue,
      changedJson: changedJson as unknown as Prisma.InputJsonValue,
    },
  });
}

/**
 * Called by a run that HOLDS the lock, before it creates its own row: any
 * other row still "running" is by definition an orphan of a process that died
 * (the lock proves nobody else is running). Marks them aborted.
 */
export async function abortOrphanedRuns(): Promise<number> {
  const { count } = await prisma.syncLog.updateMany({
    where: { status: "running" },
    data: { status: "aborted", finishedAt: new Date(), error: ORPHAN_ERROR },
  });
  if (count > 0) console.warn(`[sync] Marked ${count} orphaned "running" SyncLog row(s) as aborted.`);
  return count;
}

/**
 * Boot/scheduler sweep, safe to call WITHOUT holding the lock: marks "running"
 * rows aborted when the lock is free or stale, and — when a live run does hold
 * the lock — every "running" row except the newest (older ones are orphans of
 * earlier crashes). One statement, so a run that starts concurrently (new
 * lock, new row, both newer than the statement's snapshot) is never touched.
 */
export async function sweepOrphanedRuns(): Promise<number> {
  const count = await prisma.$executeRaw`
    UPDATE "SyncLog"
    SET "status" = 'aborted',
        "finishedAt" = timezone('utc', now()),
        "error" = COALESCE("error", ${ORPHAN_ERROR})
    WHERE "status" = 'running'
      AND (
        NOT EXISTS (
          SELECT 1 FROM "SyncLock"
          WHERE "id" = 1 AND "running"
            AND COALESCE("heartbeatAt", "since", 'epoch'::timestamp)
                  >= timezone('utc', now()) - make_interval(secs => ${LOCK_STALE_MS / 1000}::double precision)
        )
        OR "id" < (SELECT max("id") FROM "SyncLog" WHERE "status" = 'running')
      )`;
  if (count > 0) console.warn(`[sync] Boot sweep marked ${count} orphaned "running" SyncLog row(s) as aborted.`);
  return count;
}

/**
 * Retention for SyncLog. Every public press writes a row (the "running" row is
 * load-bearing: progress, run id, orphan detection), so without a prune the
 * table grows with visitor clicks and the rows an operator needs (scheduler
 * failures) sink in the history.
 *
 *  - the newest `keepNewest` rows and the rows the freshness/health/admin
 *    banners read ("latest finished run") are never touched, nor is any run
 *    still in flight;
 *  - a public press that did nothing (success, nothing updated or failed) only
 *    lives `publicNoopDays`;
 *  - anything else lives `defaultDays`; failures of non-public runs (the
 *    scheduler, the CLI, the admin button) live `nonPublicFailureDays`.
 */
export const SYNC_LOG_RETENTION = {
  keepNewest: 200,
  publicNoopDays: 7,
  defaultDays: 90,
  nonPublicFailureDays: 365,
  batchSize: 500,
  maxBatches: 20,
} as const;

/**
 * Delete expired SyncLog rows (see SYNC_LOG_RETENTION); resolves with how many
 * went. The cutoff is computed by the database on its UTC clock (SyncLog
 * timestamps are naive UTC), in batches so no statement holds a long lock.
 */
export async function pruneSyncLogs(): Promise<number> {
  const r = SYNC_LOG_RETENTION;
  let total = 0;
  for (let batch = 0; batch < r.maxBatches; batch++) {
    const deleted = await prisma.$executeRaw`
      DELETE FROM "SyncLog" WHERE "id" IN (
        SELECT l."id" FROM "SyncLog" l
        WHERE l."status" <> 'running'
          AND l."id" NOT IN (SELECT "id" FROM "SyncLog" ORDER BY "id" DESC LIMIT ${r.keepNewest}::int)
          AND l."id" IS DISTINCT FROM (
            SELECT max("id") FROM "SyncLog"
            WHERE "status" <> 'running' AND ("scope" IS NULL OR "scope" <> 'recompute'))
          AND l."id" IS DISTINCT FROM (
            SELECT max("id") FROM "SyncLog"
            WHERE "status" <> 'running'
              AND ("scope" IS NULL OR ("scope" <> 'recompute' AND "scope" NOT LIKE 'dataset:%')))
          AND (
            (l."trigger" = 'public' AND l."status" = 'success' AND l."failed" = 0 AND l."updated" = 0
              AND l."startedAt" < timezone('utc', now()) - make_interval(days => ${r.publicNoopDays}::int))
            OR (l."startedAt" < timezone('utc', now()) - make_interval(days => ${r.defaultDays}::int)
              AND NOT (l."trigger" <> 'public' AND l."status" IN ('failed', 'partial', 'aborted')))
            OR l."startedAt" < timezone('utc', now()) - make_interval(days => ${r.nonPublicFailureDays}::int)
          )
        ORDER BY l."id"
        LIMIT ${r.batchSize}::int
      )`;
    total += deleted;
    if (deleted < r.batchSize) break;
  }
  if (total > 0) console.log(`[sync] Pruned ${total} expired SyncLog row(s).`);
  return total;
}

const PRUNE_EVERY_MS = 60 * 60 * 1000;
let lastPruneStartedAt = 0;

/**
 * `pruneSyncLogs` at most once an hour per process, never throwing: called
 * after every run (so the CLI and external-cron deployments prune too, not
 * only the in-process scheduler) and from the scheduler tick.
 */
export async function maybePruneSyncLogs(nowMs = Date.now()): Promise<void> {
  if (nowMs - lastPruneStartedAt < PRUNE_EVERY_MS) return;
  lastPruneStartedAt = nowMs;
  try {
    await pruneSyncLogs();
  } catch (err) {
    console.error("[sync] SyncLog retention prune failed:", err);
  }
}

/** Test hook: forget the throttle so the next maybePruneSyncLogs() runs. */
export function resetPruneThrottleForTests(): void {
  lastPruneStartedAt = 0;
}

/** The SyncState columns a run may bump (schema.prisma says what each one means). */
export interface SyncStatePatch {
  /** Last complete catalog pass applied by ANY run: feeds "last checked" and the 60s collapse. */
  lastCatalogCheckAt?: Date;
  lastSuccessAt?: Date;
  lastDataChangeAt?: Date;
  /** The scheduler's own clock: written only by unrestricted catalog-wide runs. */
  lastFullPassAt?: Date;
}

/** Patch the SyncState singleton (creating it if the migration's seed row is missing). */
export async function updateSyncState(patch: SyncStatePatch): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await prisma.syncState.upsert({
    where: { id: 1 },
    create: { id: 1, ...patch },
    update: patch,
  });
}
