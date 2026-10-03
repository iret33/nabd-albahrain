/**
 * Server-only data-access layer for the public pages and the public JSON API.
 * Every function reads Postgres directly via Prisma — pages are React Server
 * Components, no client-side fetch waterfalls.
 *
 * Caching policy (one place: `CACHE` below)
 * -----------------------------------------
 * - Every `unstable_cache` call has an explicit `revalidate`: `CACHE.ttl`
 *   (default 300 s, env `CACHE_TTL_SECONDS`) for lists/aggregates and 6x that
 *   for per-dataset entries. The TTL is the safety net that makes CLI syncs,
 *   crashed runs and manual SQL self-heal; it is NOT how fresh data normally
 *   appears.
 * - Tags: list/aggregate entries carry `"datasets"`; per-dataset entries
 *   (detail, card, records meta, first records page) carry ONLY
 *   `dataset:<id>`. The sync engine's notify step calls
 *   `revalidateTag("datasets")` plus `revalidateTag(datasetTag(id))` for each
 *   dataset it actually updated, so one refreshed dataset no longer flushes
 *   the other 511.
 * - No attacker-chosen string ever becomes a cache key. Searches are never
 *   cached; themes and publisher slugs are validated against the cached
 *   theme/publisher lists first; dataset ids and sort columns are validated
 *   against the database / the dataset's own schema, and lookups that find
 *   nothing (or degrade) are returned WITHOUT being stored (`cachedWhen`).
 *   What can still create entries is bounded by real data: one per dataset
 *   (detail, card, meta) plus one per (dataset, valid sort column,
 *   direction) for the first records page.
 * - Rows read through `unstable_cache` come back JSON-serialized, so Date
 *   columns arrive as ISO strings on a cache hit. Every public function
 *   revives them, so callers can rely on `Date` objects.
 *
 * Lists are built the same way everywhere: a cheap, UNCACHED query decides
 * which datasets are on the page and in what order (so membership, ordering
 * and totals are always fresh and a page past the end can be clamped), and
 * the heavy card payload (chartData) is then loaded per dataset through the
 * per-dataset card cache.
 */

import { Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/slugify";
import { escapeLike } from "@/lib/search";
import {
  DATASETS_TAG,
  DETAIL_TTL_MULTIPLIER,
  datasetTag,
  isValidDatasetId,
  isValidPublisherSlug,
  resolveCacheTtl,
} from "@/lib/cache-config";
import { BusyError, createSlotLimiter, type SlotLimiter } from "@/lib/slot-limiter";
import { clampPage, offsetFor, totalPagesFor } from "@/lib/page-math";
import { buildListParams, sinceCutoff, type ListParams, type ListParamsInput } from "@/lib/list-query";
import { compareByUpdated, compareRanked, scoreMatch } from "@/lib/ranking";
import {
  NUMERIC_TEXT_RE,
  RECORDS_PAGE_SIZE,
  RECORDS_STATEMENT_TIMEOUT_MS,
  normalizeRecordsQuery,
  resolveSortField,
  type RecordsSearch,
  type SortField,
} from "@/lib/records-query";
import type { VizConfig, StatsJson } from "@/lib/sync/derived";
import type { CatalogField } from "@/lib/sync/schemas";

export const THEME_PAGE_SIZE = 30;
export { RECORDS_PAGE_SIZE };

// ---------------------------------------------------------------------------
// Cache policy
// ---------------------------------------------------------------------------

const ttl = resolveCacheTtl(process.env.CACHE_TTL_SECONDS, (message) => console.warn(`[queries] ${message}`));

/** The single source of truth for cache lifetimes and tag names. */
export const CACHE = {
  /** Seconds a list/aggregate entry may be served before it is refreshed in the background. */
  ttl,
  /** Seconds a per-dataset entry (tag-invalidated on every real change) may live. */
  detailTtl: ttl * DETAIL_TTL_MULTIPLIER,
  /** Tag on every list/aggregate entry. */
  datasetsTag: DATASETS_TAG,
  /** Tag on every per-dataset entry: `dataset:<id>`. */
  datasetTag,
} as const;

const LIST_CACHE = { tags: [DATASETS_TAG], revalidate: CACHE.ttl };

function datasetCache(id: string, revalidate: number = CACHE.detailTtl) {
  return { tags: [datasetTag(id)], revalidate };
}

/** Thrown inside `unstable_cache` to make it skip storing a result (a thrown callback is never cached). */
class NotCacheable extends Error {
  constructor() {
    super("result is not cacheable");
    this.name = "NotCacheable";
  }
}

/**
 * `unstable_cache` that only stores results `shouldCache` approves of.
 * Used so that "dataset not found" (a hostile id) and degraded fallbacks
 * (a timed-out sort) are returned to the caller but never persisted, which
 * is what keeps the cache key space bounded by real data.
 */
async function cachedWhen<T>(
  load: () => Promise<T>,
  shouldCache: (value: T) => boolean,
  keyParts: string[],
  options: { tags: string[]; revalidate: number },
): Promise<T> {
  let uncacheable: { value: T } | null = null;
  // Next joins key parts with ",", so two different tuples could collide when a part itself contains a
  // comma. Collapse everything after the entry name into one JSON string to keep keys unambiguous.
  const unambiguousKey = [keyParts[0], JSON.stringify(keyParts.slice(1))];
  try {
    return await unstable_cache(
      async () => {
        const value = await load();
        if (!shouldCache(value)) {
          uncacheable = { value };
          throw new NotCacheable();
        }
        return value;
      },
      unambiguousKey,
      options,
    )();
  } catch (err) {
    if (err instanceof NotCacheable && uncacheable !== null) return (uncacheable as { value: T }).value;
    throw err;
  }
}

/** JSON round-trips turn Dates into ISO strings; turn them back (null for absent/invalid). */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Shared row shapes
// ---------------------------------------------------------------------------

const DATASET_CARD_SELECT = {
  id: true,
  title: true,
  titleClean: true,
  titleAr: true,
  theme: true,
  publisher: true,
  recordsCount: true,
  sourceCount: true,
  sourceModified: true,
  lastSyncedAt: true,
  syncStatus: true,
  chartData: true,
  vizConfig: true,
} satisfies Prisma.DatasetSelect;

export type DatasetCardRow = Prisma.DatasetGetPayload<{ select: typeof DATASET_CARD_SELECT }>;

/**
 * `syncError` is intentionally absent (internal, never shown). `statsJson` is
 * kept: the field dictionary and the records-table formatter both read it.
 */
const DATASET_DETAIL_SELECT = {
  id: true,
  title: true,
  titleClean: true,
  titleAr: true,
  description: true,
  theme: true,
  publisher: true,
  keywords: true,
  license: true,
  recordsCount: true,
  sourceCount: true,
  fieldsJson: true,
  statsJson: true,
  vizConfig: true,
  chartData: true,
  summaryAr: true,
  sourceModified: true,
  lastSyncedAt: true,
  lastCheckedAt: true,
  removedAt: true,
  derivedVersion: true,
  syncStatus: true,
} satisfies Prisma.DatasetSelect;

export type DatasetDetailRow = Prisma.DatasetGetPayload<{ select: typeof DATASET_DETAIL_SELECT }>;

function reviveCard(row: DatasetCardRow): DatasetCardRow {
  return { ...row, sourceModified: toDate(row.sourceModified), lastSyncedAt: toDate(row.lastSyncedAt) };
}

function reviveDetail(row: DatasetDetailRow): DatasetDetailRow {
  return {
    ...row,
    sourceModified: toDate(row.sourceModified),
    lastSyncedAt: toDate(row.lastSyncedAt),
    lastCheckedAt: toDate(row.lastCheckedAt),
    removedAt: toDate(row.removedAt),
  };
}

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
  /** Sum of `sourceCount` over live datasets (rows stored), not a COUNT(*) over the records table. */
  totalRecords: number;
  syncedDatasetCount: number;
  /** Kept for compatibility: the latest run's start/finish. Prefer `latestRun` / `lastCheckedAt`. */
  lastSync: { startedAt: Date; finishedAt: Date | null } | null;
  /** Last time a complete catalog pass succeeded, even if nothing changed ("last checked"). */
  lastCheckedAt: Date | null;
  /** Last time a run finished with status success/partial. */
  lastSuccessAt: Date | null;
  /** Last time any dataset's data actually changed. */
  lastDataChangeAt: Date | null;
  latestRun: { status: string; startedAt: Date; finishedAt: Date | null } | null;
  /** Newest `sourceModified` over live datasets: when the portal itself last published something. */
  latestSourceModified: Date | null;
}

