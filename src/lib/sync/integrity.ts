/**
 * Pure integrity checks the engine applies BEFORE it writes anything: is the
 * catalog plausible enough to prune from, is a downloaded export plausible
 * enough to replace stored rows. No I/O, so they are unit-testable.
 * Throwing a SyncIntegrityError leaves the stored data untouched.
 */

import { SyncIntegrityError } from "./errors";
import type { CatalogDataset } from "./schemas";

/** A complete catalog smaller than this fraction of the known datasets is not trusted for pruning. */
export const MIN_CATALOG_FRACTION = 0.5;

/**
 * The shrink guard ignores datasets the portal itself says are tiny: "half of
 * 4 rows" is noise (a catalog count that lags a genuine shrink would park the
 * dataset in "error"), while 10+ rows is enough for a truncated export to be
 * recognisable. Everything above the floor is protected, small tables included.
 */
export const SHRINK_GUARD_MIN_ROWS = 10;
export const SHRINK_GUARD_RATIO = 0.5;

/**
 * Datasets the portal advertises with more rows than this are downloaded one
 * at a time (fetch + derive + transaction): each one pins a database
 * connection for the whole delete + createMany and holds the full export in
 * memory, so three of them at once can starve the web pool on a small VPS.
 */
export const BIG_DATASET_ROWS = 50_000;

/**
 * Refuse to prune from a catalog that is complete but implausibly small
 * (portal serving an error page as an empty catalog, wrong ODS_BASE_URL...).
 * `knownLiveCount` must be the count over the WHOLE database, also on the
 * single-dataset path, or the 50% test degenerates to "is the catalog empty".
 */
export function assertPlausibleCatalog(seenCount: number, knownLiveCount: number): void {
  if (knownLiveCount > 0 && seenCount < knownLiveCount * MIN_CATALOG_FRACTION) {
    throw new SyncIntegrityError(
      `The portal catalog lists only ${seenCount} datasets but ${knownLiveCount} are known; ` +
        `refusing to prune (possible portal problem). Nothing was changed.`,
    );
  }
}

/** What the guard needs to know about the dataset's stored copy. */
export interface StoredForIntegrity {
  syncStatus: string;
  sourceCount: number;
}

/**
 * Integrity guards, applied after the export arrived and BEFORE anything is
 * written. Throwing leaves the stored rows, lastSyncedAt and syncedVersion
 * untouched, so the next run retries.
 */
export function assertExportIntegrity(
  rows: number,
  freshCount: number,
  stored: StoredForIntegrity | undefined,
  force: boolean,
): void {
  // The fresh catalog (not our stale previous count) says there should be data.
  if (rows === 0 && freshCount > 0) {
    throw new SyncIntegrityError(
      `Export returned 0 rows but the catalog reports ${freshCount}; keeping previous data`,
    );
  }
  // Truncated export: far fewer rows than BOTH the portal's own count and
  // what we stored. Comparing with the fresh catalog count means a genuine
  // upstream shrink (catalog count drops too) is accepted; `partial` rows are
  // exempt because their stored count is capped; `force` overrides.
  //
  // A dataset left in "error" (by this very guard, or a failed download) keeps
  // its last good `sourceCount`, so it stays protected: restricting the guard
  // to "ok" rows let the truncated export through on the NEXT plain run.
  // Never-synced rows have sourceCount 0, which keeps the guard inert for them.
  const previouslyStored = stored && stored.syncStatus !== "partial" ? stored.sourceCount : 0;
  if (
    !force &&
    freshCount >= SHRINK_GUARD_MIN_ROWS &&
    rows < previouslyStored * SHRINK_GUARD_RATIO &&
    rows < freshCount * SHRINK_GUARD_RATIO
  ) {
    throw new SyncIntegrityError(
      `Export returned ${rows} rows but the catalog reports ${freshCount} (previously stored ${previouslyStored}); ` +
        `keeping previous data unless forced`,
    );
  }
}

/**
 * Whether a changed dataset must take the one-at-a-time lane. An entry whose
 * records_count is missing or not a number counts as big: "unknown" must not
 * be the way around the guardrail.
 */
export function isBigDataset(entry: CatalogDataset): boolean {
  const raw = entry.metas?.default?.records_count;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return true;
  return raw > BIG_DATASET_ROWS;
}
