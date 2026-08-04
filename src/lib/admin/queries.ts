/**
 * Server-only data-access layer for `/admin` (Phase 6). Deliberately NOT
 * routed through `src/lib/queries.ts`'s `unstable_cache` layer — the
 * admin dashboard exists specifically to show real, current sync state
 * (right after triggering a run), so every read here hits Postgres
 * directly, same as the public queries module but without the cache
 * wrapper.
 */

import { prisma } from "@/lib/prisma";

export interface AdminStats {
  total: number;
  ok: number;
  partial: number;
  error: number;
  pending: number;
  lastSync: {
    startedAt: Date;
    finishedAt: Date | null;
    processed: number;
    succeeded: number;
    failed: number;
  } | null;
}

export async function getAdminStats(): Promise<AdminStats> {
  const [total, ok, partial, error, pending, lastSync] = await Promise.all([
    prisma.dataset.count(),
    prisma.dataset.count({ where: { syncStatus: "ok" } }),
    prisma.dataset.count({ where: { syncStatus: "partial" } }),
    prisma.dataset.count({ where: { syncStatus: "error" } }),
    prisma.dataset.count({ where: { syncStatus: "pending" } }),
    prisma.syncLog.findFirst({
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, finishedAt: true, processed: true, succeeded: true, failed: true },
    }),
  ]);
  return { total, ok, partial, error, pending, lastSync };
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
} as const;

/** Every dataset, for the searchable list — filtering happens client-side (512 rows total, no pagination needed). */
export async function getAllDatasetsForAdmin(): Promise<AdminDatasetRow[]> {
  return prisma.dataset.findMany({
    orderBy: [{ titleClean: "asc" }, { id: "asc" }],
    select: ADMIN_DATASET_SELECT,
  });
}

export interface AdminSyncLogRow {
  id: number;
  trigger: string;
  startedAt: Date;
  finishedAt: Date | null;
  processed: number;
  succeeded: number;
  failed: number;
}

export async function getRecentSyncLogs(limit = 20): Promise<AdminSyncLogRow[]> {
  return prisma.syncLog.findMany({
    orderBy: { startedAt: "desc" },
    take: limit,
    select: {
      id: true,
      trigger: true,
      startedAt: true,
      finishedAt: true,
      processed: true,
      succeeded: true,
      failed: true,
    },
  });
}
