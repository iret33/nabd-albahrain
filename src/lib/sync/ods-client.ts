/**
 * Thin client over the data.gov.bh Explore API v2.1 endpoints this project
 * needs: the paginated catalog and per-dataset full JSON exports.
 */

import { EXPORT_TIMEOUT_MS, politeFetchJson } from "./http";
import {
  CatalogPageSchema,
  ExportArraySchema,
  type CatalogDataset,
} from "./schemas";

// Overridable so the whole sync pipeline can run offline against
// scripts/mock-ods.mjs (see README "Offline development").
const BASE_URL = (process.env.ODS_BASE_URL ?? "https://data.gov.bh/api/explore/v2.1").replace(/\/+$/, "");
const CATALOG_PAGE_SIZE = 100;

/**
 * Fetch every dataset in the catalog, paginating 100 at a time (the ODS
 * max), and validating each page against CatalogPageSchema. Requests are
 * still funneled through the shared rate limiter in http.ts, so the
 * concurrency cap / delay / retry rules apply here too even though the
 * pages are fetched sequentially (page N+1 needs page N's total_count).
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
 */
export async function fetchFullCatalog(): Promise<CatalogDataset[]> {
  const all: CatalogDataset[] = [];
  let offset = 0;
  let totalCount = Infinity;

  while (offset < totalCount) {
    const raw = await politeFetchJson(
      `${BASE_URL}/catalog/datasets?limit=${CATALOG_PAGE_SIZE}&offset=${offset}&order_by=dataset_id`,
    );
    const page = CatalogPageSchema.parse(raw);
    totalCount = page.total_count;
    all.push(...page.results);
    offset += CATALOG_PAGE_SIZE;

    // Defensive: if ODS ever returns an empty page before offset reaches
    // total_count (shouldn't happen, but a live third-party API is a live
    // third-party API), stop instead of looping forever.
    if (page.results.length === 0) break;
  }

  return all;
}

/**
 * Fetch the full export for one dataset as a flat array of plain objects.
 * Tolerant of an empty/absent body (returns []) — the caller decides what
 * an empty export means for sync status.
 */
export async function fetchDatasetExport(datasetId: string): Promise<Record<string, unknown>[]> {
  const raw = await politeFetchJson(
    `${BASE_URL}/catalog/datasets/${encodeURIComponent(datasetId)}/exports/json`,
    { timeoutMs: EXPORT_TIMEOUT_MS },
  );
  if (raw == null) return [];
  return ExportArraySchema.parse(raw);
}
