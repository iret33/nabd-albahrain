/**
 * Read model behind GET /api/freshness: everything a browser (or an uptime
 * monitor) needs to know about how fresh the data is and whether a sync is
 * running. Public and polled every couple of seconds by the refresh button,
 * so it only does primary-key / tiny-table reads, and the catalog-wide part is
 * shared between callers for about a second (see `loadCatalogRows`).
 */

import type { SyncState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getStaleAfterMs, loadPublicRefreshConfig } from "./config";
import { getLockState, type LockState } from "./lock";

/** The newest finished (non-recompute) run, as the visitor-facing button needs to describe it. */
export interface FreshnessLastRun {
  /** SyncLog id; compare with the `runId` of a 202 "started" answer to be sure it is YOUR run. */
  id: number;
  /** "changed" | "all" | "dataset:<id>" (null on legacy rows). */
  scope: string | null;
  /** "public" | "auto" | "api" | "cli" | ... */
  trigger: string;
  status: "success" | "partial" | "failed" | "aborted";
  finishedAt: string | null;
  /** Datasets whose data was re-downloaded. */
  updated: number;
  /** Datasets that failed in this run (a "partial" run has failed > 0). */
  failed: number;
  /** Changed datasets left for a later run (over the public size cap / beyond five per press). Count only, never ids. */
  deferred: number;
}

