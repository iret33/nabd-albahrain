/**
 * computeDerivedFields — Phase 3 implementation, hardened in the viz-engine pass.
 *
 * Given one dataset's full export array plus its ODS `fields[]` schema
 * metadata, computes (deterministically, no AI/LLM calls):
 *
 *   - statsJson: per-field stats (nullRate, distinctCount, numeric
 *     min/max/mean/median, temporal min/max, top-10 for low-cardinality
 *     text, plus numericLike / looksLikeYear / looksLikeIdentifier hints).
 *   - vizConfig + chartData: a single "best" chart recommendation picked by
 *     the decision tree in the project spec (multi-line / area / bar-h /
 *     bar-stacked / histogram / table), with chartData already aggregated
 *     and capped — never a raw record dump.
 *   - summaryAr: a short template-based Arabic sentence describing the
 *     dataset, derived from whichever chart (if any) was produced.
 *
 * The sync engine (engine.ts) calls this once per dataset, right after
 * that dataset's records are committed, and persists whatever it returns
 * onto the Dataset row.
 *
 * `records` is the FULL export array the engine just fetched for this
 * dataset — not (necessarily) what ended up in DatasetRecord — so stats
 * stay accurate even when storage was capped by the size guard. Everything
 * below is a small, fixed number of linear passes over `records` (no
 * per-field parallel arrays, medians use a bounded reservoir), which keeps
 * memory bounded even on the largest datasets.
 *
 * Number-correctness rules implemented here (each is a reproduced bug):
 *   - "Total" rows on dimensions that are not plotted are dropped, so parts
 *     are never summed together with their total; a single total on the
 *     plotted series dimension becomes `vizConfig.totalKey` (multi-line
 *     keeps it as its own series, bar charts leave it out). See series.ts.
 *   - The measure is averaged only when its name/label/unit really says it
 *     is a rate/percent/index/price (token-aware, not a substring regex), and
 *     bar-stacked does not stack means. `src/config/viz-overrides.ts` can pin
 *     measure / aggregate / series field for known-bad datasets.
 *   - A partial trailing period (`lastPeriodPartial`) never becomes the
 *     headline, and the persisted `headline` is computed once, here, by the
 *     same function the render layer uses (src/lib/headline.ts).
 *   - Temporal parsing is a strict whitelist (src/lib/temporal.ts); a bare
 *     "Month" column is combined with a sibling year column, never treated as
 *     a date on its own. Missing periods are filled with null rows so gaps
 *     are visible. A provisional marker ("2024*", "2024 (p)") is stripped from
 *     the period and recorded (`provisionalPeriods`, `headline.provisional`),
 *     never silently; rows with a period that cannot be read are counted
 *     (`droppedPeriodRows`), never silently dropped.
 *   - A "Total" that labels cannot prove is a total is only dropped when the
 *     numbers agree (it equals the sum of its siblings), and a mean (rate,
 *     index) over a hidden dimension uses the PUBLISHED overall figure when the
 *     table carries one for every period, instead of an unweighted mean of the
 *     parts. Series that are different indicators are never summed.
 *   - Identifier-like numeric columns (phone, CPR, building, road, block ...)
 *     are never the measure; reserved chart keys (period, category, __proto__)
 *     in the data never corrupt a chart row.
 *
 * This function must never throw: a single dataset's derived-field
 * computation failing must never crash the sync loop (same rule the spec
 * applies to network/schema errors elsewhere in the sync engine). The
 * outermost try/catch below is a deliberate extra safety net on top of
 * that existing rule.
 */

import type { CatalogField } from "./schemas";
import { getVizOverride, type VizOverride } from "@/config/viz-overrides";
import { NOUNS, countPhrase } from "@/lib/arabic-count";
import {
  fillPeriodGaps,
  findNumericTotalSeries,
  findTotalSeries,
  inferAggregate,
  inferUnitFromLabel,
  isIdentifierLikeName,
  isLastPeriodPartial,
  isLooseTotalLabel,
  isStrictTotalLabel,
  isTotalCandidateLabel,
  median,
  sumSeriesRow,
  totalCellsAgree,
  type Aggregate,
  type Grain,
  type PeriodCoverage,
  type TotalCell,
} from "@/lib/series";
import {
  isMonthOnlyName,
  isQuarterOnlyName,
  createTemporalParser,
  looksTemporalName,
  looksYearName,
  parseMonthPart,
  type TemporalParts,
} from "@/lib/temporal";
import {
  buildHeadlineSentence,
  computeHeadline,
  formatSummaryNumber,
  headlineWithheldReason,
  type Headline,
  type HeadlineSource,
  type HeadlineWithheld,
} from "@/lib/headline";

export type { Aggregate, Grain } from "@/lib/series";
export type { Headline, HeadlineBasis, HeadlineWithheld } from "@/lib/headline";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Version of the derivation logic. Bump whenever a change to this file alters
 * the persisted statsJson/vizConfig/chartData/summaryAr for the same input.
 * `Dataset.derivedVersion` records which version produced a row; rows with an
 * older version are re-derived from their stored records (no network).
 *
 *   1  original engine
 *   2  viz-engine rewrite (headline, totals, partial periods). It was NOT
 *      bumped for the rewrite itself, so a database stamped 2 by a build from
 *      before that rewrite still holds the old numbers.
 *   3  number-correctness pass: Arabic count agreement in the generated
 *      sentences, one percent/number convention, heterogeneous-series and
 *      identifier-measure gates, numeric total verification, total-only means,
 *      provisional/unparseable period bookkeeping, calendar partial-period
 *      detection, collision-free "أخرى" bucket and reserved chart keys. Any
 *      database stamped 2 (by this branch or an earlier build) is re-derived.
 *
 * Datasets with `syncStatus: "partial"` cannot be recomputed locally (only a
 * capped 50,000-row prefix is stored, while the engine derives from the full
 * export). recompute.ts lists them in `skippedPartial`; they keep their old
 * derived columns until a forced sync of that dataset re-downloads it.
 */
export const DERIVED_VERSION = 3;

export interface FieldStats {
  name: string;
  label: string;
  /** Normalized ODS type: text | int | double | date | datetime | boolean | geo_point_2d | geo_shape | file. */
  type: string;
  nullRate: number;
  distinctCount: number | "1000+";
  /** Numeric fields: actual min/max. Temporal fields: min/max as the original raw values. */
  min?: number | string;
  max?: number | string;
  mean?: number;
  /**
   * Numeric fields: the median. Exact up to 10,000 values per field; beyond
   * that it is taken from a deterministic reservoir sample (approximate).
   */
  median?: number;
  /** Only for text fields with distinctCount <= 30. */
  topValues?: Array<{ value: string; count: number }>;
  /** From the field's `annotations.unit`, else a "(km2)" / "(%)" suffix of its label, when present. */
  unit?: string;
  /** Text fields only, present only when true: >= 90% of the non-null values parse as numbers ("1,234.5"). */
  numericLike?: boolean;
  /** Present only when true: integer values within 1900..2100 AND a year-like name. Render as "2020", never "2,020". */
  looksLikeYear?: boolean;
  /** Present only when true: integer values AND an identifier-like name (id, code, phone, "رقم …") or a dense row-index. Never comma-group. */
  looksLikeIdentifier?: boolean;
}

export type StatsJson = Record<string, FieldStats>;

export interface GeoFieldMeta {
  name: string;
  label: string;
  type: string;
}

/** Metadata every chart type may carry so a caption can say what the plotted number is. */
interface VizMeta {
  /** Labels of classified dimension fields that were NOT plotted, i.e. the values were aggregated across them. */
  hiddenDimensions?: string[];
  /** Distinct "Total" values whose rows/categories were left out to avoid counting parts and total together. */
  excludedTotals?: string[];
  /**
   * Mean aggregates only: the published "Total" values that were USED (the overall rate/index) instead of an
   * unweighted mean of the parts. Those dimensions are at their Total level, so they are not in `hiddenDimensions`.
   */
  usedTotals?: string[];
  /** Mean aggregates only: the parts were averaged without weights because the published Total could not be used for every period. */
  unweightedMean?: true;
}

/** Extra metadata on the two temporal chart types. */
interface TemporalMeta {
  /**
   * The single most recent comparable value + % change (see src/lib/headline.ts).
   * `null` = computed and deliberately absent (ambiguous totals, non-additive
   * mean series); `undefined` = row synced before the field existed.
   */
  headline?: Headline | null;
  /** The last period has far fewer rows than its predecessors (year-to-date, half-filled month): draw it dashed, never headline it. */
  lastPeriodPartial?: boolean;
  /** Cadence of the series in grain units (3 for quarterly data in a month-grain chart). Gaps are filled at this step. */
  periodStep?: number;
  /** When the period was built from a year column + a separate "Month" column, the month column's name. */
  temporalMonthField?: string;
  /** Why `headline` is null for a multi-series chart (see HeadlineWithheld); absent when there is a headline. */
  headlineWithheld?: HeadlineWithheld;
  /** Periods (ascending, at most the last 12) whose rows carried a provisional marker such as "2024*". */
  provisionalPeriods?: string[];
  /** Rows left out because their period could not be read (only counted when they had a value); absent when 0. */
  droppedPeriodRows?: number;
  /** Provisional rows left out because the same period also had final rows; absent when 0. */
  supersededProvisionalRows?: number;
}

export type VizConfig =
  | ({
      type: "area";
      geoFields: GeoFieldMeta[];
      temporalField: string;
      temporalLabel: string;
      grain: Grain;
      measureField: string;
      measureLabel: string;
      unit?: string;
      aggregate: Aggregate;
    } & VizMeta &
      TemporalMeta)
  | ({
      type: "multi-line";
      geoFields: GeoFieldMeta[];
      temporalField: string;
      temporalLabel: string;
      grain: Grain;
      measureField: string;
      measureLabel: string;
      unit?: string;
      aggregate: Aggregate;
      seriesField: string;
      seriesLabel: string;
      seriesValues: string[];
      seriesOverflow: boolean;
      /** The one series that is the total of the others (kept as its own line, never summed with its parts); null/absent when none or ambiguous. */
      totalKey?: string | null;
      /** Series values that collided with a reserved chart key (period, __proto__, "...__partial") and were renamed in `seriesValues` and every row. */
      seriesKeyEscapes?: Array<{ from: string; to: string }>;
    } & VizMeta &
      TemporalMeta)
  | ({
      type: "bar-h";
      geoFields: GeoFieldMeta[];
      dimensionField: string;
      dimensionLabel: string;
      measureField: string;
      measureLabel: string;
      unit?: string;
      aggregate: Aggregate;
      categoryCount: number;
      otherBucketed: boolean;
      /** The synthetic bucket's label when it is not the default "أخرى" (a real category already uses that name). */
      otherLabel?: string;
    } & VizMeta)
  | ({
      type: "bar-stacked";
      geoFields: GeoFieldMeta[];
      xField: string;
      xLabel: string;
      seriesField: string;
      seriesLabel: string;
      seriesValues: string[];
      seriesOverflow: boolean;
      measureField: string;
      measureLabel: string;
      unit?: string;
      aggregate: Aggregate;
      otherBucketed: boolean;
      /** false for mean aggregates: stacking averages is meaningless, render grouped bars. Absent on rows synced before this field existed (stack). */
      stacked?: boolean;
      /** True when seriesValues ends with the aggregated "أخرى" series holding the dropped ones, so stack heights stay complete. */
      otherSeriesBucketed?: boolean;
      /** The label of the synthetic "rest" series and "rest" x-row when it is not the default "أخرى" (a real value already uses that name). */
      otherLabel?: string;
      /** Series values that collided with the reserved "category" / __proto__ key and were renamed in `seriesValues` and every row. */
      seriesKeyEscapes?: Array<{ from: string; to: string }>;
    } & VizMeta)
  | ({
      type: "histogram";
      geoFields: GeoFieldMeta[];
      measureField: string;
      measureLabel: string;
      unit?: string;
      binCount: number;
      min: number;
      max: number;
    } & VizMeta)
  | {
      type: "table";
      geoFields: GeoFieldMeta[];
      reason: "geo" | "no-viz";
    };

