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
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onError: (item: T, index: number, error: unknown) => R,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function runNext(): Promise<void> {
    while (true) {
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

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}
