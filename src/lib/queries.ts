/**
 * Server-only data-access layer for the public pages (Phase 4). Every
 * function here reads Postgres directly via Prisma — pages are React
 * Server Components, no client-side fetch waterfalls.
 *
 * Every query that reads dataset/records data is wrapped in `unstable_cache`
 * tagged `"datasets"` (and `dataset:{id}` for anything scoped to one
 * dataset), per the spec. Nothing calls `revalidateTag` yet — that's the
 * sync engine's job in a later phase — so today these caches are populated
 * once and effectively never invalidated in-process, which is a safe
 * no-op default until that wiring lands.
 */

import { Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import type { VizConfig, StatsJson } from "@/lib/sync/derived";
import type { CatalogField } from "@/lib/sync/schemas";

export const THEME_PAGE_SIZE = 30;
export const RECORDS_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Shared row shapes
// ---------------------------------------------------------------------------

const DATASET_CARD_SELECT = {
  id: true,
  title: true,
  titleClean: true,
  theme: true,
  publisher: true,
  recordsCount: true,
  sourceCount: true,
  lastSyncedAt: true,
  syncStatus: true,
  chartData: true,
  vizConfig: true,
} satisfies Prisma.DatasetSelect;

export type DatasetCardRow = Prisma.DatasetGetPayload<{ select: typeof DATASET_CARD_SELECT }>;

const DATASET_DETAIL_SELECT = {
  id: true,
  title: true,
  titleClean: true,
  description: true,
  theme: true,
  publisher: true,
  recordsCount: true,
  sourceCount: true,
  fieldsJson: true,
  statsJson: true,
  vizConfig: true,
  chartData: true,
  summaryAr: true,
  sourceModified: true,
  lastSyncedAt: true,
  syncStatus: true,
  syncError: true,
} satisfies Prisma.DatasetSelect;

export type DatasetDetailRow = Prisma.DatasetGetPayload<{ select: typeof DATASET_DETAIL_SELECT }>;

/** Narrow helper: the JSON columns come back as `Prisma.JsonValue` — cast defensively at the edge. */
export function asVizConfig(value: Prisma.JsonValue | null | undefined): VizConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as unknown as VizConfig;
}

export function asStatsJson(value: Prisma.JsonValue | null | undefined): StatsJson | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as unknown as StatsJson;
}

export function asChartData(value: Prisma.JsonValue | null | undefined): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function asFields(value: Prisma.JsonValue | null | undefined): CatalogField[] {
  return Array.isArray(value) ? (value as unknown as CatalogField[]) : [];
}

// ---------------------------------------------------------------------------
// Home page: portal-wide stats
// ---------------------------------------------------------------------------

export interface PortalStats {
  totalDatasets: number;
  publisherCount: number;
  totalRecords: number;
  syncedDatasetCount: number;
  lastSync: { startedAt: Date; finishedAt: Date | null } | null;
}

export const getPortalStats = unstable_cache(
  async (): Promise<PortalStats> => {
    const [totalDatasets, publisherGroups, totalRecords, syncedDatasetCount, lastSync] = await Promise.all([
      prisma.dataset.count(),
      prisma.dataset.groupBy({ by: ["publisher"], where: { publisher: { not: null } } }),
      prisma.datasetRecord.count(),
      prisma.dataset.count({ where: { lastSyncedAt: { not: null } } }),
      prisma.syncLog.findFirst({
        orderBy: { startedAt: "desc" },
        select: { startedAt: true, finishedAt: true },
      }),
    ]);
    return { totalDatasets, publisherCount: publisherGroups.length, totalRecords, syncedDatasetCount, lastSync };
  },
  ["portal-stats"],
  { tags: ["datasets"] },
);

// ---------------------------------------------------------------------------
// Home page: featured stats band (src/config/featured.ts entries)
// ---------------------------------------------------------------------------

export function getFeaturedDataset(datasetId: string): Promise<DatasetCardRow | null> {
  return unstable_cache(
    async () => prisma.dataset.findUnique({ where: { id: datasetId }, select: DATASET_CARD_SELECT }),
    ["dataset-card", datasetId],
    { tags: ["datasets", `dataset:${datasetId}`] },
  )();
}

// ---------------------------------------------------------------------------
// Home page + /categories: theme breakdown
// ---------------------------------------------------------------------------

export interface ThemeCount {
  theme: string;
  count: number;
}

export const getThemeCounts = unstable_cache(
  async (): Promise<ThemeCount[]> => {
    const groups = await prisma.dataset.groupBy({
      by: ["theme"],
      where: { theme: { not: null } },
      _count: { _all: true },
    });
    return groups
      .map((g) => ({ theme: g.theme as string, count: g._count._all }))
      .sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme));
  },
  ["theme-counts"],
  { tags: ["datasets"] },
);

// ---------------------------------------------------------------------------
// Home page: "الأحدث تحديثاً"
// ---------------------------------------------------------------------------