export interface DerivedFields {
  statsJson: StatsJson | null;
  vizConfig: VizConfig | null;
  chartData: unknown[] | null;
  summaryAr: string | null;
}

export interface ComputeDerivedOptions {
  /** Pin measure/aggregate/series for this call instead of the dataset's `src/config/viz-overrides.ts` entry (tests). `null` = no override. */
  override?: VizOverride | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEASURE_EXCLUDE_RE = /^(id|.*_id|code|.*_code)$/i;
// Not in the spec's literal exclusion list, but both are common enough
// across data.gov.bh exports that leaving them in routinely wins "best
// measure" over the actual data and produces a meaningless chart — see the
// Phase 3 handoff notes for the two real examples (a monthly-passengers
// dataset and a cinema-locations dataset) that motivated these additions:
//  - a bare "n" column (label "N") is a per-row sequence number on
//    virtually every dataset in this catalog. It usually gets caught by
//    the row-index heuristic below, but that heuristic only detects one
//    unbroken global run — some datasets restart "n" per facet/category,
//    which breaks the run detection while leaving a fully-non-null column
//    that then wins over a real (partially null) measure purely on
//    non-null count. A field literally named "n" is never a real measure.
//  - longitude/latitude coordinate fields (frequent on the ~37
//    "geographical-locations-of-*" datasets) are numeric but summing or
//    averaging degrees of latitude/longitude across records is never
//    meaningful, exactly like an id/code field.
const GENERIC_INDEX_NAME_RE = /^n$/i;
const COORDINATE_RE = /(longitude|latitude|\blng\b|\blat\b|خط الطول|خط العرض)/i;

const KNOWN_TYPES = new Set([
  "text",
  "int",
  "double",
  "date",
  "datetime",
  "boolean",
  "geo_point_2d",
  "geo_shape",
  "file",
]);

const DISTINCT_CAP = 1000;
const MAX_CHART_POINTS = 500;
const BAR_TOP_N = 15;
const SERIES_CAP = 8;
const OTHER_LABEL = "أخرى";
const MEDIAN_SAMPLE_CAP = 10_000;
const MAX_TOTAL_VALUES_PER_FIELD = 5;
const MAX_HIDDEN_DIMENSION_LABELS = 8;
const HISTOGRAM_BIN_COUNT = 10;
const MAX_PROVISIONAL_PERIODS = 12;
/** The twin key the chart draws a partial trailing period with (see PARTIAL_SUFFIX in src/lib/chart-model.ts). */
const PARTIAL_KEY_SUFFIX = "__partial";

/** Numbers stored as text: "1234", "1,234.5", "-3". Leading zeros are fine (identifiers). */
const NUMERIC_LIKE_RE = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
const IDENTIFIER_TOKENS = new Set([
  "id", "ids", "code", "codes", "serial", "ref", "zip", "postal", "phone", "mobile",
  "cpr", "passport", "ssn", "license", "licence",
]);
const IDENTIFIER_LAST_TOKENS = new Set(["no", "num", "nr", "number"]);
const ARABIC_IDENTIFIER_RE = /كود|رمز|معرف|هاتف|جوال|^رقم(?!\s+قياسي)/;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function normalizeType(raw: string | null | undefined): string {
  if (raw && KNOWN_TYPES.has(raw)) return raw;
  // Per spec: any unknown/unexpected type is treated as text.
  return "text";
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toDisplayString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    const t = raw.trim();
    return t === "" ? null : t;
  }
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return null;
}

function valueKey(raw: unknown): string {
  if (typeof raw === "object" && raw !== null) return JSON.stringify(raw);
  if (typeof raw === "string") return raw.trim();
  return String(raw);
}

