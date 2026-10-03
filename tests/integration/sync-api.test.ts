import http from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_INTEGRATION, setupHarness, waitUntil, type Harness } from "./helpers";

// The Next cache API only works inside a Next request; record the calls instead.
const revalidateTag = vi.fn();
vi.mock("next/cache", () => ({ revalidateTag: (tag: string) => revalidateTag(tag), unstable_cache: (fn: unknown) => fn }));

const SYNC_TOKEN = "test-sync-token-0123456789abcdef0123456789";
const ADMIN_TOKEN = "test-admin-token-0123456789abcdef0123456789";
const SITE = "https://data.example.bh";

describe.skipIf(!RUN_INTEGRATION)("HTTP API (route handlers + Postgres + in-process mock portal)", () => {
  let h: Harness;
  let refresh: typeof import("@/app/api/refresh/route");
  let freshness: typeof import("@/app/api/freshness/route");
  let sync: typeof import("@/app/api/sync/route");
  let status: typeof import("@/app/api/sync/status/route");
  let revalidate: typeof import("@/app/api/revalidate/route");
  let ready: typeof import("@/app/api/health/ready/route");
  let health: typeof import("@/app/api/health/route");
  let rateLimit: typeof import("@/lib/rate-limit");
  let session: typeof import("@/lib/admin-session");
  let app: http.Server;

  /** Headers of a browser logged into /admin: signed session cookie + same-origin marker. */
  async function adminHeaders(): Promise<Record<string, string>> {
    const token = await session.createSession(ADMIN_TOKEN);
    return { cookie: `${session.ADMIN_COOKIE_NAME}=${token}`, "sec-fetch-site": "same-origin" };
  }

  beforeAll(async () => {
    h = await setupHarness();
    refresh = await import("@/app/api/refresh/route");
    freshness = await import("@/app/api/freshness/route");
    sync = await import("@/app/api/sync/route");
    status = await import("@/app/api/sync/status/route");
    revalidate = await import("@/app/api/revalidate/route");
    ready = await import("@/app/api/health/ready/route");
    health = await import("@/app/api/health/route");
    rateLimit = await import("@/lib/rate-limit");
    session = await import("@/lib/admin-session");

    // A stand-in "web server": forwards the engine's invalidation POST to the real route handler.
    app = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const out = await revalidate.POST(new NextRequest("http://127.0.0.1/api/revalidate", { method: "POST", headers, body: raw }));
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(await out.text());
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    app.closeAllConnections();
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await h?.close();
  });

  beforeEach(async () => {
    await h.reset();
    process.env.SYNC_TOKEN = SYNC_TOKEN;
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.NEXT_PUBLIC_SITE_URL = SITE;
    process.env.APP_INTERNAL_URL = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    delete process.env.PUBLIC_REFRESH_ENABLED;
    delete process.env.AUTO_SYNC_INTERVAL_MINUTES;
    process.env.PUBLIC_REFRESH_CATALOG_COOLDOWN_SECONDS = "120";
    process.env.PUBLIC_REFRESH_DATASET_COOLDOWN_SECONDS = "600";
    rateLimit.resetRateLimit("refresh:local");
    rateLimit.resetRateLimit("refresh-attempts:local");
    revalidateTag.mockClear();
  });

  afterEach(async () => {
    await waitIdle(); // never leak a running sync into the next test
  });

  const waitIdle = () =>
    waitUntil(async () => !(await h.lock.getLockState()).running, { timeoutMs: 20_000, what: "the sync lock to be released" });
  const mutate = (qs: string) => fetch(`${h.mock.url}/__mock/mutate?${qs}`, { method: "POST" });

  function req(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
    return new NextRequest(`http://localhost:3101${path}`, {
      method,
      headers: { host: "localhost:3101", ...(opts.headers ?? {}) },
      body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
    });
  }
  const bearer = { authorization: `Bearer ${SYNC_TOKEN}` };
  const postRefresh = (body: unknown, headers: Record<string, string> = {}) =>
    refresh.POST(req("POST", "/api/refresh", { body, headers }));
  const getFreshness = async (qs = "") => {
    const res = await freshness.GET(req("GET", `/api/freshness${qs}`));
    return { res, json: await res.json() };
  };

  describe("GET /api/freshness", () => {
    it("never synced: stale, nothing running, never cached; strict mode answers 503", async () => {
      const { res, json } = await getFreshness();
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(json).toMatchObject({
        lastCheckedAt: null,
        lastSuccessAt: null,
        lastDataChangeAt: null,
        lastRunStatus: null,
        running: false,
        runStartedAt: null,
        runScope: null,
        progress: null,
        cooldown: { catalogUntil: null },
        stale: true,
        refreshEnabled: true,
      });
      expect(Number.isNaN(Date.parse(json.now))).toBe(false);
      const strict = await getFreshness("?strict=1");
      expect(strict.res.status).toBe(503);
      expect(strict.res.headers.get("cache-control")).toBe("no-store");
    });

    it("after a sync: fresh, success, strict is 200", async () => {
      await h.seed();
      const { json } = await getFreshness();
      expect(json.stale).toBe(false);
      expect(json.lastRunStatus).toBe("success");
      expect(Date.now() - Date.parse(json.lastCheckedAt)).toBeLessThan(30_000);
      expect(Date.now() - Date.parse(json.lastSuccessAt)).toBeLessThan(30_000);
      expect((await getFreshness("?strict=1")).res.status).toBe(200);
    });

    it("stale = last success older than 2x the auto-sync interval (48h when the scheduler is off)", async () => {
      await h.seed();
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastSuccessAt: new Date(Date.now() - 3 * 3_600_000) } });
      expect((await getFreshness()).json.stale).toBe(false); // 3h < 48h
      process.env.AUTO_SYNC_INTERVAL_MINUTES = "60";
      expect((await getFreshness()).json.stale).toBe(true); // 3h > 2 x 60min
      process.env.AUTO_SYNC_INTERVAL_MINUTES = "360";
      expect((await getFreshness()).json.stale).toBe(false);
    });

    it("reports a running sync with scope and progress, and clears it when done", async () => {
      await mutate("id=seaports&mode=slow&ms=500");
      const started = await h.engine.startSyncInBackground({ trigger: "test" });
      expect(started.started).toBe(true);
      const { json } = await getFreshness();
      expect(json.running).toBe(true);
      expect(json.runScope).toBe("changed");
      expect(Date.parse(json.runStartedAt)).not.toBeNaN();
      expect(json.progress).toMatchObject({ total: expect.any(Number), done: expect.any(Number) });
      await waitIdle();
      const after = (await getFreshness()).json;
      expect(after).toMatchObject({ running: false, runStartedAt: null, runScope: null, progress: null, lastRunStatus: "success" });
    });

    it("lastRunStatus reflects a failed run; recompute runs do not count", async () => {
      await h.seed();
      await mutate("mode=catalog-500");
      await h.engine.runSync({ trigger: "test" });
      expect((await getFreshness()).json.lastRunStatus).toBe("failed");
      await mutate("mode=heal");
      await h.recompute.runRecompute({ trigger: "test", force: true });
      expect((await getFreshness()).json.lastRunStatus).toBe("failed"); // the recompute (success) is ignored
    });

    it("?dataset= adds the dataset block (null when unknown, removed flag, refresh availability)", async () => {
      await h.seed();
      const known = (await getFreshness("?dataset=seaports")).json.dataset;
      expect(known).toMatchObject({ id: "seaports", removed: false, refreshAvailableAt: null });
      expect(Date.parse(known.lastSyncedAt)).not.toBeNaN();
      expect(Date.parse(known.lastCheckedAt)).not.toBeNaN();
      expect(Date.parse(known.sourceModified)).not.toBeNaN();

      expect((await getFreshness("?dataset=nope")).json.dataset).toBeNull();
      expect((await getFreshness(`?dataset=${"x".repeat(400)}`)).json.dataset).toBeNull();
      expect((await getFreshness()).json).not.toHaveProperty("dataset");

      await h.prisma.dataset.update({ where: { id: "seaports" }, data: { removedAt: new Date() } });
      expect((await getFreshness("?dataset=seaports")).json.dataset.removed).toBe(true);

      await h.prisma.dataset.update({ where: { id: "seaports" }, data: { removedAt: null, refreshRequestedAt: new Date() } });
      const cooling = (await getFreshness("?dataset=seaports")).json.dataset;
      expect(Date.parse(cooling.refreshAvailableAt) - Date.now()).toBeGreaterThan(590_000);
    });
  });

  describe("GET /api/freshness: enough for an honest message (r1-02, r1-03)", () => {
    const addBig = (id: string, claim: number) =>
      fetch(`${h.mock.url}/__mock/add-big?id=${id}&rows=10&claim=${claim}`, { method: "POST" });
    const fullPass = () => h.engine.runSync({ trigger: "auto" });

    it("lastRun carries the id, scope, trigger and COUNTS (never id lists) of the newest finished run", async () => {
      await h.seed();
      const { json } = await getFreshness();
      expect(json.lastRun).toEqual({
        id: expect.any(Number),
        scope: "changed",
        trigger: "test-seed",
        status: "success",
        finishedAt: expect.any(String),
        updated: 10,
        failed: 0,
        deferred: 0,
      });
      expect(json.lastRunStatus).toBe("success");
      expect(JSON.stringify(json)).not.toContain("changedJson");
    });

    it("a catalog press that defers a big dataset says so (updated + deferred), and the dataset block agrees", async () => {
      await h.seed();
      await addBig("big-claim", 500_000);
      await mutate("id=seaports&mode=bump");
      const press = await h.engine.runSync({ trigger: "public", maxRecords: 100_000, maxDatasets: 5 });
      expect(press.status).toBe("success");

      const { json } = await getFreshness("?dataset=big-claim");
      expect(json.lastRun).toMatchObject({ trigger: "public", status: "success", updated: 1, failed: 0, deferred: 1 });
      expect(json.dataset).toMatchObject({
        id: "big-claim",
        syncStatus: "pending",
        failed: false,
        deferred: true,
        lastRunId: json.lastRun.id,
      });
      // an ordinary dataset of the same run is not deferred
      expect((await getFreshness("?dataset=seaports")).json.dataset).toMatchObject({ deferred: false, failed: false, syncStatus: "ok" });
    });

    it("a dataset-scope press on an over-limit dataset: scope, deferred=1, and it is NOT counted as a data change", async () => {
      await h.seed();
      await addBig("big-claim", 500_000);
      await fullPass(); // the unrestricted pass syncs it...
      // ...then the portal changes it again (a new `modified`, the claimed 500k rows unchanged): the press has something to defer
      await mutate("id=big-claim&mode=set-modified&value=2026-09-01T00:00:00Z");
      const lastChangeBefore = (await getFreshness()).json.lastDataChangeAt;
      const press = await h.engine.runSync({ trigger: "public", datasetId: "big-claim", maxRecords: 100_000, maxDatasets: 5 });
      expect(press.updated).toBe(0);
      const { json } = await getFreshness("?dataset=big-claim");
      expect(json.lastRun).toMatchObject({ scope: "dataset:big-claim", status: "success", updated: 0, failed: 0, deferred: 1 });
      expect(json.dataset.deferred).toBe(true);
      expect(json.lastDataChangeAt).toBe(lastChangeBefore); // deferral does not bump "last data change"
      expect(json.lastRunStatus).toBe("success"); // nor does it turn the run partial/failed
    });

    it("the deferred flag does not outlive the deferral: a later covering run that syncs the dataset clears it", async () => {
      await h.seed();
      await addBig("big-claim", 500_000);
      await h.engine.runSync({ trigger: "public", maxRecords: 100_000, maxDatasets: 5 });
      expect((await getFreshness("?dataset=big-claim")).json.dataset.deferred).toBe(true);
      await fullPass();
      const after = (await getFreshness("?dataset=big-claim")).json;
      expect(after.dataset).toMatchObject({ deferred: false, syncStatus: "ok" });
      expect(after.lastRun.deferred).toBe(0);
    });

    it("a failed run does not hide an earlier deferral; a run that never covered the dataset does not touch it", async () => {
      await h.seed();
      await addBig("big-claim", 500_000);
      await h.engine.runSync({ trigger: "public", maxRecords: 100_000, maxDatasets: 5 });
      await h.engine.runSync({ trigger: "public", datasetId: "seaports" }); // another dataset's press
      await mutate("mode=catalog-500");
      await h.engine.runSync({ trigger: "auto" }); // a failed catalog pass
      await mutate("mode=heal");
      const { json } = await getFreshness("?dataset=big-claim");
      expect(json.lastRunStatus).toBe("failed");
      expect(json.dataset.deferred).toBe(true);
    });

    it("partial with failures exposes the failure count and the dataset's failed flag; the status stays partial", async () => {
      await h.seed();
      await mutate("id=seaports&mode=bump");
      await mutate("id=seaports&mode=http500");
      await h.engine.runSync({ trigger: "public", maxRecords: 100_000, maxDatasets: 5 });
      const { json } = await getFreshness("?dataset=seaports");
      expect(json.lastRunStatus).toBe("partial");
      expect(json.lastRun).toMatchObject({ status: "partial", updated: 0, failed: 1, deferred: 0 });
      expect(json.dataset).toMatchObject({ syncStatus: "error", failed: true });
      // ...and the stale signal keeps following the last successful RUN, so one sticky failure does not freeze it
      expect(json.stale).toBe(false);
      expect((await getFreshness("?strict=1")).res.status).toBe(200);
    });

    it("a NUL byte or other malformed id is an unknown dataset, not a 500", async () => {
      await h.seed();
      for (const qs of ["?dataset=a%00b", "?dataset=%00", `?dataset=${"x".repeat(201)}`, "?dataset=a%0Ab"]) {
        const { res, json } = await getFreshness(qs);
        expect(res.status, qs).toBe(200);
        expect(json.dataset, qs).toBeNull();
      }
      // the null never leaks into the next (memoized) catalog snapshot
      expect((await getFreshness()).json).not.toHaveProperty("dataset");
    });
  });

  describe("freshness memo (r1-15)", () => {
    it("callers within ~1s share one set of catalog reads", async () => {
      await h.seed();
      const spy = vi.spyOn(h.prisma.syncState, "findUnique");
      try {
        h.freshness.clearFreshnessMemo();
        await Promise.all(Array.from({ length: 20 }, () => getFreshness()));
        await getFreshness("?dataset=seaports"); // the dataset block adds its own reads, not another catalog read
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("is dropped when a run starts or ends in this process, so a poller never reads a stale 'idle'", async () => {
      await h.seed();
      h.freshness.clearFreshnessMemo();
      expect((await getFreshness()).json.running).toBe(false); // memoized as idle
      await mutate("id=seaports&mode=slow&ms=400");
      await mutate("id=seaports&mode=bump");
      const started = await h.engine.startSyncInBackground({ trigger: "test" });
      expect(started.started).toBe(true);
      expect((await getFreshness()).json.running).toBe(true); // within the TTL, but beginRun cleared the memo
      await waitIdle();
      expect((await getFreshness()).json.running).toBe(false); // endRun cleared it after the lock release
    });

    it("is dropped by the refresh route after the cooldown claim, so the countdown shows at once", async () => {
      await h.seed();
      h.freshness.clearFreshnessMemo();
      expect((await getFreshness()).json.cooldown.catalogUntil).toBeNull(); // memoized
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastCatalogCheckAt: new Date(Date.now() - 3_600_000) } });
      const res = await postRefresh({ scope: "catalog" });
      expect(res.status).toBe(202);
      const { json } = await getFreshness();
      expect(Date.parse(json.cooldown.catalogUntil)).toBeGreaterThan(Date.now() + 100_000);
      await waitIdle();
    });

    it("expires on its own, never caches a rejection and hands every caller its own object", async () => {
      await h.seed();
      h.freshness.clearFreshnessMemo();
      const first = (await getFreshness()).json;
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastDataChangeAt: new Date("2020-01-01T00:00:00Z") } });
      expect((await getFreshness()).json.lastDataChangeAt).toBe(first.lastDataChangeAt); // still the shared rows
      await new Promise((r) => setTimeout(r, h.freshness.FRESHNESS_MEMO_TTL_MS + 50));
      expect((await getFreshness()).json.lastDataChangeAt).toBe("2020-01-01T00:00:00.000Z");

      const spy = vi.spyOn(h.prisma.syncState, "findUnique").mockRejectedValueOnce(new Error("db blip"));
      try {
        h.freshness.clearFreshnessMemo();
        const failing = await freshness.GET(req("GET", "/api/freshness"));
        expect(failing.status).toBe(500);
        const recovered = await freshness.GET(req("GET", "/api/freshness")); // not served the failure from the memo
        expect(recovered.status).toBe(200);
      } finally {
        spy.mockRestore();
      }

      const a = await h.freshness.getFreshness();
      const b = await h.freshness.getFreshness();
      expect(a).not.toBe(b);
      a.running = true;
      expect(b.running).toBe(false);
    });
  });

  describe("POST /api/refresh", () => {
    it("kill switch", async () => {
      process.env.PUBLIC_REFRESH_ENABLED = "0";
      const res = await postRefresh({ scope: "catalog" });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: "disabled" });
      expect((await getFreshness()).json.refreshEnabled).toBe(false);
      expect(await h.prisma.syncLog.count()).toBe(0);
    });

    it("rejects cross-origin requests, allows same-origin, site-origin and no Origin", async () => {
      const evil = await postRefresh({ scope: "catalog" }, { origin: "https://evil.example" });
      expect(evil.status).toBe(403);
      expect(await evil.json()).toEqual({ status: "bad_origin" });
      const nullOrigin = await postRefresh({ scope: "catalog" }, { origin: "null" });
      expect(nullOrigin.status).toBe(403);
      expect(await h.prisma.syncLog.count()).toBe(0);

      process.env.PUBLIC_REFRESH_CATALOG_COOLDOWN_SECONDS = "0";
      for (const origin of ["http://localhost:3101", SITE, undefined]) {
        const ok = await postRefresh({ scope: "catalog" }, origin ? { origin } : {});
        // past the origin check: a run starts (202) or the catalog was checked moments ago (200)
        expect([200, 202], String(origin)).toContain(ok.status);
        await waitIdle();
      }
    });

    it("validates the body strictly (and can never be told to force)", async () => {
      for (const body of [
        "",
        "{",
        {},
        { scope: "everything" },
        { scope: "catalog", force: true },
        { scope: "dataset" },
        { scope: "dataset", id: "" },
        { scope: "dataset", id: 7 },
        { scope: "dataset", id: "seaports", force: 1 },
        "x".repeat(5000),
      ]) {
        const res = await postRefresh(body);
        expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
        expect(await res.json()).toEqual({ status: "bad_request" });
      }
      expect(await h.prisma.syncLog.count()).toBe(0);
      expect((await h.prisma.syncState.findUniqueOrThrow({ where: { id: 1 } })).lastPublicRefreshAt).toBeNull();
    });

    it("unknown or removed datasets are a 404 and consume no cooldown", async () => {
      await h.seed();
      const unknown = await postRefresh({ scope: "dataset", id: "no-such-dataset" });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ status: "unknown_dataset" });

      await h.prisma.dataset.update({ where: { id: "seaports" }, data: { removedAt: new Date() } });
      expect((await postRefresh({ scope: "dataset", id: "seaports" })).status).toBe(404);
      expect((await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } })).refreshRequestedAt).toBeNull();
      expect(h.mock.state.hits.total).toBe(0);
    });

    it("catalog refresh: 202 started, then a 429 cooldown with Retry-After; the run ends and the app is told to revalidate", async () => {
      await h.seed();
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastCatalogCheckAt: new Date(Date.now() - 3_600_000) } });
      await mutate("id=seaports&mode=bump");

      const first = await postRefresh({ scope: "catalog" });
      expect(first.status).toBe(202);
      const body = await first.json();
      expect(body).toMatchObject({ status: "started", scope: "catalog", runId: expect.any(Number) });

      const second = await postRefresh({ scope: "catalog" });
      expect(second.status).toBe(429);
      const cooldown = await second.json();
      expect(cooldown).toMatchObject({ status: "cooldown", scope: "catalog" });
      expect(cooldown.retryAfterSeconds).toBeGreaterThan(100);
      expect(cooldown.retryAfterSeconds).toBeLessThanOrEqual(120);
      expect(second.headers.get("retry-after")).toBe(String(cooldown.retryAfterSeconds));

      await waitIdle();
      const log = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: body.runId } });
      expect(log).toMatchObject({ trigger: "public", scope: "changed", status: "success", updated: 1 });
      expect((await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } })).sourceCount).toBe(13);
      // end-to-end: engine -> POST /api/revalidate -> revalidateTag, once the run is over
      expect(revalidateTag).toHaveBeenCalledWith("datasets");
      expect(revalidateTag).toHaveBeenCalledWith("dataset:seaports");
    });

    it("the cooldown is consumed even if the portal then fails (a down portal is not hammered)", async () => {
      await h.seed();
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastCatalogCheckAt: new Date(Date.now() - 3_600_000) } });
      await mutate("mode=catalog-500");
      expect((await postRefresh({ scope: "catalog" })).status).toBe(202);
      await waitIdle();
      expect((await h.prisma.syncLog.findFirstOrThrow({ orderBy: { id: "desc" } })).status).toBe("failed");
      expect((await postRefresh({ scope: "catalog" })).status).toBe(429);
    });

    it("concurrent presses: exactly one starts, the rest hit the shared cooldown (atomic)", async () => {
      await h.seed();
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastCatalogCheckAt: new Date(Date.now() - 3_600_000) } });
      const results = await Promise.all(Array.from({ length: 10 }, () => postRefresh({ scope: "catalog" })));
      const bodies = await Promise.all(results.map(async (r) => ({ code: r.status, body: await r.json() })));
      expect(bodies.filter((b) => b.code === 202 && b.body.status === "started")).toHaveLength(1);
      expect(bodies.filter((b) => b.code === 429 && b.body.status === "cooldown")).toHaveLength(9);
    });

    it("answers already_running (202) when a run holds the lock", async () => {
      process.env.PUBLIC_REFRESH_CATALOG_COOLDOWN_SECONDS = "0";
      await h.seed();
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastCatalogCheckAt: new Date(Date.now() - 3_600_000) } });
      const handle = await h.lock.acquireLock();
      try {
        const res = await postRefresh({ scope: "catalog" });
        expect(res.status).toBe(202);
        expect(await res.json()).toMatchObject({ status: "already_running", since: expect.any(String), scope: "catalog" });
      } finally {
        await handle.release();
      }
    });

    it("answers up_to_date without calling the portal when the catalog was checked < 60s ago", async () => {
      await h.seed();
      const logs = await h.prisma.syncLog.count();
      const res = await postRefresh({ scope: "catalog" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("up_to_date");
      expect(Date.now() - Date.parse(body.checkedAt)).toBeLessThan(60_000);
      expect(await h.prisma.syncLog.count()).toBe(logs);
      expect(h.mock.state.hits.total).toBe(0);
    });

    it("dataset refresh: only that dataset, one catalog-entry request, never forced; second press cools down", async () => {
      await h.seed();
      await mutate("id=seaports&mode=bump");
      const res = await postRefresh({ scope: "dataset", id: "seaports" });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body).toMatchObject({ status: "started", scope: "dataset" });
      await waitIdle();

      expect(h.mock.state.hits).toMatchObject({ catalog: 0, catalogEntry: 1, export: 1 });
      expect(h.mock.state.hits.exportById).toEqual({ seaports: 1 });
      const log = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: body.runId } });
      expect(log).toMatchObject({ trigger: "public", scope: "dataset:seaports", status: "success", updated: 1 });

      const again = await postRefresh({ scope: "dataset", id: "seaports" });
      expect(again.status).toBe(429);
      const cooldown = await again.json();
      expect(cooldown).toMatchObject({ status: "cooldown", scope: "dataset" });
      expect(cooldown.retryAfterSeconds).toBeGreaterThan(590);
      expect(cooldown.retryAfterSeconds).toBeLessThanOrEqual(600);
      expect(again.headers.get("retry-after")).toBe(String(cooldown.retryAfterSeconds));

      // another dataset has its own cooldown
      expect((await postRefresh({ scope: "dataset", id: "housing-loans" })).status).toBe(202);
    });

    it("never downloads datasets above PUBLIC_REFRESH_MAX_RECORDS and caps re-downloads at 5", async () => {
      process.env.PUBLIC_REFRESH_CATALOG_COOLDOWN_SECONDS = "0";
      await h.seed();
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastCatalogCheckAt: new Date(Date.now() - 3_600_000) } });
      await fetch(`${h.mock.url}/__mock/add-big?id=huge&rows=10&claim=500000`, { method: "POST" });
      for (const id of ["air-quality-stations", "schools-by-type", "housing-loans", "energy-consumption", "seaports", "unemployment-rate", "tourist-arrivals"]) {
        await mutate(`id=${id}&mode=bump`);
      }
      const res = await postRefresh({ scope: "catalog" });
      expect(res.status).toBe(202);
      const { runId } = await res.json();
      await waitIdle();
      const log = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: runId } });
      const changed = log.changedJson as { updated: string[]; deferred: string[] };
      expect(changed.updated).toHaveLength(5);
      expect(changed.deferred).toContain("huge");
      expect(changed.deferred).toHaveLength(3); // 2 more changed datasets + huge
      expect(h.mock.state.hits.exportById.huge).toBeUndefined();
    });

    it("a malformed dataset id (NUL byte, lone surrogate, control character, too long) is a 400, not a 500, and costs no slot", async () => {
      await h.seed();
      vi.mocked(console.error).mockClear();
      for (const id of ["a\\u0000b", "\\u0000", "a\\ud800b", "\\udc00", "a\\nb", "x".repeat(201)]) {
        const res = await postRefresh(`{"scope":"dataset","id":"${id}"}`);
        expect(res.status, id).toBe(400);
        expect(await res.json()).toEqual({ status: "bad_request" });
      }
      expect(vi.mocked(console.error)).not.toHaveBeenCalled(); // no Prisma stack trace in the log either
      expect(rateLimit.peekRateLimit("refresh-attempts:local", { limit: 120, windowMs: 3_600_000 }).remaining).toBe(120);
      expect(rateLimit.peekRateLimit("refresh:local", { limit: 20, windowMs: 3_600_000 }).remaining).toBe(20);
      expect(await h.prisma.syncLog.count({ where: { trigger: "public" } })).toBe(0);
    });

    it("already_running leaves both cooldown anchors untouched, names the run in progress, and a press after it ends starts (r1-04)", async () => {
      await h.seed();
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastCatalogCheckAt: new Date(Date.now() - 3_600_000) } });
      await mutate("id=energy-consumption&mode=slow&ms=700");
      await mutate("id=energy-consumption&mode=bump");
      const other = await h.engine.startSyncInBackground({ trigger: "api", datasetId: "energy-consumption" });
      expect(other.started).toBe(true);

      const dataset = await postRefresh({ scope: "dataset", id: "seaports" });
      expect(dataset.status).toBe(202);
      expect(await dataset.json()).toMatchObject({ status: "already_running", scope: "dataset", runScope: "dataset:energy-consumption" });
      const catalog = await postRefresh({ scope: "catalog" });
      expect(await catalog.json()).toMatchObject({ status: "already_running", scope: "catalog", runScope: "dataset:energy-consumption" });

      expect((await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } })).refreshRequestedAt).toBeNull();
      expect((await h.prisma.syncState.findUniqueOrThrow({ where: { id: 1 } })).lastPublicRefreshAt).toBeNull();
      expect((await getFreshness("?dataset=seaports")).json.dataset.refreshAvailableAt).toBeNull();
      expect(await h.prisma.syncLog.count({ where: { trigger: "public" } })).toBe(0);

      await waitIdle();
      const after = await postRefresh({ scope: "dataset", id: "seaports" });
      expect(after.status).toBe(202);
      expect((await after.json()).status).toBe("started");
      await waitIdle();
    });

    it("a lock taken between the read-only peek and the start gives the claim back (compare-and-set), not burns it", async () => {
      await h.seed();
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastCatalogCheckAt: new Date(Date.now() - 3_600_000) } });
      const handle = await h.lock.acquireLock();
      // The peek wrongly reports "idle" once: exactly the window in which another run can take the lock.
      const spy = vi.spyOn(h.lock, "getLockState").mockResolvedValueOnce({ running: false, since: null, heartbeatAt: null, stale: false });
      try {
        const res = await postRefresh({ scope: "dataset", id: "seaports" });
        expect(res.status).toBe(202);
        expect(await res.json()).toMatchObject({ status: "already_running", scope: "dataset" });
        expect(spy).toHaveBeenCalled();
        expect((await h.prisma.dataset.findUniqueOrThrow({ where: { id: "seaports" } })).refreshRequestedAt).toBeNull();

        spy.mockResolvedValueOnce({ running: false, since: null, heartbeatAt: null, stale: false });
        const cat = await postRefresh({ scope: "catalog" });
        expect((await cat.json()).status).toBe("already_running");
        expect((await h.prisma.syncState.findUniqueOrThrow({ where: { id: 1 } })).lastPublicRefreshAt).toBeNull();
      } finally {
        spy.mockRestore();
        await handle.release();
      }
      expect((await (await postRefresh({ scope: "dataset", id: "seaports" })).json()).status).toBe("started");
      await waitIdle();
    });

    it("a burst of presses on 10 different datasets during a run locks nobody out for 10 minutes (r1-04)", async () => {
      await h.seed();
      const ids = (await h.prisma.dataset.findMany({ select: { id: true } })).map((d) => d.id);
      expect(ids).toHaveLength(10);
      const handle = await h.lock.acquireLock();
      try {
        const results = await Promise.all(ids.map((id) => postRefresh({ scope: "dataset", id })));
        const bodies = await Promise.all(results.map((r) => r.json()));
        expect(bodies.map((b) => b.status)).toEqual(ids.map(() => "already_running"));
      } finally {
        await handle.release();
      }
      expect(await h.prisma.dataset.count({ where: { refreshRequestedAt: { not: null } } })).toBe(0);
      for (const id of ids.slice(0, 3)) {
        const res = await postRefresh({ scope: "dataset", id });
        expect((await res.json()).status, id).toBe("started");
        await waitIdle();
      }
    });

    it("up_to_date still consumes the catalog cooldown (the data is under a minute old) and the portal failure case still does", async () => {
      await h.seed();
      expect((await (await postRefresh({ scope: "catalog" })).json()).status).toBe("up_to_date");
      const next = await postRefresh({ scope: "catalog" });
      expect(next.status).toBe(429);
      expect((await next.json()).status).toBe("cooldown");

      await mutate("mode=catalog-500");
      await mutate("mode=single-404");
      const dataset = await postRefresh({ scope: "dataset", id: "seaports" });
      expect(dataset.status).toBe(202);
      await waitIdle();
      expect((await h.prisma.syncLog.findFirstOrThrow({ orderBy: { id: "desc" } })).status).toBe("failed");
      expect((await postRefresh({ scope: "dataset", id: "seaports" })).status).toBe(429);
    });

    it("a dataset-scope press tells the app about THAT dataset even when nothing changed, without inventing a change (r1-05, R2-04)", async () => {
      await h.seed();
      revalidateTag.mockClear();
      const res = await postRefresh({ scope: "dataset", id: "seaports" });
      const { runId } = await res.json();
      await waitIdle();
      const log = await h.prisma.syncLog.findUniqueOrThrow({ where: { id: runId } });
      expect(log).toMatchObject({ status: "success", updated: 0, skipped: 1 });
      expect(log.changedJson).toEqual({ updated: [], deferred: [], removed: [], added: [] }); // no phantom change
      expect(revalidateTag).toHaveBeenCalledWith("dataset:seaports");
      expect(revalidateTag).toHaveBeenCalledWith("datasets");
      expect(revalidateTag).not.toHaveBeenCalledWith("dataset:housing-loans");
      // and the run did move the dataset's "last checked"
      const checked = (await getFreshness("?dataset=seaports")).json.dataset.lastCheckedAt;
      expect(Date.now() - Date.parse(checked)).toBeLessThan(30_000);
    });

    it("the scoped dataset is notified even when the run FAILS (portal catalog down)", async () => {
      await h.seed();
      await mutate("mode=catalog-500");
      await mutate("mode=single-404"); // no per-dataset entry either: the run cannot even learn about the dataset
      revalidateTag.mockClear();
      await postRefresh({ scope: "dataset", id: "seaports" });
      await waitIdle();
      expect((await h.prisma.syncLog.findFirstOrThrow({ orderBy: { id: "desc" } })).status).toBe("failed");
      expect(revalidateTag).toHaveBeenCalledWith("dataset:seaports");
    });

    it("per-client rate limit: the 21st press that STARTS a run within the hour is a 429 rate_limited", async () => {
      process.env.PUBLIC_REFRESH_DATASET_COOLDOWN_SECONDS = "0";
      await h.seed();
      for (let i = 0; i < 20; i++) {
        const ok = await postRefresh({ scope: "dataset", id: "seaports" });
        expect(ok.status, `press ${i + 1}`).toBe(202);
        expect((await ok.json()).status).toBe("started");
        await waitIdle();
      }
      const limited = await postRefresh({ scope: "dataset", id: "seaports" });
      expect(limited.status).toBe(429);
      const body = await limited.json();
      expect(body.status).toBe("rate_limited");
      expect(body.retryAfterSeconds).toBeGreaterThan(3_500);
      expect(limited.headers.get("retry-after")).toBe(String(body.retryAfterSeconds));
      expect(await h.prisma.syncLog.count({ where: { trigger: "public" } })).toBe(20);
    });

    it("presses answered cooldown / up_to_date / already_running do not use up the 20 runs per hour", async () => {
      await h.seed(); // fresh catalog -> a catalog press answers up_to_date without a run
      process.env.PUBLIC_REFRESH_CATALOG_COOLDOWN_SECONDS = "0";
      for (let i = 0; i < 25; i++) {
        const res = await postRefresh({ scope: "catalog" });
        expect(res.status, `up_to_date press ${i + 1}`).toBe(200);
      }
      // a dataset press inside its own cooldown: 429 cooldown, not rate_limited
      expect((await postRefresh({ scope: "dataset", id: "seaports" })).status).toBe(202);
      await waitIdle();
      for (let i = 0; i < 25; i++) {
        const res = await postRefresh({ scope: "dataset", id: "seaports" });
        expect(res.status).toBe(429);
        expect((await res.json()).status).toBe("cooldown");
      }
      // a held lock: already_running, again without a charge
      const handle = await h.lock.acquireLock();
      try {
        for (let i = 0; i < 25; i++) {
          const res = await postRefresh({ scope: "dataset", id: "housing-loans" });
          expect((await res.json()).status).toBe("already_running");
        }
      } finally {
        await handle.release();
      }
      // 75 non-starting presses later the visitor can still start a run
      const started = await postRefresh({ scope: "dataset", id: "housing-loans" });
      expect((await started.json()).status).toBe("started");
    });

    it("a client that only ever gets no-op answers is still bounded: 120 attempts per hour", async () => {
      await h.seed();
      process.env.PUBLIC_REFRESH_CATALOG_COOLDOWN_SECONDS = "0";
      for (let i = 0; i < 120; i++) expect((await postRefresh({ scope: "catalog" })).status).toBe(200);
      const limited = await postRefresh({ scope: "catalog" });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ status: "rate_limited", retryAfterSeconds: expect.any(Number) });
    });
  });

  describe("POST /api/sync and GET /api/sync/status", () => {
    it("requires auth: bearer SYNC_TOKEN or the admin cookie", async () => {
      expect((await sync.POST(req("POST", "/api/sync"))).status).toBe(401);
      expect((await sync.POST(req("POST", "/api/sync", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
      expect((await status.GET(req("GET", "/api/sync/status"))).status).toBe(401);
      expect(await h.prisma.syncLog.count()).toBe(0);

      const viaCookie = await sync.POST(req("POST", "/api/sync", { headers: await adminHeaders() }));
      expect(viaCookie.status).toBe(202);
      await waitIdle();
    });

    it("202 {started, runId} then a truthful 409 {sync_already_running, since}", async () => {
      await mutate("id=seaports&mode=slow&ms=500");
      const a = await sync.POST(req("POST", "/api/sync", { headers: bearer }));
      expect(a.status).toBe(202);
      const aBody = await a.json();
      expect(aBody).toEqual({ started: true, runId: expect.any(Number) });

      const b = await sync.POST(req("POST", "/api/sync", { headers: bearer }));
      expect(b.status).toBe(409);
      expect(await b.json()).toEqual({ started: false, error: "sync_already_running", since: expect.any(String) });

      // status endpoint: lock + latestLog (running row, new columns present)
      const st = await status.GET(req("GET", "/api/sync/status", { headers: bearer }));
      const stBody = await st.json();
      expect(stBody.lock).toMatchObject({ running: true, stale: false });
      expect(stBody.latestLog).toMatchObject({ id: aBody.runId, status: "running", scope: "changed", trigger: "api" });
      for (const key of ["total", "skipped", "updated", "error", "changedJson"]) expect(stBody.latestLog).toHaveProperty(key);

      await waitIdle();
      const done = await (await status.GET(req("GET", "/api/sync/status", { headers: bearer }))).json();
      expect(done.lock.running).toBe(false);
      expect(done.latestLog).toMatchObject({ status: "success", updated: 10 });
    });

    it("?dataset= and ?force=1 and ?recompute=1", async () => {
      await h.seed();
      const one = await (await sync.POST(req("POST", "/api/sync?dataset=seaports&force=1", { headers: bearer }))).json();
      await waitIdle();
      expect(await h.prisma.syncLog.findUniqueOrThrow({ where: { id: one.runId } })).toMatchObject({
        scope: "dataset:seaports",
        status: "success",
        updated: 1,
      });

      const all = await (await sync.POST(req("POST", "/api/sync?force=true", { headers: bearer }))).json();
      await waitIdle();
      expect(await h.prisma.syncLog.findUniqueOrThrow({ where: { id: all.runId } })).toMatchObject({ scope: "all", updated: 10 });

      await h.prisma.dataset.update({ where: { id: "seaports" }, data: { derivedVersion: 1 } });
      h.mock.state.hits.total = 0;
      const rec = await (await sync.POST(req("POST", "/api/sync?recompute=1", { headers: bearer }))).json();
      await waitIdle();
      expect(await h.prisma.syncLog.findUniqueOrThrow({ where: { id: rec.runId } })).toMatchObject({ scope: "recompute", status: "success", updated: 1 });
      expect(h.mock.state.hits.total).toBe(0);

      expect((await sync.POST(req("POST", `/api/sync?dataset=${"x".repeat(301)}`, { headers: bearer }))).status).toBe(400);
    });

    it("a failed run is visible through the status endpoint", async () => {
      await mutate("mode=catalog-500");
      const started = await (await sync.POST(req("POST", "/api/sync", { headers: bearer }))).json();
      await waitIdle();
      const st = await (await status.GET(req("GET", "/api/sync/status", { headers: bearer }))).json();
      expect(st.latestLog).toMatchObject({ id: started.runId, status: "failed", error: "HTTP 500 from the data.gov.bh portal" });
    });
  });

  describe("POST /api/revalidate", () => {
    const call = (body: unknown, headers: Record<string, string> = bearer) =>
      revalidate.POST(req("POST", "/api/revalidate", { headers, body }));

    it("requires auth", async () => {
      expect((await call({}, {})).status).toBe(401);
      expect((await call({}, { authorization: "Bearer nope" })).status).toBe(401);
      expect(revalidateTag).not.toHaveBeenCalled();
    });

    it("defaults to the 'datasets' tag and revalidates synchronously inside the handler", async () => {
      const res = await call("");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revalidated: ["datasets"] });
      expect(revalidateTag.mock.calls).toEqual([["datasets"]]);
    });

    it("adds dataset:<id> for every datasetId and accepts explicit tags", async () => {
      const res = await call({ datasetIds: ["seaports", "housing-loans", "seaports"] });
      expect((await res.json()).revalidated).toEqual(["datasets", "dataset:seaports", "dataset:housing-loans"]);
      revalidateTag.mockClear();
      const res2 = await call({ tags: ["custom"], datasetIds: ["x"] });
      expect((await res2.json()).revalidated).toEqual(["custom", "dataset:x"]);
      expect(revalidateTag.mock.calls.map((c) => c[0])).toEqual(["custom", "dataset:x"]);
    });

    it("works with the admin cookie and rejects malformed bodies", async () => {
      expect((await call({}, await adminHeaders())).status).toBe(200);
      expect((await call("{")).status).toBe(400);
      expect((await call({ tags: "datasets" })).status).toBe(400);
      expect((await call({ tags: ["bad tag!"] })).status).toBe(400);
      expect((await call({ datasetIds: [""] })).status).toBe(400);
      expect((await call({ datasetIds: Array.from({ length: 1001 }, (_, i) => `d${i}`) })).status).toBe(400);
    });
  });

  describe("GET /api/health/ready", () => {
    const getReady = async () => {
      const res = await ready.GET();
      return { res, json: await res.json() };
    };

    it("200 ok after a successful sync, with lock/last-run/uptime and no-store", async () => {
      await h.seed();
      const { res, json } = await getReady();
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(json).toMatchObject({ ok: true, status: "ok", reasons: [], db: "up" });
      expect(json.sync).toMatchObject({ running: false, stale: false, lastStatus: "success" });
      expect(json.sync.ageHours).toBeLessThan(1);
      expect(typeof json.uptimeSec).toBe("number");
      expect(json).toHaveProperty("version");
    });

    it("degraded (still 200) when nothing was ever synced, the last run failed, or the data is old", async () => {
      const empty = await getReady();
      expect(empty.res.status).toBe(200);
      expect(empty.json).toMatchObject({ ok: false, status: "degraded" });
      expect(empty.json.reasons).toContain("no_data_synced");

      await h.seed();
      await mutate("mode=catalog-500");
      await h.engine.runSync({ trigger: "test" });
      const failed = await getReady();
      expect(failed.res.status).toBe(200);
      expect(failed.json.reasons).toContain("last_sync_failed");

      await mutate("mode=heal");
      await h.engine.runSync({ trigger: "test" });
      expect((await getReady()).json.ok).toBe(true);

      // The age is the last successful RUN's (the same clock and threshold as /api/freshness): 48h with the scheduler off.
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastSuccessAt: new Date(Date.now() - 50 * 3_600_000) } });
      const old = await getReady();
      expect(old.json.reasons).toContain("sync_stale");
      expect(old.json.ok).toBe(false);
      expect(old.json.sync.ageHours).toBeGreaterThan(49);
      // ...and /api/freshness?strict=1 agrees
      expect((await getFreshness("?strict=1")).res.status).toBe(503);
    });

    it("a quiet portal is healthy: old Dataset.lastSyncedAt with a fresh successful run is ok (r1-12)", async () => {
      await h.seed();
      await h.prisma.dataset.updateMany({ data: { lastSyncedAt: new Date(Date.now() - 40 * 3_600_000) } });
      await h.engine.runSync({ trigger: "test" }); // nothing changed upstream: lastSuccessAt moves, no dataset syncs
      const { json } = await getReady();
      expect(json).toMatchObject({ ok: true, status: "ok", reasons: [] });
      expect(json.sync.ageHours).toBeLessThan(1);
      expect(Date.now() - Date.parse(json.sync.lastSyncedAt)).toBeGreaterThan(39 * 3_600_000); // informational only
      expect((await getFreshness("?strict=1")).res.status).toBe(200);
    });

    it("uses the same threshold as /api/freshness when the scheduler is on (2 x the interval)", async () => {
      await h.seed();
      await h.prisma.syncState.update({ where: { id: 1 }, data: { lastSuccessAt: new Date(Date.now() - 3 * 3_600_000) } });
      expect((await getReady()).json.ok).toBe(true); // 3h < 48h
      process.env.AUTO_SYNC_INTERVAL_MINUTES = "60";
      expect((await getReady()).json.reasons).toContain("sync_stale"); // 3h > 2 x 60min
      expect((await getFreshness("?strict=1")).res.status).toBe(503);
      process.env.AUTO_SYNC_INTERVAL_MINUTES = "360"; // 2 x 6h = 12h > 3h
      expect((await getReady()).json.ok).toBe(true);
      expect((await getFreshness("?strict=1")).res.status).toBe(200);
    });

    it("datasets_failing: one or two sticky failures are warnings, a real share of the catalog is a reason (r1-03)", async () => {
      await h.seed();
      const fail = (ids: string[]) =>
        h.prisma.dataset.updateMany({ where: { id: { in: ids } }, data: { syncStatus: "error", syncError: "HTTP 500" } });
      await fail(["seaports"]);
      let ready = (await getReady()).json;
      expect(ready).toMatchObject({ ok: true, reasons: [], warnings: ["datasets_failing"] });
      expect(ready.sync.failingDatasets).toBe(1);

      await fail(["housing-loans", "energy-consumption"]); // 3 of 10 live
      ready = (await getReady()).json;
      expect(ready.ok).toBe(false);
      expect(ready.reasons).toContain("datasets_failing");
      expect(ready.sync.failingDatasets).toBe(3);
    });

    it("version comes from GIT_SHA and is null when unset or empty (r1-08 / R6-08 code side)", async () => {
      const saved = process.env.GIT_SHA;
      try {
        delete process.env.GIT_SHA;
        expect((await getReady()).json.version).toBeNull();
        process.env.GIT_SHA = "";
        expect((await getReady()).json.version).toBeNull();
        process.env.GIT_SHA = " 3f2a9c1 ";
        expect((await getReady()).json.version).toBe("3f2a9c1");
      } finally {
        if (saved === undefined) delete process.env.GIT_SHA;
        else process.env.GIT_SHA = saved;
      }
    });

    it("a failed single-dataset run does not flip the monitor to degraded", async () => {
      await h.seed();
      await h.engine.runSync({ trigger: "test", datasetId: "typo-id" });
      expect((await getReady()).json.ok).toBe(true);
    });

    it("/api/health stays a constant liveness answer", async () => {
      const res = await health.GET();
      expect(await res.json()).toEqual({ ok: true });
    });
  });
});
