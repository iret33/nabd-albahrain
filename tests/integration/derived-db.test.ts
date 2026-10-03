import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUN_INTEGRATION, setupHarness, type Harness } from "./helpers";
import type { CatalogField } from "@/lib/sync/schemas";
import type { VizConfig } from "@/lib/sync/derived";

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
});
