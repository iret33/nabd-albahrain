/**
 * Thin client over the data.gov.bh Explore API v2.1 endpoints this project
 * needs: the paginated catalog, a single catalog entry, and per-dataset full
 * JSON exports.
 */

import { getOdsBaseUrl, syncConfig } from "./config";
import { CatalogIncompleteError, HttpError, SyncAbortedError, SyncIntegrityError } from "./errors";
import { politeFetchJson } from "./http";
import { CatalogPageSchema, parseCatalogEntry, type CatalogDataset } from "./schemas";

const CATALOG_PAGE_SIZE = 100;
/** First attempt + 2 retries of a whole catalog pass. */
const CATALOG_PASSES = 3;
/** Hard stop against a portal that reports an absurd total_count. */
const MAX_CATALOG_PAGES = 500;

export interface CatalogSkip {
  datasetId: string;
  issue: string;
}

export interface CatalogFetchResult {
  /** Valid, de-duplicated entries in catalog order (sorted by dataset_id). */
  datasets: CatalogDataset[];
  /** Entries that failed validation: reported, never synced, never pruned. */
  skipped: CatalogSkip[];
  /**
   * EVERY dataset_id the portal listed, including malformed entries. Removal
   * detection must use this set, not `datasets`: a dataset whose entry is
   * merely malformed is still published and must not be flagged as removed.
   */
  seenIds: Set<string>;
  /** `total_count` the portal reported (equals the number of distinct entries). */
  totalCount: number;
}