const loadPortalStats = unstable_cache(
  async (): Promise<PortalStats> => {
    const live = { removedAt: null } satisfies Prisma.DatasetWhereInput;
    const [totalDatasets, publisherGroups, totals, syncedDatasetCount, state, latestRun] = await Promise.all([
      prisma.dataset.count({ where: live }),
      prisma.dataset.groupBy({ by: ["publisher"], where: { ...live, publisher: { not: null } } }),
      prisma.dataset.aggregate({ where: live, _sum: { sourceCount: true }, _max: { sourceModified: true } }),
      prisma.dataset.count({ where: { ...live, lastSyncedAt: { not: null } } }),
      prisma.syncState.findUnique({ where: { id: 1 } }),
      // Newest FINISHED non-recompute run: the same rule /api/freshness uses for
      // `lastRunStatus`, so a successful no-network recompute can never hide a
      // failed real sync from the hero/footer notice. (`OR` with an explicit null
      // branch: `scope <> 'recompute'` alone would drop legacy rows with NULL scope.)
      prisma.syncLog.findFirst({
        where: { status: { not: "running" }, OR: [{ scope: null }, { scope: { not: "recompute" } }] },
        orderBy: { startedAt: "desc" },
        select: { status: true, startedAt: true, finishedAt: true },
      }),
    ]);
    // Count publishers by slug, like /publishers does, so whitespace-variant duplicates are one publisher.
    const publisherCount = new Set(publisherGroups.map((g) => slugify(g.publisher as string))).size;
    return {
      totalDatasets,
      publisherCount,
      totalRecords: totals._sum.sourceCount ?? 0,
      syncedDatasetCount,
      lastSync: latestRun ? { startedAt: latestRun.startedAt, finishedAt: latestRun.finishedAt } : null,
      lastCheckedAt: state?.lastCatalogCheckAt ?? null,
      lastSuccessAt: state?.lastSuccessAt ?? null,
      lastDataChangeAt: state?.lastDataChangeAt ?? null,
      latestRun,
      latestSourceModified: totals._max.sourceModified ?? null,
    };
  },
  ["portal-stats"],
  LIST_CACHE,
);

export async function getPortalStats(): Promise<PortalStats> {
  const s = await loadPortalStats();
  return {
    ...s,
    lastSync: s.lastSync
      ? { startedAt: toDate(s.lastSync.startedAt) as Date, finishedAt: toDate(s.lastSync.finishedAt) }
      : null,
    lastCheckedAt: toDate(s.lastCheckedAt),
    lastSuccessAt: toDate(s.lastSuccessAt),
    lastDataChangeAt: toDate(s.lastDataChangeAt),
    latestRun: s.latestRun
      ? {
          status: s.latestRun.status,
          startedAt: toDate(s.latestRun.startedAt) as Date,
          finishedAt: toDate(s.latestRun.finishedAt),
        }
      : null,
    latestSourceModified: toDate(s.latestSourceModified),
  };
}

// ---------------------------------------------------------------------------
// Per-dataset cards (list pages, featured band) and detail
// ---------------------------------------------------------------------------

/**
 * One dataset as a card. Cached per dataset (`dataset:<id>`); unknown ids are
 * returned as null and not cached, so this is safe to call with any id.
 */
export async function getDatasetCard(id: string): Promise<DatasetCardRow | null> {
  if (!isValidDatasetId(id)) return null;
  const row = await cachedWhen(
    () => prisma.dataset.findUnique({ where: { id }, select: DATASET_CARD_SELECT }),
    (r) => r !== null,
    ["dataset-card", id],
    datasetCache(id, CACHE.ttl),
  );
  return row ? reviveCard(row) : null;
}

