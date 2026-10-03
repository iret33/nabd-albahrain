import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUN_INTEGRATION, setupHarness, type Harness } from "./helpers";

describe.skipIf(!RUN_INTEGRATION)("scheduler (integration)", () => {
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
  afterEach(() => {
    delete process.env.AUTO_SYNC_INTERVAL_MINUTES;
    delete process.env.AUTO_SYNC_FIRST_DELAY_SECONDS;
  });

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  it("an empty database gets a full first sync", async () => {
    const tick = await h.scheduler.runSchedulerTick(60);
    expect(tick).toEqual({ actions: ["first-sync"], failed: false });
    expect(await h.prisma.dataset.count({ where: { syncStatus: "ok" } })).toBe(10);
    const log = await h.prisma.syncLog.findFirstOrThrow({ orderBy: { id: "desc" } });
    expect(log).toMatchObject({ trigger: "auto", status: "success" });
  });

  it("the DATABASE decides when a run is due: a recent catalog check means nothing to do", async () => {
    await h.seed();
    const logsBefore = await h.prisma.syncLog.count();
    const tick = await h.scheduler.runSchedulerTick(60);
    expect(tick).toEqual({ actions: ["not-due"], failed: false });
    expect(await h.prisma.syncLog.count()).toBe(logsBefore); // no run, no row
    expect(h.mock.state.hits.total).toBe(0);
  });

  it("becomes due after ~0.9 x interval, then is quiet again (a restart does not re-run)", async () => {
    await h.seed();
    await h.prisma.syncState.update({ where: { id: 1 }, data: { lastCatalogCheckAt: minutesAgo(55) } });
    // 55 min < 0.9 * 60 = 54? no: 55 >= 54 -> due
    expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["sync"], failed: false });
    const log = await h.prisma.syncLog.findFirstOrThrow({ orderBy: { id: "desc" } });
    expect(log).toMatchObject({ trigger: "auto", status: "success", skipped: 10, updated: 0 });

    // "restart": a fresh tick right away finds the catalog freshly checked
    expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["not-due"], failed: false });

    // 50 min since the last check is below the 54 min threshold
    await h.prisma.syncState.update({ where: { id: 1 }, data: { lastCatalogCheckAt: minutesAgo(50) } });
    expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["not-due"], failed: false });
  });

  it("re-derives out-of-date datasets first (no network), then syncs only if due", async () => {
    await h.seed();
    await h.prisma.dataset.update({ where: { id: "seaports" }, data: { derivedVersion: null } });
    const tick = await h.scheduler.runSchedulerTick(60);
    expect(tick).toEqual({ actions: ["recompute"], failed: false });
    expect(h.mock.state.hits.total).toBe(0);
    expect((await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } })).derivedVersion).toBe(
      h.derived.DERIVED_VERSION,
    );

    await h.prisma.dataset.update({ where: { id: "seaports" } , data: { derivedVersion: 1 } });
    await h.prisma.syncState.update({ where: { id: 1 }, data: { lastCatalogCheckAt: minutesAgo(120) } });
    expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["recompute", "sync"], failed: false });
  });

  it("swallows 'already running' (another instance or an admin run holds the lock)", async () => {
    await h.seed();
    await h.prisma.syncState.update({ where: { id: 1 }, data: { lastCatalogCheckAt: minutesAgo(120) } });
    const handle = await h.lock.acquireLock();
    try {
      expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["busy"], failed: false });
    } finally {
      await handle.release();
    }
  });

  it("reports a failed run so the timer backs off, and never throws", async () => {
    await h.seed();
    await h.prisma.syncState.update({ where: { id: 1 }, data: { lastCatalogCheckAt: minutesAgo(120) } });
    await fetch(`${h.mock.url}/__mock/mutate?mode=catalog-500`, { method: "POST" });
    expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["sync"], failed: true });
    expect((await h.prisma.syncLog.findFirstOrThrow({ orderBy: { id: "desc" } })).status).toBe("failed");
  });

  it("two instances racing for the same slot: one runs, the other backs off", async () => {
    await h.seed();
    await h.prisma.syncState.update({ where: { id: 1 }, data: { lastCatalogCheckAt: minutesAgo(120) } });
    await fetch(`${h.mock.url}/__mock/mutate?id=seaports&mode=bump`, { method: "POST" });
    await fetch(`${h.mock.url}/__mock/mutate?id=seaports&mode=slow&ms=300`, { method: "POST" });
    const [a, b] = await Promise.all([h.scheduler.runSchedulerTick(60), h.scheduler.runSchedulerTick(60)]);
    const all = [...a.actions, ...b.actions].sort();
    expect(all).toEqual(["busy", "sync"]);
    expect(h.mock.state.hits.exportById.seaports).toBe(1); // downloaded once, not twice
  });

  describe("startScheduler", () => {
    it("is off unless AUTO_SYNC_INTERVAL_MINUTES is positive, and starts only once per process", () => {
      const first = h.scheduler.startScheduler();
      expect(first).not.toBeNull();
      expect(first!.intervalMinutes).toBe(0);
      expect(h.scheduler.startScheduler()).toBe(first); // double start guarded
      first!.stop();
    });

    it("arms an unref'd timer when enabled (first tick far in the future here)", () => {
      process.env.AUTO_SYNC_INTERVAL_MINUTES = "1";
      process.env.AUTO_SYNC_FIRST_DELAY_SECONDS = "3600";
      const handle = h.scheduler.startScheduler();
      expect(handle!.intervalMinutes).toBe(1);
      expect(h.scheduler.startScheduler()).toBe(handle);
      handle!.stop();
      // stop() clears the guard so a later start is possible
      const again = h.scheduler.startScheduler();
      expect(again).not.toBe(handle);
      again!.stop();
    });
  });
});
