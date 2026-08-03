/**
 * SyncLock: a singleton row (id=1) used as a mutex so only one sync runs at
 * a time. A lock whose `since` is older than STALE_MS is treated as stale
 * (e.g. a previous run crashed without releasing it) and auto-released
 * before we try to acquire it.
 */

import { prisma } from "@/lib/prisma";

const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

export class SyncAlreadyRunningError extends Error {
  constructor(since: Date) {
    super(
      `A sync is already running (started ${since.toISOString()}). ` +
        `Aborting — only one sync may run at a time.`,
    );
    this.name = "SyncAlreadyRunningError";
  }
}

/**
 * Acquire the lock or throw SyncAlreadyRunningError. Always pair with
 * releaseLock() in a finally block.
 */
export async function acquireLock(): Promise<void> {
  const existing = await prisma.syncLock.findUnique({ where: { id: 1 } });

  if (existing?.running) {
    const since = existing.since ?? new Date(0);
    const staleMs = Date.now() - since.getTime();
    if (staleMs < STALE_MS) {
      throw new SyncAlreadyRunningError(since);
    }
    // Stale lock — auto-release before proceeding.
    console.warn(
      `[sync] Found a stale lock (since ${since.toISOString()}, ` +
        `${Math.round(staleMs / 60000)}min ago). Auto-releasing.`,
    );
  }

  await prisma.syncLock.upsert({
    where: { id: 1 },
    create: { id: 1, running: true, since: new Date() },
    update: { running: true, since: new Date() },
  });
}

export async function releaseLock(): Promise<void> {
  await prisma.syncLock.upsert({
    where: { id: 1 },
    create: { id: 1, running: false, since: null },
    update: { running: false, since: null },
  });
}
