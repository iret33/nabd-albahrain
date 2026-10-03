/**
 * Integration tests for the data-access layer. They need a migrated Postgres
 * at DATABASE_URL and are opt-in:
 *
 *   set -a; . ./.env.local; set +a
 *   RUN_INTEGRATION=1 pnpm exec vitest run tests/integration/queries.test.ts
 *
 * The real `unstable_cache` runs against an in-memory incremental cache
 * (tests/queries/fake-incremental-cache.ts), so these tests also prove cache
 * behaviour: what gets stored, with which tags and TTL, and that hostile input
 * stores nothing. All fixture rows use ids starting with `qtest-` and are
 * removed before and after the run; nothing else in the database is touched
 * (SyncState/SyncLog edits are restored).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { buildSearchText } from "@/lib/search";
import { FakeIncrementalCache } from "../queries/fake-incremental-cache";

const RUN = process.env.RUN_INTEGRATION === "1";

type Queries = typeof import("@/lib/queries");
type PrismaModule = typeof import("@/lib/prisma");

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms);

interface Fixture {
  id: string;
  titleClean?: string;
  titleAr?: string | null;
  description?: string | null;
  theme?: string | null;
  publisher?: string | null;
  recordsCount?: number;
  sourceCount?: number;
  sourceModified?: Date | null;
  synced?: boolean;
  removed?: boolean;
  viz?: string | null;
  /** Simulate a row the sync engine has not back-filled searchText for. */
  legacy?: boolean;
  keywords?: string[];
  fieldsJson?: Prisma.InputJsonValue;
}

function fixtureRow(f: Fixture): Prisma.DatasetCreateManyInput {
  const titleClean = f.titleClean ?? f.id;
  return {
    id: f.id,
    title: titleClean,
    titleClean,
    titleAr: f.titleAr ?? null,
    description: f.description ?? null,
    theme: f.theme ?? null,
    publisher: f.publisher ?? null,
    keywords: f.keywords ?? [],
    recordsCount: f.recordsCount ?? 0,
    sourceCount: f.sourceCount ?? 0,
    fieldsJson: f.fieldsJson ?? [],
    sourceModified: f.sourceModified === undefined ? ago(100 * DAY) : f.sourceModified,
    lastSyncedAt: f.synced === false ? null : ago(1000),
    syncStatus: "ok",
    removedAt: f.removed ? ago(DAY) : null,
    ...(f.viz ? { vizConfig: { type: f.viz } } : {}),
    searchText: f.legacy
      ? ""
      : buildSearchText([titleClean, f.titleAr, f.publisher, f.theme, f.keywords, f.description]),
  };
}

const RECORD_FIELDS = [
  { name: "value", label: "Value", type: "int" },
  { name: "name", label: "Name", type: "text" },
  { name: "zone", label: "Zone", type: "text" },
  { name: "area", label: "Area", type: "text" },
  { name: "note", label: "Note", type: "text" },
  { name: "geo", label: "Location", type: "geo_point_2d" },
];

/** 60 rows with dirty numerics, mixed numeric/text zones and literal LIKE metacharacters. */
function recordRows(): Prisma.InputJsonObject[] {
  const zones = ["10", "2", "1", "Zone 3", "", "alpha"];
  return Array.from({ length: 60 }, (_, k) => {
    const i = k + 1;
    const value: Prisma.InputJsonValue | null = i === 7 ? "abc" : i === 8 ? null : i === 9 ? "1e3" : i === 10 ? "12abc" : i;
    return {
      value,
      name: `Name ${String(i).padStart(2, "0")}`,
      zone: zones[i % 6],
      area: i % 5 === 0 ? "Muharraq" : "Capital",
      note: i === 11 ? "50% off" : i === 12 ? "500 items" : i === 13 ? "a_b" : i === 14 ? "axb" : "n/a",
      geo: { lon: 50.5, lat: 26.1 },
    };
  });
}