/** Cards for `ids`, in the given order; ids that no longer exist are skipped. At most 100 ids. */
export async function getDatasetCards(ids: readonly string[]): Promise<DatasetCardRow[]> {
  const cards = await Promise.all(ids.slice(0, 100).map((id) => getDatasetCard(id)));
  return cards.filter((c): c is DatasetCardRow => c !== null);
}

/** Home page featured band (src/config/featured.ts entries). */
export function getFeaturedDataset(datasetId: string): Promise<DatasetCardRow | null> {
  return getDatasetCard(datasetId);
}

/**
 * `/dataset/[id]`. Returns removed datasets too (check `removedAt`), so the
 * page can say "removed from the official portal" instead of 404. Misses are
 * not cached, so random ids cost one primary-key lookup and no cache entry.
 */
export async function getDatasetById(id: string): Promise<DatasetDetailRow | null> {
  if (!isValidDatasetId(id)) return null;
  const row = await cachedWhen(
    () => prisma.dataset.findUnique({ where: { id }, select: DATASET_DETAIL_SELECT }),
    (r) => r !== null,
    ["dataset-detail", id],
    datasetCache(id),
  );
  return row ? reviveDetail(row) : null;
}

/** Same-theme-and-publisher first, then same theme, then same publisher; never the dataset itself; live only. */
export async function getRelatedDatasets(
  id: string,
  theme: string | null | undefined,
  publisher: string | null | undefined,
  limit = 6,
): Promise<DatasetCardRow[]> {
  const take = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 12) : 6;
  if (!isValidDatasetId(id) || (!theme && !publisher)) return [];
  const candidates = await prisma.dataset.findMany({
    where: {
      removedAt: null,
      id: { not: id },
      OR: [...(theme ? [{ theme }] : []), ...(publisher ? [{ publisher }] : [])],
    },
    select: { id: true, theme: true, publisher: true, sourceModified: true },
  });
  const tier = (c: { theme: string | null; publisher: string | null }) => {
    const sameTheme = !!theme && c.theme === theme;
    const samePublisher = !!publisher && c.publisher === publisher;
    return sameTheme && samePublisher ? 0 : sameTheme ? 1 : 2;
  };
  const picked = candidates
    .sort((a, b) => tier(a) - tier(b) || compareByUpdated(a, b))
    .slice(0, take)
    .map((c) => c.id);
  return getDatasetCards(picked);
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
      where: { theme: { not: null }, removedAt: null },
      _count: { _all: true },
    });
    return groups
      .map((g) => ({ theme: g.theme as string, count: g._count._all }))
      .sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme));
  },
  ["theme-counts"],
  LIST_CACHE,
);

/**
 * The real theme named `theme` (exact match), or null. This is the gate every
 * theme-keyed query and page goes through, so unknown strings never reach a
 * query or a cache key and the page can return a genuine 404.
 */
export async function findTheme(theme: string): Promise<ThemeCount | null> {
  if (typeof theme !== "string" || theme === "" || theme.length > 200) return null;
  return (await getThemeCounts()).find((t) => t.theme === theme) ?? null;
}

// ---------------------------------------------------------------------------
// /publishers + /publishers/[slug]
//
// Unlike themes (short strings, used directly/encoded as the URL segment),
// publisher names are long free text, so they get a slugified URL via
// `slugify()` (src/lib/slugify.ts). Real synced data has one pair of
// publisher strings that only differ by incidental whitespace around a
// "\" separator and collide on the same slug (see slugify.ts's docstring)
// — so slug -> publisher-name is treated as one-to-many everywhere below,
// and the listing merges any such collisions into a single tile instead
// of producing two tiles that would both link to the same URL.
// ---------------------------------------------------------------------------

export interface PublisherCount {
  slug: string;
  name: string; // canonical display name (highest dataset count among collisions, ties broken alphabetically)
  count: number;
  names: string[]; // every raw `publisher` value that maps to this slug (usually just [name])
}

