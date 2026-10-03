import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUN_INTEGRATION, setupHarness, type Harness } from "./helpers";
import type { CatalogField } from "@/lib/sync/schemas";
import type { VizConfig } from "@/lib/sync/derived";
import oldShapes from "../derived/fixtures/old-shapes.json";

/**
 * Runs the derivation engine over every dataset synced from the in-process
 * mock portal (seeded through the shared harness, so this file does not
 * depend on what other integration files left in the database) and checks the invariants
 * the unit tests cannot: the sentence on the dataset page and the card/home
 * metric are the SAME number, and rows synced by the previous engine version
 * (old vizConfig shapes, straight from Postgres) still render.
 *
 * Opt-in: needs a migrated Postgres at DATABASE_URL and RUN_INTEGRATION=1.
 */
describe.skipIf(!RUN_INTEGRATION)("derived fields over real database rows", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await setupHarness();
    await h.reset();
    await h.seed();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("every dataset: headline, summary sentence and card metric agree; old stored rows still extract", async () => {
    const { computeDerivedFields } = await import("@/lib/sync/derived");
    const { extractFeaturedMetric } = await import("@/lib/chart-data");
    const { formatSummaryNumber } = await import("@/lib/headline");

    const prisma = h.prisma;
    const datasets = await prisma.dataset.findMany({ orderBy: { id: "asc" } });
    expect(datasets.length).toBeGreaterThan(0);

    let temporal = 0;
    for (const d of datasets) {
      const rows = await prisma.datasetRecord.findMany({ where: { datasetId: d.id }, orderBy: { id: "asc" } });
      const records = rows.map((r) => r.data as Record<string, unknown>);
      const derived = await computeDerivedFields(d.id, records, d.fieldsJson as unknown as CatalogField[]);
      const viz = derived.vizConfig as VizConfig | null;
      expect(viz, d.id).not.toBeNull();
      expect(derived.summaryAr, d.id).toBeTruthy();

      if (viz && (viz.type === "area" || viz.type === "multi-line")) {
        temporal++;
        // Persisted for every temporal config: an object, or null when withheld on purpose.
        expect(viz.headline, d.id).not.toBeUndefined();
        const metric = extractFeaturedMetric(viz, derived.chartData);
        if (viz.headline === null) {
          expect(metric, d.id).toBeNull();
        } else {
          expect(metric?.value, d.id).toBe(viz.headline!.value);
          expect(metric?.period, d.id).toBe(viz.headline!.period);
          // the dataset page's lead sentence quotes the very same number
          expect(derived.summaryAr, d.id).toContain(formatSummaryNumber(viz.headline!.value));
        }
        // gap-filled rows never leak NaN/Infinity
        for (const row of derived.chartData as Array<Record<string, unknown>>) {
          for (const v of Object.values(row)) if (typeof v === "number") expect(Number.isFinite(v), d.id).toBe(true);
        }
      }

      // Rows persisted by the previous engine (no headline/totalKey/lastPeriodPartial): must not crash.
      const stored = extractFeaturedMetric(
        d.vizConfig as unknown as VizConfig | null,
        Array.isArray(d.chartData) ? d.chartData : null,
      );
      if (stored) {
        expect(Number.isFinite(stored.value), d.id).toBe(true);
        expect(stored.points.length, d.id).toBeGreaterThan(0);
      }
    }
    expect(temporal).toBeGreaterThan(0);
  });
  it("a database stamped with the PREVIOUS derivation version is re-derived to the current one (new grammar, no stale sentences)", async () => {
    const old = h.derived.DERIVED_VERSION - 1;
    await h.prisma.dataset.updateMany({ data: { derivedVersion: old, summaryAr: "تحتوي قاعدة البيانات على 8 سجلاً عبر 2 حقلاً." } });
    const needing = await h.recompute.countDatasetsNeedingRecompute();
    expect(needing).toBeGreaterThan(0);

    h.mock.state.hits.total = 0;
    const r = await h.recompute.runRecompute({ trigger: "test" });
    expect(r).toMatchObject({ status: "success", failed: 0, skippedPartial: [] });
    expect(r.updated).toBe(needing);
    expect(h.mock.state.hits.total).toBe(0); // from stored rows only

    // recompute only visits datasets that have rows (sourceCount > 0): a zero-row dataset is a cross-file
    // concern of recompute.ts, so it is derived directly below.
    const rows = await h.prisma.dataset.findMany({ where: { sourceCount: { gt: 0 } } });
    expect(rows.length).toBeGreaterThan(0);
    for (const d of rows) {
      expect(d.derivedVersion, d.id).toBe(h.derived.DERIVED_VERSION);
      expect(d.summaryAr, d.id).toBeTruthy();
      expect(d.summaryAr, d.id).not.toMatch(/قاعدة البيانات|سجلاً|حقلاً/);
    }
    expect(await h.recompute.countDatasetsNeedingRecompute()).toBe(0);

    // an empty dataset reads as empty, not as "0 records across 2 fields"
    const empty = await h.prisma.dataset.findUniqueOrThrow({ where: { id: "empty-dataset" } });
    const derived = await h.derived.computeDerivedFields(empty.id, [], empty.fieldsJson as unknown as CatalogField[]);
    expect(derived.summaryAr).toBe("لا تحتوي مجموعة البيانات على أي سجلات.");
  });

  it("vizConfig/chartData shapes written by older engines survive the Postgres JSON round trip and still extract", async () => {
    const { extractFeaturedMetric } = await import("@/lib/chart-data");
    const fixtures: Array<[string, { vizConfig: unknown; chartData: unknown }, number | null]> = [
      ["energy-consumption", oldShapes.energyConsumption, 18620],
      ["population-by-nationality", oldShapes.population, 2233000],
      ["unemployment-rate", oldShapes.unemployment, 3.6],
      ["schools-by-type", oldShapes.schools, null],
    ];
    for (const [id, fx] of fixtures) {
      await h.prisma.dataset.update({ where: { id }, data: { vizConfig: fx.vizConfig as never, chartData: (fx.chartData ?? undefined) as never } });
      const d = await h.prisma.dataset.findUniqueOrThrow({ where: { id } });
      const metric = extractFeaturedMetric(d.vizConfig as unknown as VizConfig, Array.isArray(d.chartData) ? d.chartData : null);
      const expected = fixtures.find(([i]) => i === id)![2];
      if (expected === null) expect(metric, id).toBeNull();
      else expect(metric?.value, id).toBe(expected);
    }
  });
});
