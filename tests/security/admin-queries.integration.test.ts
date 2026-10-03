import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAdminFreshness, getAdminStats, getAllDatasetsForAdmin, getRecentSyncLogs } from "@/lib/admin/queries";
import { lastRunAlert, resolveSyncRunStatus } from "@/lib/admin/sync-status";

/**
 * Needs a migrated Postgres at DATABASE_URL (opt-in: RUN_INTEGRATION=1).
 * Inserts its own rows (trigger "sec-test", dataset id "sec-test-removed") and
 * removes exactly those afterwards.
 */
describe.skipIf(process.env.RUN_INTEGRATION !== "1")("admin dashboard queries (Postgres)", () => {
  const DATASET_ID = "sec-test-removed";
  let baseline: Awaited<ReturnType<typeof getAdminStats>>;

  beforeAll(async () => {
    await prisma.syncLog.deleteMany({ where: { trigger: "sec-test" } });
    await prisma.dataset.deleteMany({ where: { id: DATASET_ID } });
    baseline = await getAdminStats();

    const future = new Date(Date.now() + 60 * 60 * 1000); // newest row => becomes `lastSync`
    await prisma.syncLog.create({
      data: {
        trigger: "sec-test",
        startedAt: future,
        finishedAt: new Date(future.getTime() + 3000),
        status: "failed",
        error: "Catalog fetch failed: portal unreachable",
        total: 12,
        skipped: 5,
        updated: 2,
        failed: 5,
        scope: "all",
      },
    });
    await prisma.dataset.create({
      data: {
        id: DATASET_ID,
        title: "Sec Test Removed",
        titleClean: "Sec Test Removed",
        fieldsJson: [],
        removedAt: new Date(),
        syncStatus: "error",
        syncError: "stale error of a removed dataset",
      },
    });
  });

  afterAll(async () => {
    await prisma.syncLog.deleteMany({ where: { trigger: "sec-test" } });
    await prisma.dataset.deleteMany({ where: { id: DATASET_ID } });
    await prisma.$disconnect();
  });

  it("surfaces the new SyncLog columns and drives the failed-run alert", async () => {
    const stats = await getAdminStats();
    expect(stats.lastSync).toMatchObject({
      trigger: "sec-test",
      status: "failed",
      error: "Catalog fetch failed: portal unreachable",
      total: 12,
      skipped: 5,
      updated: 2,
      scope: "all",
    });
    const status = resolveSyncRunStatus(stats.lastSync!, { isLatest: true, lockRunning: false });
    expect(status).toBe("failed");
    expect(lastRunAlert(status)).toBe("failed");

    const logs = await getRecentSyncLogs(5);
    expect(logs[0].id).toBe(stats.lastSync!.id);
  });

  it("counts removed datasets separately and keeps them out of the live totals", async () => {
    const stats = await getAdminStats();
    expect(stats.removed).toBe(baseline.removed + 1);
    expect(stats.total).toBe(baseline.total);
    expect(stats.error).toBe(baseline.error);

    const rows = await getAllDatasetsForAdmin();
    expect(rows.find((d) => d.id === DATASET_ID)?.removedAt).toBeInstanceOf(Date);
  });

  it("returns the SyncState freshness fields (null-safe)", async () => {
    const f = await getAdminFreshness();
    expect(Object.keys(f).sort()).toEqual(["lastCatalogCheckAt", "lastDataChangeAt", "lastSuccessAt"]);
    for (const v of Object.values(f)) expect(v === null || v instanceof Date).toBe(true);
  });
});
