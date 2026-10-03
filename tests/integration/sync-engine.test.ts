import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUN_INTEGRATION, setupHarness, waitUntil, type Harness } from "./helpers";

describe.skipIf(!RUN_INTEGRATION)("sync engine (integration: Postgres + in-process mock portal)", () => {
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

  const post = (path: string) => fetch(`${h.mock.url}${path}`, { method: "POST" });
  const recordCount = async (id?: string) =>
    h.prisma.datasetRecord.count(id ? { where: { datasetId: id } } : undefined);

  describe("initial sync", () => {
    it("syncs every dataset and records the run", async () => {
      const r = await h.engine.runSync({ trigger: "test" });
      expect(r).toMatchObject({ status: "success", processed: 10, updated: 10, skipped: 0, failed: 0, added: 10, removed: 0, deferred: 0 });
      expect(r.syncLogId).toBeGreaterThan(0);

      const rows = await h.prisma.dataset.findMany();
      expect(rows).toHaveLength(10);
      for (const d of rows) {
        expect(d.syncStatus).toBe("ok");
        expect(d.syncedVersion).toMatch(/^v1\|/);
        expect(d.derivedVersion).toBe(h.derived.DERIVED_VERSION);
        expect(d.lastSyncedAt).not.toBeNull();
        expect(d.lastCheckedAt).not.toBeNull();
        expect(d.removedAt).toBeNull();
        expect(d.syncError).toBeNull();
      }
      expect(await recordCount()).toBe(rows.reduce((n, d) => n + d.sourceCount, 0));

      // portal-provided Arabic metadata + normalized search text
      const pop = rows.find((d) => d.id === "population-by-nationality")!;
      expect(pop.titleAr).toBe("السكان حسب الجنسية 2010-2025");
      expect(pop.keywords).toEqual(["population", "nationality", "census", "السكان"]);
      expect(pop.license).toBe("Open Data License");
      expect(pop.searchText).toContain("population by nationality");
      expect(pop.searchText).toContain("السكان حسب الجنسيه 2010 2025"); // ة -> ه folded
      const unemployment = rows.find((d) => d.id === "unemployment-rate")!;
      expect(unemployment.keywords).toEqual(["labour", "unemployment", "jobs"]); // string form

      const log = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: r.syncLogId } });
      expect(log).toMatchObject({ status: "success", scope: "changed", trigger: "test", total: 10, processed: 10, updated: 10, skipped: 0, failed: 0 });
      expect(log.finishedAt).not.toBeNull();
      expect((log.changedJson as { added: string[] }).added).toHaveLength(10);

      const state = await h.prisma.syncState.findUniqueOrThrow({ where: { id: 1 } });
      expect(state.lastCatalogCheckAt).not.toBeNull();
      expect(state.lastSuccessAt).not.toBeNull();
      expect(state.lastDataChangeAt).not.toBeNull();

      expect(await h.lock.getLockState()).toMatchObject({ running: false, stale: false });
      const lockRow = await h.prisma.syncLock.findUniqueOrThrow({ where: { id: 1 } });
      expect(lockRow).toMatchObject({ running: false, holder: null, heartbeatAt: null });
    });
  });

  describe("change detection", () => {
    it("an unchanged second sync skips everything and writes no records", async () => {
      await h.seed();
      const before = await h.prisma.datasetRecord.aggregate({ _max: { id: true }, _count: true });
      const stateBefore = await h.prisma.syncState.findUniqueOrThrow({ where: { id: 1 } });
      await new Promise((r) => setTimeout(r, 15));

      const r = await h.engine.runSync({ trigger: "test" });
      expect(r).toMatchObject({ status: "success", skipped: 10, updated: 0, succeeded: 10, added: 0 });
      expect(h.mock.state.hits.export).toBe(0);

      const after = await h.prisma.datasetRecord.aggregate({ _max: { id: true }, _count: true });
      expect(after._max.id).toBe(before._max.id); // no row was deleted/reinserted
      expect(after._count).toBe(before._count);

      const stateAfter = await h.prisma.syncState.findUniqueOrThrow({ where: { id: 1 } });
      expect(stateAfter.lastCatalogCheckAt!.getTime()).toBeGreaterThan(stateBefore.lastCatalogCheckAt!.getTime());
      expect(stateAfter.lastDataChangeAt!.getTime()).toBe(stateBefore.lastDataChangeAt!.getTime());
      const checked = await h.prisma.dataset.findMany({ select: { lastCheckedAt: true } });
      expect(checked.every((d) => d.lastCheckedAt!.getTime() >= stateAfter.lastCatalogCheckAt!.getTime() - 5_000)).toBe(true);
    });

    it("bumping one dataset re-syncs only that dataset and moves its syncedVersion", async () => {
      await h.seed();
      const before = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } });
      await post("/__mock/mutate?id=seaports&mode=bump");

      const r = await h.engine.runSync({ trigger: "test" });
      expect(r).toMatchObject({ status: "success", updated: 1, skipped: 9 });
      expect(r.changed.updated).toEqual(["seaports"]);
      expect(h.mock.state.hits.export).toBe(1);
      expect(h.mock.state.hits.exportById).toEqual({ seaports: 1 });

      const after = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } });
      expect(after.syncedVersion).not.toBe(before.syncedVersion);
      expect(after.sourceCount).toBe(before.sourceCount + 1);
      expect(await recordCount("seaports")).toBe(after.sourceCount);
      expect(after.lastSyncedAt!.getTime()).toBeGreaterThan(before.lastSyncedAt!.getTime());
    });

    it("a version change that lands during the download is caught by the NEXT run", async () => {
      await h.seed();
      await post("/__mock/mutate?id=seaports&mode=bump");
      // Slow download; the portal publishes AGAIN while we are downloading.
      await post("/__mock/mutate?id=seaports&mode=slow&ms=300");
      const running = h.engine.runSync({ trigger: "test" });
      await waitUntil(() => (h.mock.state.hits.exportById.seaports ?? 0) >= 1, { what: "the export to start" });
      await post("/__mock/mutate?id=seaports&mode=restore");
      await post("/__mock/mutate?id=seaports&mode=bump");
      await running;

      // The stored version is the one captured at the START, so it differs from the portal's now.
      const next = await h.engine.runSync({ trigger: "test" });
      expect(next.changed.updated).toEqual(["seaports"]);
    });

    it("retries a dataset left in error even if its version token matches", async () => {
      await h.seed();
      await h.prisma.dataset.update({ where: { id: "housing-loans" }, data: { syncStatus: "error", syncError: "x" } });
      const r = await h.engine.runSync({ trigger: "test" });
      expect(r.changed.updated).toEqual(["housing-loans"]);
      expect((await h.prisma.dataset.findUniqueOrThrow({ where: { id: "housing-loans" } })).syncStatus).toBe("ok");
    });

    it("treats legacy rows (syncedVersion null) as changed exactly once", async () => {
      await h.seed();
      await h.prisma.dataset.updateMany({ data: { syncedVersion: null } });
      const first = await h.engine.runSync({ trigger: "test" });
      expect(first.updated).toBe(10);
      const second = await h.engine.runSync({ trigger: "test" });
      expect(second.updated).toBe(0);
    });

    it("--force re-downloads everything", async () => {
      await h.seed();
      const r = await h.engine.runSync({ trigger: "test", force: true });
      expect(r.updated).toBe(10);
      const log = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: r.syncLogId } });
      expect(log.scope).toBe("all");
    });

    it("--limit only considers the first N datasets", async () => {
      const r = await h.engine.runSync({ trigger: "test", limit: 3 });
      expect(r.processed).toBe(3);
      expect(r.updated).toBe(3);
      expect(await h.prisma.dataset.count()).toBe(10); // all metadata is still upserted
      expect(await h.prisma.dataset.count({ where: { syncStatus: "ok" } })).toBe(3);
    });
  });

  describe("integrity guards", () => {
    it("an empty export keeps the stored rows and records a sanitized error", async () => {
      await h.seed();
      const before = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } });
      await post("/__mock/mutate?id=seaports&mode=bump");
      await post("/__mock/mutate?id=seaports&mode=empty");

      const r = await h.engine.runSync({ trigger: "test" });
      expect(r).toMatchObject({ status: "partial", failed: 1, skipped: 9, updated: 0 });
      expect(r.failures).toEqual([
        { datasetId: "seaports", error: "Export returned 0 rows but the catalog reports 13; keeping previous data" },
      ]);

      const after = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } });
      expect(after.syncStatus).toBe("error");
      expect(after.syncError).toBe("Export returned 0 rows but the catalog reports 13; keeping previous data");
      expect(after.sourceCount).toBe(before.sourceCount);
      expect(await recordCount("seaports")).toBe(before.sourceCount); // rows untouched
      expect(after.syncedVersion).toBe(before.syncedVersion); // so the next run retries
      expect(after.lastSyncedAt!.getTime()).toBe(before.lastSyncedAt!.getTime());

      const log = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: r.syncLogId } });
      expect(log.status).toBe("partial");
      expect(log.failed).toBe(1);

      // the portal recovers -> the next run retries and applies it
      await post("/__mock/mutate?id=seaports&mode=restore");
      const retry = await h.engine.runSync({ trigger: "test" });
      expect(retry.changed.updated).toEqual(["seaports"]);
      const fixed = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } });
      expect(fixed).toMatchObject({ syncStatus: "ok", syncError: null, sourceCount: 13 });
    });

    it("a dataset that is legitimately empty upstream stays ok", async () => {
      const r = await h.engine.runSync({ trigger: "test" });
      expect(r.failed).toBe(0);
      expect(await h.prisma.dataset.findUniqueOrThrow({ where: { id: "empty-dataset" } })).toMatchObject({
        syncStatus: "ok",
        sourceCount: 0,
      });
    });

    it("a sharply truncated export is refused unless forced", async () => {
      await post("/__mock/add-big?id=shrink-me&rows=300");
      await h.engine.runSync({ trigger: "test" });
      expect((await h.prisma.dataset.findUniqueOrThrow({ where: { id: "shrink-me" } })).sourceCount).toBe(300);

      await post("/__mock/mutate?id=shrink-me&mode=bump");
      await post("/__mock/mutate?id=shrink-me&mode=truncate&fraction=0.3");
      const refused = await h.engine.runSync({ trigger: "test" });
      expect(refused.failures).toHaveLength(1);
      expect(refused.failures[0].error).toMatch(/keeping previous data unless forced/);
      expect(await recordCount("shrink-me")).toBe(300);

      const forced = await h.engine.runSync({ trigger: "test", force: true, datasetId: "shrink-me" });
      expect(forced.status).toBe("success");
      expect(await recordCount("shrink-me")).toBe(90);
    });

    it("never stores raw upstream error text", async () => {
      await h.seed();
      await post("/__mock/mutate?id=seaports&mode=bump");
      await post("/__mock/mutate?id=seaports&mode=http500");
      const r = await h.engine.runSync({ trigger: "test" });
      expect(r.failures[0].error).toBe("HTTP 500 from the data.gov.bh portal");
      const d = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } });
      expect(d.syncError).toBe("HTTP 500 from the data.gov.bh portal");
      expect(d.syncError).not.toMatch(/127\.0\.0\.1|http:/);
    });
  });

  describe("removal", () => {
    it("flags datasets that disappear upstream (not deleting them) and clears the flag when they return", async () => {
      await h.seed();
      await post("/__mock/mutate?id=housing-loans&mode=remove");
      const r = await h.engine.runSync({ trigger: "test" });
      expect(r).toMatchObject({ status: "success", removed: 1, added: 0 });
      expect(r.changed.removed).toEqual(["housing-loans"]);

      const gone = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "housing-loans" } });
      expect(gone.removedAt).not.toBeNull();
      expect(await recordCount("housing-loans")).toBe(gone.sourceCount); // the last copy is kept
      const log = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: r.syncLogId } });
      expect((log.changedJson as { removed: string[] }).removed).toEqual(["housing-loans"]);

      // a further run does not re-report it
      const again = await h.engine.runSync({ trigger: "test" });
      expect(again.removed).toBe(0);

      await post("/__mock/add?id=housing-loans");
      const back = await h.engine.runSync({ trigger: "test" });
      expect(back.removed).toBe(0);
      expect(back.added).toBe(0);
      expect(back.changed.updated).toEqual(["housing-loans"]);
      expect((await h.prisma.dataset.findUniqueOrThrow({ where: { id: "housing-loans" } })).removedAt).toBeNull();
    });

    it("an incomplete catalog fails the run and prunes NOTHING", async () => {
      await h.seed();
      const before = await h.prisma.dataset.findMany({ select: { id: true, lastCheckedAt: true }, orderBy: { id: "asc" } });
      await post("/__mock/mutate?mode=catalog-short&n=4");

      const r = await h.engine.runSync({ trigger: "test" });
      expect(r.status).toBe("failed");
      expect(r.error).toMatch(/could not be fetched completely/);
      expect(await h.prisma.dataset.count({ where: { removedAt: { not: null } } })).toBe(0);
      const after = await h.prisma.dataset.findMany({ select: { id: true, lastCheckedAt: true }, orderBy: { id: "asc" } });
      expect(after).toEqual(before); // not even lastCheckedAt moved

      const log = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: r.syncLogId } });
      expect(log.status).toBe("failed");
      expect(log.error).toMatch(/could not be fetched completely/);
      expect(await h.lock.getLockState()).toMatchObject({ running: false });
    });

    it("an implausibly small (empty) but complete catalog is refused, not pruned", async () => {
      await h.seed();
      await post("/__mock/mutate?mode=catalog-empty");
      const r = await h.engine.runSync({ trigger: "test" });
      expect(r.status).toBe("failed");
      expect(r.error).toMatch(/refusing to prune/);
      expect(await h.prisma.dataset.count({ where: { removedAt: { not: null } } })).toBe(0);

      await post("/__mock/mutate?mode=heal");
      expect((await h.engine.runSync({ trigger: "test" })).status).toBe("success");
    });

    it("a malformed catalog entry is reported but never treated as removed", async () => {
      await h.seed();
      await post("/__mock/mutate?id=seaports&mode=schema-break");
      const r = await h.engine.runSync({ trigger: "test" });
      expect(r.status).toBe("partial");
      expect(r.failed).toBe(1);
      expect(r.failures[0]).toMatchObject({ datasetId: "seaports" });
      expect(r.failures[0].error).toMatch(/malformed/);
      expect(r.processed).toBe(10);
      expect(r.removed).toBe(0);
      expect((await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } })).removedAt).toBeNull();
    });
  });

  describe("failures are recorded, not silent", () => {
    it("records a failed SyncLog row when the portal answers 500", async () => {
      await h.seed();
      const stateBefore = await h.prisma.syncState.findUniqueOrThrow({ where: { id: 1 } });
      await post("/__mock/mutate?mode=catalog-500");
      const r = await h.engine.runSync({ trigger: "test" });
      expect(r.status).toBe("failed");
      expect(r.error).toBe("HTTP 500 from the data.gov.bh portal");
      const log = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: r.syncLogId } });
      expect(log).toMatchObject({ status: "failed", error: "HTTP 500 from the data.gov.bh portal" });
      expect(log.finishedAt).not.toBeNull();
      const stateAfter = await h.prisma.syncState.findUniqueOrThrow({ where: { id: 1 } });
      expect(stateAfter.lastSuccessAt!.getTime()).toBe(stateBefore.lastSuccessAt!.getTime());
      expect(await h.lock.getLockState()).toMatchObject({ running: false });
    });

    it("records a failed row when the portal is unreachable", async () => {
      const prev = process.env.ODS_BASE_URL;
      process.env.ODS_BASE_URL = "http://127.0.0.1:1/api/explore/v2.1";
      try {
        const r = await h.engine.runSync({ trigger: "test" });
        expect(r.status).toBe("failed");
        expect(r.error).toMatch(/^Could not reach the data.gov.bh portal/);
        expect((await h.prisma.syncLog.findUniqueOrThrow({ where: { id: r.syncLogId } })).status).toBe("failed");
      } finally {
        process.env.ODS_BASE_URL = prev;
      }
    });

    it("sanitizes a broken catalog envelope", async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ unexpected: true }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const prev = process.env.ODS_BASE_URL;
      process.env.ODS_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      try {
        const r = await h.engine.runSync({ trigger: "test" });
        expect(r.status).toBe("failed");
        expect(r.error).toBe("Unexpected response shape from the data.gov.bh portal");
      } finally {
        process.env.ODS_BASE_URL = prev;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("marks orphaned 'running' rows aborted when a new run starts", async () => {
      await h.prisma.syncLog.create({ data: { trigger: "ghost", status: "running" } });
      const r = await h.engine.runSync({ trigger: "test" });
      const ghost = await h.prisma.syncLog.findFirstOrThrow({ where: { trigger: "ghost" } });
      expect(ghost.status).toBe("aborted");
      expect(ghost.finishedAt).not.toBeNull();
      expect(r.status).toBe("success");
    });
  });

  describe("deferral limits (public refresh)", () => {
    it("maxRecords defers big datasets and reports them", async () => {
      const r = await h.engine.runSync({ trigger: "test", maxRecords: 20 });
      expect(r.status).toBe("success");
      expect(r.updated).toBe(6);
      expect(r.deferred).toBe(4);
      expect([...r.changed.deferred].sort()).toEqual([
        "live-births-by-governorate",
        "population-by-nationality",
        "tourist-arrivals",
        "unemployment-rate",
      ]);
      const log = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: r.syncLogId } });
      expect((log.changedJson as { deferred: string[] }).deferred).toHaveLength(4);
      // deferred datasets were not downloaded and stay due
      expect(h.mock.state.hits.exportById["population-by-nationality"]).toBeUndefined();
      const pop = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "population-by-nationality" } });
      expect(pop).toMatchObject({ syncStatus: "pending", syncedVersion: null });

      const rest = await h.engine.runSync({ trigger: "test" });
      expect(rest).toMatchObject({ updated: 4, deferred: 0 });
    });

    it("maxDatasets downloads the smallest changed datasets first and defers the rest", async () => {
      const r = await h.engine.runSync({ trigger: "test", maxDatasets: 3 });
      expect(r.updated).toBe(3);
      expect(r.deferred).toBe(7);
      expect([...r.changed.updated].sort()).toEqual(["air-quality-stations", "empty-dataset", "schools-by-type"]);
    });

    it("never downloads a dataset whose catalog count exceeds maxRecords, even when changed and forced-looking", async () => {
      await h.seed();
      await post("/__mock/add-big?id=huge&rows=10&claim=500000");
      const r = await h.engine.runSync({ trigger: "public", maxRecords: 100_000, maxDatasets: 5 });
      expect(r.changed.deferred).toEqual(["huge"]);
      expect(h.mock.state.hits.exportById.huge).toBeUndefined();
    });
  });

  describe("dataset-scoped runs", () => {
    it("fetches ONE catalog entry (1 request) and leaves the catalog-wide clocks alone", async () => {
      await h.seed();
      const stateBefore = await h.prisma.syncState.findUniqueOrThrow({ where: { id: 1 } });
      await post("/__mock/mutate?id=seaports&mode=bump");
      await new Promise((r) => setTimeout(r, 15));

      const r = await h.engine.runSync({ trigger: "test", datasetId: "seaports" });
      expect(r).toMatchObject({ status: "success", updated: 1, processed: 1 });
      expect(h.mock.state.hits).toMatchObject({ catalog: 0, catalogEntry: 1, export: 1 });

      const log = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: r.syncLogId } });
      expect(log.scope).toBe("dataset:seaports");
      const stateAfter = await h.prisma.syncState.findUniqueOrThrow({ where: { id: 1 } });
      expect(stateAfter.lastCatalogCheckAt!.getTime()).toBe(stateBefore.lastCatalogCheckAt!.getTime());
      expect(stateAfter.lastSuccessAt!.getTime()).toBe(stateBefore.lastSuccessAt!.getTime());
      expect(stateAfter.lastDataChangeAt!.getTime()).toBeGreaterThan(stateBefore.lastDataChangeAt!.getTime());
      const d = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } });
      expect(d.lastCheckedAt!.getTime()).toBeGreaterThan(stateBefore.lastCatalogCheckAt!.getTime());
    });

    it("falls back to the full catalog when the per-dataset endpoint is missing", async () => {
      await h.seed();
      await post("/__mock/mutate?mode=single-404");
      await post("/__mock/mutate?id=seaports&mode=bump");
      const r = await h.engine.runSync({ trigger: "test", datasetId: "seaports" });
      expect(r.updated).toBe(1);
      expect(h.mock.state.hits.catalog).toBeGreaterThan(0);
    });

    it("a dataset the complete catalog no longer lists is flagged removed and the run fails clearly", async () => {
      await h.seed();
      await post("/__mock/mutate?id=seaports&mode=remove");
      const r = await h.engine.runSync({ trigger: "test", datasetId: "seaports" });
      expect(r.status).toBe("failed");
      expect(r.error).toBe("Dataset seaports is no longer listed in the portal catalog");
      expect(r.changed.removed).toEqual(["seaports"]);
      expect((await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } })).removedAt).not.toBeNull();
    });

    it("an unknown id fails without creating anything", async () => {
      const r = await h.engine.runSync({ trigger: "test", datasetId: "no-such-dataset" });
      expect(r.status).toBe("failed");
      expect(await h.prisma.dataset.count()).toBe(0);
    });
  });

  describe("dry run", () => {
    it("reports what would change and writes nothing", async () => {
      await h.seed();
      await post("/__mock/mutate?id=seaports&mode=bump");
      await post("/__mock/mutate?id=housing-loans&mode=remove");
      await post("/__mock/add?id=brand-new");
      const logsBefore = await h.prisma.syncLog.count();
      const seaportsBefore = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } });

      const r = await h.engine.runSync({ trigger: "test", dryRun: true });
      expect(r).toMatchObject({ dryRun: true, status: "success", syncLogId: 0 });
      expect([...r.changed.updated].sort()).toEqual(["brand-new", "seaports"]);
      expect(r.changed.added).toEqual(["brand-new"]);
      expect(r.changed.removed).toEqual(["housing-loans"]);
      expect(h.mock.state.hits.export).toBe(0);

      expect(await h.prisma.syncLog.count()).toBe(logsBefore);
      expect(await h.prisma.dataset.count()).toBe(10); // brand-new NOT created
      const seaportsAfter = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } });
      expect(seaportsAfter).toEqual(seaportsBefore); // metadata not even refreshed
      expect((await h.prisma.dataset.findUniqueOrThrow({ where: { id: "housing-loans" } })).removedAt).toBeNull();
      expect(await h.lock.getLockState()).toMatchObject({ running: false });
    });
  });

  describe("abort and background start", () => {
    it("an abort signal stops the run: status aborted, lock released", async () => {
      await post("/__mock/mutate?id=seaports&mode=slow&ms=5000");
      const controller = new AbortController();
      const running = h.engine.runSync({ trigger: "test", signal: controller.signal });
      await waitUntil(() => (h.mock.state.hits.exportById.seaports ?? 0) >= 1, { what: "the slow export to start" });
      const t0 = Date.now();
      controller.abort();
      const r = await running;
      expect(Date.now() - t0).toBeLessThan(2500);
      expect(r.status).toBe("aborted");
      const log = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: r.syncLogId } });
      expect(log.status).toBe("aborted");
      expect(log.finishedAt).not.toBeNull();
      expect(await h.lock.getLockState()).toMatchObject({ running: false });
      expect((await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } })).syncStatus).not.toBe("error");
    });

    it("startSyncInBackground takes the lock before returning and reports a truthful 'already running'", async () => {
      await post("/__mock/mutate?id=seaports&mode=slow&ms=600");
      const a = await h.engine.startSyncInBackground({ trigger: "test" });
      expect(a.started).toBe(true);
      if (!a.started) return;

      // the lock and the SyncLog row exist the moment it returns
      expect(await h.lock.getLockState()).toMatchObject({ running: true });
      const row = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: a.runId } });
      expect(row.status).toBe("running");

      const b = await h.engine.startSyncInBackground({ trigger: "test" });
      expect(b.started).toBe(false);
      if (!b.started) expect(b.since).toBeInstanceOf(Date);

      await waitUntil(async () => !(await h.lock.getLockState()).running, { timeoutMs: 15_000, what: "the run to finish" });
      const done = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: a.runId } });
      expect(done.status).toBe("success");
      expect(await h.prisma.syncLog.count({ where: { status: "running" } })).toBe(0);
    });

    it("runSync throws SyncAlreadyRunningError while the lock is held", async () => {
      const handle = await h.lock.acquireLock();
      try {
        await expect(h.engine.runSync({ trigger: "test" })).rejects.toMatchObject({ name: "SyncAlreadyRunningError" });
      } finally {
        await handle.release();
      }
    });

    it("adopts a pre-acquired lock and releases it at the end", async () => {
      const handle = await h.lock.acquireLock();
      const r = await h.engine.runSync({ trigger: "test", lock: handle });
      expect(r.status).toBe("success");
      expect(await h.lock.getLockState()).toMatchObject({ running: false });
    });
  });

  describe("cache invalidation call", () => {
    it("notifies the web app AFTER the log/state are final and BEFORE the lock is released", async () => {
      const seen: Array<{ auth: string | undefined; body: { tags?: string[]; datasetIds?: string[] }; lockRunning: boolean; logStatus: string | undefined }> = [];
      const app = http.createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const [lock, log] = await Promise.all([h.lock.getLockState(), h.prisma.syncLog.findFirst({ orderBy: { id: "desc" } })]);
        seen.push({ auth: req.headers.authorization, body: JSON.parse(raw || "{}"), lockRunning: lock.running, logStatus: log?.status });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"revalidated":["datasets"]}');
      });
      await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
      process.env.APP_INTERNAL_URL = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
      process.env.SYNC_TOKEN = "test-sync-token-0123456789abcdef0123456789";
      try {
        const r = await h.engine.runSync({ trigger: "test" });
        expect(r.status).toBe("success");
        expect(seen).toHaveLength(1);
        expect(seen[0].auth).toBe("Bearer test-sync-token-0123456789abcdef0123456789");
        expect(seen[0].lockRunning).toBe(true); // a polling browser still sees "running"
        expect(seen[0].logStatus).toBe("success"); // ...but the row was already final
        expect([...(seen[0].body.datasetIds ?? [])].sort()).toEqual(
          (await h.prisma.dataset.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((d) => d.id),
        );
        expect(await h.lock.getLockState()).toMatchObject({ running: false });

        // a failed run still tells the app (metadata may already have changed)
        await post("/__mock/mutate?mode=catalog-500");
        const failed = await h.engine.runSync({ trigger: "test" });
        expect(failed.status).toBe("failed");
        expect(seen).toHaveLength(2);
        expect(seen[1].logStatus).toBe("failed");
      } finally {
        app.closeAllConnections();
        await new Promise<void>((resolve) => app.close(() => resolve()));
      }
    });

    it("a dead or erroring web app never fails the sync", async () => {
      process.env.APP_INTERNAL_URL = "http://127.0.0.1:1";
      process.env.SYNC_TOKEN = "test-sync-token-0123456789abcdef0123456789";
      const r = await h.engine.runSync({ trigger: "test" });
      expect(r.status).toBe("success");
      expect(await h.lock.getLockState()).toMatchObject({ running: false });
    });

    it("is a no-op without SYNC_TOKEN", async () => {
      const notify = await import("@/lib/sync/notify");
      delete process.env.SYNC_TOKEN;
      expect(await notify.notifyAppToRevalidate({ datasetIds: ["x"] })).toEqual({ ok: false, reason: "no_token" });
    });
  });
});
