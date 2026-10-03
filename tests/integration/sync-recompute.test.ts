import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUN_INTEGRATION, setupHarness, type Harness } from "./helpers";

describe.skipIf(!RUN_INTEGRATION)("recompute (integration: no network)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await setupHarness();
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    await h.reset();
    await h.seed();
  });

  const recordCount = (id: string) => h.prisma.datasetRecord.count({ where: { datasetId: id } });

  /** Make derived columns look like they were produced by an older DERIVED_VERSION. */
  const makeStale = (ids: string[]) =>
    h.prisma.dataset.updateMany({
      where: { id: { in: ids } },
      data: { derivedVersion: 1, summaryAr: "قديم" },
    });

  it("a normal sync stamps derivedVersion = DERIVED_VERSION", async () => {
    const rows = await h.prisma.dataset.findMany({ select: { derivedVersion: true } });
    expect(rows.every((r) => r.derivedVersion === h.derived.DERIVED_VERSION)).toBe(true);
    expect(await h.recompute.countDatasetsNeedingRecompute()).toBe(0);
  });

  it("re-derives stale datasets from stored rows without touching the network", async () => {
    const before = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } });
    await h.prisma.dataset.update({
      where: { id: "seaports" },
      data: { derivedVersion: 1, summaryAr: "قديم", statsJson: { stale: true } as never, vizConfig: { type: "stale" } as never },
    });
    await makeStale(["housing-loans"]);
    await h.prisma.dataset.update({ where: { id: "housing-loans" }, data: { chartData: [] as never } });
    expect(await h.recompute.countDatasetsNeedingRecompute()).toBe(2);

    const stateBefore = await h.prisma.syncState.findUniqueOrThrow({ where: { id: 1 } });
    h.mock.state.hits.total = 0;

    const r = await h.recompute.runRecompute({ trigger: "test" });
    expect(r).toMatchObject({ status: "success", processed: 2, updated: 2, failed: 0, skippedPartial: [] });
    expect(h.mock.state.hits.total).toBe(0); // no portal traffic at all

    const after = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } });
    expect(after.derivedVersion).toBe(h.derived.DERIVED_VERSION);
    expect(after.summaryAr).toBe(before.summaryAr); // same input, same derivation
    expect(after.vizConfig).toEqual(before.vizConfig);
    expect(after.statsJson).toEqual(before.statsJson);
    expect(after.chartData).toEqual(before.chartData);
    // sync-state columns that describe the PORTAL are untouched
    expect(after.syncedVersion).toBe(before.syncedVersion);
    expect(after.lastSyncedAt!.getTime()).toBe(before.lastSyncedAt!.getTime());

    const log = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: r.syncLogId } });
    expect(log).toMatchObject({ scope: "recompute", status: "success", trigger: "test", updated: 2 });
    const stateAfter = await h.prisma.syncState.findUniqueOrThrow({ where: { id: 1 } });
    expect(stateAfter.lastCatalogCheckAt!.getTime()).toBe(stateBefore.lastCatalogCheckAt!.getTime());
    expect(stateAfter.lastSuccessAt!.getTime()).toBe(stateBefore.lastSuccessAt!.getTime());
    expect(stateAfter.lastDataChangeAt!.getTime()).toBe(stateBefore.lastDataChangeAt!.getTime());

    expect(await h.recompute.countDatasetsNeedingRecompute()).toBe(0);
    expect((await h.recompute.runRecompute({ trigger: "test" })).processed).toBe(0);
  });

  it("skips 'partial' datasets (their stored rows are capped) and says so", async () => {
    await makeStale(["tourist-arrivals", "seaports"]);
    await h.prisma.dataset.update({ where: { id: "tourist-arrivals" }, data: { syncStatus: "partial" } });

    const r = await h.recompute.runRecompute({ trigger: "test" });
    expect(r.updated).toBe(1);
    expect(r.skippedPartial).toEqual(["tourist-arrivals"]);
    const partial = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "tourist-arrivals" } });
    expect(partial.derivedVersion).toBe(1); // untouched: it needs a forced sync
    expect(partial.summaryAr).toBe("قديم");
    expect(await h.recompute.countDatasetsNeedingRecompute()).toBe(0); // not eligible, so no endless recompute loop
  });

  it("refuses to derive from stored rows that do not match sourceCount", async () => {
    await makeStale(["seaports"]);
    const victim = await h.prisma.datasetRecord.findFirstOrThrow({ where: { datasetId: "seaports" } });
    await h.prisma.datasetRecord.delete({ where: { id: victim.id } });

    const r = await h.recompute.runRecompute({ trigger: "test" });
    expect(r.status).toBe("failed");
    expect(r.failed).toBe(1);
    expect(r.failures[0].error).toMatch(/do not match sourceCount/);
    const flagged = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } });
    expect(flagged.summaryAr).toBe("قديم");
    // flagged so it leaves the recompute queue and the next sync re-downloads it
    expect(flagged.syncStatus).toBe("error");
    expect(await h.recompute.countDatasetsNeedingRecompute()).toBe(0);
    const repair = await h.engine.runSync({ trigger: "test" });
    expect(repair.changed.updated).toEqual(["seaports"]);
    expect(await recordCount("seaports")).toBe(12);
    expect((await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } })).syncStatus).toBe("ok");
  });

  it("--force recomputes datasets that are already current; --dataset narrows it", async () => {
    const r = await h.recompute.runRecompute({ trigger: "test", force: true });
    expect(r.updated).toBe(9); // every 'ok' dataset with rows (empty-dataset has none)

    const one = await h.recompute.runRecompute({ trigger: "test", force: true, datasetId: "seaports" });
    expect(one.updated).toBe(1);
    expect(one.processed).toBe(1);
  });

  it("holds the sync lock (conflicts with a running sync) and releases it", async () => {
    const handle = await h.lock.acquireLock();
    await expect(h.recompute.runRecompute({ trigger: "test" })).rejects.toMatchObject({ name: "SyncAlreadyRunningError" });
    await handle.release();
    await h.recompute.runRecompute({ trigger: "test" });
    expect(await h.lock.getLockState()).toMatchObject({ running: false });
  });

  it("startRecomputeInBackground returns the run id after taking the lock", async () => {
    await makeStale(["seaports"]);
    const started = await h.recompute.startRecomputeInBackground({ trigger: "test" });
    expect(started.started).toBe(true);
    if (!started.started) return;
    const log = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: started.runId } });
    expect(["running", "success"]).toContain(log.status);
    const handle = await h.lock.acquireLock().catch((e) => e);
    if (handle.release) await handle.release(); // the run was already done
    else expect(handle.name).toBe("SyncAlreadyRunningError");
  });
});
