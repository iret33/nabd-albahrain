/**
 * SyncLock: a singleton row (id=1) used as a mutex so only one sync runs at
 * a time, across processes and across web/CLI/scheduler callers.
 *
 * - ACQUIRE is one atomic statement (INSERT ... ON CONFLICT DO UPDATE ... WHERE
 *   <free or stale>): Postgres makes a second concurrent caller wait on the
 *   row lock and then re-evaluate the WHERE against the winner's row, so
 *   exactly one caller gets a row back. (The old findUnique-then-upsert let
 *   two callers both succeed.)
 * - Every acquisition gets a random `holder` token; RELEASE and HEARTBEAT only
 *   touch the row while it still carries that token, so a run that outlived a
 *   stale takeover can never free (or keep alive) somebody else's lock.
 * - The holder refreshes `heartbeatAt` every 30s from a timer inside the
 *   handle (so it also covers the gap between an API route acquiring and the
 *   background run starting). A lock whose heartbeat — or, for legacy rows
 *   without one, `since` — is older than 10 minutes is STALE and may be taken
 *   over: a crash/redeploy mid-sync now recovers in minutes, not two hours,
 *   and a healthy long run is never mistaken for a dead one.
 * - All timestamps are written and compared with `timezone('utc', now())`
 *   INSIDE the database. The columns are `timestamp(3)` (no time zone); mixing
 *   `now()` (timestamptz) or JS dates into the comparison would shift by the
 *   session time zone on a database that is not set to UTC.
 */

import { prisma } from "@/lib/prisma";
import { SyncAbortedError } from "./errors";

export const LOCK_STALE_MS = 10 * 60 * 1000;
export const LOCK_HEARTBEAT_MS = 30 * 1000;

export class SyncAlreadyRunningError extends Error {
  readonly since: Date;

  constructor(since: Date) {
    super(
      `A sync is already running (started ${since.toISOString()}). ` +
        `Aborting — only one sync may run at a time.`,
    );
    this.name = "SyncAlreadyRunningError";
    this.since = since;
  }
}

export interface SyncLockHandle {
  /** Random token of this acquisition; release/heartbeat only match it. */
  readonly holder: string;
  /** When the lock was acquired (database clock). */
  readonly since: Date;
  /** Aborts if the heartbeat finds the lock was taken over by another run. */
  readonly signal: AbortSignal;
  /**
   * Stop the heartbeat and release the lock if (and only if) we still hold
   * it. Never throws — a failed release is logged and the lock simply goes
   * stale after 10 minutes — so it can sit in a `finally` without masking
   * the original error. Idempotent. Resolves true when the row was released.
   */
  release(): Promise<boolean>;
}

export interface AcquireOptions {
  /** Override the 10-minute staleness window (tests). */
  staleMs?: number;
  /** Override the 30s heartbeat interval (tests). */
  heartbeatMs?: number;
}

interface LockRow {
  running: boolean;
  since: Date | null;
  heartbeatAt: Date | null;
  stale: boolean;
}

/** Staleness is evaluated by the database so it uses the same clock as the writes. */
async function readLockRow(staleMs: number): Promise<LockRow | null> {
  const rows = await prisma.$queryRaw<LockRow[]>`
    SELECT "running", "since", "heartbeatAt",
           ("running" AND COALESCE("heartbeatAt", "since", 'epoch'::timestamp)
              < timezone('utc', now()) - make_interval(secs => ${staleMs / 1000}::double precision)) AS "stale"
    FROM "SyncLock" WHERE "id" = 1`;
  return rows[0] ?? null;
}

/**
 * Acquire the lock or throw SyncAlreadyRunningError. Always release the
 * returned handle in a `finally` block.
 */
