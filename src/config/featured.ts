/**
 * Hand-authored "featured stats" band shown on the home page — a small,
 * curated set of datasets to headline with a big number + sparkline.
 *
 * `datasetId` must be a real `dataset_id` from data.gov.bh. The home page
 * looks each one up at render time and SKIPS the entry entirely (does not
 * crash) if:
 *   - the id isn't in the database yet (sync hasn't reached it), or
 *   - the dataset has no chartData yet, or
 *   - its chart type isn't temporal (area/multi-line) — there's no single
 *     "big number" to headline for a bar/table chart.
 *
 * Phase 8: re-picked from the real, fully-synced ~512-dataset catalog
 * (previously this list was 6 entries confirmed present as of Phase 4's
 * development-time partial syncs, picked before the real catalog's shape
 * was fully visible). Each entry below was verified two ways: (1) its
 * `dataset_id` is real and `syncStatus: "ok"` after the Phase 8 full sync,
 * and (2) its actual `chartData` was inspected to confirm the "big number"
 * `extractFeaturedMetric()` (`src/lib/chart-data.ts`) computes from it is a
 * genuinely meaningful figure — not just "a chart exists".
 *
 * That second check mattered: several otherwise-obvious headline
 * candidates were rejected because `extractFeaturedMetric()`'s multi-line
 * branch sums every series value in the last period, which silently
 * produces a nonsensical number whenever a dataset's series mix
 * incompatible units (e.g. "Unemployment Rate" + "Unemployed Persons" in
 * the same multi-line series, or five different pollutants' concentrations
 * in `01-air-quality-in-kingdom-of-bahrain`) — real cases found live in
 * this catalog, not hypothetical. `01-consumer-price-index-division-and-group-index-number`
 * (a Phase 4 pick) has the same problem for a different reason: its `area`
 * chart sums CPI *index points* across every category and month for a
 * year, producing ~42,000 instead of a real ~100-120 CPI level (documented
 * separately in the README's visualization-inference-engine section as a
 * known, not-fixed classifier limitation). All three were dropped from
 * this list rather than shipped with a misleading number.
 *
 * One genuinely wrong case *was* fixed rather than just avoided:
 * `01-caa-monthly-passenger-movement-at-bahrain-international-airport`'s
 * and `01-container-statistics-at-khalifa-bin-salman-port`'s multi-line
 * series each include an explicit "Total" value ALONGSIDE its own
 * sub-components (e.g. "Passengers Total" next to "Passengers
 * Embark/Disembark/Transit/Transfers") — summing all of them together
 * (the old behavior) double-counted the total against its own parts,
 * inflating airport passengers from a real ~1.5M to ~4.7M. Fixed at the
 * source: when a multi-line series includes an already-labeled total, that
 * value is used directly instead of summing everything — verified against
 * real data that this produces the correct ~1.5M / ~107,010 TEU figures.
 * The rule now lives in ONE place, `src/lib/headline.ts` (with the total
 * detection in `src/lib/series.ts`): `derived.ts` calls it at sync time and
 * persists the result as `vizConfig.headline` (also used for the dataset
 * page's lead sentence, which used to double count), and
 * `extractFeaturedMetric()` reads that value (recomputing with the same
 * function for rows synced before it existed). It applies to every
 * `DatasetCard` sparkline site-wide, not just this featured band. When the
 * headline cannot be stated honestly (two "Total X" series, a rate that
 * cannot be summed) the headline is null and the entry below is skipped,
 * exactly like an id that has not been synced yet.
 *
 * Kept to 6 entries as before — each one costs a query + a chart on the
 * home page. Picked for a mix of recognizable, genuinely newsworthy
 * indicators across different themes (population, demographics, trade/
 * transport, education) rather than one theme dominating.
 */

export interface FeaturedEntry {
  datasetId: string;
  metricLabelAr: string;
}

export const featuredEntries: FeaturedEntry[] = [
  {
    datasetId: "01-population-by-nationality-sex-agegroups",
    metricLabelAr: "عدد السكان",
  },
  {
    datasetId: "01-live-births",
    metricLabelAr: "المواليد الأحياء",
  },
  {
    datasetId: "01-vehicle-registered-in-use",
    metricLabelAr: "المركبات المسجلة",
  },
  {
    datasetId: "01-caa-monthly-passenger-movement-at-bahrain-international-airport",
    metricLabelAr: "حركة المسافرين بمطار البحرين الدولي",
  },
  {
    datasetId: "01-container-statistics-at-khalifa-bin-salman-port",
    metricLabelAr: "حركة الحاويات بميناء خليفة بن سلمان",
  },
  {
    datasetId: "1a-number-of-governmental-schools-by-type-of-school",
    metricLabelAr: "عدد المدارس الحكومية",
  },
];
