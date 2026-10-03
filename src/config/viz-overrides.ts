/**
 * Hand-pinned visualization choices for datasets the heuristics get wrong.
 *
 * `computeDerivedFields` (src/lib/sync/derived.ts) consults this map by
 * `dataset_id` before it falls back to its inference rules, so an editor can
 * fix a known-bad dataset here without touching (and risking) the heuristics
 * for the other ~500. Every field is optional; whatever is omitted is still
 * inferred.
 *
 *   measureField  the numeric field to plot (must exist in the dataset and
 *                 hold numbers; otherwise a warning is logged and the
 *                 inferred measure is used - an override never fails silently).
 *   aggregate     "sum" | "mean" | "last". "last" (stock/cumulative values:
 *                 take the latest observation in each period) is deliberately
 *                 NOT inferable from labels, so this map is the only way to
 *                 get it.
 *   seriesField   the text dimension to split a temporal chart into lines
 *                 (a multi-line chart; at most 8 series are plotted).
 *   lastPeriod    "complete" | "partial": pins whether the newest period of a
 *                 temporal chart is complete. The engine judges this itself
 *                 (row coverage, and for daily/weekly data the calendar), so
 *                 this is only for a dataset it keeps getting wrong: "partial"
 *                 headlines the previous period, "complete" never does.
 *
 * Changing an entry changes derived output for that dataset: it takes effect
 * on its next re-derivation (the sync engine re-derives rows whose
 * `derivedVersion` is older than DERIVED_VERSION, or on a forced sync).
 */

import type { Aggregate } from "@/lib/series";

export interface VizOverride {
  measureField?: string;
  aggregate?: Aggregate;
  seriesField?: string;
  lastPeriod?: "complete" | "partial";
}

export const vizOverrides: Record<string, VizOverride> = {
  // The consumer price index dataset's measure is an index LEVEL. Summed over
  // every division/group and month it charted ~42,000 instead of a CPI of
  // ~100-120 (documented in README "known limitation"); averaging gives the
  // meaningful figure whatever the field happens to be labeled.
  "01-consumer-price-index-division-and-group-index-number": { aggregate: "mean" },
};

export function getVizOverride(datasetId: string): VizOverride | undefined {
  return Object.prototype.hasOwnProperty.call(vizOverrides, datasetId) ? vizOverrides[datasetId] : undefined;
}
