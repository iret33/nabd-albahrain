import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMockOds } from "../../scripts/mock-ods.mjs";

// Read when the sync modules are first imported.
process.env.SYNC_DELAY_MS = "0";
process.env.SYNC_RETRY_BASE_MS = "5";

type Mock = Awaited<ReturnType<typeof startMockOds>>;
type Client = typeof import("@/lib/sync/ods-client");

let mock: Mock;
let client: Client;

beforeAll(async () => {
  mock = await startMockOds({ port: 0 });
  process.env.ODS_BASE_URL = `${mock.url}/api/explore/v2.1`;
  client = await import("@/lib/sync/ods-client");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(async () => {
  vi.restoreAllMocks();
  await mock.close();
});

beforeEach(() => {
  mock.state.reset();
});

describe("fetchFullCatalog", () => {
  it("returns every dataset, de-duplicated, sorted, with the portal's extra metas", async () => {
    const cat = await client.fetchFullCatalog();
    expect(cat.datasets).toHaveLength(10);
    expect(cat.totalCount).toBe(10);
    expect(cat.skipped).toEqual([]);
    expect(cat.seenIds.size).toBe(10);
    const ids = cat.datasets.map((d) => d.dataset_id);
    expect(ids).toEqual([...ids].sort());
    const pop = cat.datasets.find((d) => d.dataset_id === "population-by-nationality");
    expect(pop?.metas?.default?.title_ar).toContain("السكان");
    expect(pop?.metas?.default?.keyword).toContain("population");
  });

  it("pages through more than one page", async () => {
    for (let i = 0; i < 120; i++) await fetch(`${mock.url}/__mock/add?id=extra-${String(i).padStart(3, "0")}`, { method: "POST" });
    const cat = await client.fetchFullCatalog();
    expect(cat.datasets).toHaveLength(130);
    expect(mock.state.hits.catalog).toBe(2);
  });

  it("throws (never returns a partial list) when pages silently miss entries", async () => {
    mock.state.mutate(undefined, "catalog-short", { n: 3 });
    await expect(client.fetchFullCatalog()).rejects.toMatchObject({ name: "CatalogIncompleteError" });
    // 3 passes were attempted before giving up (each pass pages until it sees the gap)
    expect(mock.state.hits.catalog).toBeGreaterThanOrEqual(3);
  });

  it("recovers when the portal heals between passes", async () => {
    mock.state.mutate(undefined, "catalog-short", { n: 2 });
    const first = client.fetchFullCatalog();
    setTimeout(() => mock.state.mutate(undefined, "heal"), 3);
    const cat = await first;
    expect(cat.datasets).toHaveLength(10);
    expect(mock.state.hits.catalog).toBeGreaterThan(1);
  });

  it("skips and reports a malformed entry without aborting the page, and still counts it as seen", async () => {
    mock.state.mutate("seaports", "schema-break");
    const cat = await client.fetchFullCatalog();
    expect(cat.datasets).toHaveLength(9);
    expect(cat.datasets.some((d) => d.dataset_id === "seaports")).toBe(false);
    expect(cat.skipped).toHaveLength(1);
    expect(cat.skipped[0]).toMatchObject({ datasetId: "seaports" });
    expect(cat.skipped[0].issue).toMatch(/records_count/);
    // important for removal safety: a malformed entry is still "listed"
    expect(cat.seenIds.has("seaports")).toBe(true);
    expect(cat.seenIds.size).toBe(10);
  });

  it("fails on a portal error instead of returning something empty", async () => {
    mock.state.mutate(undefined, "catalog-500");
    await expect(client.fetchFullCatalog()).rejects.toMatchObject({ name: "HttpError", status: 500 });
  });

  it("accepts an empty catalog as complete (the engine's plausibility guard decides what to do)", async () => {
    mock.state.mutate(undefined, "catalog-empty");
    const cat = await client.fetchFullCatalog();
    expect(cat.datasets).toEqual([]);
    expect(cat.totalCount).toBe(0);
  });
});

describe("fetchCatalogEntry", () => {
  it("uses ONE request to the per-dataset endpoint", async () => {
    const r = await client.fetchCatalogEntry("seaports");
    expect(r.via).toBe("entry");
    expect(r.entry?.dataset_id).toBe("seaports");
    expect(mock.state.hits.catalogEntry).toBe(1);
    expect(mock.state.hits.catalog).toBe(0);
  });

  it("falls back to the full catalog when the endpoint answers 404", async () => {
    mock.state.mutate(undefined, "single-404");
    const r = await client.fetchCatalogEntry("seaports");
    expect(r.via).toBe("catalog");
    expect(r.entry?.dataset_id).toBe("seaports");
    expect(mock.state.hits.catalog).toBeGreaterThan(0);
  });

  it("returns null only when the COMPLETE catalog does not list the id", async () => {
    mock.state.mutate("seaports", "remove");
    const r = await client.fetchCatalogEntry("seaports");
    expect(r.entry).toBeNull();
    expect(r.via).toBe("catalog");
    expect(r.malformedIssue).toBeUndefined();
  });

  it("explains a malformed entry instead of calling it missing", async () => {
    mock.state.mutate("seaports", "schema-break");
    const r = await client.fetchCatalogEntry("seaports");
    expect(r.entry).toBeNull();
    expect(r.malformedIssue).toMatch(/records_count/);
  });
});

describe("fetchDatasetExport", () => {
  it("returns rows as plain objects", async () => {
    const rows = await client.fetchDatasetExport("seaports");
    expect(rows).toHaveLength(12);
    expect(rows[0]).toHaveProperty("year");
  });

  it("returns [] for an empty export (the engine decides what that means)", async () => {
    expect(await client.fetchDatasetExport("empty-dataset")).toEqual([]);
  });

  it("rejects a body that is not an array of objects", async () => {
    // the mock cannot serve this shape, so call the guard through a one-off server
    const http = await import("node:http");
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ rows: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as import("node:net").AddressInfo;
    const prev = process.env.ODS_BASE_URL;
    process.env.ODS_BASE_URL = `http://127.0.0.1:${port}/api`;
    try {
      await expect(client.fetchDatasetExport("x")).rejects.toMatchObject({ name: "SyncIntegrityError" });
    } finally {
      process.env.ODS_BASE_URL = prev;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
