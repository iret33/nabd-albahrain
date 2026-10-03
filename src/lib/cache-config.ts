/**
 * Pure helpers behind the data-access cache policy (see `CACHE` in
 * `queries.ts`). Split out so they can be unit-tested and imported by the
 * sync engine's notify step without dragging Prisma or `next/cache` in.
 */

/** Tag shared by every list/aggregate query. Revalidated after any sync that changed something. */
export const DATASETS_TAG = "datasets";

/** Per-dataset tag: detail, card, records page, records meta. Revalidated for each dataset a sync updated. */
export function datasetTag(id: string): string {
  return `dataset:${id}`;
}

export const DEFAULT_CACHE_TTL_SECONDS = 300;
export const MIN_CACHE_TTL_SECONDS = 5;
export const MAX_CACHE_TTL_SECONDS = 86_400;

/** Per-dataset entries are tag-invalidated on every real change, so they can safely live this many times longer. */
export const DETAIL_TTL_MULTIPLIER = 6;

/**
 * Parse `CACHE_TTL_SECONDS`. Only plain digit strings are accepted (so `1e3`,
 * `-5`, `0x10`, `" "` and `abc` are rejected rather than half-parsed) and the
 * value is clamped to [MIN, MAX]. Anything invalid falls back to the default
 * and is reported through `onInvalid` so a typo does not silently change the
 * freshness guarantees of the site.
 */
export function resolveCacheTtl(
  raw: string | undefined,
  onInvalid: (message: string) => void = () => {},
): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CACHE_TTL_SECONDS;
  const text = raw.trim();
  if (!/^\d{1,7}$/.test(text)) {
    onInvalid(`CACHE_TTL_SECONDS=${JSON.stringify(raw)} is not a positive integer; using ${DEFAULT_CACHE_TTL_SECONDS}s`);
    return DEFAULT_CACHE_TTL_SECONDS;
  }
  const n = Number.parseInt(text, 10);
  if (n < MIN_CACHE_TTL_SECONDS || n > MAX_CACHE_TTL_SECONDS) {
    const clamped = Math.min(MAX_CACHE_TTL_SECONDS, Math.max(MIN_CACHE_TTL_SECONDS, n));
    onInvalid(
      `CACHE_TTL_SECONDS=${n} is outside ${MIN_CACHE_TTL_SECONDS}..${MAX_CACHE_TTL_SECONDS}; using ${clamped}s`,
    );
    return clamped;
  }
  return n;
}

/** Longest dataset id the data layer will look up (Next caps a tag at 256 chars; `dataset:` adds 8). */
export const MAX_DATASET_ID_LENGTH = 200;

/**
 * Cheap structural check applied to every id that comes from a URL before it
 * reaches Postgres or a cache key: non-empty, bounded, no control characters
 * (a NUL byte makes Postgres reject the whole query, which would turn
 * `/dataset/%00` into a 500). It does NOT prove the dataset exists.
 */
export function isValidDatasetId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_DATASET_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(id)
  );
}

/** Publisher slugs are `slugify()` output: lowercase ASCII letters, digits and hyphens. */
export function isValidPublisherSlug(slug: unknown): slug is string {
  return typeof slug === "string" && slug.length > 0 && slug.length <= 200 && /^[a-z0-9-]+$/.test(slug);
}