export const getLatestDatasets = unstable_cache(
  async (): Promise<DatasetCardRow[]> => {
    return prisma.dataset.findMany({
      where: { lastSyncedAt: { not: null } },
      orderBy: { lastSyncedAt: "desc" },
      take: 9,
      select: DATASET_CARD_SELECT,
    });
  },
  ["latest-datasets"],
  { tags: ["datasets"] },
);

// ---------------------------------------------------------------------------
// /categories/[theme]: paginated dataset grid
// ---------------------------------------------------------------------------

export interface PaginatedDatasets {
  items: DatasetCardRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function getDatasetsByTheme(theme: string, page: number): Promise<PaginatedDatasets> {
  const pageSize = THEME_PAGE_SIZE;
  const safePage = Math.max(1, page);
  return unstable_cache(
    async () => {
      const skip = (safePage - 1) * pageSize;
      const [items, total] = await Promise.all([
        prisma.dataset.findMany({
          where: { theme },
          orderBy: [{ titleClean: "asc" }, { id: "asc" }],
          skip,
          take: pageSize,
          select: DATASET_CARD_SELECT,
        }),
        prisma.dataset.count({ where: { theme } }),
      ]);
      return { items, total, page: safePage, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
    },
    ["datasets-by-theme", theme, String(safePage)],
    { tags: ["datasets"] },
  )();
}

// ---------------------------------------------------------------------------
// /dataset/[id]
// ---------------------------------------------------------------------------

export function getDatasetById(id: string): Promise<DatasetDetailRow | null> {
  return unstable_cache(
    async () => prisma.dataset.findUnique({ where: { id }, select: DATASET_DETAIL_SELECT }),
    ["dataset-detail", id],
    { tags: ["datasets", `dataset:${id}`] },
  )();
}

export interface RecordsPage {
  rows: Array<{ id: string; data: Record<string, unknown> }>;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  sortField: string | null;
  sortDir: "asc" | "desc";
}

/**
 * Server-paginated (25/page), server-sortable raw record view — the one
 * place raw DatasetRecord rows reach the client, and only a page at a
 * time. Sorting is done in Postgres via a JSON path expression on the
 * `data` column; `sortField` is validated against the dataset's own
 * `fields[]` schema before being used in the query (defense in depth even
 * though it's bound as a query parameter, not spliced into SQL text).
 */
export async function getDatasetRecordsPage(
  datasetId: string,
  page: number,
  sortField: string | null,
  sortDir: "asc" | "desc",
  fields: CatalogField[],
): Promise<RecordsPage> {
  const pageSize = RECORDS_PAGE_SIZE;
  const safePage = Math.max(1, page);
  const fieldMeta = sortField ? fields.find((f) => f.name === sortField) : undefined;
  const validField = fieldMeta ? fieldMeta.name : null;
  const dir: "asc" | "desc" = sortDir === "desc" ? "desc" : "asc";

  const run = unstable_cache(
    async (): Promise<RecordsPage> => {
      const skip = (safePage - 1) * pageSize;
      const total = await prisma.datasetRecord.count({ where: { datasetId } });
      const totalPages = Math.max(1, Math.ceil(total / pageSize));

      const fallback = async (): Promise<RecordsPage> => {
        const rows = await prisma.datasetRecord.findMany({
          where: { datasetId },
          orderBy: { id: "asc" },
          skip,
          take: pageSize,
          select: { id: true, data: true },
        });
        return {
          rows: rows.map((r) => ({ id: String(r.id), data: r.data as Record<string, unknown> })),
          total,
          page: safePage,
          pageSize,
          totalPages,
          sortField: null,
          sortDir: dir,
        };
      };

      if (!validField) return fallback();

      const isNumeric = fieldMeta?.type === "int" || fieldMeta?.type === "double";
      const orderExpr = isNumeric
        ? Prisma.sql`NULLIF(data->>${validField}, '')::double precision`
        : Prisma.sql`(data->>${validField})`;
      const orderDirSql = dir === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`;

      try {
        const rows = await prisma.$queryRaw<Array<{ id: bigint; data: unknown }>>`
          SELECT id, data FROM "DatasetRecord"
          WHERE "datasetId" = ${datasetId}
          ORDER BY ${orderExpr} ${orderDirSql} NULLS LAST, id ASC
          LIMIT ${pageSize} OFFSET ${skip}
        `;
        return {
          rows: rows.map((r) => ({ id: String(r.id), data: r.data as Record<string, unknown> })),
          total,
          page: safePage,
          pageSize,
          totalPages,
          sortField: validField,
          sortDir: dir,
        };
      } catch (err) {
        // A messy source value (e.g. non-numeric text in a nominally
        // "int" field) could make the cast throw at query time — degrade
        // to the unsorted view rather than a 500 page.
        console.error(`[queries] sorted records query failed for ${datasetId}/${validField}:`, err);
        return fallback();
      }
    },
    ["dataset-records", datasetId, String(safePage), validField ?? "", dir],
    { tags: ["datasets", `dataset:${datasetId}`] },
  );

  return run();
}
