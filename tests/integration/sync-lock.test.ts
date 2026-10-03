import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { databaseName, RUN_INTEGRATION, setupHarness, waitUntil, type Harness } from "./helpers";

describe.skipIf(!RUN_INTEGRATION)("sync lock (integration)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await setupHarness();
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  const row = () => h.prisma.syncLock.findUniqueOrThrow({ where: { id: 1 } });
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  it("5 concurrent acquisitions: exactly one wins", async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => h.lock.acquireLock()));
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(4);
    for (const l of lost) expect((l as PromiseRejectedResult).reason).toMatchObject({ name: "SyncAlreadyRunningError" });

    const handle = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof h.lock.acquireLock>>>).value;
    expect((await row()).holder).toBe(handle.holder);
    expect(await handle.release()).toBe(true);
    // free again
    const next = await h.lock.acquireLock();
    await next.release();
  });

  it("works when the lock row is missing entirely", async () => {
    await h.prisma.syncLock.deleteMany();
    const handle = await h.lock.acquireLock();
    expect(await h.lock.getLockState()).toMatchObject({ running: true, stale: false });
    await handle.release();
  });

  it("a held, fresh lock is refused with the real start time", async () => {
    const a = await h.lock.acquireLock();
    try {
      const err = await h.lock.acquireLock().catch((e) => e);
      expect(err.name).toBe("SyncAlreadyRunningError");
      expect(Math.abs(err.since.getTime() - a.since.getTime())).toBeLessThan(5);
    } finally {
      await a.release();
    }
  });

  it("takes over a lock whose heartbeat is older than 10 minutes", async () => {
    const a = await h.lock.acquireLock();
    await h.prisma.syncLock.update({ where: { id: 1 }, data: { heartbeatAt: minutesAgo(11), since: minutesAgo(30) } });
    expect(await h.lock.getLockState()).toMatchObject({ running: true, stale: true });

    const b = await h.lock.acquireLock();
    expect((await row()).holder).toBe(b.holder);
    // the old run can no longer release (or keep alive) the new owner's lock
    expect(await a.release()).toBe(false);
    expect(await h.lock.getLockState()).toMatchObject({ running: true, stale: false });
    expect(await b.release()).toBe(true);
  });

  it("does not take over a lock with a recent heartbeat, however old `since` is", async () => {
    const a = await h.lock.acquireLock();
    await h.prisma.syncLock.update({ where: { id: 1 }, data: { since: minutesAgo(180), heartbeatAt: minutesAgo(2) } });
    await expect(h.lock.acquireLock()).rejects.toMatchObject({ name: "SyncAlreadyRunningError" });
    await a.release();
  });

  it("legacy row: running with a NULL heartbeat is taken over once `since` is old, not before", async () => {
    await h.prisma.syncLock.update({ where: { id: 1 }, data: { running: true, since: minutesAgo(180), heartbeatAt: null, holder: null } });
    expect(await h.lock.getLockState()).toMatchObject({ running: true, stale: true });
    const taken = await h.lock.acquireLock();
    await taken.release();

    await h.prisma.syncLock.update({ where: { id: 1 }, data: { running: true, since: minutesAgo(1), heartbeatAt: null, holder: null } });
    expect(await h.lock.getLockState()).toMatchObject({ running: true, stale: false });
    await expect(h.lock.acquireLock()).rejects.toMatchObject({ name: "SyncAlreadyRunningError" });

    // running=true with nothing at all (NULL since AND heartbeat) is a dead row, not a deadlock
    await h.prisma.syncLock.update({ where: { id: 1 }, data: { running: true, since: null, heartbeatAt: null } });
    const again = await h.lock.acquireLock();
    await again.release();
  });

  it("the heartbeat keeps the lock fresh", async () => {
    const handle = await h.lock.acquireLock({ heartbeatMs: 40 });
    try {
      const first = (await row()).heartbeatAt!;
      await waitUntil(async () => (await row()).heartbeatAt!.getTime() > first.getTime(), { what: "a heartbeat" });
    } finally {
      await handle.release();
    }
  });

  it("stops heart-beating after release", async () => {
    const handle = await h.lock.acquireLock({ heartbeatMs: 30 });
    await handle.release();
    await new Promise((r) => setTimeout(r, 120));
    expect(await row()).toMatchObject({ running: false, holder: null, heartbeatAt: null });
  });

  it("a run whose lock was taken over notices and aborts", async () => {
    const handle = await h.lock.acquireLock({ heartbeatMs: 30 });
    await h.prisma.syncLock.update({ where: { id: 1 }, data: { holder: "someone-else" } });
    await waitUntil(() => handle.signal.aborted, { what: "the lost-lock abort" });
    expect(String((handle.signal.reason as Error).message)).toMatch(/lock was lost/);
    expect(await handle.release()).toBe(false); // does not free someone else's lock
    expect((await row()).running).toBe(true);
  });

  it("release is idempotent and never throws", async () => {
    const handle = await h.lock.acquireLock();
    expect(await handle.release()).toBe(true);
    expect(await handle.release()).toBe(false);
  });

  it("orphan sweep: aborts 'running' rows when the lock is free; keeps only the newest while a live run holds it", async () => {
    const a = await h.prisma.syncLog.create({ data: { trigger: "ghost-a", status: "running" } });
    const b = await h.prisma.syncLog.create({ data: { trigger: "ghost-b", status: "running" } });
    expect(await h.log.sweepOrphanedRuns()).toBe(2);
    expect((await h.prisma.syncLog.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("aborted");
    expect((await h.prisma.syncLog.findUniqueOrThrow({ where: { id: b.id } })).error).toMatch(/died or was killed/);

    const c = await h.prisma.syncLog.create({ data: { trigger: "ghost-c", status: "running" } });
    const d = await h.prisma.syncLog.create({ data: { trigger: "live", status: "running" } });
    const handle = await h.lock.acquireLock();
    try {
      expect(await h.log.sweepOrphanedRuns()).toBe(1);
      expect((await h.prisma.syncLog.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("aborted");
      expect((await h.prisma.syncLog.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("running");
    } finally {
      await handle.release();
    }
  });

  describe("database time zone independence", () => {
    it("acquire / staleness / cooldown work when the database runs in a non-UTC zone", async () => {
      const db = databaseName();
      const { claimCatalogCooldown } = await import("@/lib/sync/public-refresh");
      await h.prisma.$executeRawUnsafe(`ALTER DATABASE "${db}" SET timezone TO 'Asia/Bahrain'`);
      await h.prisma.$disconnect(); // new sessions pick up the new default
      try {
        const [{ tz }] = await h.prisma.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('TimeZone') AS tz`;
        expect(tz).toBe("Asia/Bahrain");

        const a = await h.lock.acquireLock();
        expect(await h.lock.getLockState()).toMatchObject({ running: true, stale: false });
        await expect(h.lock.acquireLock()).rejects.toMatchObject({ name: "SyncAlreadyRunningError" });
        // heartbeat written 2 min ago (naive UTC, like every writer) must NOT look stale
        await h.prisma.syncLock.update({ where: { id: 1 }, data: { heartbeatAt: minutesAgo(2) } });
        expect(await h.lock.getLockState()).toMatchObject({ stale: false });
        await h.prisma.syncLock.update({ where: { id: 1 }, data: { heartbeatAt: minutesAgo(11) } });
        expect(await h.lock.getLockState()).toMatchObject({ stale: true });
        await a.release();

        expect(await claimCatalogCooldown(120)).toEqual({ claimed: true });
        const second = await claimCatalogCooldown(120);
        expect(second.claimed).toBe(false);
        if (!second.claimed) {
          expect(second.retryAfterSeconds).toBeGreaterThan(110);
          expect(second.retryAfterSeconds).toBeLessThanOrEqual(120);
        }
      } finally {
        await h.prisma.$executeRawUnsafe(`ALTER DATABASE "${db}" RESET timezone`);
        await h.prisma.$disconnect();
      }
    });
  });
});
