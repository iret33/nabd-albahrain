/**
 * Server-only data-access layer for `/admin` (Phase 6). Deliberately NOT
 * routed through `src/lib/queries.ts`'s `unstable_cache` layer — the
 * admin dashboard exists specifically to show real, current sync state
 * (right after triggering a run), so every read here hits Postgres
 * directly, same as the public queries module but without the cache
 * wrapper.
 */

import { prisma } from "@/lib/prisma";

/** The SyncLog columns the dashboard reads (see `status` semantics in `sync-status.ts`). */
export interface AdminSyncLogRow {
  id: number;
  trigger: string;
  startedAt: Date;
  finishedAt: Date | null;
  processed: number;
  succeeded: number;
  failed: number;
  status: string;
  /** Sanitized top-level failure message of a failed/aborted run. */
  error: string | null;
  total: number;
  skipped: number;
  updated: number;
  scope: string | null;
}

const SYNC_LOG_SELECT = {
  id: true,
  trigger: true,
  startedAt: true,
  finishedAt: true,
  processed: true,
  succeeded: true,
  failed: true,
  status: true,
  error: true,
  total: true,
  skipped: true,
  updated: true,
  scope: true,
} as const;

/**
 * A visitor pressed the public refresh button and nothing came of it: the run
 * finished cleanly and changed no dataset. Every press writes a permanent
 * SyncLog row (the row is load-bearing for progress and orphan detection), so
 * left in the admin history these rows push the scheduler/CLI/admin runs an
 * operator actually needs off the first page within an hour, and a successful
 * press masks a failed scheduled run in the "last run" banner. Presses that
 * failed, ended partial, were aborted, are still running, or updated data are
 * NOT quiet and stay visible.
 */
export const QUIET_PUBLIC_PRESS = { trigger: "public", status: "success", failed: 0, updated: 0 } as const;

const EXCLUDE_QUIET_PUBLIC_PRESSES = { NOT: QUIET_PUBLIC_PRESS } as const;

export interface AdminStats {
  /** Datasets currently on the portal (removed ones are counted separately). */
  total: number;
  ok: number;
  partial: number;
  error: number;
  pending: number;
  /** Datasets a complete catalog pass no longer lists (`Dataset.removedAt` set). */
  removed: number;
  /**
   * The newest run that is not a no-op public press (see QUIET_PUBLIC_PRESS):
   * a visitor's harmless click must not replace a failed scheduled run in the
   * dashboard banner. It is also the only row the dashboard treats as "the
   * latest run" when deciding whether a `running` row is live.
   */
  lastSync: AdminSyncLogRow | null;
}

export async function getAdminStats(): Promise<AdminStats> {
  const active = { removedAt: null } as const;
  const [total, ok, partial, error, pending, removed, lastSync] = await Promise.all([
    prisma.dataset.count({ where: active }),
    prisma.dataset.count({ where: { ...active, syncStatus: "ok" } }),
    prisma.dataset.count({ where: { ...active, syncStatus: "partial" } }),
    prisma.dataset.count({ where: { ...active, syncStatus: "error" } }),
    prisma.dataset.count({ where: { ...active, syncStatus: "pending" } }),
    prisma.dataset.count({ where: { removedAt: { not: null } } }),
    prisma.syncLog.findFirst({
      where: EXCLUDE_QUIET_PUBLIC_PRESSES,
      orderBy: { startedAt: "desc" },
      select: SYNC_LOG_SELECT,
    }),
  ]);
  return { total, ok, partial, error, pending, removed, lastSync };
}

export interface AdminFreshness {
  lastCatalogCheckAt: Date | null;
  lastSuccessAt: Date | null;
  lastDataChangeAt: Date | null;
}

/** Portal-wide freshness bookkeeping (the `SyncState` singleton); all-null before the first run. */
export async function getAdminFreshness(): Promise<AdminFreshness> {
  const row = await prisma.syncState.findUnique({
    where: { id: 1 },
    select: { lastCatalogCheckAt: true, lastSuccessAt: true, lastDataChangeAt: true },
  });
  return row ?? { lastCatalogCheckAt: null, lastSuccessAt: null, lastDataChangeAt: null };
}

export interface AdminDatasetRow {
  id: string;
  titleClean: string;
  theme: string | null;
  publisher: string | null;
  syncStatus: string;
  syncError: string | null;
  lastSyncedAt: Date | null;
  recordsCount: number;
  sourceCount: number;
  removedAt: Date | null;
}

const ADMIN_DATASET_SELECT = {
  id: true,
  titleClean: true,
  theme: true,
  publisher: true,
  syncStatus: true,
  syncError: true,
  lastSyncedAt: true,
  recordsCount: true,
  sourceCount: true,
  removedAt: true,
} as const;

/** Every dataset (removed ones flagged), for the searchable list — filtering happens client-side (512 rows total, no pagination needed). */
export async function getAllDatasetsForAdmin(): Promise<AdminDatasetRow[]> {
  return prisma.dataset.findMany({
    orderBy: [{ titleClean: "asc" }, { id: "asc" }],
    select: ADMIN_DATASET_SELECT,
  });
}

/**
 * Newest runs first. No-op public presses (QUIET_PUBLIC_PRESS) are left out
 * unless `includeQuietPublic` (the dashboard's "show all runs" toggle), so the
 * `limit` is spent on runs worth reading.
 */
export async function getRecentSyncLogs(
  limit = 20,
  opts: { includeQuietPublic?: boolean } = {},
): Promise<AdminSyncLogRow[]> {
  return prisma.syncLog.findMany({
    where: opts.includeQuietPublic ? undefined : EXCLUDE_QUIET_PUBLIC_PRESSES,
    orderBy: { startedAt: "desc" },
    take: limit,
    select: SYNC_LOG_SELECT,
  });
}

/** How many no-op public presses the default history view is hiding (for the toggle's label). */
export async function countQuietPublicPresses(): Promise<number> {
  return prisma.syncLog.count({ where: QUIET_PUBLIC_PRESS });
}
