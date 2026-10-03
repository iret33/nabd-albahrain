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

export interface Gate {
  /**
   * Run `fn` once fewer than `limit` calls are inside the gate. The slot is
   * released in a `finally`. When `signal` aborts while the caller is still
   * WAITING for a slot, the wait is dropped and the promise rejects with the
   * signal's reason (fn never starts); a call already running is not touched.
   */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** A counting semaphore (FIFO) that holds at most `limit` async operations at once. */
export function createGate(limit: number): Gate {
  const max = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  let active = 0;
  const waiters: Array<() => void> = [];

  const release = () => {
    const next = waiters.shift();
    if (next) next(); // hand the slot straight to the next waiter (active stays the same)
    else active--;
  };

  const acquire = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const at = waiters.indexOf(grant);
        if (at >= 0) waiters.splice(at, 1);
        reject(signal?.reason ?? new Error("aborted"));
      };
      waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  return {
    async run(fn, signal) {
      await acquire(signal);
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
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
