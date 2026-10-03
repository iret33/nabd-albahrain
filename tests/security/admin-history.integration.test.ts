import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { countQuietPublicPresses, getAdminStats, getRecentSyncLogs } from "@/lib/admin/queries";
import { isQuietPublicPress, lastRunAlert, resolveSyncRunStatus } from "@/lib/admin/sync-status";

/**
 * r1-13, admin side: anonymous presses of the public refresh button must not
 * push scheduler/CLI/admin runs out of the dashboard history or hide a failed
 * scheduled run behind a harmless "public success" row. Needs a migrated
 * Postgres at DATABASE_URL (opt-in: RUN_INTEGRATION=1). Every row it inserts
 * carries `scope` = "admin-history-test:<n>" and only those rows are deleted.
 */
const SCOPE = "admin-history-test";

describe.skipIf(process.env.RUN_INTEGRATION !== "1")("admin run history hides no-op public presses (Postgres)", () => {
  // Far in the future so these rows are the newest in the table whatever other suites left behind.
  const base = Date.now() + 5 * 24 * 60 * 60 * 1000;
  let n = 0;

  async function insert(
    minutesAfterBase: number,
    row: { trigger: string; status: string; failed?: number; updated?: number; error?: string; running?: boolean },
  ) {
    const startedAt = new Date(base + minutesAfterBase * 60_000);
    return prisma.syncLog.create({
      data: {
        trigger: row.trigger,
        status: row.status,
        startedAt,
        finishedAt: row.running ? null : new Date(startedAt.getTime() + 2000),
        failed: row.failed ?? 0,
        updated: row.updated ?? 0,
        error: row.error ?? null,
        total: 10,
        scope: `${SCOPE}:${++n}`,
      },
    });
  }

  const wipe = () => prisma.syncLog.deleteMany({ where: { scope: { startsWith: `${SCOPE}:` } } });
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it("hides only trigger=public AND success AND failed=0 AND updated=0 by default; the toggle shows everything", async () => {
    const auto = await insert(1, { trigger: "auto", status: "failed", failed: 3, error: "portal unreachable" });
    const quietA = await insert(2, { trigger: "public", status: "success" });
    const pubFailed = await insert(3, { trigger: "public", status: "failed", failed: 1, error: "export 500" });
    const pubPartial = await insert(4, { trigger: "public", status: "partial", failed: 1, updated: 1 });
    const pubChanged = await insert(5, { trigger: "public", status: "success", updated: 2 });
    const quietB = await insert(6, { trigger: "public", status: "success" });
    const apiQuiet = await insert(7, { trigger: "api", status: "success" }); // an admin run that changed nothing: still shown
    const pubAborted = await insert(8, { trigger: "public", status: "aborted", error: "shutdown" });
    const pubRunning = await insert(9, { trigger: "public", status: "running", running: true });

    const mine = (rows: Awaited<ReturnType<typeof getRecentSyncLogs>>) =>
      rows.filter((r) => r.scope?.startsWith(`${SCOPE}:`)).map((r) => r.id);

    const shown = mine(await getRecentSyncLogs(100));
    expect(shown).not.toContain(quietA.id);
    expect(shown).not.toContain(quietB.id);
    for (const row of [auto, pubFailed, pubPartial, pubChanged, apiQuiet, pubAborted, pubRunning]) {
      expect(shown, `${row.trigger}/${row.status} must stay visible`).toContain(row.id);
    }

    const all = mine(await getRecentSyncLogs(100, { includeQuietPublic: true }));
    expect(new Set(all)).toEqual(new Set([auto, quietA, pubFailed, pubPartial, pubChanged, quietB, apiQuiet, pubAborted, pubRunning].map((r) => r.id)));
  });

  it("spends the row limit on real runs: a flood of quiet presses cannot push a failed scheduler run off the first page", async () => {
    const auto = await insert(1, { trigger: "auto", status: "failed", failed: 2, error: "portal unreachable" });
    for (let i = 0; i < 30; i++) await insert(10 + i, { trigger: "public", status: "success" });

    const page = await getRecentSyncLogs(20);
    expect(page.map((r) => r.id)).toContain(auto.id);
    // Before the filter, the newest 20 rows were all presses and the failure was gone.
    const unfiltered = await getRecentSyncLogs(20, { includeQuietPublic: true });
    expect(unfiltered.map((r) => r.id)).not.toContain(auto.id);
  });

  it("a successful public press no longer masks a failed scheduled run in the last-run banner", async () => {
    const auto = await insert(1, { trigger: "auto", status: "failed", failed: 3, error: "portal unreachable" });
    await insert(2, { trigger: "public", status: "success" });

    const { lastSync } = await getAdminStats();
    expect(lastSync?.id).toBe(auto.id);
    const status = resolveSyncRunStatus(lastSync!, { isLatest: true, lockRunning: false });
    expect(lastRunAlert(status)).toBe("failed");
  });

  it("but a public press that failed, changed data or is running IS the last run", async () => {
    await insert(1, { trigger: "auto", status: "success", updated: 1 });
    const failed = await insert(2, { trigger: "public", status: "failed", failed: 1, error: "export 500" });
    expect((await getAdminStats()).lastSync?.id).toBe(failed.id);

    const changed = await insert(3, { trigger: "public", status: "success", updated: 1 });
    expect((await getAdminStats()).lastSync?.id).toBe(changed.id);

    const running = await insert(4, { trigger: "public", status: "running", running: true });
    expect((await getAdminStats()).lastSync?.id).toBe(running.id);
  });

  it("counts the hidden presses for the toggle label", async () => {
    const before = await countQuietPublicPresses();
    await insert(1, { trigger: "public", status: "success" });
    await insert(2, { trigger: "public", status: "success" });
    await insert(3, { trigger: "public", status: "success", updated: 1 });
    await insert(4, { trigger: "auto", status: "success" });
    expect(await countQuietPublicPresses()).toBe(before + 2);
  });

  it("the SQL filter and the pure isQuietPublicPress agree on every trigger/status/failed/updated combination", async () => {
    const combos: Array<{ trigger: string; status: string; failed: number; updated: number }> = [];
    for (const trigger of ["public", "auto", "api", "cli"]) {
      for (const status of ["success", "partial", "failed", "aborted", "running"]) {
        for (const failed of [0, 2]) {
          for (const updated of [0, 3]) combos.push({ trigger, status, failed, updated });
        }
      }
    }
    await prisma.syncLog.createMany({
      data: combos.map((c, i) => ({
        ...c,
        startedAt: new Date(base + i * 60_000),
        finishedAt: c.status === "running" ? null : new Date(base + i * 60_000 + 1000),
        scope: `${SCOPE}:matrix-${i}`,
      })),
    });

    const visible = new Set(
      (await getRecentSyncLogs(1000)).filter((r) => r.scope?.startsWith(`${SCOPE}:matrix-`)).map((r) => r.scope),
    );
    combos.forEach((c, i) => {
      const scope = `${SCOPE}:matrix-${i}`;
      expect(visible.has(scope), JSON.stringify(c)).toBe(!isQuietPublicPress(c));
    });
    // Exactly one combination per (failed,updated)=(0,0) public success is quiet.
    expect(combos.filter(isQuietPublicPress)).toHaveLength(1);
  });
});
