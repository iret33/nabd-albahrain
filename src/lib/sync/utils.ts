/**
 * Small stateless helpers shared by the sync engine.
 */

/** Leading index prefix on dataset titles, e.g. "2. Population by..." -> "Population by...". */
const TITLE_INDEX_PREFIX = /^\d+[a-z]?[-_.\s]+/;

export function computeTitleClean(title: string): string {
  return title.replace(TITLE_INDEX_PREFIX, "").trim();
}

/** Split an array into fixed-size chunks (last chunk may be shorter). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once.
 * Unlike Promise.all(items.map(...)), this never has more than
 * `concurrency` workers pending simultaneously — important when `items`
 * can be in the hundreds and each worker does real I/O (HTTP + DB writes).
 * A worker's rejection is caught and reported via `onError` rather than
 * aborting the remaining items, matching the "one dataset failing must
 * never stop the loop" rule.
 *
 * `concurrency` is clamped to at least 1 (0, negatives and NaN used to spawn
 * zero workers and silently return an empty array). `shouldStop`, when given,
 * is checked before each item is picked up: a graceful shutdown stops
 * starting new work while in-flight items finish; skipped items leave a hole
 * (`undefined`) in the returned array.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onError: (item: T, index: number, error: unknown) => R,
  shouldStop?: () => boolean,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const width = Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : 1;
  let cursor = 0;

  async function runNext(): Promise<void> {
    while (true) {
      if (shouldStop?.()) return;
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      try {
        results[index] = await worker(item, index);
      } catch (err) {
        results[index] = onError(item, index, err);
      }
    }
  }

  const workers = Array.from({ length: Math.min(width, items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

/**
 * JSON.stringify with object keys sorted at every level, so two values that
 * differ only in key order (e.g. a portal payload vs. what Postgres `jsonb`
 * hands back, which normalises key order) compare equal.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/** 32-bit FNV-1a of a string as 8 hex chars. Not cryptographic; for change detection only. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
