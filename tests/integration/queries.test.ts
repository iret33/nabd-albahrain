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

  // -------------------------------------------------------------------------
  // Stage-3 fixes (findings r1-07, r1-14, R2-02, R2-03, R2-05, R2-06, R2-07, R2-11, R2-13)
  describe("stage-3 data fixes", () => {
    const F2 = "qtest-f2-";
    const cleanupF2 = () => prisma.dataset.deleteMany({ where: { id: { startsWith: F2 } } });
    beforeEach(async () => {
      await cleanupF2();
    });
    afterAll(async () => {
      await cleanupF2();
    });

    const rows = (count: number, tag = "a") => Array.from({ length: count }, (_, i) => ({ n: i + 1, v: `${tag}${i + 1}` }));
    async function seedRecords(id: string, count: number, extra: Partial<Fixture> = {}) {
      await prisma.dataset.create({
        data: fixtureRow({
          id,
          titleClean: id,
          theme: "QTF2",
          recordsCount: count,
          sourceCount: count,
          fieldsJson: [
            { name: "n", label: "N", type: "int" },
            { name: "v", label: "V", type: "text" },
          ],
          ...extra,
        }),
      });
      await prisma.datasetRecord.createMany({ data: rows(count).map((data) => ({ datasetId: id, data })) });
    }
    /** What the sync engine does to a changed dataset: all rows deleted, all rows inserted (new BIGSERIAL ids), one transaction. */
    async function replaceRecords(id: string, count: number) {
      await prisma.$transaction(async (tx) => {
        await tx.datasetRecord.deleteMany({ where: { datasetId: id } });
        await tx.datasetRecord.createMany({ data: rows(count, "b").map((data) => ({ datasetId: id, data })) });
      });
      cache.clear();
    }

    describe("keyset cursor generation (r1-14, R2-02)", () => {
      it("continues a cursor within one generation, and treats after=0 / garbage as 'from the start'", async () => {
        await seedRecords(`${F2}gen`, 10);
        const first = await q.getDatasetRecordsAfter({ datasetId: `${F2}gen`, limit: 4 });
        expect(first?.rows).toHaveLength(4);
        const second = await q.getDatasetRecordsAfter({ datasetId: `${F2}gen`, after: first?.nextAfter, limit: 4 });
        expect(second?.rows.map((r) => r.data.n)).toEqual([5, 6, 7, 8]);
        expect((await q.getDatasetRecordsAfter({ datasetId: `${F2}gen`, after: "0", limit: 2 }))?.rows).toHaveLength(2);
        expect((await q.getDatasetRecordsAfter({ datasetId: `${F2}gen`, after: "000", limit: 2 }))?.rows[0].data.n).toBe(1);
        expect((await q.getDatasetRecordsAfter({ datasetId: `${F2}gen`, after: "1; DROP TABLE x", limit: 2 }))?.rows[0].data.n).toBe(1);
      });

      it("rejects a cursor from before a sync replaced the rows, instead of re-reading the new copy from row 1", async () => {
        const { StaleCursorError } = await import("@/lib/records-query");
        await seedRecords(`${F2}gen`, 10);
        const first = await q.getDatasetRecordsAfter({ datasetId: `${F2}gen`, limit: 4 });
        const cursor = first?.nextAfter as string;
        await replaceRecords(`${F2}gen`, 12);
        // Before the fix this returned the whole NEW copy from its first row (ids above the old cursor).
        await expect(q.getDatasetRecordsAfter({ datasetId: `${F2}gen`, after: cursor, limit: 4 })).rejects.toBeInstanceOf(StaleCursorError);
        // Restarting works, and its cursors work.
        const again = await q.getDatasetRecordsAfter({ datasetId: `${F2}gen`, limit: 4 });
        expect(again?.rows.map((r) => r.data.v)).toEqual(["b1", "b2", "b3", "b4"]);
        await expect(q.getDatasetRecordsAfter({ datasetId: `${F2}gen`, after: again?.nextAfter, limit: 4 })).resolves.toBeTruthy();
      });

      it("a cursor at the very end of the data is valid (an empty page), and stale after a replace", async () => {
        const { StaleCursorError } = await import("@/lib/records-query");
        await seedRecords(`${F2}end`, 3);
        const all = await q.getDatasetRecordsAfter({ datasetId: `${F2}end`, limit: 100 });
        const last = all?.rows.at(-1)?.id as string;
        const empty = await q.getDatasetRecordsAfter({ datasetId: `${F2}end`, after: last, limit: 5 });
        expect(empty).toEqual({ rows: [], nextAfter: null });
        await replaceRecords(`${F2}end`, 3);
        await expect(q.getDatasetRecordsAfter({ datasetId: `${F2}end`, after: last })).rejects.toBeInstanceOf(StaleCursorError);
      });

      it("a record id of ANOTHER dataset is not a cursor here", async () => {
        const { StaleCursorError } = await import("@/lib/records-query");
        await seedRecords(`${F2}mine`, 5);
        const other = await q.getDatasetRecordsAfter({ datasetId: "qtest-records", limit: 1 });
        await expect(
          q.getDatasetRecordsAfter({ datasetId: `${F2}mine`, after: other?.rows[0].id as string }),
        ).rejects.toBeInstanceOf(StaleCursorError);
      });

      it("pages through a replaced dataset without ever mixing generations (the 70,000-read / 60,000-distinct repro, small)", async () => {
        const { StaleCursorError } = await import("@/lib/records-query");
        await seedRecords(`${F2}walk`, 30);
        const seen: string[] = [];
        let after: string | null = null;
        let replaced = false;
        let stale = false;
        for (let guard = 0; guard < 20; guard++) {
          try {
            const page: Awaited<ReturnType<Queries["getDatasetRecordsAfter"]>> = await q.getDatasetRecordsAfter({ datasetId: `${F2}walk`, after, limit: 5 });
            seen.push(...(page?.rows.map((r) => String(r.data.v)) ?? []));
            after = page?.nextAfter ?? null;
            if (!replaced && seen.length >= 10) {
              await replaceRecords(`${F2}walk`, 30);
              replaced = true;
            }
            if (after === null) break;
          } catch (err) {
            expect(err).toBeInstanceOf(StaleCursorError);
            stale = true;
            break;
          }
        }
        expect(stale).toBe(true);
        expect(seen.every((v) => v.startsWith("a"))).toBe(true); // nothing of the new generation was mixed in
        expect(new Set(seen).size).toBe(seen.length); // and nothing twice
      });
    });

    describe("the records route (JSON 409, CSV, slots)", () => {
      type RouteModule = typeof import("@/app/api/v1/datasets/[id]/records/route");
      let route: RouteModule;
      let limits: typeof import("@/lib/api-limits");
      const call = (id: string, query = "", ip: string | null = null) =>
        route.GET(
          new Request(`http://x.test/api/v1/datasets/${id}/records${query}`, { headers: ip ? { "cf-connecting-ip": ip } : {} }),
          { params: Promise.resolve({ id }) },
        );
      const bodyText = async (res: Response) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
      let ipCounter = 0;
      const freshIp = () => `198.51.100.${(ipCounter = (ipCounter % 250) + 1)}`;
      const savedProxy = process.env.TRUST_PROXY;

      beforeEach(async () => {
        route = await import("@/app/api/v1/datasets/[id]/records/route");
        limits = await import("@/lib/api-limits");
        process.env.TRUST_PROXY = "1";
        vi.spyOn(console, "error").mockImplementation(() => undefined);
      });
      afterAll(() => {
        if (savedProxy === undefined) delete process.env.TRUST_PROXY;
        else process.env.TRUST_PROXY = savedProxy;
      });

      it("JSON: a stale cursor is 409 cursor_expired with a restart URL, not cacheable", async () => {
        await seedRecords(`${F2}j`, 12);
        const ip = freshIp();
        const page = (await (await call(`${F2}j`, "?limit=5", ip)).json()) as { nextAfter: string; next: string };
        expect(page.next).toContain(`after=${page.nextAfter}`);
        await replaceRecords(`${F2}j`, 12);
        const res = await call(`${F2}j`, `?after=${page.nextAfter}&limit=5`, ip);
        expect(res.status).toBe(409);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const body = (await res.json()) as { error: string; parameter: string; restart: string };
        expect(body).toMatchObject({ error: "cursor_expired", parameter: "after" });
        expect(body.restart).toMatch(/\/api\/v1\/datasets\/qtest-f2-j\/records\?limit=5$/);
        const restarted = await call(`${F2}j`, "?limit=5", ip);
        expect(restarted.status).toBe(200);
      });

      it("CSV: every stored row, exactly once, in id order, with the dataset's own partial flag", async () => {
        await seedRecords(`${F2}csv`, 2500);
        const res = await call(`${F2}csv`, "?format=csv", freshIp());
        expect(res.status).toBe(200);
        expect(res.headers.get("x-dataset-partial")).toBe("false");
        const lines = (await bodyText(res)).split("\r\n");
        expect(lines.pop()).toBe("");
        expect(lines[0]).toBe("﻿n,v");
        expect(lines).toHaveLength(2501); // header + 2,500 stored rows (the old cap was 200,000: this is the shape of that bug)
        expect(lines.slice(1).map((l) => Number(l.split(",")[0]))).toEqual(Array.from({ length: 2500 }, (_, i) => i + 1));
        expect(limits.csvStreamsInFlight()).toBe(0);
      });

      it("CSV: an unknown dataset is a 404 and a stale after is a 409 BEFORE any body, and neither keeps a slot", async () => {
        const ip = freshIp();
        expect((await call(`${F2}nope`, "?format=csv", ip)).status).toBe(404);
        await seedRecords(`${F2}csv409`, 20);
        const page = (await (await call(`${F2}csv409`, "?limit=5", ip)).json()) as { nextAfter: string };
        await replaceRecords(`${F2}csv409`, 20);
        const res = await call(`${F2}csv409`, `?format=csv&after=${page.nextAfter}`, ip);
        expect(res.status).toBe(409);
        expect((await res.json()) as { restart: string }).toMatchObject({ error: "cursor_expired" });
        expect(limits.csvStreamsInFlight()).toBe(0);
      });

      it("CSV: a sync replacing the dataset mid-download ERRORS the stream, it does not end a short or duplicated file cleanly", async () => {
        await seedRecords(`${F2}mid`, 2500);
        const res = await call(`${F2}mid`, "?format=csv", freshIp());
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const first = await reader.read(); // BOM + header + batch 1 (rows 1..1000)
        expect(first.done).toBe(false);
        await replaceRecords(`${F2}mid`, 2500);
        let failure: unknown = null;
        let chunks = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            chunks += 1;
            if (chunks > 5) break;
          }
        } catch (err) {
          failure = err;
        }
        expect(failure, "the stream must fail, not finish").toBeInstanceOf(Error);
        expect(String((failure as Error).name)).toBe("StaleCursorError");
        expect(limits.csvStreamsInFlight()).toBe(0); // the failed export gave its slot back
      });

      it("CSV: the slot is held until the body is finished or cancelled, never just until the Response exists", async () => {
        await seedRecords(`${F2}slot`, 2500);
        const ip = freshIp();
        const { CSV_MAX_PER_CLIENT, CSV_MAX_CONCURRENT } = limits;
        const mine = [];
        for (let i = 0; i < CSV_MAX_PER_CLIENT; i++) {
          const res = await call(`${F2}slot`, "?format=csv", ip);
          expect(res.status).toBe(200);
          mine.push(res);
        }
        // The Response objects exist (the old run(() => new Response(...)) would already have freed the slots).
        expect(limits.csvStreamsInFlight()).toBe(CSV_MAX_PER_CLIENT);

        const refused = await call(`${F2}slot`, "?format=csv", ip);
        expect(refused.status).toBe(429); // this client already has its share
        expect(refused.headers.get("retry-after")).toBeTruthy();
        expect(refused.headers.get("cache-control")).toBe("no-store");
        expect(((await refused.json()) as { error: string }).error).toBe("rate_limited");

        // Other clients are still served, up to the server-wide cap; the next one is told the SERVER is full (503).
        const others: Response[] = [];
        while (limits.csvStreamsInFlight() < CSV_MAX_CONCURRENT) {
          const res = await call(`${F2}slot`, "?format=csv", freshIp());
          expect(res.status).toBe(200);
          others.push(res);
        }
        const full = await call(`${F2}slot`, "?format=csv", freshIp());
        expect(full.status).toBe(503);
        expect(full.headers.get("retry-after")).toBeTruthy();
        expect(((await full.json()) as { error: string }).error).toBe("server_busy");

        for (const res of others) await res.body?.cancel();
        await mine[0].body?.cancel(); // the client hangs up: Next calls cancel() on the body
        await vi.waitFor(() => expect(limits.csvStreamsInFlight()).toBe(CSV_MAX_PER_CLIENT - 1));
        const again = await call(`${F2}slot`, "?format=csv", ip);
        expect(again.status).toBe(200); // the slot really came back
        await again.body?.cancel();
        for (const res of mine.slice(1)) await res.body?.cancel();
        await vi.waitFor(() => expect(limits.csvStreamsInFlight()).toBe(0));
      });

      it("every JSON route is rate limited per client too, with a 429 that carries Retry-After", async () => {
        const ip = freshIp();
        const { API_READ_BUDGET } = limits;
        let refused: Response | null = null;
        for (let i = 0; i < API_READ_BUDGET.limit + 3 && !refused; i++) {
          const res = await call(`${F2}nothing`, "?limit=1", ip);
          if (res.status === 429) refused = res;
        }
        expect(refused?.status).toBe(429);
        expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
        expect(refused?.headers.get("access-control-allow-origin")).toBe("*");
        // Another client is unaffected.
        expect((await call(`${F2}nothing`, "?limit=1", freshIp())).status).toBe(404);
      });
    });

    describe("featured band (R2-05)", () => {
      it("getFeaturedDataset returns a live dataset (removedAt null, also on a cache hit) and null for a removed one", async () => {
        await prisma.dataset.createMany({
          data: [
            fixtureRow({ id: `${F2}live`, titleClean: "Featured live", theme: "QTF2", viz: "area" }),
            fixtureRow({ id: `${F2}gone`, titleClean: "Featured gone", theme: "QTF2", viz: "area", removed: true }),
          ],
        });
        const live = await q.getFeaturedDataset(`${F2}live`);
        expect(live?.removedAt).toBeNull();
        const hit = cache.hits;
        const liveAgain = await q.getFeaturedDataset(`${F2}live`);
        expect(cache.hits).toBeGreaterThan(hit);
        expect(liveAgain?.removedAt).toBeNull();

        expect(await q.getFeaturedDataset(`${F2}gone`)).toBeNull();
        // ... while the card itself still exists for callers that ask by id, with a revived Date.
        const card = await q.getDatasetCard(`${F2}gone`);
        expect(card?.removedAt).toBeInstanceOf(Date);
        expect((await q.getDatasetCard(`${F2}gone`))?.removedAt).toBeInstanceOf(Date); // cache hit
        expect(await q.getFeaturedDataset("qtest-f2-missing")).toBeNull();
      });

      it("removed datasets are still absent from every list (unchanged)", async () => {
        await prisma.dataset.create({ data: fixtureRow({ id: `${F2}gone`, titleClean: "Zzgone", theme: "QTF2", removed: true }) });
        expect((await q.listDatasets({ q: "zzgone" })).items).toHaveLength(0);
      });
    });

    describe("themes (R2-06)", () => {
      it.each([100, 101, 150, 200])("a theme of %i characters has a tile, a lookup and a non-empty listing", async (length) => {
        const theme = `${"T".repeat(length - 1)}ص`;
        await prisma.dataset.create({ data: fixtureRow({ id: `${F2}theme-${length}`, titleClean: `Long theme ${length}`, theme }) });
        const counts = await q.getThemeCounts();
        expect(counts.find((t) => t.theme === theme)?.count).toBe(1);
        expect((await q.findTheme(theme))?.theme).toBe(theme);
        const result = await q.getDatasetsByTheme(theme, 1);
        expect(result.status).toBe("ok"); // it used to be "unknown-theme" past 100 characters
        expect(result.total).toBe(1);
        expect(result.items[0].id).toBe(`${F2}theme-${length}`);
        expect(result.facets.themes.find((t) => t.theme === theme)?.count).toBe(1);
      });
    });

    describe("publishers (R2-07)", () => {
      const ARABIC = ["وزارة الداخلية", "هيئة المعلومات والحكومة الإلكترونية"];
      const LONG = `Ministry of ${"Something Very Long ".repeat(16)}`; // > 300 characters

      it("Arabic-only and over-long publisher names get distinct, valid, reachable slugs", async () => {
        const { isValidPublisherSlug } = await import("@/lib/cache-config");
        await prisma.dataset.createMany({
          data: [
            fixtureRow({ id: `${F2}p-ar-1`, titleClean: "Ar one", publisher: ARABIC[0] }),
            fixtureRow({ id: `${F2}p-ar-2`, titleClean: "Ar two", publisher: ARABIC[1] }),
            fixtureRow({ id: `${F2}p-long`, titleClean: "Long pub", publisher: LONG }),
            fixtureRow({ id: `${F2}p-blank`, titleClean: "Blank pub", publisher: "   " }),
          ],
        });
        const counts = await q.getPublisherCounts();
        const mine = counts.filter((p) => [...ARABIC, LONG].some((n) => p.names.includes(n)));
        expect(mine).toHaveLength(3); // the two Arabic publishers no longer merge into one
        expect(new Set(mine.map((p) => p.slug)).size).toBe(3);
        for (const p of mine) {
          expect(p.slug).not.toBe("");
          expect(isValidPublisherSlug(p.slug)).toBe(true);
          expect(p.name).toBe(p.names[0]);
        }
        expect(counts.some((p) => p.slug === "" || p.name.trim() === "")).toBe(false); // a blank name is no publisher

        for (const p of mine) {
          expect((await q.findPublisher(p.slug))?.name).toBe(p.name);
          const list = await q.getDatasetsByPublisherSlug(p.slug, 1);
          expect(list.status).toBe("ok");
          expect(list.total).toBe(1);
          expect(list.publisherName).toBe(p.name);
        }
        const facets = (await q.listDatasets({})).facets.publishers;
        expect(mine.every((p) => facets.some((f) => f.slug === p.slug))).toBe(true);
      });

      it("the sitemap lists each of them once and never '/publishers/' with an empty slug", async () => {
        await prisma.dataset.createMany({
          data: [
            fixtureRow({ id: `${F2}p-ar-1`, titleClean: "Ar one", publisher: ARABIC[0] }),
            fixtureRow({ id: `${F2}p-ar-2`, titleClean: "Ar two", publisher: ARABIC[1] }),
          ],
        });
        const sitemap = (await import("@/app/sitemap")).default;
        const urls = (await sitemap()).map((e) => e.url);
        expect(urls.some((u) => /\/publishers\/$/.test(u))).toBe(false);
        const slugs = (await q.getPublisherCounts()).filter((p) => ARABIC.some((n) => p.names.includes(n))).map((p) => p.slug);
        expect(slugs).toHaveLength(2);
        for (const slug of slugs) expect(urls.filter((u) => u.endsWith(`/publishers/${slug}`))).toHaveLength(1);
      });

      it("the hero publisher count includes them (it used to be one short)", async () => {
        const before = (await q.getPublisherCounts()).length;
        await prisma.dataset.createMany({
          data: [
            fixtureRow({ id: `${F2}p-ar-1`, titleClean: "Ar one", publisher: ARABIC[0] }),
            fixtureRow({ id: `${F2}p-ar-2`, titleClean: "Ar two", publisher: ARABIC[1] }),
          ],
        });
        cache.clear();
        const stats = await q.getPortalStats();
        const after = (await q.getPublisherCounts()).length;
        expect(after).toBe(before + 2);
        expect(stats.publisherCount).toBe(after);
      });
    });

    describe("/updates metadata count (R2-13)", () => {
      it("countRecentlyUpdated agrees with getRecentlyUpdated for every window", async () => {
        for (const days of [null, 1, 7, 30, 90, 3650]) {
          const listed = await q.getRecentlyUpdated({ sinceDays: days, pageSize: 100 });
          expect(await q.countRecentlyUpdated(days), `window ${days}`).toBe(listed.total);
        }
        expect(await q.countRecentlyUpdated(0)).toBe(await q.countRecentlyUpdated(null)); // invalid window = all time, like the list
      });
    });

    describe("in-table search share per client (R2-11)", () => {
      it("one client cannot take every expensive-query slot; another client is still admitted", async () => {
        const waiting: Array<(value: unknown) => void> = [];
        vi.spyOn(prisma, "$transaction").mockImplementation((() => new Promise((resolve) => waiting.push(resolve))) as never);
        const sorted = (page: number, client?: string) =>
          q.getDatasetRecordsPage({ datasetId: "qtest-records", page, sort: "value", ...(client ? { client } : {}) });
        const hog = [2, 3].map((page) => sorted(page, "client-hog"));
        for (let i = 0; i < 100 && waiting.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
        expect(waiting).toHaveLength(2); // the hog holds its share (half of the 4 slots)

        const refused = await sorted(2, "client-hog");
        expect(refused.sortFailed).toBe(true);
        expect(refused.throttled).toBe(true); // "slow down", not "the search failed"
        expect(refused.rows).toHaveLength(25); // degraded to id order, still a page

        const polite = sorted(2, "client-polite");
        for (let i = 0; i < 100 && waiting.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
        expect(waiting).toHaveLength(3); // the other client got a slot while the hog was refused

        for (const resolve of waiting) resolve([]);
        await Promise.all([...hog, polite]);
        vi.restoreAllMocks();
        const after = await sorted(2, "client-hog");
        expect(after.throttled).toBe(false); // the share came back
        expect(after.sortFailed).toBe(false);
      });

      it("a client over its per-minute budget of sorted/searched queries is refused with throttled=true", async () => {
        const client = `budget-${Math.random()}`;
        let refused = 0;
        for (let i = 0; i < 130 && refused === 0; i++) {
          const r = await q.getDatasetRecordsPage({ datasetId: "qtest-records", page: 2, sort: "value", client });
          if (r.throttled) refused += 1;
        }
        expect(refused).toBe(1); // after 120 heavy queries inside the window
      });

      it("without a client key only the global cap applies (unchanged), and throttled is false", async () => {
        const r = await q.getDatasetRecordsPage({ datasetId: "qtest-records", page: 2, sort: "value" });
        expect(r.throttled).toBe(false);
        expect(r.sortField).toBe("value");
      });
    });
  });
});
