/**
 * Defensive parsing for URL search params (Next.js hands pages `string |
 * string[] | undefined`). Every public page must run user-controlled params
 * through these before they reach a query or a cache key.
 */

type RawParam = string | string[] | undefined | null;

/** First value of a possibly-repeated param (`?q=a&q=b` -> "a"). */
export function first(value: RawParam): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

/**
 * 1-based page number. Accepts only plain digit strings of at most 5 digits,
 * so `1e21`, `Infinity`, `0x10`, `1.5`, `-3` and `[]` all fall back to 1.
 */
export function parsePage(value: RawParam, max = 10_000): number {
  const raw = first(value)?.trim();
  if (!raw || !/^\d{1,5}$/.test(raw)) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < 1) return 1;
  return Math.min(n, max);
}

/** Trimmed, length-capped free-text query ("" when absent). */
export function parseQuery(value: RawParam, maxLen = 100): string {
  return (first(value) ?? "").trim().slice(0, maxLen);
}

/** One of an allowed set of values, else the fallback. */
export function parseEnum<T extends string>(value: RawParam, allowed: readonly T[], fallback: T): T {
  const raw = first(value);
  return raw !== undefined && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}