interface PassOutcome {
  result: CatalogFetchResult;
  /** Why the pass cannot be trusted (null = complete). */
  problem: string | null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * One full pagination pass over the catalog.
 *
 * IMPORTANT — `order_by=dataset_id` is required here. Reality-check finding
 * (2026-08-04): without an explicit sort, data.gov.bh's default relevance
 * ordering is NOT stable across separate requests (confirmed live: the
 * same `?limit=100&offset=0` call returned dataset_id lists in a
 * different order on two occasions minutes apart, even though it *was*
 * stable across immediately-repeated calls). Paginating an unstable order
 * would silently skip and/or duplicate datasets across pages. Sorting by
 * `dataset_id` (verified live to be alphabetically stable and to produce
 * exactly 512 unique, non-overlapping ids across all pages) makes
 * pagination deterministic.
 *
 * Even so, a dataset added or removed WHILE we paginate shifts the offsets.
 * So the pass verifies itself: every page must report the same total_count
 * and the number of distinct entries must equal it. Anything else is
 * reported as a `problem` and the caller retries the whole pass.
 */
async function fetchCatalogPass(signal?: AbortSignal): Promise<PassOutcome> {
  const datasets: CatalogDataset[] = [];
  const skipped: CatalogSkip[] = [];
  const seenIds = new Set<string>();
  let noIdCount = 0;
  let rawCount = 0;
  let offset = 0;
  let totalCount: number | null = null;
  let problem: string | null = null;

  for (let pageIndex = 0; pageIndex < MAX_CATALOG_PAGES; pageIndex++) {
    const raw = await politeFetchJson(
      `${getOdsBaseUrl()}/catalog/datasets?limit=${CATALOG_PAGE_SIZE}&offset=${offset}&order_by=dataset_id`,
      { signal },
    );
    const page = CatalogPageSchema.parse(raw);

    if (totalCount === null) {
      totalCount = page.total_count;
    } else if (page.total_count !== totalCount) {
      problem = `total_count changed from ${totalCount} to ${page.total_count} during pagination`;
    }

    for (const rawEntry of page.results) {
      rawCount++;
      const parsed = parseCatalogEntry(rawEntry);
      const id = parsed.datasetId;
      if (id === null) {
        noIdCount++;
        skipped.push({ datasetId: "?", issue: parsed.ok ? "missing dataset_id" : parsed.issue });
        continue;
      }
      if (seenIds.has(id)) {
        problem ??= `duplicate dataset_id ${id} in the catalog pages`;
        continue;
      }
      seenIds.add(id);
      if (parsed.ok) datasets.push(parsed.entry);
      else skipped.push({ datasetId: id, issue: parsed.issue });
    }

    // Advance by what we actually received (not by the page size we asked
    // for) so a portal that caps `limit` lower than 100 cannot make us skip
    // entries. An empty page before offset reaches total_count ends the pass;
    // the count check below then flags it as incomplete.
    offset += page.results.length;
    if (page.results.length === 0 || offset >= totalCount) break;
  }

  const expected = totalCount ?? 0;
  if (problem === null && rawCount !== expected) {
    problem = `received ${rawCount} entries but total_count is ${expected}`;
  }
  if (problem === null && seenIds.size + noIdCount !== expected) {
    problem = `${seenIds.size + noIdCount} distinct entries but total_count is ${expected}`;
  }

  return { result: { datasets, skipped, seenIds, totalCount: expected }, problem };
}

/**
 * Fetch every dataset in the catalog, paginating 100 at a time (the ODS max).
 * Requests are funneled through the shared rate limiter in http.ts, so the
 * concurrency cap / delay / retry rules apply here too even though the pages
 * are fetched sequentially (page N+1 needs page N's total_count).
 *
 * The result is only ever returned when the pass was PROVEN complete
 * (distinct entries === total_count on every page). Otherwise the whole pass
 * is retried (up to 2 more times) and, if it never completes, this THROWS
 * CatalogIncompleteError. Callers may therefore treat a returned catalog as
 * the full truth — in particular it is safe to prune datasets absent from it.
 */
export async function fetchFullCatalog(opts: { signal?: AbortSignal } = {}): Promise<CatalogFetchResult> {
  let lastProblem = "unknown";
  for (let pass = 1; pass <= CATALOG_PASSES; pass++) {
    if (opts.signal?.aborted) throw new SyncAbortedError("Sync aborted while fetching the catalog");
    const outcome = await fetchCatalogPass(opts.signal);
    if (outcome.problem === null) return outcome.result;

    lastProblem = outcome.problem;
    console.warn(`[sync] Catalog pass ${pass}/${CATALOG_PASSES} was incomplete: ${outcome.problem}`);
    if (pass < CATALOG_PASSES) await sleep(syncConfig.retryBaseMs * pass, opts.signal);
  }
  throw new CatalogIncompleteError(
    `The portal catalog could not be fetched completely after ${CATALOG_PASSES} attempts (${lastProblem}); nothing was changed`,
  );
}

export interface CatalogEntryResult {
  /** The entry, or null when the portal's complete catalog does not list the id. */
  entry: CatalogDataset | null;
  /** "entry" = one request to the per-dataset endpoint; "catalog" = fell back to the full catalog. */
  via: "entry" | "catalog";
  /** Set when `entry` is null although the id was listed (the entry was malformed). */
  malformedIssue?: string;
}

/**
 * Fetch ONE catalog entry: `GET {BASE}/catalog/datasets/{id}` (1 request
 * instead of 6 catalog pages). Falls back to the full catalog whenever that
 * endpoint answers anything unusable — a non-2xx status (404 on a portal that
 * lacks the endpoint, or on a removed dataset), a different id, or an entry
 * without `fields` — so the answer for "is this id still published?" always
 * comes from a verified-complete catalog, never from a single 404.
 */
export async function fetchCatalogEntry(
  datasetId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<CatalogEntryResult> {
  try {
    const raw = await politeFetchJson(
      `${getOdsBaseUrl()}/catalog/datasets/${encodeURIComponent(datasetId)}`,
      { signal: opts.signal },
    );
    // v2.1 returns the dataset object itself; tolerate a { dataset: {...} } wrapper.
    const candidate =
      raw && typeof raw === "object" && !("dataset_id" in raw) && "dataset" in raw
        ? (raw as { dataset: unknown }).dataset
        : raw;
    const parsed = parseCatalogEntry(candidate);
    if (parsed.ok && parsed.entry.dataset_id === datasetId && parsed.entry.fields !== undefined) {
      return { entry: parsed.entry, via: "entry" };
    }
    console.warn(`[sync] Per-dataset catalog endpoint gave an unusable entry for ${datasetId}; using the full catalog.`);
  } catch (err) {
    if (err instanceof SyncAbortedError) throw err;
    const reason = err instanceof HttpError && err.status ? `HTTP ${err.status}` : "request failed";
    console.warn(`[sync] Per-dataset catalog endpoint failed for ${datasetId} (${reason}); using the full catalog.`);
  }

  const catalog = await fetchFullCatalog({ signal: opts.signal });
  const entry = catalog.datasets.find((d) => d.dataset_id === datasetId) ?? null;
  if (entry) return { entry, via: "catalog" };
  const malformed = catalog.skipped.find((s) => s.datasetId === datasetId);
  return { entry: null, via: "catalog", malformedIssue: malformed?.issue };
}

/**
 * Fetch the full export for one dataset as a flat array of plain objects.
 * Tolerant of an empty/absent body (returns []) — the caller decides what an
 * empty export means for sync status (see the integrity guard in engine.ts).
 * The row check is a cheap loop, not a per-row Zod parse: exports reach
 * 300k+ rows and this runs inside the web process.
 */
export async function fetchDatasetExport(
  datasetId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Record<string, unknown>[]> {
  const raw = await politeFetchJson(
    `${getOdsBaseUrl()}/catalog/datasets/${encodeURIComponent(datasetId)}/exports/json`,
    { timeoutMs: syncConfig.exportTimeoutMs, signal: opts.signal },
  );
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new SyncIntegrityError("Export was not a JSON array; keeping previous data");
  }
  for (const row of raw) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new SyncIntegrityError("Export contained a row that is not an object; keeping previous data");
    }
  }
  return raw as Record<string, unknown>[];
}
