import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUN_INTEGRATION, databaseName, setupHarness, type Harness } from "./helpers";

const DAY = 86_400_000;

describe.skipIf(!RUN_INTEGRATION)("SyncLog retention (integration, r1-13)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await setupHarness();
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    await h.reset();
    h.log.resetPruneThrottleForTests();
  });

  type Row = {
    label: string;
    trigger: string;
    status: string;
    daysAgo: number;
    scope?: string | null;
    updated?: number;
    failed?: number;
  };

  /** Insert rows oldest-first (ids ascend with the array), labelled through `error`. */
  async function insert(rows: Row[]) {
    for (const r of rows) {
      const startedAt = new Date(Date.now() - r.daysAgo * DAY);
      await h.prisma.syncLog.create({
        data: {
          trigger: r.trigger,
          status: r.status,
          scope: r.scope === undefined ? "changed" : r.scope,
          startedAt,
          finishedAt: r.status === "running" ? null : startedAt,
          updated: r.updated ?? 0,
          failed: r.failed ?? 0,
          error: r.label,
        },
      });
    }
  }
  const survivors = async () =>
    (await h.prisma.syncLog.findMany({ orderBy: { id: "asc" }, select: { error: true } })).map((r) => r.error);

  /** 200 newer filler rows push everything else out of the "newest 200" safety net. */
  const filler = (n = 200): Row[] =>
    Array.from({ length: n }, (_, i) => ({
      label: `filler-${i}`,
      trigger: "public",
      status: "success",
      daysAgo: 0,
      scope: "dataset:seaports",
    }));

  it("deletes expired rows by the rules, and only those", async () => {
    await insert([
      { label: "pub-noop-10d-a", trigger: "public", status: "success", daysAgo: 10, scope: "dataset:seaports" },
      { label: "pub-noop-10d-b", trigger: "public", status: "success", daysAgo: 10, scope: "changed" },
      { label: "pub-noop-3d", trigger: "public", status: "success", daysAgo: 3, scope: "dataset:seaports" },
      { label: "pub-updated-10d", trigger: "public", status: "success", daysAgo: 10, updated: 1 },
      { label: "pub-failed-10d", trigger: "public", status: "failed", daysAgo: 10, failed: 0 },
      { label: "pub-partial-10d", trigger: "public", status: "partial", daysAgo: 10, failed: 2 },
      { label: "pub-noop-100d", trigger: "public", status: "success", daysAgo: 100 },
      { label: "pub-failed-100d", trigger: "public", status: "failed", daysAgo: 100 },
      { label: "auto-success-100d", trigger: "auto", status: "success", daysAgo: 100 },
      { label: "auto-failed-100d", trigger: "auto", status: "failed", daysAgo: 100 },
      { label: "cli-aborted-200d", trigger: "cli", status: "aborted", daysAgo: 200 },
      { label: "api-partial-300d", trigger: "api", status: "partial", daysAgo: 300, failed: 1 },
      { label: "auto-failed-400d", trigger: "auto", status: "failed", daysAgo: 400 },
      { label: "cli-success-400d", trigger: "cli", status: "success", daysAgo: 400 },
      { label: "running-400d", trigger: "auto", status: "running", daysAgo: 400 },
      { label: "recompute-100d", trigger: "auto", status: "success", daysAgo: 100, scope: "recompute" },
      // the newest finished catalog-wide run, inside the horizon: it is what health/ready and the admin banner read
      { label: "newest-catalog-50d", trigger: "auto", status: "success", daysAgo: 50 },
      ...filler(),
    ]);

    const deleted = await h.log.pruneSyncLogs();
    const kept = new Set(await survivors());

    // public no-ops live a week; everything else of a public run lives 90 days
    expect(kept.has("pub-noop-10d-a")).toBe(false);
    expect(kept.has("pub-noop-10d-b")).toBe(false);
    expect(kept.has("pub-noop-3d")).toBe(true);
    expect(kept.has("pub-updated-10d")).toBe(true);
    expect(kept.has("pub-failed-10d")).toBe(true);
    expect(kept.has("pub-partial-10d")).toBe(true);
    expect(kept.has("pub-noop-100d")).toBe(false);
    expect(kept.has("pub-failed-100d")).toBe(false);
    // non-public rows live 90 days, but their FAILURES a year
    expect(kept.has("auto-success-100d")).toBe(false);
    expect(kept.has("auto-failed-100d")).toBe(true);
    expect(kept.has("cli-aborted-200d")).toBe(true);
    expect(kept.has("api-partial-300d")).toBe(true);
    expect(kept.has("auto-failed-400d")).toBe(false);
    expect(kept.has("cli-success-400d")).toBe(false);
    expect(kept.has("recompute-100d")).toBe(false);
    // a run still in flight is never touched
    expect(kept.has("running-400d")).toBe(true);
    expect(kept.has("newest-catalog-50d")).toBe(true);
    // the newest 200 are all there
    for (let i = 0; i < 200; i++) expect(kept.has(`filler-${i}`), `filler-${i}`).toBe(true);
    expect(deleted).toBe(8);
  });

  it("always keeps the newest finished catalog-wide run, even when it is ancient and buried", async () => {
    await insert([
      { label: "older-catalog-run-600d", trigger: "auto", status: "success", daysAgo: 600 },
      { label: "newest-catalog-run-500d", trigger: "auto", status: "success", daysAgo: 500 },
      ...filler(),
    ]);
    await h.log.pruneSyncLogs();
    const after = new Set(await survivors());
    expect(after.has("newest-catalog-run-500d")).toBe(true); // health/ready and the admin banner read it
    expect(after.has("older-catalog-run-600d")).toBe(false);
  });

  it("never removes anything while there are fewer than 200 rows (the history stays complete)", async () => {
    await insert([
      { label: "pub-noop-30d", trigger: "public", status: "success", daysAgo: 30, scope: "dataset:seaports" },
      { label: "auto-success-200d", trigger: "auto", status: "success", daysAgo: 200 },
    ]);
    expect(await h.log.pruneSyncLogs()).toBe(0);
    expect(await survivors()).toHaveLength(2);
  });

  it("works through more than one batch", async () => {
    const old = Array.from({ length: 1_300 }, (_, i) => ({
      label: `old-${i}`,
      trigger: "public",
      status: "success",
      daysAgo: 30,
      scope: "dataset:seaports",
    }));
    await h.prisma.syncLog.createMany({
      data: old.map((r) => ({
        trigger: r.trigger,
        status: r.status,
        scope: r.scope,
        startedAt: new Date(Date.now() - 30 * DAY),
        finishedAt: new Date(Date.now() - 30 * DAY),
        error: r.label,
      })),
    });
    await insert(filler());
    expect(await h.log.pruneSyncLogs()).toBe(1_300);
    expect(await h.prisma.syncLog.count()).toBe(200);
  });

  it("maybePruneSyncLogs runs at most once an hour per process and never throws", async () => {
    await insert([{ label: "pub-noop-30d", trigger: "public", status: "success", daysAgo: 30, scope: "dataset:seaports" }, ...filler()]);
    await h.log.maybePruneSyncLogs();
    expect((await survivors()).includes("pub-noop-30d")).toBe(false);

    await insert([{ label: "pub-noop-31d", trigger: "public", status: "success", daysAgo: 31, scope: "dataset:seaports" }, ...filler()]);
    await h.log.maybePruneSyncLogs(); // throttled
    expect((await survivors()).includes("pub-noop-31d")).toBe(true);
    await h.log.maybePruneSyncLogs(Date.now() + 61 * 60_000);
    expect((await survivors()).includes("pub-noop-31d")).toBe(false);
  });

  it("every finished run prunes (the CLI and external-cron deployments never start the scheduler)", async () => {
    await insert([{ label: "pub-noop-30d", trigger: "public", status: "success", daysAgo: 30, scope: "dataset:seaports" }, ...filler()]);
    await h.engine.runSync({ trigger: "cli" });
    expect((await survivors()).includes("pub-noop-30d")).toBe(false);
  });

  it("the scheduler tick prunes before any early return, including 'not-due'", async () => {
    await h.seed();
    await insert([{ label: "pub-noop-30d", trigger: "public", status: "success", daysAgo: 30, scope: "dataset:seaports" }, ...filler()]);
    h.log.resetPruneThrottleForTests();
    expect((await h.scheduler.runSchedulerTick(60)).actions).toEqual(["not-due"]);
    expect((await survivors()).includes("pub-noop-30d")).toBe(false);
  });

  it("does not delete a run's row from under it: finalize and progress keep working", async () => {
    // a long-running row older than every horizon must survive a prune triggered by another process
    await insert([{ label: "live-run", trigger: "api", status: "running", daysAgo: 400 }, ...filler()]);
    await h.log.pruneSyncLogs();
    expect((await survivors()).includes("live-run")).toBe(true);
  });

  describe("database time zone independence", () => {
    it("the cutoff is computed on the UTC clock, whatever the database time zone is", async () => {
      const db = databaseName();
      await insert([
        { label: "pub-noop-8d", trigger: "public", status: "success", daysAgo: 8 },
        { label: "pub-noop-6d", trigger: "public", status: "success", daysAgo: 6.5 },
        ...filler(),
      ]);
      await h.prisma.$executeRawUnsafe(`ALTER DATABASE "${db}" SET timezone TO 'Pacific/Kiritimati'`); // UTC+14
      await h.prisma.$disconnect();
      try {
        await h.log.pruneSyncLogs();
        const kept = new Set(await survivors());
        expect(kept.has("pub-noop-8d")).toBe(false);
        expect(kept.has("pub-noop-6d")).toBe(true);
      } finally {
        await h.prisma.$executeRawUnsafe(`ALTER DATABASE "${db}" RESET timezone`);
        await h.prisma.$disconnect();
      }
    });
  });
});