function roundTo(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function clampIndex(i: number, max: number): number {
  if (i < 0) return 0;
  if (i > max) return max;
  return i;
}

/**
 * Evenly downsample to at most maxPoints, preserving order and the first/last
 * item. `keepIndex` forces one more item to survive (the headline's period
 * when the last, partial period is not the headline) by swapping it for the
 * nearest sampled item, so the chart still contains the number it is quoting
 * without exceeding maxPoints.
 */
function downsampleEvenly<T>(items: T[], maxPoints: number, keepIndex = -1): T[] {
  if (items.length <= maxPoints || maxPoints <= 1) return items.slice(0, maxPoints);
  const n = items.length;
  const picked: number[] = [];
  for (let i = 0; i < maxPoints; i++) picked.push(Math.floor((i * (n - 1)) / (maxPoints - 1)));
  if (keepIndex > 0 && keepIndex < n - 1 && !picked.includes(keepIndex)) {
    let nearest = 1;
    for (let i = 1; i < picked.length - 1; i++) {
      if (Math.abs(picked[i] - keepIndex) < Math.abs(picked[nearest] - keepIndex)) nearest = i;
    }
    picked[nearest] = keepIndex;
    picked.sort((a, b) => a - b);
  }
  return picked.map((i) => items[i]);
}

function hashSeed(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = (Math.imul(h, 33) ^ input.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

function parseNumericLike(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "" || s.length > 32) return null;
  const c = s.charCodeAt(0);
  // Cheap pre-filter: digits, '+', '-' only (this runs for every text cell).
  if (!((c >= 48 && c <= 57) || c === 43 || c === 45)) return null;
  if (!NUMERIC_LIKE_RE.test(s)) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function looksLikeIdentifierName(text: string): boolean {
  if (!text) return false;
  if (ARABIC_IDENTIFIER_RE.test(text.trim())) return true;
  const tokens = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  if (tokens.some((t) => IDENTIFIER_TOKENS.has(t))) return true;
  // "Reg No", "License Number" are identifiers; "Number of Registrations" is a count.
  return tokens.length > 0 && IDENTIFIER_LAST_TOKENS.has(tokens[tokens.length - 1]);
}

function extractUnit(field: CatalogField, label: string): string | null {
  const raw = (field as unknown as Record<string, unknown>).annotations;
  if (raw && typeof raw === "object") {
    const unit = (raw as Record<string, unknown>).unit;
    if (typeof unit === "string" && unit.trim() !== "") return unit.trim();
  }
  // data.gov.bh fields rarely carry annotations.unit; the unit usually lives
  // in the label itself ("Area (km2)", "Value (BHD)", "Unemployment (%)").
  return inferUnitFromLabel(label);
}

// ---------------------------------------------------------------------------
// Pass 1: per-field accumulators (single linear scan over `records`)
// ---------------------------------------------------------------------------

interface Accum {
  name: string;
  label: string;
  type: string;
  unit: string | null;
  looksTemporalByName: boolean;
  /** The whole name/label is just "Month" / "الشهر": a month-of-year part, never a date on its own. */
  looksMonthByName: boolean;

  total: number;
  nonNull: number;

  distinct: Set<string>;
  distinctCapped: boolean;
  freq: Map<string, number>; // only populated for type === "text"
  /** Text fields: distinct values that are exactly "Total"/"الإجمالي" (strict tier), capped; tracked even past the distinct cap. */
  totalValues: Set<string>;
  /** Text fields: distinct values that MAY be a total ("Total (all)", "All", "Kingdom of Bahrain"), capped; accepted only after a numeric check. */
  candidateValues: Set<string>;

  numSum: number;
  numSumSq: number;
  numCount: number;
  numMin: number | null;
  numMax: number | null;
  numAllInt: boolean;
  /** Deterministic reservoir for the median (exact up to MEDIAN_SAMPLE_CAP values). */
  numSample: number[];
  numSeen: number;
  rng: number;

  /** Text fields: how many non-null string values looked like numbers, and their range. */
  textTested: number;
  textNumeric: number;
  textNumMin: number | null;
  textNumMax: number | null;
  textNumAllInt: boolean;

  // Row-index heuristic: flags numeric fields whose values are a dense
  // 0- or 1-based +1 sequence (e.g. the "n" column present on almost every
  // data.gov.bh export) so they don't get treated as a real measure. Not
  // in the spec's literal exclusion regex, but "n" is common enough across
  // this specific catalog that leaving it in routinely won "best measure"
  // by sheer variance (1..N) — see PR notes.
  rowIndexCandidate: boolean;
  rowIndexExpected: number | null;

  temporalMinTime: number | null;
  temporalMaxTime: number | null;
  temporalMinRaw: string | null;
  temporalMaxRaw: string | null;
  temporalYearOnly: boolean;
  temporalParsed: number;
  /** How many parsed values carried a provisional marker ("2024*"). */
  temporalProvisional: number;

  // Sampled parse-rate check for text/int fields whose name/label looks
  // temporal (classification rule 3, second bullet).
  sampleAttempts: number;
  sampleOk: number;

  // Same check for month-of-year parts (1..12 or a month name).
  monthPartAttempts: number;
  monthPartOk: number;
}

function newAccum(field: CatalogField): Accum {
  const label = (field.label && field.label.trim()) || field.name;
  return {
    name: field.name,
    label,
    type: normalizeType(field.type),
    unit: extractUnit(field, label),
    looksTemporalByName: looksTemporalName(field.name) || looksTemporalName(label),
    looksMonthByName: isMonthOnlyName(field.name) || isMonthOnlyName(label),
    total: 0,
    nonNull: 0,
    distinct: new Set(),
    distinctCapped: false,
    freq: new Map(),
    totalValues: new Set(),
    candidateValues: new Set(),
    numSum: 0,
    numSumSq: 0,
    numCount: 0,
    numMin: null,
    numMax: null,
    numAllInt: true,
    numSample: [],
    numSeen: 0,
    rng: hashSeed(field.name),
    textTested: 0,
    textNumeric: 0,
    textNumMin: null,
    textNumMax: null,
    textNumAllInt: true,
    rowIndexCandidate: true,
    rowIndexExpected: null,
    temporalMinTime: null,
    temporalMaxTime: null,
    temporalMinRaw: null,
    temporalMaxRaw: null,
    temporalYearOnly: true,
    temporalParsed: 0,
    temporalProvisional: 0,
    sampleAttempts: 0,
    sampleOk: 0,
    monthPartAttempts: 0,
    monthPartOk: 0,
  };
}

function sampleForMedian(acc: Accum, n: number): void {
  acc.numSeen++;
  if (acc.numSample.length < MEDIAN_SAMPLE_CAP) {
    acc.numSample.push(n);
    return;
  }
  acc.rng = (Math.imul(acc.rng, 1664525) + 1013904223) >>> 0;
  // High bits only: the low bits of an LCG have tiny periods and biased the sample.
  const j = Math.floor((acc.rng / 4294967296) * acc.numSeen);
  if (j < MEDIAN_SAMPLE_CAP) acc.numSample[j] = n;
}

function buildAccumulators(
  fields: CatalogField[],
  records: Record<string, unknown>[],
  parseTemporal: (raw: unknown) => TemporalParts | null,
): Accum[] {
  const seen = new Set<string>();
  const accumList: Accum[] = [];
  for (const f of fields) {
    if (!f?.name || seen.has(f.name)) continue; // defensive: blank/duplicate field names
    seen.add(f.name);
    accumList.push(newAccum(f));
  }

  for (const row of records) {
    for (const acc of accumList) {
      acc.total++;
      const raw = row[acc.name];
      if (raw === null || raw === undefined) continue;
      acc.nonNull++;

      if (!acc.distinctCapped) {
        const key = valueKey(raw);
        if (!acc.distinct.has(key)) {
          if (acc.distinct.size >= DISTINCT_CAP) {
            acc.distinctCapped = true;
          } else {
            acc.distinct.add(key);
            if (acc.type === "text") {
              if (acc.totalValues.size < MAX_TOTAL_VALUES_PER_FIELD && isStrictTotalLabel(key)) {
                acc.totalValues.add(key);
              } else if (acc.candidateValues.size < MAX_TOTAL_VALUES_PER_FIELD && isTotalCandidateLabel(key)) {
                acc.candidateValues.add(key);
              }
            }
          }
        }
        if (!acc.distinctCapped && acc.type === "text") {
          acc.freq.set(key, (acc.freq.get(key) ?? 0) + 1);
        }
      }
      if (
        acc.distinctCapped &&
        acc.type === "text" &&
        typeof raw === "string" &&
        raw.length <= 24 &&
        acc.totalValues.size < MAX_TOTAL_VALUES_PER_FIELD &&
        isStrictTotalLabel(raw)
      ) {
        // A "Total" row can appear after the distinct cap was hit (long
        // commodity/country tables); it must still be recognised.
        acc.totalValues.add(raw.trim());
      }

      if (acc.type === "int" || acc.type === "double") {
        const n = toNumber(raw);
        if (n !== null) {
          acc.numCount++;
          acc.numSum += n;
          acc.numSumSq += n * n;
          acc.numMin = acc.numMin === null ? n : Math.min(acc.numMin, n);
          acc.numMax = acc.numMax === null ? n : Math.max(acc.numMax, n);
          if (!Number.isInteger(n)) acc.numAllInt = false;
          sampleForMedian(acc, n);

          if (acc.rowIndexCandidate) {
            if (!Number.isInteger(n)) {
              acc.rowIndexCandidate = false;
            } else if (acc.rowIndexExpected === null) {
              if (n === 0 || n === 1) acc.rowIndexExpected = n + 1;
              else acc.rowIndexCandidate = false;
            } else if (n === acc.rowIndexExpected) {
              acc.rowIndexExpected += 1;
            } else {
              acc.rowIndexCandidate = false;
            }
          }
        }
      }

      if (acc.type === "text" && typeof raw === "string") {
        acc.textTested++;
        const n = parseNumericLike(raw);
        if (n !== null) {
          acc.textNumeric++;
          acc.textNumMin = acc.textNumMin === null ? n : Math.min(acc.textNumMin, n);
          acc.textNumMax = acc.textNumMax === null ? n : Math.max(acc.textNumMax, n);
          if (!Number.isInteger(n)) acc.textNumAllInt = false;
        }
      }

      const trackTemporal =
        acc.type === "date" ||
        acc.type === "datetime" ||
        ((acc.type === "text" || acc.type === "int") && acc.looksTemporalByName);
      if (trackTemporal) {
        const parsed = parseTemporal(raw);
        if (acc.type !== "date" && acc.type !== "datetime") {
          acc.sampleAttempts++;
          if (parsed !== null) acc.sampleOk++;
        }
        if (parsed) {
          // Year/month grain bookkeeping also covers text/int temporal-looking
          // fields: a text "year" column used to fall through to month grain
          // and chart "2025-01" for a yearly series.
          const t = Date.UTC(parsed.year, (parsed.month ?? 1) - 1, 1);
          if (acc.temporalMinTime === null || t < acc.temporalMinTime) {
            acc.temporalMinTime = t;
            acc.temporalMinRaw = String(raw);
          }
          if (acc.temporalMaxTime === null || t > acc.temporalMaxTime) {
            acc.temporalMaxTime = t;
            acc.temporalMaxRaw = String(raw);
          }
          acc.temporalParsed++;
          if (parsed.provisional) acc.temporalProvisional++;
          if (parsed.month !== null) acc.temporalYearOnly = false;
        }
      }

      if (acc.looksMonthByName && (acc.type === "text" || acc.type === "int" || acc.type === "double")) {
        acc.monthPartAttempts++;
        if (parseMonthPart(raw) !== null) acc.monthPartOk++;
      }
    }
  }

  return accumList;
}

// ---------------------------------------------------------------------------
// statsJson
// ---------------------------------------------------------------------------

function buildStatsJson(accumList: Accum[]): StatsJson {
  // Built from entries so a field literally named "__proto__" becomes an own key (`out[name] = ...` would set the prototype and drop it).
  const entries: Array<[string, FieldStats]> = [];
  for (const acc of accumList) {
    const nullRate = acc.total > 0 ? roundTo((acc.total - acc.nonNull) / acc.total, 4) : 0;
    const distinctCount: number | "1000+" = acc.distinctCapped ? "1000+" : acc.distinct.size;

    const stat: FieldStats = { name: acc.name, label: acc.label, type: acc.type, nullRate, distinctCount };
    if (acc.unit) stat.unit = acc.unit;

    if ((acc.type === "int" || acc.type === "double") && acc.numCount > 0) {
      if (acc.numMin !== null) stat.min = acc.numMin;
      if (acc.numMax !== null) stat.max = acc.numMax;
      stat.mean = roundTo(acc.numSum / acc.numCount, 4);
      if (acc.numSample.length > 0) stat.median = roundTo(median(acc.numSample), 4);
    }

    if ((acc.type === "date" || acc.type === "datetime") && acc.temporalParsed > 0) {
      if (acc.temporalMinRaw !== null) stat.min = acc.temporalMinRaw;
      if (acc.temporalMaxRaw !== null) stat.max = acc.temporalMaxRaw;
    }

    if (acc.type === "text" && !acc.distinctCapped && acc.distinct.size > 0 && acc.distinct.size <= 30) {
      stat.topValues = [...acc.freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([value, count]) => ({ value, count }));
    }

    const textNumericLike = acc.type === "text" && acc.textTested > 0 && acc.textNumeric / acc.textTested >= 0.9;
    if (textNumericLike) stat.numericLike = true;

    // Integer-valued numbers (real numeric fields, or numeric text) that are
    // years / identifiers must never be comma-grouped by the records table.
    const integerRange =
      (acc.type === "int" || acc.type === "double") && acc.numCount > 0 && acc.numAllInt
        ? { min: acc.numMin, max: acc.numMax }
        : textNumericLike && acc.textNumAllInt
          ? { min: acc.textNumMin, max: acc.textNumMax }
          : null;
    if (integerRange && integerRange.min !== null && integerRange.max !== null) {
      if (
        integerRange.min >= 1900 &&
        integerRange.max <= 2100 &&
        (looksYearName(acc.name) || looksYearName(acc.label))
      ) {
        stat.looksLikeYear = true;
      }
      if (
        (acc.rowIndexCandidate && acc.numCount >= 5) ||
        looksLikeIdentifierName(acc.name) ||
        looksLikeIdentifierName(acc.label) ||
        // the same predicate that keeps these columns out of the chart measure (Building, Road, Block, Phone ...)
        isIdentifierLikeName(acc.name) ||
        isIdentifierLikeName(acc.label)
      ) {
        stat.looksLikeIdentifier = true;
      }
    }

    entries.push([acc.name, stat]);
  }
  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface ClassifiedField {
  name: string;
  label: string;
  accum: Accum;
}

interface DimensionField extends ClassifiedField {
  seriesAble: boolean;
  distinctCount: number;
}

interface Classification {
  temporal: ClassifiedField[];
  measure: ClassifiedField[];
  dimension: DimensionField[];
  geo: ClassifiedField[];
  /** "Month" columns holding 1..12 / month names: not dates by themselves, combined with a sibling year column when one exists. */
  monthParts: ClassifiedField[];
}

function classifyFields(accumList: Accum[]): Classification {
  const temporal: ClassifiedField[] = [];
  const measure: ClassifiedField[] = [];
  const dimension: DimensionField[] = [];
  const geo: ClassifiedField[] = [];
  const monthParts: ClassifiedField[] = [];

  for (const acc of accumList) {
    const cf: ClassifiedField = { name: acc.name, label: acc.label, accum: acc };

    let isTemporal = false;
    if (acc.type === "date" || acc.type === "datetime") {
      isTemporal = true;
    } else if ((acc.type === "text" || acc.type === "int") && acc.looksTemporalByName && acc.sampleAttempts > 0) {
      isTemporal = acc.sampleOk / acc.sampleAttempts >= 0.9;
    }
    if (isTemporal) {
      temporal.push(cf);
      continue;
    }

    const isNumeric = acc.type === "int" || acc.type === "double";

    // A "Month" column of 1..12 / month names is a part of a date, not a
    // standalone temporal field, and (when numeric) not a measure either.
    if (
      acc.looksMonthByName &&
      (acc.type === "text" || isNumeric) &&
      acc.monthPartAttempts > 0 &&
      acc.monthPartOk / acc.monthPartAttempts >= 0.9
    ) {
      monthParts.push(cf);
      if (isNumeric) continue;
    }
    // Same for a numeric "Quarter" column of 1..4.
    if (
      isNumeric &&
      (isQuarterOnlyName(acc.name) || isQuarterOnlyName(acc.label)) &&
      acc.numAllInt &&
      acc.numMin !== null &&
      acc.numMax !== null &&
      acc.numMin >= 1 &&
      acc.numMax <= 4
    ) {
      continue;
    }

    const isRowIndex =
      (acc.rowIndexCandidate && acc.numCount >= 5) || GENERIC_INDEX_NAME_RE.test(acc.name);
    const isCoordinate = COORDINATE_RE.test(acc.name) || COORDINATE_RE.test(acc.label);
    // A whole-label identifier / address part ("Phone", "Building", "Road No", "License Number") holding integers is a
    // name, not a quantity: summing building numbers produced "Northern بقيمة 22,100". A viz override can still pin it.
    const isIdentifierMeasure =
      acc.numAllInt && (isIdentifierLikeName(acc.name) || isIdentifierLikeName(acc.label));
    if (isNumeric && !MEASURE_EXCLUDE_RE.test(acc.name) && !isRowIndex && !isCoordinate && !isIdentifierMeasure) {
      measure.push(cf);
      continue;
    }

    if (acc.type === "text" && !acc.distinctCapped && acc.distinct.size >= 2 && acc.distinct.size <= 30) {
      dimension.push({ ...cf, seriesAble: acc.distinct.size <= 8, distinctCount: acc.distinct.size });
      continue;
    }

    if (acc.type === "geo_point_2d" || acc.type === "geo_shape") {
      geo.push(cf);
    }
  }

  return { temporal, measure, dimension, geo, monthParts };
}

/**
 * Scale-free spread: std / (|mean| + std), bounded to [0, 1] and well defined
 * for a mean at or near 0 or negative. The raw variance it replaces made a
 * population column always beat a percent column when counts tied.
 */
function measureSpread(acc: Accum): number {
  if (acc.numCount === 0) return 0;
  const mean = acc.numSum / acc.numCount;
  const variance = acc.numSumSq / acc.numCount - mean * mean;
  const std = variance > 0 ? Math.sqrt(variance) : 0;
  const denom = Math.abs(mean) + std;
  return denom > 0 ? std / denom : 0;
}

/** An additive measure whose spread is below this is "nearly flat" (a population that moves 0.05%): not worth plotting over a column that varies. */
const INFORMATIVE_SPREAD = 0.02;

function isTotalNamed(m: ClassifiedField): boolean {
  return [m.name, m.label].some((t) => isStrictTotalLabel(t) || isLooseTotalLabel(t));
}

function meanMagnitude(acc: Accum): number {
  return acc.numCount > 0 ? Math.abs(acc.numSum / acc.numCount) : 0;
}

/** First best by `score`; ties keep schema order (the pool is in schema order). */
function bestBy<T>(items: T[], score: (item: T) => number): T {
  let best = items[0];
  let bestScore = score(best);
  for (let i = 1; i < items.length; i++) {
    const sc = score(items[i]);
    if (sc > bestScore) {
      best = items[i];
      bestScore = sc;
    }
  }
  return best;
}

/**
 * "best" measure = highest non-null count with non-constant values (spec's
 * area-chart rule, reused everywhere a single measure must be picked). Columns
 * that TIE on count are compared like with like:
 *
 *   1. grouped by (inferred aggregate, unit): a count and a percent are not
 *      comparable, nor are persons and BHD;
 *   2. inside an additive group the winner is the column named like a total
 *      ("Total", "الإجمالي", a unique match only), else the one with the
 *      largest magnitude: for non-negative additive columns the total is never
 *      smaller than its parts, so a wide table's "Total" or "Kingdom" column
 *      wins (the scale-free spread alone can only ever pick a component);
 *   3. inside a rate/index group the more spread-out column wins;
 *   4. across groups the additive representative wins if it actually varies,
 *      otherwise the most spread-out representative does (a flat population
 *      column does not beat a percent series).
 *
 * Schema order is the final tie-break.
 */
function pickBestMeasure(measures: ClassifiedField[], ctx: BuildContext): ClassifiedField | null {
  const withData = measures.filter((m) => m.accum.numCount > 0);
  if (withData.length === 0) return null;
  const nonConstant = withData.filter((m) => m.accum.numMin !== m.accum.numMax);
  const pool = nonConstant.length > 0 ? nonConstant : withData;
  const bestCount = pool.reduce((m, c) => Math.max(m, c.accum.numCount), 0);
  const top = pool.filter((m) => m.accum.numCount === bestCount);
  if (top.length === 1) return top[0];

  const groups = new Map<string, { aggregate: Aggregate; members: ClassifiedField[] }>();
  for (const m of top) {
    const aggregate = aggregateKindFor(m, ctx);
    const key = `${aggregate}\u0000${m.accum.unit ?? ""}`;
    const g = groups.get(key);
    if (g) g.members.push(m);
    else groups.set(key, { aggregate, members: [m] });
  }

  const reps = [...groups.values()].map(({ aggregate, members }) => {
    if (members.length === 1) return { aggregate, pick: members[0] };
    if (aggregate === "mean") return { aggregate, pick: bestBy(members, (m) => measureSpread(m.accum)) };
    const named = members.filter(isTotalNamed);
    return { aggregate, pick: named.length === 1 ? named[0] : bestBy(members, (m) => meanMagnitude(m.accum)) };
  });
  if (reps.length === 1) return reps[0].pick;

  const additive = reps.filter((r) => r.aggregate !== "mean" && measureSpread(r.pick.accum) >= INFORMATIVE_SPREAD);
  return bestBy(additive.length > 0 ? additive : reps, (r) => measureSpread(r.pick.accum)).pick;
}

// ---------------------------------------------------------------------------
// Build context: overrides + total-row detection
// ---------------------------------------------------------------------------

interface TotalField {
  name: string;
  /** Strict totals ("Total", "الإجمالي"): dropped on a hidden dimension by label alone. */
  values: Set<string>;
  /** Possible totals ("Total (all)", "All nationalities", "Kingdom of Bahrain"): dropped only after the numbers agree. */
  candidates: Set<string>;
}

interface BuildContext {
  datasetId: string;
  /** Memoizing temporal parser shared by every pass over this dataset's rows. */
  parseTemporal: (raw: unknown) => TemporalParts | null;
  override: VizOverride | undefined;
  /** Text fields that carry a strict "Total" value or a total candidate next to non-total siblings. */
  totalFields: TotalField[];
  /** The classified dimensions: the "other dimensions" a candidate total is compared with its siblings within. */
  dimensions: DimensionField[];
  /** Memoized numeric verification of total candidates, keyed by field | measure | period source. */
  verified: Map<string, Set<string>>;
}

function aggregateKindFor(measure: ClassifiedField, ctx: BuildContext): Aggregate {
  if (ctx.override?.aggregate) return ctx.override.aggregate;
  return inferAggregate({ name: measure.name, label: measure.label, unit: measure.accum.unit });
}

/** The measure list a builder should pick from: the override's pinned field when valid, else the classified measures. */
function resolveMeasures(classification: Classification, accumList: Accum[], ctx: BuildContext): ClassifiedField[] {
  const pinned = ctx.override?.measureField;
  if (!pinned) return classification.measure;
  const acc = accumList.find((a) => a.name === pinned);
  if (acc && (acc.type === "int" || acc.type === "double") && acc.numCount > 0) {
    return [{ name: acc.name, label: acc.label, accum: acc }];
  }
  console.warn(
    `[derived] viz override for ${ctx.datasetId}: measureField "${pinned}" is not a numeric field with data; using the inferred measure.`,
  );
  return classification.measure;
}

function collectTotalFields(accumList: Accum[], temporalNames: ReadonlySet<string>): TotalField[] {
  const out: TotalField[] = [];
  for (const acc of accumList) {
    if (acc.type !== "text" || temporalNames.has(acc.name)) continue;
    const special = acc.totalValues.size + acc.candidateValues.size;
    if (special === 0) continue;
    // Only a dimension that also has non-total siblings: a constant "Total" column has nothing to double count.
    if (!acc.distinctCapped && acc.distinct.size <= special) continue;
    out.push({ name: acc.name, values: acc.totalValues, candidates: acc.candidateValues });
  }
  return out;
}

/** A hidden dimension and the Total values that stand for "all of it". */
interface GateField {
  name: string;
  values: ReadonlySet<string>;
}

interface RowGate {
  /**
   * "drop": Total rows on hidden dimensions are left out (parts are summed/averaged).
   * "only": a mean (rate, index) keeps ONLY the rows that are the published Total on every hidden
   * total-bearing dimension: the overall rate, not an unweighted mean of the sub-rates.
   */
  mode: "drop" | "only";
  /** True when the row must be left out. */
  skip(row: Record<string, unknown>): boolean;
  /** Distinct total values dropped so far (hidden rows, plus plotted categories the builders add). */
  dropped: Set<string>;
  /** True once a hidden-dimension Total row was dropped. */
  hiddenDropped: boolean;
  /** "only" mode: the Total values that were used. */
  used: Set<string>;
  /** "only" mode: the hidden dimensions that stand at their Total (not "aggregated across"). */
  fieldNames: ReadonlySet<string>;
}

function makeRowGate(active: GateField[], mode: "drop" | "only"): RowGate {
  const dropped = new Set<string>();
  const used = new Set<string>();
  const gate: RowGate = {
    mode,
    dropped,
    used,
    hiddenDropped: false,
    fieldNames: new Set(mode === "only" ? active.map((f) => f.name) : []),
    skip(row) {
      if (mode === "only") {
        for (const f of active) {
          const raw = row[f.name];
          if (typeof raw !== "string" || !f.values.has(raw.trim())) return true;
        }
        for (const f of active) used.add((row[f.name] as string).trim());
        return false;
      }
      for (const f of active) {
        const raw = row[f.name];
        if (typeof raw !== "string") continue;
        const v = raw.trim();
        if (f.values.has(v)) {
          dropped.add(v);
          gate.hiddenDropped = true;
          return true;
        }
      }
      return false;
    },
  };
  return gate;
}

/** What a builder tells the totals machinery about the chart it is building. */
interface TotalsSpec {
  aggregate: Aggregate;
  measure: ClassifiedField;
  /** The chart cell a row feeds (period, period|series, category, x|series); null when the row cannot be charted. */
  keyOf(row: Record<string, unknown>): string | null;
  /** The period a row belongs to; undefined for charts without a time axis. */
  periodOf?: (row: Record<string, unknown>) => string | null;
  /** Identifies the period source for memoization. */
  periodId?: string;
  /** Skip the numeric verification of candidates (histogram: rows are not cells). */
  noVerify?: boolean;
}

/** Cap on (period x other-dimension) cells the numeric check holds; beyond it nothing is verified (the safe answer). */
const MAX_VERIFY_CELLS = 50_000;
const MAX_VERIFY_DIMENSIONS = 6;

/**
 * Which candidate totals of hidden dimension `f` really are totals: in every
 * (period x other dimensions) cell the candidate equals the sum of the other
 * values of `f`, never less than the largest of them (series.ts totalCellsAgree).
 * Label tiers only NOMINATE; this is what accepts. Skipped for means (a sum
 * check is meaningless) and bailed out on negative values or too many cells.
 */
function verifyTotalCandidates(
  ctx: BuildContext,
  records: Record<string, unknown>[],
  f: TotalField,
  spec: TotalsSpec,
): Set<string> {
  const none = new Set<string>();
  if (spec.aggregate === "mean" || spec.noVerify || f.candidates.size < 1) return none;
  const memoKey = `${f.name}\u0000${spec.measure.name}\u0000${spec.periodId ?? ""}`;
  const memo = ctx.verified.get(memoKey);
  if (memo) return memo;

  // Other dimensions identify "the same cell", except a bilingual twin of `f` (it differs on every sibling).
  const cellDims = ctx.dimensions
    .filter((d) => d.name !== f.name && !isRedundantDimensionPair(records, f.name, d.name))
    .slice(0, MAX_VERIFY_DIMENSIONS);

  interface VCell {
    cand: Map<string, number>;
    siblings: number;
    siblingCount: number;
    maxSibling: number;
    allIntegers: boolean;
  }
  const cells = new Map<string, VCell>();
  let aborted = false;
  for (const row of records) {
    const raw = row[f.name];
    if (typeof raw !== "string") continue;
    const v = raw.trim();
    if (v === "" || f.values.has(v)) continue; // strict totals are dropped anyway: not parts
    const val = toNumber(row[spec.measure.name]);
    if (val === null) continue;
    if (val < 0) {
      aborted = true;
      break;
    }
    const period = spec.periodOf ? spec.periodOf(row) : "";
    if (period === null) continue;
    let key = period;
    for (const d of cellDims) key += `\u0000${toDisplayString(row[d.name]) ?? ""}`;
    let cell = cells.get(key);
    if (!cell) {
      if (cells.size >= MAX_VERIFY_CELLS) {
        aborted = true;
        break;
      }
      cell = { cand: new Map(), siblings: 0, siblingCount: 0, maxSibling: 0, allIntegers: true };
      cells.set(key, cell);
    }
    if (f.candidates.has(v)) {
      cell.cand.set(v, (cell.cand.get(v) ?? 0) + val);
    } else {
      cell.siblings += val;
      cell.siblingCount++;
      if (val > cell.maxSibling) cell.maxSibling = val;
      if (!Number.isInteger(val)) cell.allIntegers = false;
    }
  }

  const ok = new Set<string>();
  if (!aborted) {
    for (const cand of f.candidates) {
      const evidence: TotalCell[] = [];
      for (const c of cells.values()) {
        const candidate = c.cand.get(cand);
        if (candidate === undefined) continue;
        evidence.push({
          candidate,
          siblings: c.siblings,
          maxSibling: c.maxSibling,
          siblingCount: c.siblingCount,
          allIntegers: c.allIntegers && Number.isInteger(candidate),
        });
      }
      if (totalCellsAgree(evidence)) ok.add(cand);
    }
  }
  ctx.verified.set(memoKey, ok);
  return ok;
}

/**
 * For a MEAN measure (a rate, an index) the published Total on a hidden
 * dimension IS the overall figure, and an unweighted mean of its parts is not
 * (the mean of twelve age-group rates is not the national rate). The Total-only
 * pass is used only when it is safe, decided ONCE for the whole dataset:
 *   - every chart cell that has part rows also has a Total row (otherwise the
 *     chart would silently shrink to the periods that have one);
 *   - at least one cell has a Total on EVERY hidden total-bearing dimension;
 *   - the Total is not simply the sum of its parts (a distribution of shares
 *     that adds to 100 would flatten into a constant 100%).
 */
function totalOnlyUsable(records: Record<string, unknown>[], fields: GateField[], spec: TotalsSpec): boolean {
  const parts = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const row of records) {
    const key = spec.keyOf(row);
    if (key === null) continue;
    const val = toNumber(row[spec.measure.name]);
    if (val === null) continue;
    let totalOn = 0;
    for (const f of fields) {
      const raw = row[f.name];
      if (typeof raw === "string" && f.values.has(raw.trim())) totalOn++;
    }
    if (totalOn === fields.length) totals.set(key, (totals.get(key) ?? 0) + val);
    else if (totalOn === 0) parts.set(key, (parts.get(key) ?? 0) + val);
    // a mix (Total on one dimension, a part on another) belongs to neither pass
  }
  if (totals.size === 0) return false;
  for (const key of parts.keys()) if (!totals.has(key)) return false;

  let compared = 0;
  let additive = 0;
  for (const [key, partSum] of parts) {
    const totalSum = totals.get(key)!;
    compared++;
    if (Math.abs(totalSum - partSum) <= 0.01 * Math.abs(totalSum)) additive++;
  }
  return !(compared > 0 && additive / compared >= 0.8);
}

/**
 * Runs a builder with totals handled; if that leaves the chart empty (a table
 * that ONLY has total rows) runs it once more keeping them. The decision is
 * whole-dataset on purpose: a per-period fallback would mix total-only and
 * parts-only periods in one line.
 *
 *   mean:    the published overall figure when the table has it for every cell
 *            ("only" mode), else the parts (and the builder withholds the headline);
 *   others:  strict Totals and numerically verified candidates are dropped.
 */
function withTotalsFallback<T>(
  ctx: BuildContext,
  records: Record<string, unknown>[],
  plotted: ReadonlySet<string>,
  spec: TotalsSpec,
  attempt: (gate: RowGate, dropPlotted: boolean) => T | null,
): T | null {
  const hidden = ctx.totalFields.filter((f) => !plotted.has(f.name));

  if (spec.aggregate === "mean") {
    const strict = hidden.filter((f) => f.values.size > 0).map((f) => ({ name: f.name, values: f.values }));
    if (strict.length > 0 && totalOnlyUsable(records, strict, spec)) {
      const built = attempt(makeRowGate(strict, "only"), true);
      if (built !== null) return built;
    }
  }

  const active: GateField[] = [];
  for (const f of hidden) {
    const values = new Set(f.values);
    for (const c of verifyTotalCandidates(ctx, records, f, spec)) values.add(c);
    if (values.size > 0) active.push({ name: f.name, values });
  }
  const gate = makeRowGate(active, "drop");
  const first = attempt(gate, true);
  if (first !== null || gate.dropped.size === 0) return first;
  return attempt(makeRowGate([], "drop"), false);
}

function metaFrom(
  gate: RowGate,
  classification: Classification,
  plotted: ReadonlySet<string>,
  aggregate: Aggregate,
): VizMeta {
  const hidden = classification.dimension
    .filter((d) => !plotted.has(d.name) && !gate.fieldNames.has(d.name))
    .map((d) => d.label);
  const meta: VizMeta = {};
  const uniqueHidden = [...new Set(hidden)].slice(0, MAX_HIDDEN_DIMENSION_LABELS);
  if (uniqueHidden.length > 0) meta.hiddenDimensions = uniqueHidden;
  if (gate.dropped.size > 0) meta.excludedTotals = [...gate.dropped].sort();
  if (gate.used.size > 0) meta.usedTotals = [...gate.used].sort();
  if (aggregate === "mean" && gate.mode === "drop" && gate.hiddenDropped) meta.unweightedMean = true;
  return meta;
}

// ---------------------------------------------------------------------------
// Aggregation cells
// ---------------------------------------------------------------------------

/**
 * One (period | category | cell) accumulator. Tracks everything needed for
 * sum, mean and last at once: `last*` follows the greatest sub-key seen
 * (month*100+day inside a period, the row index for non-temporal charts) and
 * sums the rows that share it, so "last" = the latest observation, summed
 * across hidden dimensions at that date.
 */
interface Cell {
  sum: number;
  count: number;
  abs: number;
  lastKey: number;
  lastSum: number;
}

function newCell(): Cell {
  return { sum: 0, count: 0, abs: 0, lastKey: -1, lastSum: 0 };
}

function addToCell(cell: Cell, val: number, subKey: number): void {
  cell.sum += val;
  cell.count += 1;
  cell.abs += Math.abs(val);
  if (subKey > cell.lastKey) {
    cell.lastKey = subKey;
    cell.lastSum = val;
  } else if (subKey === cell.lastKey) {
    cell.lastSum += val;
  }
}

function cellValue(cell: Cell, aggregate: Aggregate): number {
  if (aggregate === "mean") return cell.sum / cell.count;
  if (aggregate === "last") return cell.lastSum;
  return cell.sum;
}

/** Combine several cells into one value (the "Other" bucket): sums add, means are weighted, lasts add. */
function combinedValue(cells: Cell[], aggregate: Aggregate): number | null {
  if (cells.length === 0) return null;
  if (aggregate === "mean") {
    let sum = 0;
    let count = 0;
    for (const c of cells) {
      sum += c.sum;
      count += c.count;
    }
    return count > 0 ? sum / count : null;
  }
  let total = 0;
  for (const c of cells) total += aggregate === "last" ? c.lastSum : c.sum;
  return total;
}

// ---------------------------------------------------------------------------
// Temporal source (a date field, or a year field + a "Month" part)
// ---------------------------------------------------------------------------

interface TemporalSource {
  name: string;
  label: string;
  grain: Grain;
  /** Every field the period is built from (excluded from "hidden dimensions"). */
  fieldNames: string[];
  monthField?: ClassifiedField;
  /** Some values of the period field carry a provisional marker ("2024*"). */
  hasProvisional: boolean;
  read(row: Record<string, unknown>): TemporalParts | null;
}

function grainFor(temporalField: ClassifiedField): Grain {
  return temporalField.accum.temporalYearOnly && temporalField.accum.temporalParsed > 0 ? "year" : "month";
}

function temporalSourceFor(
  primary: ClassifiedField,
  monthParts: ClassifiedField[],
  parseTemporal: (raw: unknown) => TemporalParts | null,
): TemporalSource {
  const grain = grainFor(primary);
  const monthField = grain === "year" ? monthParts[0] : undefined;
  const hasProvisional = primary.accum.temporalProvisional > 0;
  if (monthField) {
    return {
      name: primary.name,
      label: primary.label,
      grain: "month",
      fieldNames: [primary.name, monthField.name],
      monthField,
      hasProvisional,
      read(row) {
        const y = parseTemporal(row[primary.name]);
        if (!y) return null;
        if (y.month !== null) return y; // the year column already carries a month: trust it
        const month = parseMonthPart(row[monthField.name]);
        return month === null
          ? null
          : { year: y.year, month, day: null, ...(y.provisional ? { provisional: true as const } : {}) };
      },
    };
  }
  return {
    name: primary.name,
    label: primary.label,
    grain,
    fieldNames: [primary.name],
    hasProvisional,
    read: (row) => parseTemporal(row[primary.name]),
  };
}

function periodKeyFor(parsed: { year: number; month: number | null }, grain: Grain): string {
  return grain === "year" ? String(parsed.year) : `${parsed.year}-${pad2(parsed.month ?? 1)}`;
}

function subKeyFor(parsed: TemporalParts): number {
  return (parsed.month ?? 0) * 100 + (parsed.day ?? 0);
}

function geoMeta(geo: ClassifiedField[]): GeoFieldMeta[] {
  return geo.map((g) => ({ name: g.name, label: g.label, type: g.accum.type }));
}

/** Bookkeeping about the rows of a temporal chart that were NOT charted as given (never silent). */
interface PeriodAudit {
  provisional: Set<string>;
  droppedPeriodRows: number;
  supersededProvisionalRows: number;
}

function newPeriodAudit(): PeriodAudit {
  return { provisional: new Set(), droppedPeriodRows: 0, supersededProvisionalRows: 0 };
}

function temporalMetaFor(
  temporal: TemporalSource,
  headline: Headline | null,
  lastPeriodPartial: boolean,
  step: number,
  extra: { withheld: HeadlineWithheld | null; audit: PeriodAudit },
): TemporalMeta {
  const provisional = [...extra.audit.provisional].sort().slice(-MAX_PROVISIONAL_PERIODS);
  return {
    headline,
    lastPeriodPartial,
    periodStep: step,
    ...(temporal.monthField ? { temporalMonthField: temporal.monthField.name } : {}),
    ...(headline === null && extra.withheld ? { headlineWithheld: extra.withheld } : {}),
    ...(provisional.length > 0 ? { provisionalPeriods: provisional } : {}),
    ...(extra.audit.droppedPeriodRows > 0 ? { droppedPeriodRows: extra.audit.droppedPeriodRows } : {}),
    ...(extra.audit.supersededProvisionalRows > 0
      ? { supersededProvisionalRows: extra.audit.supersededProvisionalRows }
      : {}),
  };
}

/** The headline, flagged provisional when its period's rows carried a marker, and the reason when there is none. */
function finishHeadline(
  src: HeadlineSource,
  fullRows: ReadonlyArray<Record<string, unknown>>,
  audit: PeriodAudit,
  unweighted: boolean,
): { headline: Headline | null; withheld: HeadlineWithheld | null } {
  // A mean over parts whose published Total could not be used is an unweighted mean of sub-rates: not THE rate.
  if (unweighted) return { headline: null, withheld: "unweighted-mean" };
  const computed = computeHeadline(src, fullRows);
  if (!computed) return { headline: null, withheld: headlineWithheldReason(src, fullRows) };
  return {
    headline: audit.provisional.has(computed.period) ? { ...computed, provisional: true } : computed,
    withheld: null,
  };
}

/**
 * Keys (a period, or period + series) that have at least one FINAL row. A
 * provisional row for the same key is superseded by it: merging "2024" and
 * "2024*" into one period would count the same figure twice. Only run when the
 * period column actually contains provisional values.
 */
function finalKeysOf(
  records: Record<string, unknown>[],
  gate: RowGate,
  temporal: TemporalSource,
  measureName: string,
  seriesName?: string,
): Set<string> {
  const finals = new Set<string>();
  for (const row of records) {
    if (gate.skip(row)) continue;
    if (toNumber(row[measureName]) === null) continue;
    const parsed = temporal.read(row);
    if (!parsed || parsed.provisional) continue;
    const period = periodKeyFor(parsed, temporal.grain);
    if (seriesName === undefined) {
      finals.add(period);
    } else {
      const cat = toDisplayString(row[seriesName]);
      if (cat !== null) finals.add(`${period}\u0000${cat}`);
    }
  }
  return finals;
}

/** Row count and (month grain) the latest day seen, per period: what the completeness rules judge. */
function coverageOf(period: string, cells: Iterable<Cell>, grain: Grain): PeriodCoverage {
  let count = 0;
  let maxDay = 0;
  for (const c of cells) {
    count += c.count;
    if (grain === "month" && c.lastKey >= 0) maxDay = Math.max(maxDay, c.lastKey % 100);
  }
  return { period, count, ...(maxDay > 0 ? { maxDay } : {}) };
}

/** Is the last period incomplete? Honors a `lastPeriod` pin in viz-overrides; only sums are judged (a mean is not distorted by a short period). */
function judgeLastPeriodPartial(ctx: BuildContext, aggregate: Aggregate, coverage: PeriodCoverage[]): boolean {
  const pinned = ctx.override?.lastPeriod;
  if (pinned === "complete") return false;
  if (pinned === "partial") return coverage.length >= 2;
  return aggregate === "sum" && isLastPeriodPartial(coverage);
}

/**
 * Renames series values that would collide with a reserved row key. A chart
 * row is `{ period | category, <series>: value }`, so a series called "period"
 * would overwrite the x value, "__proto__" cannot be assigned at all, and
 * "<k>__partial" is the twin key the chart draws a partial segment with.
 * Deterministic (`«period»`, then trailing "_" until unique) and recorded in
 * vizConfig, so the legend shows «period» instead of a broken chart.
 */
function planSeriesKeys(
  names: readonly string[],
  reserved: (name: string) => boolean,
): { keyOf: (name: string) => string; escapes: Array<{ from: string; to: string }> } {
  const taken = new Set(names);
  const renamed = new Map<string, string>();
  const escapes: Array<{ from: string; to: string }> = [];
  for (const name of names) {
    if (!reserved(name)) continue;
    let to = `«${name}»`;
    while (taken.has(to)) to += "_";
    taken.add(to);
    renamed.set(name, to);
    escapes.push({ from: name, to });
  }
  return { keyOf: (name) => renamed.get(name) ?? name, escapes };
}

const reservedMultiLineKey = (k: string) => k === "period" || k === "__proto__" || k.endsWith(PARTIAL_KEY_SUFFIX);
const reservedStackedKey = (k: string) => k === "category" || k === "__proto__";

/** "أخرى", or "أخرى (البقية)" (then " 2", " 3" ...) when a real value already carries the name. */
function uniqueOtherLabel(taken: ReadonlySet<string>): string {
  if (!taken.has(OTHER_LABEL)) return OTHER_LABEL;
  let label = `${OTHER_LABEL} (البقية)`;
  for (let i = 2; taken.has(label); i++) label = `${OTHER_LABEL} (البقية) ${i}`;
  return label;
}

/**
 * A plotted category/series that is numerically the sum of the others. Only
 * values the labels NOMINATE ("Kingdom of Bahrain", "All") are considered, and
 * only for additive measures: label proposes, arithmetic disposes. `slots`
 * are the rows the sum is checked in (one per series for x categories, one per
 * x for series; a single one for a bar chart).
 */
function numericPlottedTotal(
  names: readonly string[],
  slots: ReadonlyArray<Record<string, unknown>>,
  minCells: number,
): string | null {
  if (names.length < 3) return null;
  const candidates = names.filter((n) => isTotalCandidateLabel(n));
  if (candidates.length === 0) return null;
  return findNumericTotalSeries(slots, names, { candidates, minCells });
}

// ---------------------------------------------------------------------------
// Chart builders — each does its own light second pass over `records` for
// just the 2-3 fields it needs, and returns null (rather than a degenerate
// chart) if it can't actually produce data, so the caller falls through to
// the next rule in the decision tree.
// ---------------------------------------------------------------------------

type Built = { vizConfig: VizConfig; chartData: unknown[] };

function buildArea(
  ctx: BuildContext,
  records: Record<string, unknown>[],
  temporal: TemporalSource,
  measures: ClassifiedField[],
  classification: Classification,
  geoFields: GeoFieldMeta[],
): Built | null {
  const measure = pickBestMeasure(measures, ctx);
  if (!measure) return null;
  const aggregate = aggregateKindFor(measure, ctx);
  const plotted = new Set([...temporal.fieldNames, measure.name]);
  const periodOf = (row: Record<string, unknown>) => {
    const p = temporal.read(row);
    return p ? periodKeyFor(p, temporal.grain) : null;
  };
  const spec: TotalsSpec = { aggregate, measure, keyOf: periodOf, periodOf, periodId: `${temporal.name}|${temporal.grain}` };

  return withTotalsFallback(ctx, records, plotted, spec, (gate) => {
    const groups = new Map<string, Cell>();
    const audit = newPeriodAudit();
    const finals = temporal.hasProvisional ? finalKeysOf(records, gate, temporal, measure.name) : null;
    for (const row of records) {
      if (gate.skip(row)) continue;
      const val = toNumber(row[measure.name]);
      if (val === null) continue;
      const parsed = temporal.read(row);
      if (!parsed) {
        audit.droppedPeriodRows++;
        continue;
      }
      const period = periodKeyFor(parsed, temporal.grain);
      if (parsed.provisional) {
        if (finals?.has(period)) {
          audit.supersededProvisionalRows++;
          continue;
        }
        audit.provisional.add(period);
      }
      let g = groups.get(period);
      if (!g) {
        g = newCell();
        groups.set(period, g);
      }
      addToCell(g, val, subKeyFor(parsed));
    }
    if (groups.size === 0) return null;

    // Judge completeness and compute the headline on the FULL period list,
    // before gap filling and downsampling shrink or reshape it.
    const realPeriods = [...groups.keys()].sort();
    const lastPeriodPartial = judgeLastPeriodPartial(
      ctx,
      aggregate,
      realPeriods.map((p) => coverageOf(p, [groups.get(p)!], temporal.grain)),
    );
    const { periods: fullPeriods, step } = fillPeriodGaps(realPeriods, temporal.grain);
    const fullRows = fullPeriods.map((period) => {
      const g = groups.get(period);
      return { period, value: g ? roundTo(cellValue(g, aggregate), 4) : null };
    });
    const unweighted = aggregate === "mean" && gate.mode === "drop" && gate.hiddenDropped;
    const { headline, withheld } = finishHeadline({ type: "area", aggregate, lastPeriodPartial }, fullRows, audit, unweighted);
    const chartData = downsampleEvenly(
      fullRows,
      MAX_CHART_POINTS,
      headline ? fullRows.findIndex((r) => r.period === headline.period) : -1,
    );

    const vizConfig: VizConfig = {
      type: "area",
      geoFields,
      temporalField: temporal.name,
      temporalLabel: temporal.label,
      grain: temporal.grain,
      measureField: measure.name,
      measureLabel: measure.label,
      aggregate,
      ...(measure.accum.unit ? { unit: measure.accum.unit } : {}),
      ...temporalMetaFor(temporal, headline, lastPeriodPartial, step, { withheld, audit }),
      ...metaFrom(gate, classification, plotted, aggregate),
    };
    return { vizConfig, chartData };
  });
}

function buildMultiLine(
  ctx: BuildContext,
  records: Record<string, unknown>[],
  temporal: TemporalSource,
  measures: ClassifiedField[],
  seriesDim: DimensionField,
  classification: Classification,
  geoFields: GeoFieldMeta[],
): Built | null {
  const measure = pickBestMeasure(measures, ctx);
  if (!measure) return null;
  const aggregate = aggregateKindFor(measure, ctx);
  const plotted = new Set([...temporal.fieldNames, measure.name, seriesDim.name]);
  const spec: TotalsSpec = {
    aggregate,
    measure,
    keyOf: (row) => {
      const p = temporal.read(row);
      const cat = toDisplayString(row[seriesDim.name]);
      return p && cat !== null ? `${periodKeyFor(p, temporal.grain)}\u0000${cat}` : null;
    },
    periodOf: (row) => {
      const p = temporal.read(row);
      return p ? periodKeyFor(p, temporal.grain) : null;
    },
    periodId: `${temporal.name}|${temporal.grain}`,
  };

  return withTotalsFallback(ctx, records, plotted, spec, (gate) => {
    const periodSeries = new Map<string, Map<string, Cell>>();
    const seriesTotals = new Map<string, number>();
    const audit = newPeriodAudit();
    const finals = temporal.hasProvisional ? finalKeysOf(records, gate, temporal, measure.name, seriesDim.name) : null;

    for (const row of records) {
      if (gate.skip(row)) continue;
      const cat = toDisplayString(row[seriesDim.name]);
      if (cat === null) continue;
      const val = toNumber(row[measure.name]);
      if (val === null) continue;
      const parsed = temporal.read(row);
      if (!parsed) {
        audit.droppedPeriodRows++;
        continue;
      }
      const period = periodKeyFor(parsed, temporal.grain);
      if (parsed.provisional) {
        if (finals?.has(`${period}\u0000${cat}`)) {
          audit.supersededProvisionalRows++;
          continue;
        }
        audit.provisional.add(period);
      }
      let byCat = periodSeries.get(period);
      if (!byCat) {
        byCat = new Map();
        periodSeries.set(period, byCat);
      }
      let g = byCat.get(cat);
      if (!g) {
        g = newCell();
        byCat.set(cat, g);
      }
      addToCell(g, val, subKeyFor(parsed));
      seriesTotals.set(cat, (seriesTotals.get(cat) ?? 0) + Math.abs(val));
    }
    if (periodSeries.size === 0) return null;

    // The plotted series dimension may contain the total of its own other
    // values ("Passengers Total" next to embark/disembark/...). It stays a
    // series of its own (first, so a legend can style it) and is recorded as
    // `totalKey` so nothing downstream ever adds it to its parts. Two or more
    // total-looking values are ambiguous: no totalKey, no headline. A total
    // the LABELS miss ("Kingdom of Bahrain" next to its governorates) is found
    // by arithmetic on ALL series, before the cap trims the list.
    const ranked = [...seriesTotals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const realPeriods = [...periodSeries.keys()].sort();
    const found = findTotalSeries(ranked);
    let totalKey = found.key;
    if (!totalKey && !found.ambiguous && aggregate !== "mean" && ranked.length >= 3) {
      const matrix = realPeriods.map((p) => {
        const row: Record<string, unknown> = Object.create(null);
        for (const [cat, g] of periodSeries.get(p)!) row[cat] = roundTo(cellValue(g, aggregate), 4);
        return row;
      });
      totalKey = findNumericTotalSeries(matrix, ranked);
    }
    const parts = totalKey ? ranked.filter((k) => k !== totalKey) : ranked;
    const seriesOverflow = ranked.length > SERIES_CAP;
    const shown = totalKey ? [totalKey, ...parts.slice(0, SERIES_CAP - 1)] : parts.slice(0, SERIES_CAP);
    const { keyOf, escapes } = planSeriesKeys(ranked, reservedMultiLineKey);
    const seriesValues = shown.map(keyOf);
    const totalKeyOut = totalKey ? keyOf(totalKey) : null;

    // Row coverage per period = rows across ALL series (including series the
    // cap trimmed), so a series appearing/disappearing is not mistaken for a
    // half-filled period.
    const coverage = realPeriods.map((p) => coverageOf(p, periodSeries.get(p)!.values(), temporal.grain));
    const lastPeriodPartial = judgeLastPeriodPartial(ctx, aggregate, coverage);
    const { periods: fullPeriods, step } = fillPeriodGaps(realPeriods, temporal.grain);
    const fullRows = fullPeriods.map((period) => {
      const byCat = periodSeries.get(period);
      const row: Record<string, string | number | null> = { period };
      for (const cat of shown) {
        const g = byCat?.get(cat);
        row[keyOf(cat)] = g ? roundTo(cellValue(g, aggregate), 4) : null;
      }
      return row;
    });
    const unweighted = aggregate === "mean" && gate.mode === "drop" && gate.hiddenDropped;
    const headlineSource: HeadlineSource = {
      type: "multi-line",
      aggregate,
      seriesValues,
      seriesOverflow,
      totalKey: totalKeyOut,
      seriesField: seriesDim.name,
      seriesLabel: seriesDim.label,
      lastPeriodPartial,
    };
    const { headline, withheld } = finishHeadline(headlineSource, fullRows, audit, unweighted);
    const chartData = downsampleEvenly(
      fullRows,
      MAX_CHART_POINTS,
      headline ? fullRows.findIndex((r) => r.period === headline.period) : -1,
    );

    const vizConfig: VizConfig = {
      type: "multi-line",
      geoFields,
      temporalField: temporal.name,
      temporalLabel: temporal.label,
      grain: temporal.grain,
      measureField: measure.name,
      measureLabel: measure.label,
      aggregate,
      seriesField: seriesDim.name,
      seriesLabel: seriesDim.label,
      seriesValues,
      seriesOverflow,
      totalKey: totalKeyOut,
      ...(escapes.length > 0 ? { seriesKeyEscapes: escapes } : {}),
      ...(measure.accum.unit ? { unit: measure.accum.unit } : {}),
      ...temporalMetaFor(temporal, headline, lastPeriodPartial, step, { withheld, audit }),
      ...metaFrom(gate, classification, plotted, aggregate),
    };
    return { vizConfig, chartData };
  });
}

function buildBarH(
  ctx: BuildContext,
  records: Record<string, unknown>[],
  dim: ClassifiedField,
  measures: ClassifiedField[],
  classification: Classification,
  geoFields: GeoFieldMeta[],
): Built | null {
  const measure = pickBestMeasure(measures, ctx);
  if (!measure) return null;
  const aggregate = aggregateKindFor(measure, ctx);
  const plotted = new Set([dim.name, measure.name]);
  const spec: TotalsSpec = { aggregate, measure, keyOf: (row) => toDisplayString(row[dim.name]) };

  return withTotalsFallback(ctx, records, plotted, spec, (gate, dropPlotted) => {
    const groups = new Map<string, Cell>();
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      if (gate.skip(row)) continue;
      const cat = toDisplayString(row[dim.name]);
      if (cat === null) continue;
      const val = toNumber(row[measure.name]);
      if (val === null) continue;
      let g = groups.get(cat);
      if (!g) {
        g = newCell();
        groups.set(cat, g);
      }
      addToCell(g, val, i);
    }
    if (groups.size === 0) return null;

    // A "Total" category would be the tallest bar and "top category". A
    // nominated one ("Kingdom of Bahrain") is dropped only if it IS the sum of the rest.
    if (dropPlotted) {
      const names = [...groups.keys()];
      let totalCat = findTotalSeries(names).key;
      if (!totalCat && aggregate !== "mean") {
        const row: Record<string, unknown> = Object.create(null);
        for (const [cat, g] of groups) row[cat] = cellValue(g, aggregate);
        totalCat = numericPlottedTotal(names, [row], 1);
      }
      if (totalCat && groups.size > 1) {
        groups.delete(totalCat);
        gate.dropped.add(totalCat);
      }
    }

    const finalized = [...groups.entries()]
      .map(([category, g]) => ({
        category,
        value: cellValue(g, aggregate),
        cell: g,
      }))
      .sort((a, b) => b.value - a.value);

    const top = finalized.slice(0, BAR_TOP_N);
    const rest = finalized.slice(BAR_TOP_N);
    const otherLabel = rest.length > 0 ? uniqueOtherLabel(new Set(top.map((r) => r.category))) : OTHER_LABEL;

    const chartData: Array<{ category: string; value: number }> = top.map((r) => ({
      category: r.category,
      value: roundTo(r.value, 4),
    }));
    if (rest.length > 0) {
      const restValue = combinedValue(
        rest.map((r) => r.cell),
        aggregate,
      );
      chartData.push({ category: otherLabel, value: roundTo(restValue ?? 0, 4) });
    }

    const vizConfig: VizConfig = {
      type: "bar-h",
      geoFields,
      dimensionField: dim.name,
      dimensionLabel: dim.label,
      measureField: measure.name,
      measureLabel: measure.label,
      aggregate,
      categoryCount: finalized.length,
      otherBucketed: rest.length > 0,
      ...(rest.length > 0 && otherLabel !== OTHER_LABEL ? { otherLabel } : {}),
      ...(measure.accum.unit ? { unit: measure.accum.unit } : {}),
      ...metaFrom(gate, classification, plotted, aggregate),
    };
    return { vizConfig, chartData };
  });
}

/**
 * True when `fieldB` is fully determined by `fieldA` across the sampled
 * records — every value of `fieldA` co-occurs with exactly one value of
 * `fieldB`. This catches bilingual duplicate fields, which are common
 * across this catalog (e.g. an English "Occupancy" column and its Arabic
 * "الإشغال" twin describing the exact same value): pairing two such fields
 * as a stacked chart's category + series produces a degenerate chart where
 * every category bar has exactly one non-zero series segment (because the
 * "series" is just a translation of the "category"), which both looks
 * wrong and hides whichever dimension is actually informative.
 */
function isRedundantDimensionPair(records: Record<string, unknown>[], fieldA: string, fieldB: string): boolean {
  const aToB = new Map<string, string>();
  for (const row of records) {
    const aVal = toDisplayString(row[fieldA]);
    const bVal = toDisplayString(row[fieldB]);
    if (aVal === null || bVal === null) continue;
    const existing = aToB.get(aVal);
    if (existing === undefined) aToB.set(aVal, bVal);
    else if (existing !== bVal) return false;
  }
  return aToB.size > 0;
}

function buildBarStacked(
  ctx: BuildContext,
  records: Record<string, unknown>[],
  dimensions: DimensionField[],
  measures: ClassifiedField[],
  classification: Classification,
  geoFields: GeoFieldMeta[],
): Built | null {
  const measure = pickBestMeasure(measures, ctx);
  if (!measure) return null;
  const aggregate = aggregateKindFor(measure, ctx);

  // Pick the two lowest-cardinality dimensions when more than 2 qualify;
  // the lower-cardinality one of that pair becomes the stacked series. Try
  // candidate pairs in ascending-cardinality order (so the common case is
  // unchanged) and skip any pair that's a redundant bilingual/duplicate
  // encoding of the same concept — see `isRedundantDimensionPair` above.
  const sorted = [...dimensions].sort((a, b) => a.distinctCount - b.distinctCount);
  let seriesDim: DimensionField | null = null;
  let xDim: DimensionField | null = null;
  outer: for (let i = 0; i < sorted.length - 1; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (isRedundantDimensionPair(records, sorted[i].name, sorted[j].name)) continue;
      seriesDim = sorted[i];
      xDim = sorted[j];
      break outer;
    }
  }
  if (!seriesDim || !xDim) return null;
  const xd = xDim;
  const sd = seriesDim;
  const plotted = new Set([xd.name, sd.name, measure.name]);
  const spec: TotalsSpec = {
    aggregate,
    measure,
    keyOf: (row) => {
      const x = toDisplayString(row[xd.name]);
      const s = toDisplayString(row[sd.name]);
      return x !== null && s !== null ? `${x}\u0000${s}` : null;
    },
  };

  return withTotalsFallback(ctx, records, plotted, spec, (gate, dropPlotted) => {
    const cellMap = new Map<string, Map<string, Cell>>();

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      if (gate.skip(row)) continue;
      const xVal = toDisplayString(row[xd.name]);
      const sVal = toDisplayString(row[sd.name]);
      if (xVal === null || sVal === null) continue;
      const val = toNumber(row[measure.name]);
      if (val === null) continue;
      let bySeries = cellMap.get(xVal);
      if (!bySeries) {
        bySeries = new Map();
        cellMap.set(xVal, bySeries);
      }
      let g = bySeries.get(sVal);
      if (!g) {
        g = newCell();
        bySeries.set(sVal, g);
      }
      addToCell(g, val, i);
    }
    if (cellMap.size === 0) return null;

    // A "Total" x-category or series would be the tallest bar / stack and
    // double the stack height: leave it out, and say so in `excludedTotals`.
    // A value only the labels NOMINATE ("Kingdom of Bahrain") goes only if the
    // numbers say it is the sum of the others.
    if (dropPlotted) {
      const allSeries = new Set<string>();
      for (const bySeries of cellMap.values()) for (const s of bySeries.keys()) allSeries.add(s);
      const xNames = [...cellMap.keys()];
      const sNames = [...allSeries];
      let xTotal = findTotalSeries(xNames).key;
      let sTotal = findTotalSeries(sNames).key;
      if (aggregate !== "mean") {
        if (!xTotal && !findTotalSeries(xNames).ambiguous) {
          // one slot per series: the value of every x category in that series
          const slots = sNames.map((s) => {
            const slot: Record<string, unknown> = Object.create(null);
            for (const [x, bySeries] of cellMap) {
              const g = bySeries.get(s);
              if (g) slot[x] = cellValue(g, aggregate);
            }
            return slot;
          });
          xTotal = numericPlottedTotal(xNames, slots, 2);
        }
        if (!sTotal && !findTotalSeries(sNames).ambiguous) {
          // one slot per x category: the value of every series in that category
          const slots = xNames.map((x) => {
            const slot: Record<string, unknown> = Object.create(null);
            for (const [s, g] of cellMap.get(x)!) slot[s] = cellValue(g, aggregate);
            return slot;
          });
          sTotal = numericPlottedTotal(sNames, slots, 2);
        }
      }
      if (xTotal && cellMap.size > 1) {
        cellMap.delete(xTotal);
        gate.dropped.add(xTotal);
      }
      if (sTotal && allSeries.size > 1) {
        for (const bySeries of cellMap.values()) bySeries.delete(sTotal);
        for (const [x, bySeries] of [...cellMap]) if (bySeries.size === 0) cellMap.delete(x);
        gate.dropped.add(sTotal);
      }
      if (cellMap.size === 0) return null;
    }

    const xRank = new Map<string, number>();
    const seriesRank = new Map<string, number>();
    for (const [x, bySeries] of cellMap) {
      let abs = 0;
      let count = 0;
      for (const [s, g] of bySeries) {
        abs += g.abs;
        count += g.count;
        seriesRank.set(s, (seriesRank.get(s) ?? 0) + g.abs);
      }
      // Means are ranked by their average magnitude, sums by their total.
      xRank.set(x, aggregate === "mean" ? (count > 0 ? abs / count : 0) : abs);
    }

    const rankedSeries = [...seriesRank.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const seriesOverflow = rankedSeries.length > SERIES_CAP;
    // The dropped series are folded into one aggregated "rest" series instead
    // of vanishing, which understated every stack height.
    const keptSeries = seriesOverflow ? rankedSeries.slice(0, SERIES_CAP - 1) : rankedSeries;
    const restSeries = seriesOverflow ? rankedSeries.slice(SERIES_CAP - 1) : [];

    const xValues = [...xRank.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const xTop = xValues.slice(0, BAR_TOP_N);
    const xRest = xValues.slice(BAR_TOP_N);

    // Real series values that would clash with the row's own "category" key are renamed; the synthetic
    // "rest" bucket (series and x-row share one label) never reuses a name a real value carries.
    const { keyOf, escapes } = planSeriesKeys(rankedSeries, reservedStackedKey);
    const needsOther = seriesOverflow || xRest.length > 0;
    const otherLabel = needsOther
      ? uniqueOtherLabel(new Set([...keptSeries.map(keyOf), ...xTop]))
      : OTHER_LABEL;
    const columns = [
      ...keptSeries.map((name) => ({ key: keyOf(name), wanted: [name] })),
      ...(seriesOverflow ? [{ key: otherLabel, wanted: restSeries }] : []),
    ];
    const seriesValues = columns.map((c) => c.key);

    function cellsFor(xVals: string[], wanted: string[]): Cell[] {
      const out: Cell[] = [];
      for (const x of xVals) {
        const bySeries = cellMap.get(x);
        if (!bySeries) continue;
        for (const s of wanted) {
          const g = bySeries.get(s);
          if (g) out.push(g);
        }
      }
      return out;
    }

    const chartData: Array<Record<string, string | number | null>> = xTop.map((xVal) => {
      const row: Record<string, string | number | null> = { category: xVal };
      for (const col of columns) {
        const v = combinedValue(cellsFor([xVal], col.wanted), aggregate);
        row[col.key] = v === null ? null : roundTo(v, 4);
      }
      return row;
    });

    if (xRest.length > 0) {
      const row: Record<string, string | number | null> = { category: otherLabel };
      for (const col of columns) {
        const v = combinedValue(cellsFor(xRest, col.wanted), aggregate);
        row[col.key] = v === null ? null : roundTo(v, 4);
      }
      chartData.push(row);
    }

    const vizConfig: VizConfig = {
      type: "bar-stacked",
      geoFields,
      xField: xd.name,
      xLabel: xd.label,
      seriesField: sd.name,
      seriesLabel: sd.label,
      seriesValues,
      seriesOverflow,
      measureField: measure.name,
      measureLabel: measure.label,
      aggregate,
      otherBucketed: xRest.length > 0,
      // Stacking averages (or rates, indices, prices) adds up numbers that
      // were never additive: render those as grouped bars.
      stacked: aggregate !== "mean",
      ...(seriesOverflow ? { otherSeriesBucketed: true } : {}),
      ...(needsOther && otherLabel !== OTHER_LABEL ? { otherLabel } : {}),
      ...(escapes.length > 0 ? { seriesKeyEscapes: escapes } : {}),
      ...(measure.accum.unit ? { unit: measure.accum.unit } : {}),
      ...metaFrom(gate, classification, plotted, aggregate),
    };
    return { vizConfig, chartData };
  });
}

/**
 * Decimal places shared by every bucket edge of a histogram, derived from the
 * bucket WIDTH (not each edge's magnitude): the smallest count at which the
 * 11 edges stay strictly increasing and are shown within 5% of a bucket of
 * their true value. Per-edge formatting collapsed narrow ranges to labels
 * like "0–0" or "100–100".
 */
function histogramDecimals(min: number, width: number): number {
  for (let d = 0; d <= 6; d++) {
    const f = 10 ** d;
    let ok = true;
    let prev = Number.NEGATIVE_INFINITY;
    for (let i = 0; i <= HISTOGRAM_BIN_COUNT; i++) {
      const edge = min + i * width;
      const r = Math.round(edge * f) / f;
      if (!(r > prev) || Math.abs(r - edge) > width * 0.05) {
        ok = false;
        break;
      }
      prev = r;
    }
    if (ok) return d;
  }
  return 6;
}

function buildHistogram(
  ctx: BuildContext,
  records: Record<string, unknown>[],
  measures: ClassifiedField[],
  classification: Classification,
  geoFields: GeoFieldMeta[],
): Built | null {
  const measure = pickBestMeasure(measures, ctx);
  if (!measure) return null;
  const plotted = new Set([measure.name]);
  // A histogram is over rows, not cells: Total rows are outliers to drop, and there is nothing to verify or weight.
  const spec: TotalsSpec = { aggregate: "sum", measure, keyOf: () => null, noVerify: true };

  return withTotalsFallback(ctx, records, plotted, spec, (gate) => {
    const values: number[] = [];
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const row of records) {
      if (gate.skip(row)) continue;
      const v = toNumber(row[measure.name]);
      if (v === null) continue;
      values.push(v);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (values.length === 0 || min === max) return null;

    const width = (max - min) / HISTOGRAM_BIN_COUNT;
    const counts = new Array(HISTOGRAM_BIN_COUNT).fill(0) as number[];
    for (const v of values) counts[clampIndex(Math.floor((v - min) / width), HISTOGRAM_BIN_COUNT - 1)]++;

    const decimals = histogramDecimals(min, width);
    const labelFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    const precision = Math.max(4, decimals + 2);

    const chartData = counts.map((count, i) => ({
      bucket: `${labelFormat.format(min + i * width)}–${labelFormat.format(min + (i + 1) * width)}`,
      rangeMin: roundTo(min + i * width, precision),
      rangeMax: roundTo(min + (i + 1) * width, precision),
      count,
    }));

    const vizConfig: VizConfig = {
      type: "histogram",
      geoFields,
      measureField: measure.name,
      measureLabel: measure.label,
      binCount: HISTOGRAM_BIN_COUNT,
      min: roundTo(min, precision),
      max: roundTo(max, precision),
      ...(measure.accum.unit ? { unit: measure.accum.unit } : {}),
      ...metaFrom(gate, classification, plotted, "sum"),
    };
    return { vizConfig, chartData };
  });
}

// ---------------------------------------------------------------------------
// Decision tree (item 4 in the spec) — first match wins. Each builder
// returns null when the structural match doesn't yield real data (e.g. a
// "temporal" field whose values happen not to parse), in which case we
// fall through to the next rule rather than persisting an empty chart.
// ---------------------------------------------------------------------------

function buildVizConfig(
  ctx: BuildContext,
  records: Record<string, unknown>[],
  classification: Classification,
  measures: ClassifiedField[],
): { vizConfig: VizConfig; chartData: unknown[] | null } {
  const { temporal, geo, monthParts } = classification;
  const geoFields = geoMeta(geo);
  const primaryTemporal = temporal[0];
  const temporalSource = primaryTemporal ? temporalSourceFor(primaryTemporal, monthParts, ctx.parseTemporal) : null;

  // A "Month" column consumed by the period is not a dimension any more.
  const consumed = new Set<string>(temporalSource?.monthField ? [temporalSource.monthField.name] : []);
  const dimension = classification.dimension.filter((d) => !consumed.has(d.name));
  const view: Classification = { ...classification, dimension };

  let seriesDim: DimensionField | undefined = dimension.find((d) => d.seriesAble);
  const pinnedSeries = ctx.override?.seriesField;
  if (pinnedSeries) {
    const pinned = dimension.find((d) => d.name === pinnedSeries);
    if (pinned) {
      seriesDim = pinned;
    } else {
      console.warn(
        `[derived] viz override for ${ctx.datasetId}: seriesField "${pinnedSeries}" is not a text dimension with 2-30 values; using the inferred series field.`,
      );
    }
  }

  if (temporalSource && measures.length > 0 && seriesDim) {
    const built = buildMultiLine(ctx, records, temporalSource, measures, seriesDim, view, geoFields);
    if (built) return built;
  }

  if (temporalSource && measures.length > 0) {
    const built = buildArea(ctx, records, temporalSource, measures, view, geoFields);
    if (built) return built;
  }

  if (dimension.length === 1 && measures.length > 0) {
    const built = buildBarH(ctx, records, dimension[0], measures, view, geoFields);
    if (built) return built;
  }

  if (dimension.length >= 2 && measures.length > 0) {
    const built = buildBarStacked(ctx, records, dimension, measures, view, geoFields);
    if (built) return built;
  }

  if (dimension.length === 0 && temporal.length === 0 && measures.length > 0 && records.length >= 20) {
    const built = buildHistogram(ctx, records, measures, view, geoFields);
    if (built) return built;
  }

  return {
    vizConfig: { type: "table", geoFields, reason: geo.length > 0 ? "geo" : "no-viz" },
    chartData: null,
  };
}

// ---------------------------------------------------------------------------
// summaryAr (item 6 in the spec)
// ---------------------------------------------------------------------------

function valueOfBarRow(row: Record<string, unknown>, vizConfig: VizConfig): number | null {
  if (vizConfig.type === "bar-h") return typeof row.value === "number" ? row.value : null;
  if (vizConfig.type === "bar-stacked") {
    if (vizConfig.stacked === false) {
      // Grouped (mean) bars: there is no meaningful stack total, use the
      // category's average across its series.
      const total = sumSeriesRow(row, vizConfig.seriesValues);
      const present = vizConfig.seriesValues.filter((k) => typeof row[k] === "number").length;
      return total !== null && present > 0 ? total / present : null;
    }
    return sumSeriesRow(row, vizConfig.seriesValues);
  }
  return null;
}

function buildFallbackSummary(rows: number, fieldCount: number): string {
  if (!(rows > 0)) return "لا تحتوي مجموعة البيانات على أي سجلات.";
  // After "على" and "عبر" the dual takes its oblique form (سجلين / حقلين); see src/lib/arabic-count.ts.
  const records = countPhrase(rows, NOUNS.record, { oblique: true });
  if (!(fieldCount > 0)) return `تحتوي مجموعة البيانات على ${records}.`;
  return `تحتوي مجموعة البيانات على ${records} عبر ${countPhrase(fieldCount, NOUNS.field, { oblique: true })}.`;
}

function buildSummaryAr(
  vizConfig: VizConfig,
  chartData: unknown[] | null,
  rows: number,
  fieldCount: number,
): string {
  const fallback = buildFallbackSummary(rows, fieldCount);
  if (!Array.isArray(chartData) || chartData.length === 0) return fallback;

  if (vizConfig.type === "area" || vizConfig.type === "multi-line") {
    const data = chartData as Record<string, unknown>[];
    // The persisted headline is THE number (same function the cards use);
    // `null` means it was deliberately withheld (ambiguous totals, a mean
    // over several series, series that are different indicators), and the
    // generic sentence is the honest answer.
    const headline = vizConfig.headline !== undefined ? vizConfig.headline : computeHeadline(vizConfig, data);
    if (!headline) return fallback;
    const lastRow = data[data.length - 1];
    const partialPeriod =
      vizConfig.lastPeriodPartial && typeof lastRow?.period === "string" ? (lastRow.period as string) : null;
    return buildHeadlineSentence({
      headline,
      unit: vizConfig.unit,
      grain: vizConfig.grain,
      step: vizConfig.periodStep,
      partialPeriod,
    });
  }

  if (vizConfig.type === "bar-h" || vizConfig.type === "bar-stacked") {
    const all = chartData as Record<string, unknown>[];
    // The synthetic "rest" row is always the LAST row: drop exactly that one, never by name
    // (a real category may be called "أخرى" and can be the top one).
    const data = vizConfig.otherBucketed ? all.slice(0, -1) : all;
    if (data.length === 0) return fallback;
    let top = data[0];
    let topValue = valueOfBarRow(top, vizConfig);
    for (const r of data) {
      const v = valueOfBarRow(r, vizConfig);
      if (v !== null && (topValue === null || v > topValue)) {
        top = r;
        topValue = v;
      }
    }
    if (topValue === null || typeof top.category !== "string") return fallback;

    const noun = vizConfig.aggregate === "mean" ? "بمتوسط" : "بقيمة";
    let sentence = `الفئة الأعلى: «${top.category}» ${noun} ${formatSummaryNumber(topValue)}`;
    if (vizConfig.type === "bar-h") {
      sentence += ` من أصل ${countPhrase(vizConfig.categoryCount, NOUNS.category, { oblique: true })}`;
    }
    return sentence + ".";
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// Input hygiene
// ---------------------------------------------------------------------------

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * The records every pass reads: the input itself in the overwhelmingly common
 * case (zero cost), otherwise a cleaned copy. Two things are repaired once, up
 * front, instead of in the dozen places that read `row[name]`:
 *  - rows that are not plain objects (null, numbers, arrays) are skipped and
 *    counted in ONE warning (the ingest boundary already rejects them; this is
 *    defense in depth, and the alternative was one bad row disabling all derivation);
 *  - a field named like an Object.prototype member ("constructor", "toString",
 *    "__proto__") would read the inherited function for a row that lacks it, so
 *    rows are copied into prototype-less objects holding only their own values.
 */
function prepareRecords(
  datasetId: string,
  records: Record<string, unknown>[],
  fields: CatalogField[],
): Record<string, unknown>[] {
  const isPlain = (r: unknown): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r);
  const names = fields.map((f) => f?.name).filter((n): n is string => typeof n === "string" && n !== "");
  const protoNames = names.some((n) => n in Object.prototype);

  let clean = true;
  if (!protoNames) {
    for (const r of records) {
      if (!isPlain(r)) {
        clean = false;
        break;
      }
    }
    if (clean) return records;
  }

  const out: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const r of records) {
    if (!isPlain(r)) {
      skipped++;
      continue;
    }
    if (!protoNames) {
      out.push(r);
      continue;
    }
    const copy: Record<string, unknown> = Object.create(null);
    for (const n of names) if (hasOwn.call(r, n)) copy[n] = r[n];
    out.push(copy);
  }
  if (skipped > 0) {
    console.warn(`[derived] ${datasetId}: ${skipped} record(s) are not objects and were skipped.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function computeDerivedFields(
  datasetId: string,
  records: Record<string, unknown>[],
  fields: CatalogField[],
  options: ComputeDerivedOptions = {},
): Promise<DerivedFields> {
  const inputRows = Array.isArray(records) ? records.length : 0;
  try {
    if (!Array.isArray(fields) || fields.length === 0) {
      return {
        statsJson: null,
        vizConfig: null,
        chartData: null,
        summaryAr: buildFallbackSummary(inputRows, 0),
      };
    }

    const rows = prepareRecords(datasetId, Array.isArray(records) ? records : [], fields);
    const parseTemporal = createTemporalParser();
    const accumList = buildAccumulators(fields, rows, parseTemporal);
    const statsJson = buildStatsJson(accumList);
    const classification = classifyFields(accumList);

    const override = options.override === undefined ? getVizOverride(datasetId) : (options.override ?? undefined);
    const ctx: BuildContext = {
      datasetId,
      parseTemporal,
      override,
      totalFields: collectTotalFields(accumList, new Set(classification.temporal.map((t) => t.name))),
      dimensions: classification.dimension,
      verified: new Map(),
    };
    const measures = resolveMeasures(classification, accumList, ctx);

    const { vizConfig, chartData } = buildVizConfig(ctx, rows, classification, measures);
    const summaryAr = buildSummaryAr(vizConfig, chartData, rows.length, fields.length);

    return { statsJson, vizConfig, chartData, summaryAr };
  } catch (err) {
    // Absolute last resort: never let a bug in this file crash the sync
    // loop for one dataset and take the rest of the run down with it.
    console.error(`[derived] computeDerivedFields failed for ${datasetId}:`, err);
    return {
      statsJson: null,
      vizConfig: null,
      chartData: null,
      summaryAr: buildFallbackSummary(inputRows, Array.isArray(fields) ? fields.length : 0),
    };
  }
}
