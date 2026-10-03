/**
 * A fail-fast concurrency cap, for expensive queries and for long streams.
 *
 * Sorted and searched record views scan a whole dataset (100–400 ms for 200k
 * rows, up to the 3 s statement timeout), a CSV export streams hundreds of
 * thousands of rows, both are reachable by anyone, and the Prisma pool is
 * small. Queueing them would let a burst of crawlers hold every connection
 * while ordinary pages wait; instead, once `max` are in flight further callers
 * are refused immediately with `BusyError` so the caller can degrade (default
 * order / "try again later") and the pool stays free for the cheap queries
 * that serve the rest of the site.
 *
 * Two ways to hold a slot:
 *  - `run(fn)`: for work that finishes with a promise.
 *  - `tryAcquire()`: for work that outlives the call that started it, i.e. a
 *    streamed response. `run(() => new Response(stream))` would free the slot
 *    when the Response object is RETURNED, long before the body is sent, and so
 *    cap nothing. `tryAcquire` hands back a `release` function the stream must
 *    call exactly once when it ends, fails or is cancelled by the client.
 *
 * `perKey` bounds how many of the `max` slots one caller (a client key) may
 * hold, so a single client cannot take them all and starve everybody else.
 */

export type BusyScope = "global" | "client";

export class BusyError extends Error {
  constructor(
    message = "too many expensive queries in flight",
    /** `client`: this caller already holds its share; `global`: every slot is taken. */
    public readonly scope: BusyScope = "global",
  ) {
    super(message);
    this.name = "BusyError";
  }
}

export interface SlotLimiter {
  /** Run `fn` if a slot is free, else reject with `BusyError` without running it. */
  run<T>(fn: () => Promise<T>, key?: string): Promise<T>;
  /**
   * Take a slot without running anything. Returns a release function (safe to call more than once:
   * only the first call frees the slot), or `null` when no slot is available to `key`.
   */
  tryAcquire(key?: string): (() => void) | null;
  /** Why `tryAcquire`/`run` would refuse right now, or null when a slot is free for `key`. */
  refusal(key?: string): BusyScope | null;
  readonly inFlight: number;
}

export const DEFAULT_HEAVY_QUERY_LIMIT = 4;

/**
 * How many sorted/searched record queries may run at once. `HEAVY_QUERY_LIMIT` (digits, 1..16) wins;
 * otherwise 4, lowered to `connection_limit - 2` when DATABASE_URL pins the Prisma pool, so at least two
 * pooled connections stay free for the cheap queries behind every other page. (Without a pinned pool
 * Prisma sizes it from the host's CPU count, which the app cannot see from inside a container, so the
 * default stays 4 and deployments are expected to set `connection_limit`.) A bad value falls back to
 * the default and is reported through `onInvalid`.
 */
export function resolveHeavyQueryLimit(
  rawEnv: string | undefined,
  databaseUrl: string | undefined,
  onInvalid: (message: string) => void = () => {},
): number {
  const text = rawEnv?.trim() ?? "";
  if (text !== "") {
    if (/^\d{1,2}$/.test(text) && Number(text) >= 1 && Number(text) <= 16) return Number(text);
    onInvalid(`HEAVY_QUERY_LIMIT=${JSON.stringify(rawEnv)} is not an integer from 1 to 16; using the default`);
  }
  const pooled = /[?&]connection_limit=(\d{1,3})(?:&|$)/.exec(databaseUrl ?? "");
  if (pooled) return Math.min(DEFAULT_HEAVY_QUERY_LIMIT, Math.max(1, Number(pooled[1]) - 2));
  return DEFAULT_HEAVY_QUERY_LIMIT;
}

export function createSlotLimiter(max: number, options: { perKey?: number } = {}): SlotLimiter {
  let inFlight = 0;
  /** Slots held per key. An entry is deleted when it reaches zero, so the map never outgrows what is in flight. */
  const held = new Map<string, number>();
  const perKey = options.perKey !== undefined && options.perKey >= 1 ? options.perKey : Number.POSITIVE_INFINITY;

  const refusal = (key?: string): BusyScope | null => {
    if (inFlight >= max) return "global";
    if (key !== undefined && (held.get(key) ?? 0) >= perKey) return "client";
    return null;
  };

  const tryAcquire = (key?: string): (() => void) | null => {
    if (refusal(key) !== null) return null;
    inFlight += 1;
    if (key !== undefined) held.set(key, (held.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight -= 1;
      if (key !== undefined) {
        const left = (held.get(key) ?? 1) - 1;
        if (left <= 0) held.delete(key);
        else held.set(key, left);
      }
    };
  };

  return {
    get inFlight() {
      return inFlight;
    },
    refusal,
    tryAcquire,
    async run<T>(fn: () => Promise<T>, key?: string): Promise<T> {
      const scope = refusal(key);
      if (scope !== null) throw new BusyError(undefined, scope);
      const release = tryAcquire(key) as () => void;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