export const getPublisherCounts = unstable_cache(
  async (): Promise<PublisherCount[]> => {
    const groups = await prisma.dataset.groupBy({
      by: ["publisher"],
      where: { publisher: { not: null }, removedAt: null },
      _count: { _all: true },
    });

    const bySlug = new Map<string, { name: string; count: number; names: string[] }>();
    for (const g of groups) {
      const raw = g.publisher as string;
      const count = g._count._all;
      const slug = slugify(raw);
      const existing = bySlug.get(slug);
      if (!existing) {
        bySlug.set(slug, { name: raw, count, names: [raw] });
        continue;
      }
      existing.names.push(raw);
      existing.count += count;
      // Prefer the raw name with the most datasets as the display name;
      // break ties alphabetically for determinism.
      const currentPrimaryCount = existing.count - count; // count before this merge
      if (count > currentPrimaryCount || (count === currentPrimaryCount && raw.localeCompare(existing.name) < 0)) {
        existing.name = raw;
      }
    }

    return [...bySlug.entries()]
      .map(([slug, v]) => ({ slug, name: v.name, count: v.count, names: v.names }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  },
  ["publisher-counts"],
  LIST_CACHE,
);

/** The real publisher behind `slug`, or null. Gate for every publisher-keyed query (see `findTheme`). */
export async function findPublisher(slug: string): Promise<PublisherCount | null> {
  if (!isValidPublisherSlug(slug)) return null;
  return (await getPublisherCounts()).find((p) => p.slug === slug) ?? null;
}

// ---------------------------------------------------------------------------
// Listings: search, theme, publisher, filters, sorting, facets
// ---------------------------------------------------------------------------

export interface PaginatedDatasets {
  items: DatasetCardRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface PublisherFacet {
  slug: string;
  name: string;
  count: number;
}

export type ListStatus = "ok" | "query-too-short" | "unknown-theme" | "unknown-publisher";

export interface ListResult extends PaginatedDatasets {
  /** The trimmed, capped query text ("" when none). */
  query: string;
  tokens: string[];
  /** The effective parameters (page clamped to the real last page). */
  params: ListParams;
  /**
   * "ok", or why the result is empty without having searched: the query had
   * no searchable token, or the theme/publisher is not a real one (render a 404).
   */
  status: ListStatus;
  /** The validated theme filter (canonical spelling and live count), if one was given. */
  theme: ThemeCount | null;
  /** The validated publisher filter, if one was given. */
  publisher: PublisherCount | null;
  /**
   * Option counts for the filter UI, computed over the datasets matching every
   * OTHER filter (so "Health (12)" tells the truth about what selecting it
   * would give), from the same rows as the list: no extra queries, no cache keys.
   */
  facets: { themes: ThemeCount[]; publishers: PublisherFacet[] };
}

export interface ListOptions {
  /** Page size (1..100). Default `THEME_PAGE_SIZE`. */
  pageSize?: number;
  /** Only datasets whose source modified date is at or after this instant (public API `updated_since`). */
  updatedSince?: Date | null;
}

const LIST_ROW_SELECT = {
  id: true,
  titleClean: true,
  titleAr: true,
  publisher: true,
  theme: true,
  sourceModified: true,
  recordsCount: true,
} satisfies Prisma.DatasetSelect;

type ListRow = Prisma.DatasetGetPayload<{ select: typeof LIST_ROW_SELECT }>;

/**
 * True while any live dataset still has an empty searchText (the column was
 * added by a migration; the sync engine fills it on its next catalog pass).
 * While that is the case, token matching also falls back to the raw columns
 * for those rows, so search does not go blank between deploying the column
 * and running the backfill. Once it is false (the normal state) the query is
 * the plain `searchText LIKE '%token%'` that the trigram index can serve.
 * One cached boolean, tag "datasets", so the sync's notify step flips it.
 */
const loadSearchBackfillPending = unstable_cache(
  async (): Promise<boolean> =>
    (await prisma.dataset.findFirst({ where: { removedAt: null, searchText: "" }, select: { id: true } })) !== null,
  ["search-backfill-pending"],
  LIST_CACHE,
);

/**
 * One token must occur in the normalized searchText (already lowercase, so a
 * plain LIKE; see normalizeSearch). Tokens contain only letters and digits,
 * so there is nothing for LIKE to misread; they are escaped anyway.
 * `withFallback` adds the raw-column match for not-yet-backfilled rows.
 */
function tokenClause(token: string, withFallback: boolean): Prisma.DatasetWhereInput {
  const like = escapeLike(token);
  if (!withFallback) return { searchText: { contains: like } };
  const contains = { contains: like, mode: "insensitive" as const };
  return {
    OR: [
      { searchText: { contains: like } },
      {
        searchText: "",
        OR: [
          { titleClean: contains },
          { titleAr: contains },
          { description: contains },
          { publisher: contains },
          { theme: contains },
        ],
      },
    ],
  };
}

const TITLE_COLLATOR = new Intl.Collator(["ar", "en"], { numeric: true, sensitivity: "base" });

function sortKeyTitle(row: Pick<ListRow, "titleAr" | "titleClean">): string {
  return row.titleAr?.trim() || row.titleClean;
}

function emptyList(params: ListParams, pageSize: number, status: ListStatus): ListResult {
  return {
    items: [],
    total: 0,
    page: 1,
    pageSize,
    totalPages: 1,
    query: params.q,
    tokens: params.tokens,
    params: { ...params, page: 1 },
    status,
    theme: null,
    publisher: null,
    facets: { themes: [], publishers: [] },
  };
}

/**
 * The generic listing behind search, category pages, publisher pages, the
 * filter bar and the public API. `input` may be raw or already parsed: it is
 * re-normalized here, so it is always safe to pass `parseListParams(...)`
 * output (optionally with `theme`/`publisher` taken from the URL path).
 *
 * Nothing here is cached under a user-controlled key: matching, ranking and
 * paging are computed per request over lightweight rows (a few hundred), and
 * only the page's cards come from the per-dataset cache. A page past the end
 * is clamped to the last page.
 */
export async function listDatasets(input: ListParamsInput | ListParams, options: ListOptions = {}): Promise<ListResult> {
  const params = buildListParams(input);
  const pageSize = Number.isSafeInteger(options.pageSize)
    ? Math.min(Math.max(options.pageSize as number, 1), 100)
    : THEME_PAGE_SIZE;

  // A query that normalizes to nothing searchable ("a", "%", "!!") is rejected, not silently ignored:
  // ignoring it would show the whole catalog under a query that matches nothing.
  if (params.q !== "" && params.tokens.length === 0) return emptyList(params, pageSize, "query-too-short");

  const [themeCounts, publisherCounts] = await Promise.all([getThemeCounts(), getPublisherCounts()]);
  const theme = params.theme === null ? null : (themeCounts.find((t) => t.theme === params.theme) ?? null);
  if (params.theme !== null && theme === null) return emptyList(params, pageSize, "unknown-theme");
  const publisher =
    params.publisher === null ? null : (publisherCounts.find((p) => p.slug === params.publisher) ?? null);
  if (params.publisher !== null && publisher === null) return emptyList(params, pageSize, "unknown-publisher");

  const cutoffs = [params.since ? sinceCutoff(params.since) : null, options.updatedSince ?? null].filter(
    (d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()),
  );
  const cutoff = cutoffs.length > 0 ? new Date(Math.max(...cutoffs.map((d) => d.getTime()))) : null;

  const withFallback = params.tokens.length > 0 && (await loadSearchBackfillPending());
  const and: Prisma.DatasetWhereInput[] = params.tokens.map((t) => tokenClause(t, withFallback));
  // "Has a chart" = a derived viz that is not the plain-table fallback. SQL NULL (no viz yet) compares
  // as unknown under `<>`, so rows without any vizConfig are excluded too.
  if (params.hasChart) and.push({ vizConfig: { path: ["type"], not: "table" } });
  if (cutoff) and.push({ sourceModified: { gte: cutoff } });

  const rows = await prisma.dataset.findMany({
    where: { removedAt: null, AND: and },
    select: LIST_ROW_SELECT,
  });

  const slugOf = (row: ListRow) => (row.publisher ? slugify(row.publisher) : null);
  const matchesTheme = (row: ListRow) => theme === null || row.theme === theme.theme;
  const matchesPublisher = (row: ListRow) => publisher === null || slugOf(row) === publisher.slug;

  // Facets: each dimension is counted over the rows passing every filter except its own.
  const themeFacet = new Map<string, number>();
  const publisherFacet = new Map<string, PublisherFacet>();
  const canonicalName = new Map(publisherCounts.map((p) => [p.slug, p.name]));
  for (const row of rows) {
    if (row.theme && matchesPublisher(row)) themeFacet.set(row.theme, (themeFacet.get(row.theme) ?? 0) + 1);
    const slug = slugOf(row);
    if (slug && row.publisher && matchesTheme(row)) {
      const entry = publisherFacet.get(slug) ?? { slug, name: canonicalName.get(slug) ?? row.publisher, count: 0 };
      entry.count += 1;
      publisherFacet.set(slug, entry);
    }
  }

  const selected = rows.filter((row) => matchesTheme(row) && matchesPublisher(row));

  let ordered: ListRow[];
  if (params.sort === "relevance") {
    ordered = selected
      .map((row) => ({
        row,
        id: row.id,
        sourceModified: row.sourceModified,
        score: scoreMatch(
          { titles: [row.titleClean, row.titleAr], publisher: row.publisher, theme: row.theme },
          params.tokens,
        ),
      }))
      .sort(compareRanked)
      .map((x) => x.row);
  } else if (params.sort === "updated") {
    ordered = [...selected].sort(compareByUpdated);
  } else if (params.sort === "records") {
    ordered = [...selected].sort(
      (a, b) =>
        b.recordsCount - a.recordsCount ||
        TITLE_COLLATOR.compare(sortKeyTitle(a), sortKeyTitle(b)) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  } else {
    ordered = [...selected].sort(
      (a, b) => TITLE_COLLATOR.compare(sortKeyTitle(a), sortKeyTitle(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  const total = ordered.length;
  const totalPages = totalPagesFor(total, pageSize);
  const page = clampPage(params.page, totalPages);
  const pageIds = ordered.slice(offsetFor(page, pageSize), offsetFor(page, pageSize) + pageSize).map((r) => r.id);

  return {
    items: await getDatasetCards(pageIds),
    total,
    page,
    pageSize,
    totalPages,
    query: params.q,
    tokens: params.tokens,
    params: { ...params, page },
    status: "ok",
    theme,
    publisher,
    facets: {
      themes: [...themeFacet.entries()]
        .map(([t, count]) => ({ theme: t, count }))
        .sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme)),
      publishers: [...publisherFacet.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    },
  };
}

/**
 * `/categories/[theme]`, A-Z. Unknown themes return an empty page without
 * touching any cache; `status === "unknown-theme"` tells the page to 404.
 */
export async function getDatasetsByTheme(theme: string, page: number): Promise<ListResult> {
  return listDatasets({ theme, sort: "title", page });
}

/**
 * `/publishers/[slug]`, A-Z. Unknown slugs return an empty page with
 * `publisherName: null` and `status === "unknown-publisher"` (404 it).
 */
export async function getDatasetsByPublisherSlug(
  slug: string,
  page: number,
): Promise<ListResult & { publisherName: string | null }> {
  const result = await listDatasets({ publisher: slug, sort: "title", page });
  return { ...result, publisherName: result.publisher?.name ?? null };
}

/** `/search?q=`. A query with nothing searchable ("", "a", "%") returns an empty result, as before. */
export async function searchDatasets(query: string, page: number): Promise<ListResult> {
  const params = buildListParams({ q: query, page });
  // Unlike `listDatasets` (where no query means "browse everything"), a search with nothing to search
  // for has no results.
  if (params.tokens.length === 0) {
    return emptyList(params, THEME_PAGE_SIZE, params.q === "" ? "ok" : "query-too-short");
  }
  return listDatasets(params);
}

// ---------------------------------------------------------------------------
// Home page rail + /updates
// ---------------------------------------------------------------------------

/**
 * Home page "الأحدث تحديثاً": newest by the SOURCE's modified date (not our
 * sync time, which is identical for every dataset after a full sync). Live,
 * synced datasets only; undated ones sort last.
 */
export async function getLatestDatasets(limit = 9): Promise<DatasetCardRow[]> {
  const take = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 9;
  const rows = await prisma.dataset.findMany({
    where: { removedAt: null, lastSyncedAt: { not: null } },
    orderBy: [{ sourceModified: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    take,
    select: { id: true },
  });
  return getDatasetCards(rows.map((r) => r.id));
}

export interface RecentlyUpdated extends PaginatedDatasets {
  /** The validated window in days, or null for "all time". */
  sinceDays: number | null;
}

/**
 * `/updates`: paginated, newest source-modified first. Live and synced
 * datasets with a known modified date only (an undated dataset cannot be
 * "recently updated"). `sinceDays` (1..3650) limits the window; anything else
 * means all time. The UI groups the items by month.
 */
export async function getRecentlyUpdated(
  options: { page?: number; sinceDays?: number | null; pageSize?: number } = {},
): Promise<RecentlyUpdated> {
  const pageSize = Number.isSafeInteger(options.pageSize)
    ? Math.min(Math.max(options.pageSize as number, 1), 100)
    : THEME_PAGE_SIZE;
  const sinceDays =
    typeof options.sinceDays === "number" &&
    Number.isSafeInteger(options.sinceDays) &&
    options.sinceDays >= 1 &&
    options.sinceDays <= 3650
      ? options.sinceDays
      : null;
  const cutoff = sinceDays === null ? null : new Date(Date.now() - sinceDays * 86_400_000);

  const rows = await prisma.dataset.findMany({
    where: {
      removedAt: null,
      lastSyncedAt: { not: null },
      sourceModified: cutoff ? { not: null, gte: cutoff } : { not: null },
    },
    orderBy: [{ sourceModified: "desc" }, { id: "asc" }],
    select: { id: true },
  });

  const total = rows.length;
  const totalPages = totalPagesFor(total, pageSize);
  const page = clampPage(options.page ?? 1, totalPages);
  const offset = offsetFor(page, pageSize);
  const items = await getDatasetCards(rows.slice(offset, offset + pageSize).map((r) => r.id));
  return { items, total, page, pageSize, totalPages, sinceDays };
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

export interface SitemapDataset {
  id: string;
  sourceModified: Date | null;
  lastSyncedAt: Date | null;
}

const loadSitemapDatasets = unstable_cache(
  async () =>
    prisma.dataset.findMany({
      where: { removedAt: null },
      orderBy: { id: "asc" },
      select: { id: true, sourceModified: true, lastSyncedAt: true },
    }),
  ["sitemap-datasets"],
  LIST_CACHE,
);

/** Live datasets for `sitemap.xml` (one cache entry, not one query per crawler hit). */
export async function getSitemapDatasets(): Promise<SitemapDataset[]> {
  const rows = await loadSitemapDatasets();
  return rows.map((r) => ({ id: r.id, sourceModified: toDate(r.sourceModified), lastSyncedAt: toDate(r.lastSyncedAt) }));
}

// ---------------------------------------------------------------------------
// Dataset records
// ---------------------------------------------------------------------------

/** What the records queries need to know about a dataset; tiny, so cached on its own. */
export interface RecordsMeta {
  id: string;
  /** Rows actually stored in DatasetRecord (capped for huge datasets); the page count is derived from it. */
  sourceCount: number;
  /** The portal's own record count (may exceed `sourceCount` for partial datasets). */
  recordsCount: number;
  syncStatus: string;
  removed: boolean;
  fields: Array<{ name: string; label: string | null; type: string }>;
}

/** Records metadata for one dataset (cached per dataset; null and not cached for unknown ids). */
export async function getRecordsMeta(datasetId: string): Promise<RecordsMeta | null> {
  if (!isValidDatasetId(datasetId)) return null;
  return cachedWhen(
    async (): Promise<RecordsMeta | null> => {
      const row = await prisma.dataset.findUnique({
        where: { id: datasetId },
        select: {
          id: true,
          sourceCount: true,
          recordsCount: true,
          syncStatus: true,
          removedAt: true,
          fieldsJson: true,
        },
      });
      if (!row) return null;
      return {
        id: row.id,
        sourceCount: row.sourceCount,
        recordsCount: row.recordsCount,
        syncStatus: row.syncStatus,
        removed: row.removedAt !== null,
        fields: asFields(row.fieldsJson)
          .filter((f): f is CatalogField & { name: string } => typeof f?.name === "string" && f.name !== "")
          .map((f) => ({ name: f.name, label: f.label ?? null, type: (f.type ?? "text").toLowerCase() })),
      };
    },
    (m) => m !== null,
    ["dataset-records-meta", datasetId],
    datasetCache(datasetId),
  );
}

export interface RecordsPage {
  rows: Array<{ id: string; data: Record<string, unknown> }>;
  /** Rows matching (the dataset's stored row count, or the match count when `rq` is set). */
  total: number;
  /** The page actually returned: the requested one clamped into [1, totalPages]. */
  page: number;
  pageSize: number;
  totalPages: number;
  /** The column the rows are sorted by; null when unsorted (or when the sort had to be abandoned). */
  sortField: string | null;
  sortDir: "asc" | "desc";
  /** The in-table search actually applied (cleaned), or null. */
  rq: string | null;
  /** The requested sort timed out or failed, so rows are in default (id) order. */
  sortFailed: boolean;
  /** The in-table search timed out or failed; `rows` is empty and `total` 0. */
  searchFailed: boolean;
}

export interface RecordsPageOptions {
  datasetId: string;
  /** 1-based; clamped into [1, totalPages]. */
  page: number;
  /** Column to sort by; validated against the dataset's own fields (unknown -> default order). */
  sort?: string | null;
  dir?: "asc" | "desc" | null;
  /** In-table search over cell VALUES (max 60 chars, LIKE-escaped). Empty means none. */
  rq?: string | null;
  /** Row count when the caller already has `dataset.sourceCount`; ignored when `rq` is set. */
  total?: number;
}

type RecordRow = { id: bigint; data: unknown };

function toRecordRows(rows: RecordRow[]): RecordsPage["rows"] {
  return rows.map((r) => ({ id: String(r.id), data: (r.data ?? {}) as Record<string, unknown> }));
}

function emptyRecordsPage(dir: "asc" | "desc", flags: Partial<Pick<RecordsPage, "searchFailed" | "rq">> = {}): RecordsPage {
  return {
    rows: [],
    total: 0,
    page: 1,
    pageSize: RECORDS_PAGE_SIZE,
    totalPages: 1,
    sortField: null,
    sortDir: dir,
    rq: null,
    sortFailed: false,
    searchFailed: false,
    ...flags,
  };
}

/**
 * Run raw SQL in a transaction whose statements are capped at
 * RECORDS_STATEMENT_TIMEOUT_MS. `SET LOCAL` semantics via `set_config(..., true)`:
 * the limit dies with the transaction and never leaks onto the pooled connection.
 */
function runRaw<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  // At most HEAVY_QUERY_LIMIT of these run at once per process; the rest fail fast (BusyError)
  // and degrade like a timeout, so a burst of sorted/searched requests cannot starve the pool.
  return heavyQueries.run(() =>
    prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(RECORDS_STATEMENT_TIMEOUT_MS)}, true)`;
        return fn(tx);
      },
      { maxWait: 5_000, timeout: RECORDS_STATEMENT_TIMEOUT_MS * 3 },
    ),
  );
}

/**
 * Concurrent sorted/searched record queries allowed per process (see
 * `src/lib/slot-limiter.ts`). Kept on `globalThis` because Next may evaluate
 * this module once per route bundle, and the cap must be shared by all of them.
 */
const HEAVY_QUERY_LIMIT = 4;
const globalForLimiter = globalThis as unknown as { __nabdHeavyQueries?: SlotLimiter };
const heavyQueries = (globalForLimiter.__nabdHeavyQueries ??= createSlotLimiter(HEAVY_QUERY_LIMIT));

function logRecordsFailure(message: string, err: unknown): void {
  if (err instanceof BusyError) console.warn(`[queries] ${message}: ${err.message}`);
  else console.error(`[queries] ${message}:`, err);
}

let icuProbe: Promise<boolean> | null = null;

/** Whether the `und-x-icu` collation exists here (probed once; a failed probe is retried next time). */
function icuCollationAvailable(): Promise<boolean> {
  icuProbe ??= prisma.$queryRaw<Array<{ ok: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'und-x-icu') AS ok
  `
    .then((r) => r[0]?.ok === true)
    .catch((err) => {
      icuProbe = null;
      console.error("[queries] collation probe failed; text sort falls back to lower():", err);
      return false;
    });
  return icuProbe;
}

/**
 * "Rows of this dataset", written as `= ANY(ARRAY[x])` instead of `= x` — and
 * paired with `ORDER BY r."datasetId", r.id` wherever the order is by id —
 * on purpose. With a plain `datasetId = x ... ORDER BY id LIMIT n` the planner
 * treats datasetId as a constant, sees the primary key already delivers id
 * order, and walks the pkey from id 1 filtering on datasetId, assuming the
 * dataset's rows are spread evenly through the table. They are not (each
 * sync inserts a dataset's rows in one contiguous run), so for the last
 * dataset of a 1.1M-row table that scan discarded 1,070,180 rows (156 ms)
 * to return page 2. A one-element `ANY` is not an equality the planner folds
 * into a constant, so `ORDER BY datasetId, id` can only be served by the
 * (datasetId, id) index: Limit -> Index Scan, ~0.1 ms for any shallow page.
 */
function inDataset(datasetId: string): Prisma.Sql {
  return Prisma.sql`r."datasetId" = ANY(ARRAY[${datasetId}]::text[])`;
}

function recordsWhere(datasetId: string, search: RecordsSearch | null): Prisma.Sql {
  if (!search) return inDataset(datasetId);
  // Match VALUES only: casting the whole document to text would also match key names, so searching
  // "year" would hit every row. The CASE guards against a non-object document (jsonb_each_text
  // raises on those) and, unlike AND, is guaranteed to evaluate in order. ILIKE's default escape
  // character is a backslash, which is what `escapeLike` produces.
  //
  // The exact check calls a set-returning function per row, so when it is safe (see
  // RecordsSearch.jsonSafe) a plain `data::text ILIKE` goes first as a pre-filter: the planner
  // evaluates the cheaper qual first, which cut a no-match search over 200k rows from ~800 ms to ~330 ms.
  const prefilter = search.jsonSafe ? Prisma.sql` AND r.data::text ILIKE ${search.pattern}` : Prisma.empty;
  return Prisma.sql`${inDataset(datasetId)}${prefilter} AND (
    CASE WHEN jsonb_typeof(r.data) = 'object'
      THEN EXISTS (SELECT 1 FROM jsonb_each_text(r.data) AS e WHERE e.value ILIKE ${search.pattern})
      ELSE false
    END)`;
}

/**
 * ORDER BY for a validated sort column. Values are read once through a
 * LATERAL (`k.v`, the cell as text).
 *
 * Numeric columns (int/double): guarded numeric cast, dirty values last in
 * both directions.
 * Text columns: empty cells last; then numeric-looking values as numbers
 * ("2" before "10"), then everything else by ICU collation (case-insensitive,
 * Arabic-aware) or `lower()` where ICU is unavailable. Direction reverses the
 * groups consistently.
 *
 * The cast only ever sees text that matched NUMERIC_TEXT_RE (bound as a
 * parameter so its brackets/backslash-free form survives untouched), so a
 * messy source value can never abort the query.
 */
function recordsOrder(sort: SortField, dir: "asc" | "desc", icu: boolean): Prisma.Sql {
  const d = dir === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  const looksNumeric = Prisma.sql`k.v ~ ${NUMERIC_TEXT_RE}::text`;
  const numericValue = Prisma.sql`(CASE WHEN ${looksNumeric} THEN k.v::numeric END)`;
  if (sort.numeric) return Prisma.sql`${numericValue} ${d} NULLS LAST, r.id ASC`;
  const textKey = icu ? Prisma.raw(`k.v COLLATE "und-x-icu"`) : Prisma.raw("lower(k.v)");
  return Prisma.sql`(k.v IS NULL OR k.v = '') ASC, (CASE WHEN ${looksNumeric} THEN 0 ELSE 1 END) ${d}, ${numericValue} ${d} NULLS LAST, ${textKey} ${d}, r.id ASC`;
}

interface RecordsRequest {
  meta: RecordsMeta;
  sort: SortField | null;
  dir: "asc" | "desc";
  search: RecordsSearch | null;
  page: number;
  knownTotal: number;
}

async function loadRecordsPage(req: RecordsRequest): Promise<RecordsPage> {
  const { meta, sort, dir, search } = req;
  const pageSize = RECORDS_PAGE_SIZE;
  const rq = search?.text ?? null;

  let total = req.knownTotal;
  if (search) {
    // Only here is a COUNT needed: a plain page uses the dataset's stored row count.
    try {
      const [{ n }] = await runRaw((tx) =>
        tx.$queryRaw<Array<{ n: number }>>(
          Prisma.sql`SELECT count(*)::int AS n FROM "DatasetRecord" r WHERE ${recordsWhere(meta.id, search)}`,
        ),
      );
      total = n;
    } catch (err) {
      logRecordsFailure(`records search count failed for ${meta.id}`, err);
      return emptyRecordsPage(dir, { searchFailed: true, rq });
    }
  }

  // A search that matched nothing is already answered: do not scan the dataset a second time for rows.
  if (search && total === 0) return emptyRecordsPage(dir, { rq });

  const totalPages = totalPagesFor(total, pageSize);
  const page = clampPage(req.page, totalPages);
  const skip = offsetFor(page, pageSize);

  const fetchRows = async (candidate: SortField | null): Promise<RecordRow[]> => {
    if (!candidate && !search) {
      // Default order: Limit -> Index Scan on (datasetId, id), no sort, no COUNT (see `inDataset`).
      return prisma.$queryRaw<RecordRow[]>(Prisma.sql`
        SELECT r.id, r.data FROM "DatasetRecord" r
        WHERE ${inDataset(meta.id)}
        ORDER BY r."datasetId", r.id
        LIMIT ${pageSize} OFFSET ${skip}`);
    }
    const icu = candidate && !candidate.numeric ? await icuCollationAvailable() : false;
    return runRaw((tx) =>
      tx.$queryRaw<RecordRow[]>(
        candidate
          ? Prisma.sql`
              SELECT r.id, r.data FROM "DatasetRecord" r
              CROSS JOIN LATERAL (SELECT r.data ->> ${candidate.name}::text AS v) k
              WHERE ${recordsWhere(meta.id, search)}
              ORDER BY ${recordsOrder(candidate, dir, icu)}
              LIMIT ${pageSize} OFFSET ${skip}`
          : Prisma.sql`
              SELECT r.id, r.data FROM "DatasetRecord" r
              WHERE ${recordsWhere(meta.id, search)}
              ORDER BY r."datasetId", r.id
              LIMIT ${pageSize} OFFSET ${skip}`,
      ),
    );
  };

  // A sorted/filtered query that times out degrades to id order (then, for a search, to a failure
  // notice) instead of a 500 page. Plain id-order failures are real errors and propagate.
  let rows: RecordRow[] | null = null;
  let usedSort: SortField | null = null;
  let sortFailed = false;
  for (const candidate of sort ? [sort, null] : [null]) {
    try {
      rows = await fetchRows(candidate);
      usedSort = candidate;
      break;
    } catch (err) {
      if (!candidate && !search) throw err;
      logRecordsFailure(`records query failed for ${meta.id} (sort=${candidate?.name ?? "none"})`, err);
      if (candidate) sortFailed = true;
    }
  }
  if (!rows) return emptyRecordsPage(dir, { searchFailed: true, rq });

  return {
    rows: toRecordRows(rows),
    total,
    page,
    pageSize,
    totalPages,
    sortField: usedSort?.name ?? null,
    sortDir: dir,
    rq,
    sortFailed,
    searchFailed: false,
  };
}

/**
 * Server-paginated (25/page), server-sortable, searchable raw record view —
 * the one place raw DatasetRecord rows reach the client, and only a page at a
 * time.
 *
 * - `datasetId`, `sort` and `rq` are all validated here (existence, the
 *   dataset's own field list, length/charset) — callers may pass URL values
 *   straight through.
 * - `total` comes from `options.total` or the dataset's stored `sourceCount`;
 *   no COUNT(*) unless `rq` is set. `page` is clamped to the last real page.
 * - Sorted/searched queries run with a 3 s statement timeout; a sort that
 *   fails falls back to id order (`sortFailed: true`).
 * - Only the first page without `rq` is cached (tag `dataset:<id>`), keyed by
 *   dataset, validated sort column and direction; everything else is a plain
 *   query, so page/sort/rq combinations cannot grow the cache.
 *
 * The positional form is the pre-options signature, kept so existing pages
 * keep working; its `fields` argument is ignored (the schema is read from the
 * dataset itself).
 */
export function getDatasetRecordsPage(options: RecordsPageOptions): Promise<RecordsPage>;
/** @deprecated Use the options form. `fields` is ignored. */
export function getDatasetRecordsPage(
  datasetId: string,
  page: number,
  sortField: string | null,
  sortDir: "asc" | "desc",
  fields?: readonly CatalogField[],
): Promise<RecordsPage>;
export async function getDatasetRecordsPage(
  ...args: [RecordsPageOptions] | [string, number, string | null, "asc" | "desc", (readonly CatalogField[])?]
): Promise<RecordsPage> {
  const options: RecordsPageOptions =
    typeof args[0] === "string"
      ? { datasetId: args[0], page: args[1] as number, sort: args[2] as string | null, dir: args[3] as "asc" | "desc" }
      : (args[0] as RecordsPageOptions);

  const dir: "asc" | "desc" = options.dir === "desc" ? "desc" : "asc";
  const meta = await getRecordsMeta(options.datasetId);
  if (!meta) return emptyRecordsPage(dir);

  const sort = resolveSortField(meta.fields, options.sort);
  const search = normalizeRecordsQuery(options.rq);
  const knownTotal =
    typeof options.total === "number" && Number.isSafeInteger(options.total) && options.total >= 0
      ? options.total
      : meta.sourceCount;
  const req: RecordsRequest = { meta, sort, dir, search, page: options.page, knownTotal };

  const wantsFirstPage = !search && Number.isSafeInteger(options.page) && options.page === 1;
  if (!wantsFirstPage) return loadRecordsPage(req);
  return cachedWhen(
    () => loadRecordsPage(req),
    (p) => !p.sortFailed,
    ["dataset-records", meta.id, sort?.name ?? "", dir],
    datasetCache(meta.id),
  );
}

export interface RecordsAfterPage {
  rows: Array<{ id: string; data: Record<string, unknown> }>;
  /** Pass as `after` to get the next batch; null when this was the last. */
  nextAfter: string | null;
}

/**
 * Keyset pagination for the public API / CSV export: rows with `id > after`
 * in id order, at most `limit` (1..1000), no OFFSET and no COUNT. Returns
 * null for an unknown dataset. Uncached on purpose (the API sits behind a CDN
 * cache header; a cursor space is unbounded).
 */
export async function getDatasetRecordsAfter(options: {
  datasetId: string;
  after?: string | null;
  limit?: number;
}): Promise<RecordsAfterPage | null> {
  const meta = await getRecordsMeta(options.datasetId);
  if (!meta) return null;
  const limit = Number.isSafeInteger(options.limit) ? Math.min(Math.max(options.limit as number, 1), 1000) : 100;
  const after = typeof options.after === "string" && /^\d{1,18}$/.test(options.after) ? BigInt(options.after) : null;
  const afterCondition = after !== null ? Prisma.sql` AND r.id > ${after}` : Prisma.empty;
  const rows = await prisma.$queryRaw<RecordRow[]>(Prisma.sql`
    SELECT r.id, r.data FROM "DatasetRecord" r
    WHERE ${inDataset(meta.id)}${afterCondition}
    ORDER BY r."datasetId", r.id
    LIMIT ${limit + 1}`);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: toRecordRows(page),
    nextAfter: hasMore ? String(page[page.length - 1].id) : null,
  };
}
