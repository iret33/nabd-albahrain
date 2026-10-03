/**
 * Hand-authored "featured stats" band shown on the home page — a small,
 * curated set of datasets to headline with a big number + sparkline.
 *
 * `datasetId` must be a real `dataset_id` from data.gov.bh. The home page
 * looks each one up at render time and SKIPS the entry entirely (does not
 * crash) if:
 *   - the id isn't in the database yet (sync hasn't reached it) or the
 *     dataset has been removed upstream,
 *   - the dataset has no chartData yet,
 *   - its chart type isn't temporal (area/multi-line): there is no single
 *     "big number" to headline for a bar/table chart, or
 *   - its headline is withheld (`vizConfig.headline` is null: two "Total X"
 *     series, a rate that cannot be summed, series that are different
 *     indicators, ...), because a number that cannot be stated honestly is
 *     better missing than wrong.
 *
 * The headline itself is not computed here. The ONE implementation lives in
 * `src/lib/headline.ts` (total-series detection in `src/lib/series.ts`):
 * `derived.ts` computes it at sync time and persists it as
 * `vizConfig.headline`, the dataset page's lead sentence uses it, and
 * `extractFeaturedMetric()` (`src/lib/chart-data.ts`) reads it back (recomputing
 * with the same function for rows synced before it existed).
 *
 * Why these six: the entries were picked from the real ~512-dataset catalog
 * (August 2026) by checking that the number the band prints is a genuinely
 * meaningful figure, not just that "a chart exists". Obvious candidates that
 * were rejected at the time because their series mix incompatible units
 * (`01-unemployment-monthly` puts a rate and a head count in one series;
 * `01-air-quality-in-kingdom-of-bahrain` mixes five pollutants) would now simply
 * have their headline withheld by the rules above. The consumer price index
 * dataset (`01-consumer-price-index-division-and-group-index-number`) used to
 * sum index points into a meaningless ~42,000; `src/config/viz-overrides.ts`
 * now pins it to a mean, so it is eligible again if someone wants it here.
 * Entries whose headline is withheld are skipped automatically.
 *
 * Kept to 6 entries: each one costs a query + a chart on the home page. A mix
 * of recognizable indicators across themes (population, demographics, trade/
 * transport, education) rather than one theme dominating.
 */

export interface FeaturedEntry {
  datasetId: string;
  metricLabelAr: string;
  /**
   * Optional guard: the numeric field this band entry is ABOUT (e.g. the Total
   * column of a wide table). When set, the home band should skip the entry if
   * the dataset's derived `vizConfig.measureField` is a different column,
   * because the hand-written `metricLabelAr` would then caption another number
   * (non-Bahraini population under "عدد السكان"). Left unset for every entry
   * below: the real portal schema is not available to confirm the field names,
   * and a wrong name would hide a good card. Pin an id here, and in
   * `src/config/viz-overrides.ts` (`measureField`), only after checking its
   * actual columns. Entries whose chart has no `measureField` (tables, rows
   * synced before the field existed) are never skipped by this guard.
   */
  measureField?: string;
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
