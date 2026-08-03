/**
 * computeDerivedFields — STUB for Phase 2. Phase 3 implements the real
 * logic here: statsJson (min/max/avg/distinct counts per field),
 * vizConfig (which chart type + fields to plot), chartData (precomputed,
 * chart-ready aggregates — never raw record dumps, per the Recharts rule
 * in the spec), and summaryAr (a short Arabic auto-summary).
 *
 * The sync engine (engine.ts) calls this once per dataset, right after
 * that dataset's records are committed, and persists whatever it returns
 * onto the Dataset row. Phase 3 should only need to fill in the body of
 * this function — the call site and persistence are already wired up.
 *
 * `records` is the FULL export array the engine just fetched for this
 * dataset — not (necessarily) what ended up in DatasetRecord. When the
 * size guard truncates storage (>300k rows -> only the first 50k are
 * persisted, syncStatus="partial"), `records` still holds every row, so
 * Phase 3 can compute accurate stats/chartData over the complete dataset
 * even though only a subset was written to the DB. Phase 3 should process
 * `records` in chunks (e.g. slice-and-reduce) rather than building large
 * derived structures from the whole array at once, to stay memory-safe on
 * the largest datasets.
 */

export interface DerivedFields {
  statsJson: unknown | null;
  vizConfig: unknown | null;
  chartData: unknown | null;
  summaryAr: string | null;
}

export async function computeDerivedFields(
  datasetId: string,
  records: Record<string, unknown>[],
): Promise<DerivedFields> {
  // TODO(Phase 3): compute real stats/vizConfig/chartData/summaryAr.
  void datasetId;
  void records;

  return {
    statsJson: null,
    vizConfig: null,
    chartData: null,
    summaryAr: null,
  };
}