export interface FreshnessSnapshot {
  now: string;
  /** Last complete catalog pass (SyncState.lastCatalogCheckAt). */
  lastCheckedAt: string | null;
  /** Last run that finished success/partial. */
  lastSuccessAt: string | null;
  /** Last time any dataset's data was actually re-synced. */
  lastDataChangeAt: string | null;
  /** Status of the most recent finished sync run (recompute runs excluded). */
  lastRunStatus: "success" | "partial" | "failed" | "aborted" | null;
  /**
   * Counts of the most recent finished sync run (recompute runs excluded), so
   * the button can say what really happened: "partial" with `failed > 0` and
   * `updated === 0` is NOT "nothing new at the source", and `deferred > 0`
   * means a large dataset was left for the scheduled sync.
   */
  lastRun: FreshnessLastRun | null;
  running: boolean;
  runStartedAt: string | null;
  /** "changed" | "all" | "dataset:<id>" while a run is in flight. */
  runScope: string | null;
  progress: { done: number; total: number } | null;
  cooldown: { catalogUntil: string | null };
  /** Last success older than 2x the auto-sync interval (48h when the scheduler is off), or never. */
  stale: boolean;
  /** False when PUBLIC_REFRESH_ENABLED switches the public refresh off. */
  refreshEnabled: boolean;
  /** Present only when ?dataset= was given; null when that id is unknown. */
  dataset?: {
    id: string;
    lastCheckedAt: string | null;
    lastSyncedAt: string | null;
    sourceModified: string | null;
    refreshAvailableAt: string | null;
    removed: boolean;
    /** "ok" | "partial" | "error" | "pending" (never synced). */
    syncStatus: string;
    /** The dataset's last download failed (syncStatus "error"); the previous rows are still shown. */
    failed: boolean;
    /**
     * The latest successful/partial run that covered this dataset found it
     * changed but left it for the scheduled sync (too large for a public
     * press, or beyond the five per press). Clears itself once a later run
     * covers the dataset without deferring it.
     */
    deferred: boolean;
    /** SyncLog id of the run `deferred` was read from (null when no run covered the dataset). */
    lastRunId: number | null;
  } | null;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Pure: is data older than `staleAfterMs`? Never synced counts as stale. */
export function isStale(lastSuccessAt: Date | null, nowMs: number, staleAfterMs: number): boolean {
  return lastSuccessAt === null || nowMs - lastSuccessAt.getTime() > staleAfterMs;
}

/** `anchor + cooldown` when still in the future, else null. */
export function cooldownUntil(anchor: Date | null | undefined, cooldownSeconds: number, nowMs: number): string | null {
  if (!anchor) return null;
  const until = anchor.getTime() + cooldownSeconds * 1000;
  return until > nowMs ? new Date(until).toISOString() : null;
}

// ---------------------------------------------------------------------------
// Catalog-wide rows (shared for ~1s) and the per-dataset rows (never shared)
// ---------------------------------------------------------------------------

type RunStatus = FreshnessLastRun["status"];
const RUN_STATUSES: readonly string[] = ["success", "partial", "failed", "aborted"];

interface LastRunRow {
  id: number;
  scope: string | null;
  trigger: string;
  status: string;
  finishedAt: Date | null;
  updated: number;
  failed: number;
  deferred: number;
}

interface CatalogRows {
  state: SyncState | null;
  lock: LockState;
  lastRun: LastRunRow | null;
  runningLog: { scope: string | null; processed: number; total: number } | null;
}

async function readCatalogRows(): Promise<CatalogRows> {
  const [state, lock, lastRunRows] = await Promise.all([
    prisma.syncState.findUnique({ where: { id: 1 } }),
    getLockState(),
    // One row by primary key, counts only. The deferred list can hold 1000 ids
    // per run, so its LENGTH is computed in the database (a catalog press can
    // defer a lot) and never shipped. `scope <> 'recompute'` keeps legacy
    // NULL-scope rows in; the typeof guard keeps a malformed changedJson from
    // failing the whole probe.
    prisma.$queryRaw<LastRunRow[]>`
      SELECT "id", "scope", "trigger", "status", "finishedAt", "updated", "failed",
             CASE WHEN jsonb_typeof("changedJson" -> 'deferred') = 'array'
                  THEN jsonb_array_length("changedJson" -> 'deferred') ELSE 0 END AS "deferred"
      FROM "SyncLog"
      WHERE "status" <> 'running' AND ("scope" IS NULL OR "scope" <> 'recompute')
      ORDER BY "id" DESC
      LIMIT 1`,
  ]);

  const running = lock.running && !lock.stale;
  const runningLog = running
    ? await prisma.syncLog.findFirst({
        where: { status: "running" },
        orderBy: { id: "desc" },
        select: { scope: true, processed: true, total: true },
      })
    : null;

  return { state, lock, lastRun: lastRunRows[0] ?? null, runningLog };
}

/**
 * The catalog-wide rows are identical for every visitor, and every page view
 * plus every polling tab asks for them, so concurrent and back-to-back callers
 * share one set of reads for MEMO_TTL_MS. Design constraints:
 *  - strictly below the client's 2s poll: the client treats `running: false`
 *    as "the run finished", so a snapshot older than a poll could end the UI
 *    early. Runs that start or end INSIDE this process (the refresh route, the
 *    scheduler, the admin button) call `clearFreshnessMemo()`; runs in another
 *    process (CLI, a second instance) are covered by the short TTL alone;
 *  - the in-flight promise is shared, not just the result, and a rejection is
 *    dropped so a transient database error is never served for the whole TTL;
 *  - only the catalog part is memoized: the per-dataset part is keyed by an id
 *    anonymous callers control, so caching it would be an unbounded map;
 *  - each caller gets its own snapshot object built from the shared rows.
 * Kept on globalThis because Next bundles the route handlers and
 * instrumentation (which hosts the scheduler) separately: a module-level
 * variable would be two variables and the clear would not reach the routes.
 */
export const FRESHNESS_MEMO_TTL_MS = 1_000;

const g = globalThis as unknown as { __nabdFreshnessMemo?: { at: number; rows: Promise<CatalogRows> } | null };

function loadCatalogRows(): Promise<CatalogRows> {
  const nowMs = Date.now();
  const cached = g.__nabdFreshnessMemo;
  if (cached && nowMs - cached.at < FRESHNESS_MEMO_TTL_MS) return cached.rows;
  const entry = { at: nowMs, rows: readCatalogRows() };
  g.__nabdFreshnessMemo = entry;
  entry.rows.catch(() => {
    if (g.__nabdFreshnessMemo === entry) g.__nabdFreshnessMemo = null;
  });
  return entry.rows;
}

/** Forget the shared catalog rows (a run started or ended in this process, or a cooldown was claimed). */
export function clearFreshnessMemo(): void {
  g.__nabdFreshnessMemo = null;
}

/**
 * The newest SUCCESSFUL or partial run that covered `datasetId` (its own
 * single-dataset run, or a catalog-wide one) and whether it deferred the
 * dataset. A failed or aborted run says nothing about deferral, so it never
 * hides an earlier answer. `jsonb_exists` is the function behind the `?`
 * operator (a literal `?` is awkward in a raw query); the lookup is a
 * newest-first scan that stops at the first covering row.
 */
async function loadCoveringRun(datasetId: string): Promise<{ id: number; deferred: boolean } | null> {
  const rows = await prisma.$queryRaw<Array<{ id: number; deferred: boolean }>>`
    SELECT "id", COALESCE(jsonb_exists("changedJson" -> 'deferred', ${datasetId}), false) AS "deferred"
    FROM "SyncLog"
    WHERE "status" IN ('success', 'partial')
      AND ("scope" IS NULL OR "scope" IN ('changed', 'all') OR "scope" = ${`dataset:${datasetId}`})
    ORDER BY "id" DESC
    LIMIT 1`;
  return rows[0] ?? null;
}

/** The scope of the run holding the lock right now (null when unknown or idle). */
export async function getRunningScope(): Promise<string | null> {
  const row = await prisma.syncLog.findFirst({
    where: { status: "running" },
    orderBy: { id: "desc" },
    select: { scope: true },
  });
  return row?.scope ?? null;
}

export async function getFreshness(opts: { datasetId?: string } = {}): Promise<FreshnessSnapshot> {
  const nowMs = Date.now();
  const cfg = loadPublicRefreshConfig();

  const [{ state, lock, lastRun, runningLog }, dataset] = await Promise.all([
    loadCatalogRows(),
    opts.datasetId
      ? prisma.dataset.findUnique({
          where: { id: opts.datasetId },
          select: {
            id: true,
            lastCheckedAt: true,
            lastSyncedAt: true,
            sourceModified: true,
            refreshRequestedAt: true,
            removedAt: true,
            syncStatus: true,
          },
        })
      : Promise.resolve(undefined),
  ]);

  const running = lock.running && !lock.stale;
  const known = lastRun && RUN_STATUSES.includes(lastRun.status) ? lastRun : null;
  const lastRunStatus = known ? (known.status as RunStatus) : null;

  const snapshot: FreshnessSnapshot = {
    now: new Date(nowMs).toISOString(),
    lastCheckedAt: iso(state?.lastCatalogCheckAt),
    lastSuccessAt: iso(state?.lastSuccessAt),
    lastDataChangeAt: iso(state?.lastDataChangeAt),
    lastRunStatus,
    lastRun: known
      ? {
          id: known.id,
          scope: known.scope,
          trigger: known.trigger,
          status: known.status as RunStatus,
          finishedAt: iso(known.finishedAt),
          updated: known.updated,
          failed: known.failed,
          deferred: known.deferred,
        }
      : null,
    running,
    runStartedAt: running ? iso(lock.since) : null,
    runScope: running ? (runningLog?.scope ?? null) : null,
    progress: running && runningLog ? { done: runningLog.processed, total: runningLog.total } : null,
    cooldown: { catalogUntil: cooldownUntil(state?.lastPublicRefreshAt, cfg.catalogCooldownSeconds, nowMs) },
    stale: isStale(state?.lastSuccessAt ?? null, nowMs, getStaleAfterMs()),
    refreshEnabled: cfg.enabled,
  };

  if (opts.datasetId) {
    if (dataset) {
      const covering = await loadCoveringRun(dataset.id);
      snapshot.dataset = {
        id: dataset.id,
        lastCheckedAt: iso(dataset.lastCheckedAt),
        lastSyncedAt: iso(dataset.lastSyncedAt),
        sourceModified: iso(dataset.sourceModified),
        refreshAvailableAt: cooldownUntil(dataset.refreshRequestedAt, cfg.datasetCooldownSeconds, nowMs),
        removed: dataset.removedAt !== null,
        syncStatus: dataset.syncStatus,
        failed: dataset.syncStatus === "error",
        deferred: covering?.deferred ?? false,
        lastRunId: covering?.id ?? null,
      };
    } else {
      snapshot.dataset = null;
    }
  }
  return snapshot;
}