describe.skipIf(!RUN)("queries (integration)", () => {
  const cache = new FakeIncrementalCache();
  let q: Queries;
  let prisma: PrismaModule["prisma"];

  const ids = (r: { items: Array<{ id: string }> }) => r.items.map((i) => i.id);
  const qids = (r: { items: Array<{ id: string }> }) => ids(r).filter((id) => id.startsWith("qtest-"));

  async function cleanup() {
    await prisma.dataset.deleteMany({ where: { id: { startsWith: "qtest-" } } });
  }

  const savedState: { row: { lastCatalogCheckAt: Date | null; lastSuccessAt: Date | null; lastDataChangeAt: Date | null } | null } = {
    row: null,
  };
  let createdLogId: number | null = null;

  beforeAll(async () => {
    cache.install();
    q = await import("@/lib/queries");
    ({ prisma } = await import("@/lib/prisma"));
    await cleanup();

    const fixtures: Fixture[] = [
      {
        id: "qtest-births",
        titleClean: "Live Births by Governorate",
        titleAr: "المواليد الأحياء حسب المحافظة",
        description: "Annual registered live births in the Kingdom",
        theme: "QTHealth",
        publisher: "QT Ministry of Health",
        recordsCount: 500,
        sourceModified: ago(DAY / 24), // 1 hour ago: the newest dataset
        viz: "area",
        keywords: ["births", "health"],
      },
      {
        id: "qtest-hospitals",
        titleClean: "Hospital Beds",
        description: "Hospitals with live birth services; births recorded per hospital",
        theme: "QTHealth",
        publisher: "QT Ministry of Health",
        recordsCount: 900,
        sourceModified: ago(10 * DAY),
        viz: "multi-line",
      },
      {
        id: "qtest-health-other",
        titleClean: "Clinics Directory",
        description: "Directory of private clinics",
        theme: "QTHealth",
        publisher: "QT Private Health Board",
        recordsCount: 100,
        sourceModified: ago(20 * DAY),
        viz: "table",
      },
      {
        id: "qtest-pubonly",
        titleClean: "Ministry Staffing",
        description: "Staff numbers",
        theme: "QTOther",
        publisher: "QT Ministry of Health",
        recordsCount: 50,
        sourceModified: ago(30 * DAY),
        viz: "bar-stacked",
      },
      {
        id: "qtest-removed",
        titleClean: "Removed Births Archive",
        description: "Retired dataset about live births",
        theme: "QTHealth",
        publisher: "QT Ministry of Health",
        recordsCount: 10,
        sourceModified: ago(DAY / 48),
        removed: true,
        viz: "area",
      },
      {
        id: "qtest-unsynced",
        titleClean: "Unsynced Pending Dataset",
        description: "Not synced yet",
        theme: "QTOther",
        publisher: "QT Pending Board",
        sourceModified: ago(DAY / 96),
        synced: false,
      },
      {
        id: "qtest-schools",
        titleClean: "School Statistics 2020",
        titleAr: "إحصائيات المدارس",
        description: "بيانات المدرسة والطلاب",
        theme: "QTEducation",
        publisher: "QT Ministry of Education",
        recordsCount: 300,
        sourceModified: ago(200 * DAY),
        viz: "table",
      },
      {
        id: "qtest-underscore",
        titleClean: "Data_with_underscore 50% off",
        description: "Literal punctuation in the title",
        theme: "QTMisc",
        publisher: "QT Misc Authority",
        sourceModified: null,
      },
      {
        id: "qtest-legacy",
        titleClean: "Legacy Fallback Dataset",
        description: "Row whose searchText was never back-filled",
        theme: "QTMisc",
        publisher: "QT Misc Authority",
        sourceModified: ago(5 * DAY),
        legacy: true,
        viz: "area",
      },
      {
        id: "qtest-records",
        titleClean: "Records Playground",
        description: "Dataset with raw records",
        theme: "QTRecords",
        publisher: "QT Records Authority",
        recordsCount: 60,
        sourceCount: 60,
        fieldsJson: RECORD_FIELDS,
        sourceModified: ago(3 * DAY),
        viz: "table",
      },
      // Two publisher strings that differ only by whitespace around a backslash collapse to one slug.
      { id: "qtest-met-a", titleClean: "Met A", theme: "QTMet", publisher: "QT Met Directorate \\ QT Ministry", sourceModified: ago(DAY) },
      { id: "qtest-met-b", titleClean: "Met B", theme: "QTMet", publisher: "QT Met Directorate\\QT Ministry", sourceModified: ago(2 * DAY) },
      // 35 datasets in one theme: a second page of 5.
      ...Array.from({ length: 35 }, (_, i): Fixture => ({
        id: `qtest-bulk-${String(i + 1).padStart(2, "0")}`,
        titleClean: `Bulk Dataset ${String(i + 1).padStart(2, "0")}`,
        theme: "QTBulk",
        publisher: "QT Bulk Authority",
        recordsCount: i + 1,
        sourceModified: ago((40 + i) * DAY),
      })),
    ];
    await prisma.dataset.createMany({ data: fixtures.map(fixtureRow) });

    const rows = await prisma.datasetRecord.createMany({
      data: recordRows().map((data) => ({ datasetId: "qtest-records", data })),
    });
    expect(rows.count).toBe(60);

    savedState.row = await prisma.syncState.findUnique({
      where: { id: 1 },
      select: { lastCatalogCheckAt: true, lastSuccessAt: true, lastDataChangeAt: true },
    });
  });

  afterAll(async () => {
    if (createdLogId !== null) await prisma.syncLog.deleteMany({ where: { id: createdLogId } });
    if (savedState.row) await prisma.syncState.update({ where: { id: 1 }, data: savedState.row });
    await cleanup();
    cache.uninstall();
    await prisma.$disconnect();
  });

  beforeEach(() => {
    cache.clear();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  describe("search", () => {
    it("ranks a title phrase hit above description-only mentions", async () => {
      const r = await q.searchDatasets("live births", 1);
      expect(r.status).toBe("ok");
      const found = qids(r);
      expect(found[0]).toBe("qtest-births");
      expect(found).toContain("qtest-hospitals");
      expect(found.indexOf("qtest-births")).toBeLessThan(found.indexOf("qtest-hospitals"));
    });

    it("matches multiple words in any order (AND over tokens)", async () => {
      const r = await q.searchDatasets("births live", 1);
      expect(qids(r)).toContain("qtest-births");
      expect(qids(r)[0]).toBe("qtest-births");
      // Words spread across title + publisher + theme still match.
      const spread = await q.searchDatasets("governorate health", 1);
      expect(qids(spread)).toContain("qtest-births");
    });

    it("requires every token", async () => {
      const r = await q.searchDatasets("births zzzunmatchable", 1);
      expect(qids(r)).toEqual([]);
      expect(r.total).toBe(0);
    });

    it("finds Arabic titles and folds alef/ya/ta-marbuta and digit variants", async () => {
      for (const query of ["المواليد", "المحافظه", "احصائيات المدارس", "إحصائيات", "المدرسه", "المدرسة"]) {
        const r = await q.searchDatasets(query, 1);
        expect(r.total, query).toBeGreaterThan(0);
      }
      expect(qids(await q.searchDatasets("احصائيات", 1))).toContain("qtest-schools");
      expect(qids(await q.searchDatasets("إحصائيات", 1))).toContain("qtest-schools");
      expect(qids(await q.searchDatasets("٢٠٢٠", 1))).toContain("qtest-schools");
      expect(qids(await q.searchDatasets("2020 المدارس", 1))).toContain("qtest-schools");
    });

    it("is case-insensitive and matches publisher, theme and keywords", async () => {
      expect(qids(await q.searchDatasets("LIVE BIRTHS", 1))).toContain("qtest-births");
      expect(qids(await q.searchDatasets("qtlabourtypo", 1))).toEqual([]);
      expect(qids(await q.searchDatasets("QTEducation", 1))).toContain("qtest-schools"); // theme
      expect(qids(await q.searchDatasets("Private Health Board", 1))).toContain("qtest-health-other"); // publisher
    });

    it("treats % and _ as nothing searchable instead of wildcards", async () => {
      for (const query of ["%", "_", "%%", "_%_", "\\"]) {
        const r = await q.listDatasets({ q: query });
        expect(r.status, query).toBe("query-too-short");
        expect(r.total, query).toBe(0);
        expect(r.items, query).toEqual([]);
      }
      // A real token next to wildcards searches only the token.
      const r = await q.searchDatasets("50% off", 1);
      expect(qids(r)).toContain("qtest-underscore");
    });

    it("rejects one-letter queries and returns an empty result for blank ones", async () => {
      expect((await q.listDatasets({ q: "a" })).status).toBe("query-too-short");
      expect((await q.searchDatasets("", 1)).total).toBe(0);
      expect((await q.searchDatasets("   ", 1)).total).toBe(0);
    });

    it("caps the query: 5 000 characters behave like the first 100", async () => {
      const r = await q.searchDatasets("births ".repeat(1000), 1);
      expect(r.query.length).toBeLessThanOrEqual(100);
      expect(r.status).toBe("ok");
      expect(qids(r)).toContain("qtest-births");
    });

    it("still finds rows whose searchText was never back-filled (raw-column fallback)", async () => {
      const r = await q.searchDatasets("fallback", 1);
      expect(qids(r)).toContain("qtest-legacy");
    });

    it("stops falling back once every live row has searchText, and notices again after revalidation", async () => {
      const empties = await prisma.dataset.findMany({
        where: { searchText: "", removedAt: null },
        select: { id: true, titleClean: true, publisher: true, theme: true, description: true },
      });
      expect(empties.length).toBeGreaterThan(0); // at least qtest-legacy
      try {
        for (const row of empties) {
          await prisma.dataset.update({
            where: { id: row.id },
            data: { searchText: buildSearchText([row.titleClean, row.publisher, row.theme, row.description]) },
          });
        }
        // Fully back-filled: plain searchText match, and the former legacy row is found through it.
        expect(qids(await q.searchDatasets("fallback", 1))).toContain("qtest-legacy");

        // A row that appears later without searchText is invisible while the "nothing pending" answer is cached...
        await prisma.dataset.create({
          data: { ...fixtureRow({ id: "qtest-late", titleClean: "Latecomer Unindexed", legacy: true }), vizConfig: undefined },
        });
        expect((await q.searchDatasets("latecomer", 1)).total).toBe(0);
        // ...and found as soon as the datasets tag is revalidated (what the sync's notify step does).
        cache.revalidateTag("datasets");
        expect(qids(await q.searchDatasets("latecomer", 1))).toEqual(["qtest-late"]);
      } finally {
        await prisma.dataset.deleteMany({ where: { id: "qtest-late" } });
        await prisma.dataset.updateMany({ where: { id: { in: empties.map((r) => r.id) } }, data: { searchText: "" } });
      }
    });

    it("never returns removed datasets", async () => {
      const r = await q.searchDatasets("archive", 1);
      expect(qids(r)).not.toContain("qtest-removed");
      expect(qids(await q.searchDatasets("live births", 1))).not.toContain("qtest-removed");
    });

    it("clamps pages instead of showing a false empty state", async () => {
      const r = await q.listDatasets({ theme: "QTBulk", page: 999 });
      expect(r.total).toBe(35);
      expect(r.totalPages).toBe(2);
      expect(r.page).toBe(2);
      expect(r.items).toHaveLength(5);
      for (const page of [0, -4, Number.NaN, Infinity, 1.7, 1e21]) {
        const p = await q.listDatasets({ theme: "QTBulk", page });
        expect(p.page, String(page)).toBe(1);
        expect(p.items, String(page)).toHaveLength(30);
      }
    });

    it("returns each page's items in a stable order with no overlap", async () => {
      const a = await q.listDatasets({ theme: "QTBulk", sort: "title", page: 1 });
      const b = await q.listDatasets({ theme: "QTBulk", sort: "title", page: 2 });
      const all = [...ids(a), ...ids(b)];
      expect(new Set(all).size).toBe(35);
      expect(all).toEqual([...all].sort());
    });
  });

  // -------------------------------------------------------------------------
  describe("listing: theme, publisher, sorting, filters, facets", () => {
    it("treats unknown themes and publishers as empty with a status, never as a query", async () => {
      const t = await q.listDatasets({ theme: "No Such Theme" });
      expect(t.status).toBe("unknown-theme");
      expect(t.items).toEqual([]);
      const p = await q.listDatasets({ publisher: "no-such-publisher" });
      expect(p.status).toBe("unknown-publisher");
      expect(await q.findTheme("No Such Theme")).toBeNull();
      expect(await q.findPublisher("no-such-publisher")).toBeNull();
      expect(await q.findPublisher("Bad Slug!")).toBeNull();
      expect((await q.getDatasetsByTheme("nope", 1)).items).toEqual([]);
      const legacy = await q.getDatasetsByPublisherSlug("nope", 1);
      expect(legacy.publisherName).toBeNull();
      expect(legacy.items).toEqual([]);
    });

    it("merges whitespace-variant publishers behind one slug", async () => {
      const pubs = await q.getPublisherCounts();
      const met = pubs.filter((p) => p.name.startsWith("QT Met Directorate"));
      expect(met).toHaveLength(1);
      expect(met[0].count).toBe(2);
      expect(met[0].names).toHaveLength(2);
      const r = await q.getDatasetsByPublisherSlug(met[0].slug, 1);
      expect(r.publisherName).toBe(met[0].name);
      expect(ids(r).sort()).toEqual(["qtest-met-a", "qtest-met-b"]);
    });

    it("excludes removed datasets from theme and publisher counts", async () => {
      const health = (await q.getThemeCounts()).find((t) => t.theme === "QTHealth");
      expect(health?.count).toBe(3); // births, hospitals, clinics — not the removed one
      const ministry = (await q.getPublisherCounts()).find((p) => p.name === "QT Ministry of Health");
      expect(ministry?.count).toBe(3); // births, hospitals, staffing
    });

    it("sorts by title, updated, records and relevance", async () => {
      const byTitle = await q.listDatasets({ theme: "QTHealth", sort: "title" });
      expect(ids(byTitle)).toEqual(["qtest-health-other", "qtest-hospitals", "qtest-births"].sort((a, b) => {
        const t = (id: string) => ({ "qtest-health-other": "Clinics Directory", "qtest-hospitals": "Hospital Beds", "qtest-births": "المواليد الأحياء حسب المحافظة" })[id] as string;
        return new Intl.Collator(["ar", "en"], { numeric: true, sensitivity: "base" }).compare(t(a), t(b));
      }));

      const byUpdated = await q.listDatasets({ theme: "QTHealth", sort: "updated" });
      expect(ids(byUpdated)).toEqual(["qtest-births", "qtest-hospitals", "qtest-health-other"]);

      const byRecords = await q.listDatasets({ theme: "QTHealth", sort: "records" });
      expect(ids(byRecords)).toEqual(["qtest-hospitals", "qtest-births", "qtest-health-other"]);

      const relevance = await q.listDatasets({ q: "clinics" });
      expect(relevance.params.sort).toBe("relevance");
      expect(ids(relevance)[0]).toBe("qtest-health-other");
    });

    it("filters to datasets that have a chart", async () => {
      const r = await q.listDatasets({ theme: "QTHealth", hasChart: true });
      expect(ids(r).sort()).toEqual(["qtest-births", "qtest-hospitals"]); // area + multi-line, not the table one
      const edu = await q.listDatasets({ theme: "QTEducation", hasChart: true });
      expect(edu.total).toBe(0); // table-only
      const none = await q.listDatasets({ theme: "QTBulk", hasChart: true });
      expect(none.total).toBe(0); // no vizConfig at all
    });

    it("filters by source-modified window", async () => {
      const recent = await q.listDatasets({ theme: "QTHealth", since: "30d" });
      expect(ids(recent).sort()).toEqual(["qtest-births", "qtest-health-other", "qtest-hospitals"]);
      const edu = await q.listDatasets({ theme: "QTEducation", since: "1y" });
      expect(ids(edu)).toEqual(["qtest-schools"]);
      const old = await q.listDatasets({ theme: "QTBulk", since: "30d" });
      expect(old.total).toBe(0); // all modified 40+ days ago
      const api = await q.listDatasets({ theme: "QTHealth" }, { updatedSince: ago(5 * DAY) });
      expect(ids(api)).toEqual(["qtest-births"]);
      // Undated datasets drop out as soon as a window is applied.
      const undated = await q.listDatasets({ q: "underscore", since: "1y" });
      expect(qids(undated)).toEqual([]);
      expect(qids(await q.listDatasets({ q: "underscore" }))).toEqual(["qtest-underscore"]);
    });

    it("supports a custom page size and caps it at 100", async () => {
      const r = await q.listDatasets({ theme: "QTBulk" }, { pageSize: 10 });
      expect(r.items).toHaveLength(10);
      expect(r.pageSize).toBe(10);
      expect(r.totalPages).toBe(4);
      const big = await q.listDatasets({ theme: "QTBulk" }, { pageSize: 100_000 });
      expect(big.pageSize).toBe(100);
    });

    it("computes facets over the other filters", async () => {
      const r = await q.listDatasets({ q: "births" });
      const health = r.facets.themes.find((t) => t.theme === "QTHealth");
      expect(health?.count).toBe(2); // births + hospitals (the removed one is excluded)
      // Selecting a theme must not collapse the theme facet to that one theme...
      const withTheme = await q.listDatasets({ q: "ministry", theme: "QTHealth" });
      expect(withTheme.facets.themes.map((t) => t.theme)).toContain("QTOther");
      // ...but it does narrow the publisher facet.
      expect(withTheme.facets.publishers.every((p) => p.name !== "QT Misc Authority")).toBe(true);
      expect(withTheme.facets.publishers.find((p) => p.name === "QT Ministry of Health")?.count).toBe(2);
      expect(withTheme.theme?.theme).toBe("QTHealth");
    });

    it("builds full cards: source date, Arabic title, chart data", async () => {
      const r = await q.listDatasets({ theme: "QTHealth", sort: "updated" });
      const card = r.items[0];
      expect(card.id).toBe("qtest-births");
      expect(card.titleAr).toBe("المواليد الأحياء حسب المحافظة");
      expect(card.sourceModified).toBeInstanceOf(Date);
      expect(card.lastSyncedAt).toBeInstanceOf(Date);
      expect(card.vizConfig).toEqual({ type: "area" });
    });
  });

  // -------------------------------------------------------------------------
  describe("home rail, updates and related", () => {
    it("orders the latest rail by the source's modified date and skips removed/unsynced rows", async () => {
      const latest = await q.getLatestDatasets();
      expect(latest.length).toBeLessThanOrEqual(9);
      expect(latest[0].id).toBe("qtest-births");
      const idsLatest = latest.map((d) => d.id);
      expect(idsLatest).not.toContain("qtest-removed"); // newer than births but removed
      expect(idsLatest).not.toContain("qtest-unsynced"); // newer but never synced
      const dates = latest.map((d) => d.sourceModified?.getTime() ?? -Infinity);
      expect(dates).toEqual([...dates].sort((a, b) => b - a));
    });

    it("getRecentlyUpdated paginates, clamps and honours the window", async () => {
      const day = await q.getRecentlyUpdated({ sinceDays: 1 });
      expect(day.sinceDays).toBe(1);
      expect(ids(day)).toEqual(["qtest-births"]);

      const month = await q.getRecentlyUpdated({ sinceDays: 30, pageSize: 3 });
      expect(month.items.length).toBeLessThanOrEqual(3);
      expect(month.total).toBeGreaterThanOrEqual(6);
      expect(month.items[0].sourceModified).toBeInstanceOf(Date);
      const times = month.items.map((d) => d.sourceModified?.getTime() ?? -Infinity);
      expect(times).toEqual([...times].sort((a, b) => b - a));

      const beyond = await q.getRecentlyUpdated({ page: 99_999, pageSize: 3 });
      expect(beyond.page).toBe(beyond.totalPages);
      expect(beyond.items.length).toBeGreaterThan(0);

      for (const bad of [0, -3, 1.5, Number.NaN, 4000, Infinity]) {
        expect((await q.getRecentlyUpdated({ sinceDays: bad })).sinceDays, String(bad)).toBeNull();
      }
      const all = await q.getRecentlyUpdated({ pageSize: 100 });
      expect(all.items.map((d) => d.id)).not.toContain("qtest-underscore"); // undated
      expect(all.items.map((d) => d.id)).not.toContain("qtest-removed");
      expect(all.items.map((d) => d.id)).not.toContain("qtest-unsynced");
    });

    it("getRelatedDatasets prefers same theme+publisher, then theme, then publisher; never self/removed", async () => {
      const related = await q.getRelatedDatasets("qtest-births", "QTHealth", "QT Ministry of Health");
      expect(related.map((d) => d.id)).toEqual(["qtest-hospitals", "qtest-health-other", "qtest-pubonly"]);
      expect(related.map((d) => d.id)).not.toContain("qtest-births");
      expect(related.map((d) => d.id)).not.toContain("qtest-removed");

      const limited = await q.getRelatedDatasets("qtest-bulk-01", "QTBulk", "QT Bulk Authority", 4);
      expect(limited).toHaveLength(4);
      expect(await q.getRelatedDatasets("qtest-births", null, null)).toEqual([]);
      expect(await q.getRelatedDatasets("bad\u0000id", "QTHealth", null)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("detail, cards and stats", () => {
    it("getDatasetById returns removed datasets with removedAt and omits syncError", async () => {
      const removed = await q.getDatasetById("qtest-removed");
      expect(removed?.removedAt).toBeInstanceOf(Date);
      const live = await q.getDatasetById("qtest-births");
      expect(live?.removedAt).toBeNull();
      expect(live?.titleAr).toBe("المواليد الأحياء حسب المحافظة");
      expect(live?.keywords).toEqual(["births", "health"]);
      expect(live).not.toHaveProperty("syncError");
      expect(live).toHaveProperty("derivedVersion");
      expect(live).toHaveProperty("lastCheckedAt");
      expect(live).toHaveProperty("license");
      expect(live?.sourceModified).toBeInstanceOf(Date);
    });

    it("revives Dates on a cache hit", async () => {
      const first = await q.getDatasetById("qtest-births");
      const hitsBefore = cache.hits;
      const second = await q.getDatasetById("qtest-births");
      expect(cache.hits).toBeGreaterThan(hitsBefore);
      expect(second?.sourceModified).toBeInstanceOf(Date);
      expect(second?.lastSyncedAt).toBeInstanceOf(Date);
      expect(second?.sourceModified?.getTime()).toBe(first?.sourceModified?.getTime());
      const card = await q.getFeaturedDataset("qtest-births");
      expect((await q.getFeaturedDataset("qtest-births"))?.sourceModified).toBeInstanceOf(Date);
      expect(card?.id).toBe("qtest-births");
    });

    it("returns null for unknown or malformed ids without storing anything", async () => {
      const before = cache.sets;
      for (const id of ["nope", "", "x".repeat(500), "a\u0000b", "a\nb"]) {
        expect(await q.getDatasetById(id), id).toBeNull();
        expect(await q.getDatasetCard(id), id).toBeNull();
        expect(await q.getRecordsMeta(id), id).toBeNull();
      }
      expect(cache.sets).toBe(before);
    });

    it("getPortalStats exposes freshness fields and sums sourceCount without COUNT(*) on records", async () => {
      const checked = ago(3600_000);
      const success = ago(3000_000);
      const changed = ago(2000_000);
      await prisma.syncState.update({
        where: { id: 1 },
        data: { lastCatalogCheckAt: checked, lastSuccessAt: success, lastDataChangeAt: changed },
      });
      const log = await prisma.syncLog.create({
        data: { trigger: "test", status: "success", startedAt: ago(10), finishedAt: ago(5) },
      });
      createdLogId = log.id;

      const stats = await q.getPortalStats();
      expect(stats.lastCheckedAt?.getTime()).toBe(checked.getTime());
      expect(stats.lastSuccessAt?.getTime()).toBe(success.getTime());
      expect(stats.lastDataChangeAt?.getTime()).toBe(changed.getTime());
      expect(stats.latestRun?.status).toBe("success");
      expect(stats.latestRun?.startedAt).toBeInstanceOf(Date);
      expect(stats.lastSync?.startedAt).toBeInstanceOf(Date);

      const live = await prisma.dataset.aggregate({ where: { removedAt: null }, _sum: { sourceCount: true }, _max: { sourceModified: true } });
      expect(stats.totalRecords).toBe(live._sum.sourceCount ?? 0);
      expect(stats.latestSourceModified?.getTime()).toBe(live._max.sourceModified?.getTime());
      expect(stats.totalDatasets).toBe(await prisma.dataset.count({ where: { removedAt: null } }));
      expect(stats.syncedDatasetCount).toBe(await prisma.dataset.count({ where: { removedAt: null, lastSyncedAt: { not: null } } }));
      expect(stats.publisherCount).toBeGreaterThan(0);

      // Second call is a cache hit and still yields Dates.
      const again = await q.getPortalStats();
      expect(again.lastCheckedAt).toBeInstanceOf(Date);
      expect(again.latestRun?.finishedAt).toBeInstanceOf(Date);
    });
  });

  // -------------------------------------------------------------------------
  describe("records", () => {
    const RID = "qtest-records";

    it("pages in id order from the stored row count and clamps the page", async () => {
      const p1 = await q.getDatasetRecordsPage({ datasetId: RID, page: 1 });
      expect(p1.total).toBe(60);
      expect(p1.totalPages).toBe(3);
      expect(p1.rows).toHaveLength(25);
      expect(p1.sortField).toBeNull();
      expect(p1.rq).toBeNull();
      expect(p1.sortFailed).toBe(false);
      const names = p1.rows.map((r) => r.data.name);
      expect(names[0]).toBe("Name 01");
      expect(names[24]).toBe("Name 25");

      const last = await q.getDatasetRecordsPage({ datasetId: RID, page: 999 });
      expect(last.page).toBe(3);
      expect(last.rows).toHaveLength(10);
      expect(last.rows[0].data.name).toBe("Name 51");

      for (const page of [0, -1, Number.NaN, Infinity, 1e21, 2.9]) {
        const p = await q.getDatasetRecordsPage({ datasetId: RID, page });
        expect(p.rows.length, String(page)).toBeGreaterThan(0);
        expect(p.page, String(page)).toBe(page === 2.9 ? 2 : 1);
      }
    });

    it("trusts a caller-provided total and ignores nonsense totals", async () => {
      const small = await q.getDatasetRecordsPage({ datasetId: RID, page: 5, total: 30 });
      expect(small.total).toBe(30);
      expect(small.page).toBe(2);
      const bad = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, total: -4 });
      expect(bad.total).toBe(60);
      const nan = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, total: Number.NaN });
      expect(nan.total).toBe(60);
    });

    it("returns an empty page for an unknown dataset", async () => {
      const p = await q.getDatasetRecordsPage({ datasetId: "qtest-does-not-exist", page: 1 });
      expect(p.rows).toEqual([]);
      expect(p.total).toBe(0);
      expect(p.totalPages).toBe(1);
    });

    it("sorts a numeric column numerically with dirty values last and never throws", async () => {
      const desc = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, sort: "value", dir: "desc" });
      expect(desc.sortField).toBe("value");
      expect(desc.sortDir).toBe("desc");
      expect(desc.sortFailed).toBe(false);
      const values = desc.rows.map((r) => r.data.value);
      expect(values[0]).toBe("1e3"); // numeric text counts as a number (1000)
      expect(values[1]).toBe(60);
      expect(values[2]).toBe(59);

      const lastDesc = await q.getDatasetRecordsPage({ datasetId: RID, page: 3, sort: "value", dir: "desc" });
      const tail = lastDesc.rows.map((r) => r.data.value);
      // "abc", null and "12abc" cannot be numbers: they sort last in id order, in BOTH directions.
      expect(tail.slice(-3)).toEqual(["abc", null, "12abc"]);

      const asc = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, sort: "value", dir: "asc" });
      expect(asc.rows.map((r) => r.data.value).slice(0, 3)).toEqual([1, 2, 3]);
      const lastAsc = await q.getDatasetRecordsPage({ datasetId: RID, page: 3, sort: "value", dir: "asc" });
      expect(lastAsc.rows.map((r) => r.data.value).slice(-3)).toEqual(["abc", null, "12abc"]);
    });

    it("sorts text columns: empties last, numeric-looking values as numbers, then collated text", async () => {
      const asc = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, sort: "zone", dir: "asc" });
      const zones = asc.rows.map((r) => r.data.zone);
      // 10 rows each of "1", "2", "10" (numeric order), then "alpha" before "Zone 3" (case-insensitive), then "".
      expect(zones.slice(0, 10).every((z) => z === "1")).toBe(true);
      expect(zones.slice(10, 20).every((z) => z === "2")).toBe(true);
      expect(zones.slice(20, 25).every((z) => z === "10")).toBe(true);
      const page3 = await q.getDatasetRecordsPage({ datasetId: RID, page: 3, sort: "zone", dir: "asc" });
      const tail = page3.rows.map((r) => r.data.zone);
      expect(tail.slice(-1)).toEqual([""]);

      const desc = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, sort: "zone", dir: "desc" });
      // Reversed groups: "Zone 3" (text) first, empties still last overall.
      expect(desc.rows[0].data.zone).toBe("Zone 3");
      const descLast = await q.getDatasetRecordsPage({ datasetId: RID, page: 3, sort: "zone", dir: "desc" });
      expect(descLast.rows.at(-1)?.data.zone).toBe("");
    });

    it("breaks sort ties by id so pages never overlap", async () => {
      const seen = new Set<string>();
      for (const page of [1, 2, 3]) {
        const p = await q.getDatasetRecordsPage({ datasetId: RID, page, sort: "area", dir: "asc" });
        for (const r of p.rows) seen.add(r.id);
      }
      expect(seen.size).toBe(60);
    });

    it("ignores unknown, object-valued and oversized sort columns", async () => {
      for (const sort of ["nope", "geo", "value; DROP TABLE x", "y".repeat(300), "", "  ", "Value"]) {
        const p = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, sort });
        expect(p.sortField, sort).toBeNull();
        expect(p.rows[0].data.name, sort).toBe("Name 01");
      }
    });

    it("keeps the positional (legacy) call shape working", async () => {
      const p = await q.getDatasetRecordsPage(RID, 2, "value", "desc", []);
      expect(p.page).toBe(2);
      expect(p.sortField).toBe("value");
      expect(p.rows).toHaveLength(25);
    });

    it("searches cell values only, counts matches and clamps the page", async () => {
      const r = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, rq: "Muharraq" });
      expect(r.rq).toBe("Muharraq");
      expect(r.total).toBe(12);
      expect(r.totalPages).toBe(1);
      expect(r.rows).toHaveLength(12);
      expect(r.rows.every((row) => row.data.area === "Muharraq")).toBe(true);
      expect(r.rows.map((x) => Number(x.id))).toEqual([...r.rows.map((x) => Number(x.id))].sort((a, b) => a - b));

      // Case-insensitive.
      expect((await q.getDatasetRecordsPage({ datasetId: RID, page: 1, rq: "muharraq" })).total).toBe(12);
      // Key names are not searchable: no cell VALUE contains "area" or "year".
      expect((await q.getDatasetRecordsPage({ datasetId: RID, page: 1, rq: "area" })).total).toBe(0);
      expect((await q.getDatasetRecordsPage({ datasetId: RID, page: 1, rq: "year" })).total).toBe(0);

      const beyond = await q.getDatasetRecordsPage({ datasetId: RID, page: 50, rq: "Muharraq" });
      expect(beyond.page).toBe(1);
      expect(beyond.rows).toHaveLength(12);
    });

    it("escapes LIKE wildcards in the in-table search", async () => {
      const pct = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, rq: "50%" });
      expect(pct.rows.map((r) => r.data.note)).toEqual(["50% off"]); // not "500 items"
      const us = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, rq: "a_b" });
      expect(us.rows.map((r) => r.data.note)).toEqual(["a_b"]); // not "axb"
      const bare = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, rq: "%" });
      expect(bare.rows.map((r) => r.data.note)).toEqual(["50% off"]); // a literal percent sign, not "everything"
      const underscore = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, rq: "_" });
      expect(underscore.rows.map((r) => r.data.note)).toEqual(["a_b"]);
      const slash = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, rq: "\\" });
      expect(slash.total).toBe(0);
    });

    it("sanitizes and caps rq, and treats blank rq as no search", async () => {
      expect((await q.getDatasetRecordsPage({ datasetId: RID, page: 1, rq: "   " })).rq).toBeNull();
      const long = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, rq: "x".repeat(5000) });
      expect(long.total).toBe(0);
      expect((long.rq ?? "").length).toBeLessThanOrEqual(60);
      const nul = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, rq: "Muharraq\u0000" });
      expect(nul.searchFailed).toBe(false);
      expect(nul.total).toBe(12);
    });

    it("combines search with sorting", async () => {
      const r = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, rq: "Muharraq", sort: "value", dir: "desc" });
      expect(r.sortField).toBe("value");
      expect(r.total).toBe(12);
      const values = r.rows.map((x) => x.data.value);
      expect(values[0]).toBe(60);
      expect(values.at(-1)).toBe("12abc"); // the dirty one among the Muharraq rows is last
    });

    it("falls back to id order (and does not cache the fallback) when the sorted query fails", async () => {
      vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("canceling statement due to statement timeout"));
      const failing = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, sort: "value", dir: "desc" });
      expect(failing.sortFailed).toBe(true);
      expect(failing.sortField).toBeNull();
      expect(failing.rows[0].data.name).toBe("Name 01");
      const keysBefore = cache.entries().filter((e) => e.tags.includes("dataset:qtest-records") && e.revalidate !== false).length;

      const recovered = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, sort: "value", dir: "desc" });
      expect(recovered.sortFailed).toBe(false);
      expect(recovered.sortField).toBe("value");
      expect(recovered.rows[0].data.value).toBe("1e3");
      expect(keysBefore).toBeGreaterThan(0); // the meta entry; the failed page was not among them
    });

    it("refuses a fifth concurrent sorted query instead of queueing it", async () => {
      const waiting: Array<(value: unknown) => void> = [];
      vi.spyOn(prisma, "$transaction").mockImplementation((() => new Promise((resolve) => waiting.push(resolve))) as never);
      // Pages 2..5 are never cached, so each goes to the database; four of them occupy every slot.
      const occupying = [2, 3, 4, 5].map((page) => q.getDatasetRecordsPage({ datasetId: RID, page, sort: "value" }));
      for (let i = 0; i < 100 && waiting.length < 4; i++) await new Promise((r) => setTimeout(r, 10));
      expect(waiting).toHaveLength(4);

      const refused = await q.getDatasetRecordsPage({ datasetId: RID, page: 2, sort: "value" });
      expect(refused.sortFailed).toBe(true);
      expect(refused.sortField).toBeNull();
      expect(refused.rows).toHaveLength(25);
      expect(refused.rows[0].data.name).toBe("Name 26"); // default (id) order, page 2

      for (const resolve of waiting) resolve([]);
      await Promise.all(occupying);
      vi.restoreAllMocks();
      const after = await q.getDatasetRecordsPage({ datasetId: RID, page: 2, sort: "value" });
      expect(after.sortFailed).toBe(false); // slots were released
    });

    it("reports a search failure instead of throwing", async () => {
      vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("canceling statement due to statement timeout"));
      const r = await q.getDatasetRecordsPage({ datasetId: RID, page: 1, rq: "Muharraq" });
      expect(r.searchFailed).toBe(true);
      expect(r.rows).toEqual([]);
      expect(r.total).toBe(0);
    });

    it("pages by keyset for the API", async () => {
      const collected: string[] = [];
      let after: string | null = null;
      let guard = 0;
      do {
        const page: Awaited<ReturnType<Queries["getDatasetRecordsAfter"]>> = await q.getDatasetRecordsAfter({ datasetId: RID, after, limit: 25 });
        expect(page).not.toBeNull();
        collected.push(...(page?.rows.map((r) => r.id) ?? []));
        after = page?.nextAfter ?? null;
        guard += 1;
      } while (after !== null && guard < 10);
      expect(collected).toHaveLength(60);
      expect(new Set(collected).size).toBe(60);
      expect(guard).toBe(3);
      expect(await q.getDatasetRecordsAfter({ datasetId: "qtest-does-not-exist" })).toBeNull();
      const garbage = await q.getDatasetRecordsAfter({ datasetId: RID, after: "1; DROP TABLE x", limit: 5 });
      expect(garbage?.rows).toHaveLength(5);
      const clamped = await q.getDatasetRecordsAfter({ datasetId: RID, limit: 1_000_000 });
      expect(clamped?.rows).toHaveLength(60);
      expect(clamped?.nextAfter).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("cache policy", () => {
    it("gives every stored entry an explicit TTL and the right tags", async () => {
      await q.getPortalStats();
      await q.getThemeCounts();
      await q.getPublisherCounts();
      await q.getDatasetById("qtest-births");
      await q.getDatasetCard("qtest-births");
      await q.getDatasetRecordsPage({ datasetId: "qtest-records", page: 1, sort: "value", dir: "asc" });
      await q.getSitemapDatasets();

      const entries = cache.entries();
      expect(entries.length).toBeGreaterThanOrEqual(8);
      for (const e of entries) {
        expect(typeof e.revalidate, e.key).toBe("number"); // never the one-year default
        expect(e.revalidate as number).toBeGreaterThan(0);
        expect(e.revalidate as number).toBeLessThanOrEqual(q.CACHE.detailTtl);
      }

      const aggregate = entries.filter((e) => e.tags.includes("datasets"));
      expect(aggregate.length).toBeGreaterThanOrEqual(4); // stats, themes, publishers, sitemap
      for (const e of aggregate) {
        expect(e.tags).toEqual(["datasets"]);
        expect(e.revalidate).toBe(q.CACHE.ttl);
      }

      const perDataset = entries.filter((e) => e.tags.some((t) => t.startsWith("dataset:")));
      expect(perDataset.length).toBeGreaterThanOrEqual(4); // detail, card, meta, records page
      for (const e of perDataset) {
        expect(e.tags).toHaveLength(1);
        expect(e.tags[0]).toMatch(/^dataset:qtest-records$|^dataset:qtest-births$/);
        expect(e.tags).not.toContain("datasets");
      }
      const detail = perDataset.find((e) => e.tags[0] === "dataset:qtest-births" && e.revalidate === q.CACHE.detailTtl);
      expect(detail).toBeDefined();
    });

    it("refreshes a dataset when its tag is revalidated, and only that dataset", async () => {
      await q.getDatasetById("qtest-births");
      await q.getDatasetById("qtest-hospitals");
      await prisma.dataset.update({ where: { id: "qtest-births" }, data: { titleClean: "Live Births (renamed)" } });
      await prisma.dataset.update({ where: { id: "qtest-hospitals" }, data: { titleClean: "Hospital Beds (renamed)" } });
      try {
        // Still cached: stale until invalidated.
        expect((await q.getDatasetById("qtest-births"))?.titleClean).toBe("Live Births by Governorate");
        cache.revalidateTag(q.CACHE.datasetTag("qtest-births"));
        expect((await q.getDatasetById("qtest-births"))?.titleClean).toBe("Live Births (renamed)");
        // The other dataset's entry was not flushed.
        expect((await q.getDatasetById("qtest-hospitals"))?.titleClean).toBe("Hospital Beds");
        // The "datasets" tag does not touch per-dataset entries either.
        cache.revalidateTag("datasets");
        expect((await q.getDatasetById("qtest-hospitals"))?.titleClean).toBe("Hospital Beds");
      } finally {
        await prisma.dataset.update({ where: { id: "qtest-births" }, data: { titleClean: "Live Births by Governorate" } });
        await prisma.dataset.update({ where: { id: "qtest-hospitals" }, data: { titleClean: "Hospital Beds" } });
      }
    });

    it("self-heals after the TTL even if nobody revalidates", async () => {
      await q.getDatasetById("qtest-births");
      await prisma.dataset.update({ where: { id: "qtest-births" }, data: { titleClean: "Live Births (ttl)" } });
      try {
        expect((await q.getDatasetById("qtest-births"))?.titleClean).toBe("Live Births by Governorate");
        cache.advance((q.CACHE.detailTtl + 1) * 1000);
        expect((await q.getDatasetById("qtest-births"))?.titleClean).toBe("Live Births (ttl)");
      } finally {
        await prisma.dataset.update({ where: { id: "qtest-births" }, data: { titleClean: "Live Births by Governorate" } });
      }
    });

    it("aggregate entries refresh with the 'datasets' tag", async () => {
      const before = (await q.getThemeCounts()).find((t) => t.theme === "QTMisc")?.count;
      expect(before).toBe(2);
      await prisma.dataset.update({ where: { id: "qtest-legacy" }, data: { removedAt: new Date() } });
      try {
        expect((await q.getThemeCounts()).find((t) => t.theme === "QTMisc")?.count).toBe(2); // cached
        cache.revalidateTag("datasets");
        expect((await q.getThemeCounts()).find((t) => t.theme === "QTMisc")?.count).toBe(1);
      } finally {
        await prisma.dataset.update({ where: { id: "qtest-legacy" }, data: { removedAt: null } });
      }
    });

    it("never stores an entry for hostile input (200 bogus values per surface)", async () => {
      // Warm the legitimate entries first so the baseline is stable.
      await q.listDatasets({ q: "births" });
      await q.getDatasetRecordsPage({ datasetId: "qtest-records", page: 1 });
      const baseline = cache.sets;
      const entriesBefore = cache.size;

      const hostile = (i: number) => `bogus-${i}-${"é\u0000/<>?".repeat(3)}`;
      for (let i = 0; i < 200; i++) {
        const v = hostile(i);
        await q.listDatasets({ theme: v });
        await q.listDatasets({ publisher: v });
        await q.listDatasets({ q: `${v} births` });
        await q.searchDatasets(v, i);
        await q.getDatasetsByTheme(v, i * 1e9);
        await q.getDatasetsByPublisherSlug(v, Infinity);
        await q.getDatasetById(v);
        await q.getDatasetCard(v);
        await q.getRecordsMeta(v);
        await q.getDatasetRecordsPage({ datasetId: v, page: i });
        // Valid dataset, hostile page/sort/dir/rq: only the single legitimate first-page entry may exist.
        await q.getDatasetRecordsPage({ datasetId: "qtest-records", page: 1e15 + i, sort: v, dir: i % 2 ? "asc" : "desc", rq: v });
        await q.getDatasetRecordsPage({ datasetId: "qtest-records", page: i + 2, sort: v });
        await q.getDatasetRecordsPage({ datasetId: "qtest-records", page: 1, sort: v });
        await q.getRelatedDatasets(v, v, v);
      }
      expect(cache.sets).toBe(baseline);
      expect(cache.size).toBe(entriesBefore);
    });

    it("bounds first-page records entries by (valid sort column x direction)", async () => {
      const before = cache.size;
      for (const sort of ["value", "name", "zone", "area", "note", "value"]) {
        for (const dir of ["asc", "desc"] as const) {
          await q.getDatasetRecordsPage({ datasetId: "qtest-records", page: 1, sort, dir });
        }
      }
      const created = cache.size - before;
      // 5 sortable columns x 2 directions + the shared meta entry; repeats add nothing.
      expect(created).toBe(11);
      // Deeper pages and searches never add entries.
      const mark = cache.size;
      for (let page = 2; page <= 3; page++) await q.getDatasetRecordsPage({ datasetId: "qtest-records", page, sort: "value" });
      await q.getDatasetRecordsPage({ datasetId: "qtest-records", page: 1, rq: "Muharraq" });
      expect(cache.size).toBe(mark);
    });
  });

  // -------------------------------------------------------------------------
  describe("sitemap", () => {
    it("lists live datasets with the source modified date, /updates, and no noise fields", async () => {
      const sitemap = (await import("@/app/sitemap")).default;
      const entries = await sitemap();
      const urls = entries.map((e) => e.url);
      expect(urls.some((u) => u.endsWith("/updates"))).toBe(true);
      expect(urls.some((u) => u.endsWith("/dataset/qtest-births"))).toBe(true);
      expect(urls.some((u) => u.endsWith("/dataset/qtest-removed"))).toBe(false);
      for (const e of entries) {
        expect(e).not.toHaveProperty("changeFrequency");
        expect(e).not.toHaveProperty("priority");
      }
      const births = entries.find((e) => e.url.endsWith("/dataset/qtest-births"));
      const row = await prisma.dataset.findUnique({ where: { id: "qtest-births" }, select: { sourceModified: true } });
      expect(new Date(births?.lastModified as Date).getTime()).toBe(row?.sourceModified?.getTime());
      // The undated dataset falls back to its sync time.
      const undated = entries.find((e) => e.url.endsWith("/dataset/qtest-underscore"));
      expect(undated?.lastModified).toBeDefined();

      // Second request is served from the cache: no new stored entries.
      const sets = cache.sets;
      await sitemap();
      expect(cache.sets).toBe(sets);
    });
  });
});