export async function acquireLock(opts: AcquireOptions = {}): Promise<SyncLockHandle> {
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const heartbeatMs = opts.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const holder = crypto.randomUUID();

  // Read-only peek, only so a takeover of a dead run's lock is logged. The
  // authoritative decision is the single statement below.
  const before = await readLockRow(staleMs);

  const acquired = await prisma.$queryRaw<Array<{ since: Date }>>`
    INSERT INTO "SyncLock" ("id", "running", "since", "heartbeatAt", "holder")
    VALUES (1, true, timezone('utc', now()), timezone('utc', now()), ${holder})
    ON CONFLICT ("id") DO UPDATE SET
      "running" = true,
      "since" = timezone('utc', now()),
      "heartbeatAt" = timezone('utc', now()),
      "holder" = ${holder}
    WHERE "SyncLock"."running" = false
       OR COALESCE("SyncLock"."heartbeatAt", "SyncLock"."since", 'epoch'::timestamp)
            < timezone('utc', now()) - make_interval(secs => ${staleMs / 1000}::double precision)
    RETURNING "since"`;

  if (acquired.length === 0) {
    const row = await readLockRow(staleMs);
    throw new SyncAlreadyRunningError(row?.since ?? new Date(0));
  }

  if (before?.running && before.stale) {
    const last = before.heartbeatAt ?? before.since;
    console.warn(
      `[sync] Took over a stale lock (last heartbeat ${last ? last.toISOString() : "never"}).`,
    );
  }

  const since = acquired[0].since;
  const lostController = new AbortController();
  let released = false;
  let beating = false;

  const timer = setInterval(() => {
    if (released || beating) return;
    beating = true;
    prisma
      .$executeRaw`UPDATE "SyncLock" SET "heartbeatAt" = timezone('utc', now()) WHERE "id" = 1 AND "holder" = ${holder}`
      .then((count) => {
        if (count === 0 && !released && !lostController.signal.aborted) {
          console.error("[sync] Lock heartbeat found the lock owned by someone else; aborting this run.");
          lostController.abort(new SyncAbortedError("Sync lock was lost (taken over by another run)"));
        }
      })
      .catch((err) => {
        // A transient DB error must not abort a healthy run; the next beat retries.
        console.error("[sync] Lock heartbeat failed:", err);
      })
      .finally(() => {
        beating = false;
      });
  }, heartbeatMs);
  timer.unref();

  return {
    holder,
    since,
    signal: lostController.signal,
    async release() {
      if (released) return false;
      released = true;
      clearInterval(timer);
      try {
        const count = await prisma.$executeRaw`
          UPDATE "SyncLock"
          SET "running" = false, "since" = NULL, "heartbeatAt" = NULL, "holder" = NULL
          WHERE "id" = 1 AND "holder" = ${holder}`;
        return count > 0;
      } catch (err) {
        console.error("[sync] Failed to release the sync lock (it will go stale in ~10 minutes):", err);
        return false;
      }
    },
  };
}

/** Release a handle (convenience wrapper kept for call-site symmetry with acquireLock). */
export function releaseLock(handle: SyncLockHandle): Promise<boolean> {
  return handle.release();
}

export interface LockState {
  running: boolean;
  since: Date | null;
  /** Last heartbeat of the holder (null for legacy rows or when idle). */
  heartbeatAt: Date | null;
  /** True when `running` but the heartbeat is older than 10 minutes — acquireLock() would take it over. */
  stale: boolean;
}

/**
 * Read-only peek at the lock (`GET /api/sync/status`, `/api/freshness`,
 * health). Never mutates anything. `stale` follows the same rule as the
 * atomic acquire (heartbeat, else `since`, older than 10 minutes), evaluated
 * on the database clock.
 */
export async function getLockState(): Promise<LockState> {
  const row = await readLockRow(LOCK_STALE_MS);
  if (!row?.running) {
    return { running: false, since: null, heartbeatAt: null, stale: false };
  }
  return {
    running: true,
    since: row.since ?? new Date(0),
    heartbeatAt: row.heartbeatAt,
    stale: Boolean(row.stale),
  };
}
