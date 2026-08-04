/**
 * Hand-authored "featured stats" band shown on the home page — a small,
 * curated set of datasets to headline with a big number + sparkline.
 *
 * TODO(later phase): once the full sync has run against all ~512
 * datasets, revisit this list — pick datasets that are genuinely
 * newsworthy/representative (population, economy, health headline
 * figures) rather than whatever happened to be in the first `--limit 10`
 * / spot-check batches during Phase 2-3 development. Keep this list to
 * ~6 entries; each one costs a query + a chart on the home page.
 *
 * `datasetId` must be a real `dataset_id` from data.gov.bh. The home page
 * looks each one up at render time and SKIPS the entry entirely (does not
 * crash) if:
 *   - the id isn't in the database yet (sync hasn't reached it), or
 *   - the dataset has no chartData yet, or
 *   - its chart type isn't temporal (area/multi-line) — there's no single
 *     "big number" to headline for a bar/table chart.
 *
 * The 6 entries below are real dataset_ids confirmed present in local
 * Postgres as of this phase (verified via `pnpm sync -- --dataset <id>
 * --force` during Phase 4 development), spanning a few different themes.
 */

export interface FeaturedEntry {
  datasetId: string;
  metricLabelAr: string;
}

export const featuredEntries: FeaturedEntry[] = [
  {
    datasetId: "01-consumer-price-index-division-and-group-index-number",
    metricLabelAr: "الرقم القياسي لأسعار المستهلك",
  },
  {
    datasetId: "01-air-quality-in-kingdom-of-bahrain",
    metricLabelAr: "جودة الهواء",
  },
  {
    datasetId: "01-caa-monthly-passenger-movement-at-bahrain-international-airport",
    metricLabelAr: "حركة المسافرين بمطار البحرين الدولي",
  },
  {
    datasetId: "live-births-by-usual-residence-of-mother-and-place-of-birth",
    metricLabelAr: "المواليد الأحياء",
  },
  {
    datasetId: "01-container-statistics-at-khalifa-bin-salman-port",
    metricLabelAr: "حركة الحاويات بميناء خليفة بن سلمان",
  },
  {
    datasetId: "02b-average-length-of-stay",
    metricLabelAr: "متوسط مدة إقامة الزوار",
  },
];
