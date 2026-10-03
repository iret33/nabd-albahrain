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

/** Patch the SyncState singleton (creating it if the migration's seed row is missing). */
export async function updateSyncState(patch: {
  lastCatalogCheckAt?: Date;
  lastSuccessAt?: Date;
  lastDataChangeAt?: Date;
}): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await prisma.syncState.upsert({
    where: { id: 1 },
    create: { id: 1, ...patch },
    update: patch,
  });
}
