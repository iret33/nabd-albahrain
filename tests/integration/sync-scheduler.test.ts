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
    await h.prisma.syncState.update({ where: { id: 1 }, data: { lastFullPassAt: minutesAgo(55) } });
    // 55 min < 0.9 * 60 = 54? no: 55 >= 54 -> due
    expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["sync"], failed: false });
    const log = await h.prisma.syncLog.findFirstOrThrow({ orderBy: { id: "desc" } });
    expect(log).toMatchObject({ trigger: "auto", status: "success", skipped: 10, updated: 0 });

    // "restart": a fresh tick right away finds the catalog freshly checked
    expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["not-due"], failed: false });

    // 50 min since the last check is below the 54 min threshold
    await h.prisma.syncState.update({ where: { id: 1 }, data: { lastFullPassAt: minutesAgo(50) } });
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
    await h.prisma.syncState.update({ where: { id: 1 }, data: { lastFullPassAt: minutesAgo(120) } });
    expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["recompute", "sync"], failed: false });
  });

  it("swallows 'already running' (another instance or an admin run holds the lock)", async () => {
    await h.seed();
    await h.prisma.syncState.update({ where: { id: 1 }, data: { lastFullPassAt: minutesAgo(120) } });
    const handle = await h.lock.acquireLock();
    try {
      expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["busy"], failed: false });
    } finally {
      await handle.release();
    }
  });

  it("reports a failed run so the timer backs off, and never throws", async () => {
    await h.seed();
    await h.prisma.syncState.update({ where: { id: 1 }, data: { lastFullPassAt: minutesAgo(120) } });
    await fetch(`${h.mock.url}/__mock/mutate?mode=catalog-500`, { method: "POST" });
    expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["sync"], failed: true });
    expect((await h.prisma.syncLog.findFirstOrThrow({ orderBy: { id: "desc" } })).status).toBe("failed");
  });

  it("two instances racing for the same slot: one runs, the other backs off", async () => {
    await h.seed();
    await h.prisma.syncState.update({ where: { id: 1 }, data: { lastFullPassAt: minutesAgo(120) } });
    await fetch(`${h.mock.url}/__mock/mutate?id=seaports&mode=bump`, { method: "POST" });
    await fetch(`${h.mock.url}/__mock/mutate?id=seaports&mode=slow&ms=300`, { method: "POST" });
    const [a, b] = await Promise.all([h.scheduler.runSchedulerTick(60), h.scheduler.runSchedulerTick(60)]);
    const all = [...a.actions, ...b.actions].sort();
    expect(all).toEqual(["busy", "sync"]);
    expect(h.mock.state.hits.exportById.seaports).toBe(1); // downloaded once, not twice
  });

  const syncState = () => h.prisma.syncState.findUniqueOrThrow({ where: { id: 1 } });
  const addBig = (id: string, claim: number) =>
    fetch(`${h.mock.url}/__mock/add-big?id=${id}&rows=10&claim=${claim}`, { method: "POST" });

  describe("the due-clock is lastFullPassAt (r1-01)", () => {
    it("a public press that defers a big dataset does not postpone the scheduled pass", async () => {
      await h.seed();
      await addBig("big-claim", 500_000);
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastFullPassAt: minutesAgo(320) } });
      const before = await syncState();

      // What POST /api/refresh runs: capped, so the 500k-row dataset is deferred.
      const press = await h.engine.runSync({ trigger: "public", maxRecords: 100_000, maxDatasets: 5 });
      expect(press.changed.deferred).toEqual(["big-claim"]);
      const after = await syncState();
      // The display clock and the 60s collapse moved; the scheduler's clock did not.
      expect(after.lastCatalogCheckAt!.getTime()).toBeGreaterThan(before.lastCatalogCheckAt!.getTime());
      expect(after.lastFullPassAt!.getTime()).toBe(before.lastFullPassAt!.getTime());

      // 10 minutes later the pass is due (320 + 10 >= 0.9 * 360) although the press was seconds ago.
      const tick = await h.scheduler.runSchedulerTick(360, Date.now() + 10 * 60_000);
      expect(tick).toEqual({ actions: ["sync"], failed: false });
      expect((await h.prisma.dataset.findUniqueOrThrow({ where: { id: "big-claim" } })).syncStatus).toBe("ok");
      expect((await syncState()).lastFullPassAt!.getTime()).toBeGreaterThan(before.lastFullPassAt!.getTime());
    });

    it("only an UNRESTRICTED catalog-wide run advances it (scheduler, admin, CLI), not capped, scoped, limited or failed ones", async () => {
      await h.seed();
      const reset = () => h.prisma.syncState.update({ where: { id: 1 }, data: { lastFullPassAt: minutesAgo(600) } });
      const advanced = async (run: () => Promise<unknown>) => {
        await reset();
        const before = (await syncState()).lastFullPassAt!.getTime();
        await run();
        return (await syncState()).lastFullPassAt!.getTime() > before;
      };
      expect(await advanced(() => h.engine.runSync({ trigger: "public", maxRecords: 100_000 }))).toBe(false);
      expect(await advanced(() => h.engine.runSync({ trigger: "public", maxDatasets: 5 }))).toBe(false);
      expect(await advanced(() => h.engine.runSync({ trigger: "cli", limit: 3 }))).toBe(false);
      expect(await advanced(() => h.engine.runSync({ trigger: "public", datasetId: "seaports" }))).toBe(false);
      expect(await advanced(() => h.engine.runSync({ trigger: "cli", dryRun: true }))).toBe(false);
      await fetch(`${h.mock.url}/__mock/mutate?mode=catalog-500`, { method: "POST" });
      expect(await advanced(() => h.engine.runSync({ trigger: "api" }))).toBe(false); // catalog never applied
      await fetch(`${h.mock.url}/__mock/mutate?mode=heal`, { method: "POST" });

      expect(await advanced(() => h.engine.runSync({ trigger: "api" }))).toBe(true);
      expect(await advanced(() => h.engine.runSync({ trigger: "cli", force: true }))).toBe(true);
      expect(await advanced(() => h.engine.runSync({ trigger: "auto" }))).toBe(true);
    });

    it("a permanently failing dataset (every run partial) does not keep the scheduler due on every wake", async () => {
      await h.seed();
      await fetch(`${h.mock.url}/__mock/mutate?id=seaports&mode=bump`, { method: "POST" });
      await fetch(`${h.mock.url}/__mock/mutate?id=seaports&mode=http500`, { method: "POST" });
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastFullPassAt: minutesAgo(120) } });
      expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["sync"], failed: false });
      expect((await h.prisma.syncLog.findFirstOrThrow({ orderBy: { id: "desc" } })).status).toBe("partial");
      expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["not-due"], failed: false });
    });

    it("a never-run database (NULL clock, as the migration leaves it) is due immediately", async () => {
      await h.seed();
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastFullPassAt: null, lastCatalogCheckAt: new Date() } });
      expect(await h.scheduler.runSchedulerTick(360)).toEqual({ actions: ["sync"], failed: false });
      expect((await syncState()).lastFullPassAt).not.toBeNull();
    });
  });

  describe("boot-time catch-up for datasets an old engine left behind (r1-01, R2-09)", () => {
    const legacify = (id: string, data: Record<string, unknown>) =>
      h.prisma.dataset.update({ where: { id }, data });

    it("a live ok dataset without a version token pulls the pass forward and the pass repairs it", async () => {
      await h.seed();
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastFullPassAt: minutesAgo(20) } });
      expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["not-due"], failed: false }); // 20 < 54, nothing legacy
      expect(await h.scheduler.hasLegacyDatasets()).toBe(false);

      await legacify("seaports", { syncedVersion: null });
      expect(await h.scheduler.hasLegacyDatasets()).toBe(true);
      expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["sync"], failed: false });
      const row = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } });
      expect(row.syncedVersion).not.toBeNull();
      expect(h.mock.state.hits.exportById.seaports).toBe(1); // re-downloaded once, on the missing token only
      expect(h.mock.state.hits.exportById["housing-loans"]).toBeUndefined();

      expect(await h.scheduler.hasLegacyDatasets()).toBe(false);
      expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["not-due"], failed: false });
    });

    it("an empty search text is legacy too", async () => {
      await h.seed();
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastFullPassAt: minutesAgo(20) } });
      await legacify("housing-loans", { searchText: "" });
      expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["sync"], failed: false });
      expect((await h.prisma.dataset.findUniqueOrThrow({ where: { id: "housing-loans" } })).searchText).not.toBe("");
    });

    it("is rate limited by a minimum gap since the last full pass, so a row no pass can repair cannot loop", async () => {
      await h.seed();
      await legacify("seaports", { syncedVersion: null });
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastFullPassAt: minutesAgo(5) } });
      expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["not-due"], failed: false }); // 5 < min(15, 60 / 4)
      expect(h.mock.state.hits.total).toBe(0);
      // 16 minutes after the last full pass the gap is over
      expect(await h.scheduler.runSchedulerTick(60, Date.now() + 11 * 60_000)).toEqual({ actions: ["sync"], failed: false });
    });

    it("rows in error / pending / removed are not legacy (the normal pass retries them; they must not make every wake a pass)", async () => {
      await h.seed();
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastFullPassAt: minutesAgo(30) } });
      await legacify("seaports", { syncedVersion: null, syncStatus: "error" });
      await legacify("housing-loans", { syncedVersion: null, syncStatus: "pending", sourceCount: 0 });
      await legacify("energy-consumption", { syncedVersion: null, removedAt: new Date() });
      expect(await h.scheduler.hasLegacyDatasets()).toBe(false);
      expect(await h.scheduler.runSchedulerTick(60)).toEqual({ actions: ["not-due"], failed: false });
    });
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
