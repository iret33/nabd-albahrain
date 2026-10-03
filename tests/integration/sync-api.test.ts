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
  let app: http.Server;

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

    it("per-client rate limit: the 21st press within the hour is a 429", async () => {
      process.env.PUBLIC_REFRESH_CATALOG_COOLDOWN_SECONDS = "0";
      await h.seed(); // fresh catalog -> every accepted press answers up_to_date cheaply
      for (let i = 0; i < 20; i++) expect((await postRefresh({ scope: "catalog" })).status).toBe(200);
      const limited = await postRefresh({ scope: "catalog" });
      expect(limited.status).toBe(429);
      const body = await limited.json();
      expect(body.status).toBe("rate_limited");
      expect(limited.headers.get("retry-after")).toBe(String(body.retryAfterSeconds));
    });
  });

  describe("POST /api/sync and GET /api/sync/status", () => {
    it("requires auth: bearer SYNC_TOKEN or the admin cookie", async () => {
      expect((await sync.POST(req("POST", "/api/sync"))).status).toBe(401);
      expect((await sync.POST(req("POST", "/api/sync", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
      expect((await status.GET(req("GET", "/api/sync/status"))).status).toBe(401);
      expect(await h.prisma.syncLog.count()).toBe(0);

      const viaCookie = await sync.POST(req("POST", "/api/sync", { headers: { cookie: `admin_token=${ADMIN_TOKEN}` } }));
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
      expect((await call({}, { cookie: `admin_token=${ADMIN_TOKEN}` })).status).toBe(200);
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
      await h.prisma.dataset.updateMany({ data: { lastSyncedAt: new Date(Date.now() - 40 * 3_600_000) } });
      const old = await getReady();
      expect(old.json.reasons).toContain("data_older_than_36h");
      expect(old.json.sync.ageHours).toBeGreaterThan(39);
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
