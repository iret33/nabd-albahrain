/**
 * Read model behind GET /api/freshness: everything a browser (or an uptime
 * monitor) needs to know about how fresh the data is and whether a sync is
 * running. Public and polled every couple of seconds by the refresh button,
 * so it only does primary-key / tiny-table reads.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getStaleAfterMs, loadPublicRefreshConfig } from "./config";
import { getLockState } from "./lock";

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
  running: boolean;
  runStartedAt: string | null;
  /** "changed" | "all" | "dataset:<id>" while a run is in flight. */
  runScope: string | null;
  progress: { done: number; total: number } | null;
  cooldown: { catalogUntil: string | null };
  /** Last success older than 2x the auto-sync interval (48h when the scheduler is off), or never. */
  stale: boolean;
  /** False when PUBLIC_REFRESH_ENABLED=0. */
  refreshEnabled: boolean;
  /** Present only when ?dataset= was given; null when that id is unknown. */
  dataset?: {
    id: string;
    lastCheckedAt: string | null;
    lastSyncedAt: string | null;
    sourceModified: string | null;
    refreshAvailableAt: string | null;
    removed: boolean;
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

const FINISHED_SYNC_RUN: Prisma.SyncLogWhereInput = {
  status: { not: "running" },
  // `OR` with an explicit null branch: `scope <> 'recompute'` alone would
  // drop rows whose scope is NULL (legacy runs).
  OR: [{ scope: null }, { scope: { not: "recompute" } }],
};

export async function getFreshness(opts: { datasetId?: string } = {}): Promise<FreshnessSnapshot> {
  const nowMs = Date.now();
  const cfg = loadPublicRefreshConfig();

  const [state, lock, lastRun, dataset] = await Promise.all([
    prisma.syncState.findUnique({ where: { id: 1 } }),
    getLockState(),
    prisma.syncLog.findFirst({
      where: FINISHED_SYNC_RUN,
      orderBy: { id: "desc" },
      select: { status: true },
    }),
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
          },
        })
      : Promise.resolve(undefined),
  ]);

  const running = lock.running && !lock.stale;
  const runningLog = running
    ? await prisma.syncLog.findFirst({
        where: { status: "running" },
        orderBy: { id: "desc" },
        select: { scope: true, processed: true, total: true },
      })
    : null;

  const lastRunStatus =
    lastRun && ["success", "partial", "failed", "aborted"].includes(lastRun.status)
      ? (lastRun.status as FreshnessSnapshot["lastRunStatus"])
      : null;

  const snapshot: FreshnessSnapshot = {
    now: new Date(nowMs).toISOString(),
    lastCheckedAt: iso(state?.lastCatalogCheckAt),
    lastSuccessAt: iso(state?.lastSuccessAt),
    lastDataChangeAt: iso(state?.lastDataChangeAt),
    lastRunStatus,
    running,
    runStartedAt: running ? iso(lock.since) : null,
    runScope: runningLog?.scope ?? null,
    progress: runningLog ? { done: runningLog.processed, total: runningLog.total } : null,
    cooldown: { catalogUntil: cooldownUntil(state?.lastPublicRefreshAt, cfg.catalogCooldownSeconds, nowMs) },
    stale: isStale(state?.lastSuccessAt ?? null, nowMs, getStaleAfterMs()),
    refreshEnabled: cfg.enabled,
  };

  if (opts.datasetId) {
    snapshot.dataset = dataset
      ? {
          id: dataset.id,
          lastCheckedAt: iso(dataset.lastCheckedAt),
          lastSyncedAt: iso(dataset.lastSyncedAt),
          sourceModified: iso(dataset.sourceModified),
          refreshAvailableAt: cooldownUntil(dataset.refreshRequestedAt, cfg.datasetCooldownSeconds, nowMs),
          removed: dataset.removedAt !== null,
        }
      : null;
  }
  return snapshot;
}
