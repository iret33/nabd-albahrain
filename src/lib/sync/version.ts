/**
 * Change detection: "did the portal publish something new for this dataset?"
 *
 * The old rule compared OUR clock (`lastSyncedAt`, stamped after the download
 * finished) with the portal's `modified`. That races with a change landing
 * mid-download, breaks on date-only/future/skewed timestamps, and never
 * looked at the row count. Instead we snapshot an OPAQUE version string of the
 * catalog entry we synced from and later test it for plain equality against
 * the freshly fetched entry. Nothing is ever ordered or compared as a time.
 */

import type { CatalogDataset } from "./schemas";
import { fnv1a } from "./utils";

/** Bump the prefix to invalidate every stored version (each dataset re-syncs once). */
const VERSION_PREFIX = "v1";

function token(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/**
 * Opaque version of one catalog entry: portal timestamps (`modified`,
 * `data_processed`, `metadata_processed`, whichever the portal provides), the
 * advertised row count, and a short hash of the (sorted) field names so a
 * schema change is noticed even if no timestamp moved. Absent inputs simply
 * contribute an empty slot, so it degrades to modified + records_count.
 */
export function computeSourceVersion(entry: CatalogDataset): string {
  const meta = entry.metas?.default;
  const fieldNames = (entry.fields ?? [])
    .map((f) => f.name)
    .sort()
    .join("\u0001");

  return [
    VERSION_PREFIX,
    token(meta?.modified),
    token(meta?.data_processed),
    token(meta?.metadata_processed),
    token(meta?.records_count),
    fieldNames ? fnv1a(fieldNames) : "",
  ].join("|");
}
