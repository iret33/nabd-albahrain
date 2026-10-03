/**
 * Pure page arithmetic shared by every paginated query in the data layer.
 * Kept separate from `params.ts` (which parses URL text) because these take
 * numbers the *server* computed: a total, a page size and an already-parsed
 * page that may still be past the end.
 */

/** Number of pages needed for `total` items; always at least 1 so an empty list still has "page 1". */
export function totalPagesFor(total: number, pageSize: number): number {
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(pageSize) || pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Coerce an arbitrary page number into `[1, totalPages]`.
 *
 * `Math.max(1, NaN)` is NaN and `Math.max(1, Infinity)` is Infinity, so the
 * finiteness / safe-integer check has to come first and replace `Math.max`,
 * not follow it. Fractions truncate (page 1.5 is page 1).
 */
export function clampPage(page: number, totalPages: number): number {
  const last = Number.isSafeInteger(totalPages) && totalPages >= 1 ? totalPages : 1;
  if (typeof page !== "number" || !Number.isFinite(page)) return 1;
  const n = Math.trunc(page);
  if (!Number.isSafeInteger(n) || n < 1) return 1;
  return Math.min(n, last);
}

/** Zero-based row offset of a (valid, clamped) 1-based page. */
export function offsetFor(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}
