/**
 * A fail-fast concurrency cap for expensive queries.
 *
 * Sorted and searched record views scan a whole dataset (100–400 ms for 200k
 * rows, up to the 3 s statement timeout), they are reachable by anyone, and
 * the Prisma pool is small. Queueing them would let a burst of crawlers hold
 * every connection while ordinary pages wait; instead, once `max` are in
 * flight further callers are refused immediately with `BusyError` so the data
 * layer can degrade (default order / "try again") and the pool stays free for
 * the cheap queries that serve the rest of the site.
 */

export class BusyError extends Error {
  constructor(message = "too many expensive queries in flight") {
    super(message);
    this.name = "BusyError";
  }
}

export interface SlotLimiter {
  /** Run `fn` if a slot is free, else reject with `BusyError` without running it. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly inFlight: number;
}

export function createSlotLimiter(max: number): SlotLimiter {
  let inFlight = 0;
  return {
    get inFlight() {
      return inFlight;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (inFlight >= max) throw new BusyError();
      inFlight += 1;
      try {
        return await fn();
      } finally {
        inFlight -= 1;
      }
    },
  };
}
