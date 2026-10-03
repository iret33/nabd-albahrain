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

export interface AdminStats {
  /** Datasets currently on the portal (removed ones are counted separately). */
  total: number;
  ok: number;
  partial: number;
  error: number;
  pending: number;
  /** Datasets a complete catalog pass no longer lists (`Dataset.removedAt` set). */
  removed: number;
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
    prisma.syncLog.findFirst({ orderBy: { startedAt: "desc" }, select: SYNC_LOG_SELECT }),
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

export async function getRecentSyncLogs(limit = 20): Promise<AdminSyncLogRow[]> {
  return prisma.syncLog.findMany({
    orderBy: { startedAt: "desc" },
    take: limit,
    select: SYNC_LOG_SELECT,
  });
}
