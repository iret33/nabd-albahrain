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
 *     are visible.
 *
 * This function must never throw: a single dataset's derived-field
 * computation failing must never crash the sync loop (same rule the spec
 * applies to network/schema errors elsewhere in the sync engine). The
 * outermost try/catch below is a deliberate extra safety net on top of
 * that existing rule.
 */

import type { CatalogField } from "./schemas";
import { getVizOverride, type VizOverride } from "@/config/viz-overrides";
import {
  detectPartialLastPeriod,
  fillPeriodGaps,
  findTotalSeries,
  inferAggregate,
  inferUnitFromLabel,
  isStrictTotalLabel,
  median,
  sumSeriesRow,
  type Aggregate,
  type Grain,
} from "@/lib/series";
import {
  isMonthOnlyName,
  isQuarterOnlyName,
  looksTemporalName,
  looksYearName,
  parseMonthPart,
  parseTemporalValue,
  type TemporalParts,
} from "@/lib/temporal";
import {
  buildHeadlineSentence,
  computeHeadline,
  formatSummaryNumber,
  type Headline,
} from "@/lib/headline";

export type { Aggregate, Grain } from "@/lib/series";
export type { Headline, HeadlineBasis } from "@/lib/headline";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Version of the derivation logic. Bump whenever a change to this file alters
 * the persisted statsJson/vizConfig/chartData/summaryAr for the same input.
 * `Dataset.derivedVersion` records which version produced a row; rows with an
 * older version are re-derived from their stored records (no network).
 */
export const DERIVED_VERSION = 2;

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

/** Evenly downsample to at most maxPoints, preserving order and the first/last item. */
function downsampleEvenly<T>(items: T[], maxPoints: number): T[] {
  if (items.length <= maxPoints || maxPoints <= 1) return items.slice(0, maxPoints);
  const out: T[] = [];
  const n = items.length;
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.floor((i * (n - 1)) / (maxPoints - 1));
    out.push(items[idx]);
  }
  return out;
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

function buildAccumulators(fields: CatalogField[], records: Record<string, unknown>[]): Accum[] {
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
            if (
              acc.type === "text" &&
              acc.totalValues.size < MAX_TOTAL_VALUES_PER_FIELD &&
              isStrictTotalLabel(key)
            ) {
              acc.totalValues.add(key);
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
        const parsed = parseTemporalValue(raw);
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
  const out: StatsJson = {};
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
        looksLikeIdentifierName(acc.label)
      ) {
        stat.looksLikeIdentifier = true;
      }
    }

    out[acc.name] = stat;
  }
  return out;
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
    if (isNumeric && !MEASURE_EXCLUDE_RE.test(acc.name) && !isRowIndex && !isCoordinate) {
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

/** "best" measure = highest non-null count with non-constant values (spec's area-chart rule, reused everywhere a single measure must be picked); ties go to the more spread-out column, then schema order. */
function pickBestMeasure(measures: ClassifiedField[]): ClassifiedField | null {
  const withData = measures.filter((m) => m.accum.numCount > 0);
  if (withData.length === 0) return null;
  const nonConstant = withData.filter((m) => m.accum.numMin !== m.accum.numMax);
  const pool = nonConstant.length > 0 ? nonConstant : withData;
  return [...pool].sort((a, b) => {
    if (b.accum.numCount !== a.accum.numCount) return b.accum.numCount - a.accum.numCount;
    return measureSpread(b.accum) - measureSpread(a.accum);
  })[0];
}

// ---------------------------------------------------------------------------
// Build context: overrides + total-row detection
// ---------------------------------------------------------------------------

interface TotalField {
  name: string;
  values: Set<string>;
}

interface BuildContext {
  datasetId: string;
  override: VizOverride | undefined;
  /** Text fields that carry a strict "Total" value next to non-total siblings. */
  totalFields: TotalField[];
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
    if (acc.type !== "text" || acc.totalValues.size === 0 || temporalNames.has(acc.name)) continue;
    // Only a dimension that also has non-total siblings: a constant "Total" column has nothing to double count.
    if (!acc.distinctCapped && acc.distinct.size <= acc.totalValues.size) continue;
    out.push({ name: acc.name, values: acc.totalValues });
  }
  return out;
}

interface RowGate {
  /** True when the row is a "Total" row on a hidden dimension and must be left out. */
  skip(row: Record<string, unknown>): boolean;
  /** Distinct total values dropped so far (rows or plotted categories). */
  dropped: Set<string>;
}

function makeRowGate(totalFields: TotalField[], plotted: ReadonlySet<string>, enabled: boolean): RowGate {
  const active = enabled ? totalFields.filter((f) => !plotted.has(f.name)) : [];
  const dropped = new Set<string>();
  return {
    dropped,
    skip(row) {
      for (const f of active) {
        const raw = row[f.name];
        if (typeof raw !== "string") continue;
        const v = raw.trim();
        if (f.values.has(v)) {
          dropped.add(v);
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * Runs a builder with totals dropped; if that leaves the chart empty (a
 * table that ONLY has total rows) runs it once more keeping them. The
 * decision is whole-dataset on purpose: a per-period fallback would mix
 * total-only and parts-only periods in one line.
 */
function withTotalsFallback<T>(
  ctx: BuildContext,
  plotted: ReadonlySet<string>,
  attempt: (gate: RowGate, dropPlotted: boolean) => T | null,
): T | null {
  const gate = makeRowGate(ctx.totalFields, plotted, true);
  const first = attempt(gate, true);
  if (first !== null || gate.dropped.size === 0) return first;
  return attempt(makeRowGate(ctx.totalFields, plotted, false), false);
}

function metaFrom(gate: RowGate, classification: Classification, plotted: ReadonlySet<string>): VizMeta {
  const hidden = classification.dimension.filter((d) => !plotted.has(d.name)).map((d) => d.label);
  const meta: VizMeta = {};
  const uniqueHidden = [...new Set(hidden)].slice(0, MAX_HIDDEN_DIMENSION_LABELS);
  if (uniqueHidden.length > 0) meta.hiddenDimensions = uniqueHidden;
  if (gate.dropped.size > 0) meta.excludedTotals = [...gate.dropped].sort();
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
  read(row: Record<string, unknown>): TemporalParts | null;
}

function grainFor(temporalField: ClassifiedField): Grain {
  return temporalField.accum.temporalYearOnly && temporalField.accum.temporalParsed > 0 ? "year" : "month";
}

function temporalSourceFor(primary: ClassifiedField, monthParts: ClassifiedField[]): TemporalSource {
  const grain = grainFor(primary);
  const monthField = grain === "year" ? monthParts[0] : undefined;
  if (monthField) {
    return {
      name: primary.name,
      label: primary.label,
      grain: "month",
      fieldNames: [primary.name, monthField.name],
      monthField,
      read(row) {
        const y = parseTemporalValue(row[primary.name]);
        if (!y) return null;
        if (y.month !== null) return y; // the year column already carries a month: trust it
        const month = parseMonthPart(row[monthField.name]);
        return month === null ? null : { year: y.year, month, day: null };
      },
    };
  }
  return {
    name: primary.name,
    label: primary.label,
    grain,
    fieldNames: [primary.name],
    read: (row) => parseTemporalValue(row[primary.name]),
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

function temporalMetaFor(
  temporal: TemporalSource,
  headline: Headline | null,
  lastPeriodPartial: boolean,
  step: number,
): TemporalMeta {
  return {
    headline,
    lastPeriodPartial,
    periodStep: step,
    ...(temporal.monthField ? { temporalMonthField: temporal.monthField.name } : {}),
  };
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
  const measure = pickBestMeasure(measures);
  if (!measure) return null;
  const aggregate = aggregateKindFor(measure, ctx);
  const plotted = new Set([...temporal.fieldNames, measure.name]);

  return withTotalsFallback(ctx, plotted, (gate) => {
    const groups = new Map<string, Cell>();
    for (const row of records) {
      if (gate.skip(row)) continue;
      const parsed = temporal.read(row);
      if (!parsed) continue;
      const val = toNumber(row[measure.name]);
      if (val === null) continue;
      const period = periodKeyFor(parsed, temporal.grain);
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
    const lastPeriodPartial =
      aggregate === "sum" && detectPartialLastPeriod(realPeriods.map((p) => groups.get(p)!.count));
    const { periods: fullPeriods, step } = fillPeriodGaps(realPeriods, temporal.grain);
    const fullRows = fullPeriods.map((period) => {
      const g = groups.get(period);
      return { period, value: g ? roundTo(cellValue(g, aggregate), 4) : null };
    });
    const headline = computeHeadline({ type: "area", aggregate, lastPeriodPartial }, fullRows);
    const chartData = downsampleEvenly(fullRows, MAX_CHART_POINTS);

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
      ...temporalMetaFor(temporal, headline, lastPeriodPartial, step),
      ...metaFrom(gate, classification, plotted),
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
  const measure = pickBestMeasure(measures);
  if (!measure) return null;
  const aggregate = aggregateKindFor(measure, ctx);
  const plotted = new Set([...temporal.fieldNames, measure.name, seriesDim.name]);

  return withTotalsFallback(ctx, plotted, (gate) => {
    const periodSeries = new Map<string, Map<string, Cell>>();
    const seriesTotals = new Map<string, number>();

    for (const row of records) {
      if (gate.skip(row)) continue;
      const parsed = temporal.read(row);
      if (!parsed) continue;
      const cat = toDisplayString(row[seriesDim.name]);
      if (cat === null) continue;
      const val = toNumber(row[measure.name]);
      if (val === null) continue;
      const period = periodKeyFor(parsed, temporal.grain);
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
    // total-looking values are ambiguous: no totalKey, no headline.
    const ranked = [...seriesTotals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const totalKey = findTotalSeries(ranked).key;
    const parts = totalKey ? ranked.filter((k) => k !== totalKey) : ranked;
    const seriesOverflow = ranked.length > SERIES_CAP;
    const seriesValues = totalKey ? [totalKey, ...parts.slice(0, SERIES_CAP - 1)] : parts.slice(0, SERIES_CAP);

    // Row coverage per period = rows across ALL series (including series the
    // cap trimmed), so a series appearing/disappearing is not mistaken for a
    // half-filled period.
    const realPeriods = [...periodSeries.keys()].sort();
    const counts = realPeriods.map((p) => {
      let n = 0;
      for (const g of periodSeries.get(p)!.values()) n += g.count;
      return n;
    });
    const lastPeriodPartial = aggregate === "sum" && detectPartialLastPeriod(counts);
    const { periods: fullPeriods, step } = fillPeriodGaps(realPeriods, temporal.grain);
    const fullRows = fullPeriods.map((period) => {
      const byCat = periodSeries.get(period);
      const row: Record<string, string | number | null> = { period };
      for (const cat of seriesValues) {
        const g = byCat?.get(cat);
        row[cat] = g ? roundTo(cellValue(g, aggregate), 4) : null;
      }
      return row;
    });
    const headline = computeHeadline(
      { type: "multi-line", aggregate, seriesValues, seriesOverflow, totalKey, lastPeriodPartial },
      fullRows,
    );
    const chartData = downsampleEvenly(fullRows, MAX_CHART_POINTS);

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
      totalKey,
      ...(measure.accum.unit ? { unit: measure.accum.unit } : {}),
      ...temporalMetaFor(temporal, headline, lastPeriodPartial, step),
      ...metaFrom(gate, classification, plotted),
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
  const measure = pickBestMeasure(measures);
  if (!measure) return null;
  const aggregate = aggregateKindFor(measure, ctx);
  const plotted = new Set([dim.name, measure.name]);

  return withTotalsFallback(ctx, plotted, (gate, dropPlotted) => {
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

    // A "Total" category would be the tallest bar and "top category".
    if (dropPlotted) {
      const totalCat = findTotalSeries([...groups.keys()]).key;
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

    const chartData: Array<{ category: string; value: number }> = top.map((r) => ({
      category: r.category,
      value: roundTo(r.value, 4),
    }));
    if (rest.length > 0) {
      const restValue = combinedValue(
        rest.map((r) => r.cell),
        aggregate,
      );
      chartData.push({ category: OTHER_LABEL, value: roundTo(restValue ?? 0, 4) });
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
      ...(measure.accum.unit ? { unit: measure.accum.unit } : {}),
      ...metaFrom(gate, classification, plotted),
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
  const measure = pickBestMeasure(measures);
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

  return withTotalsFallback(ctx, plotted, (gate, dropPlotted) => {
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
    if (dropPlotted) {
      const allSeries = new Set<string>();
      for (const bySeries of cellMap.values()) for (const s of bySeries.keys()) allSeries.add(s);
      const xTotal = findTotalSeries([...cellMap.keys()]).key;
      const sTotal = findTotalSeries([...allSeries]).key;
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
    // The dropped series are folded into one aggregated "أخرى" series instead
    // of vanishing, which understated every stack height.
    const keptSeries = seriesOverflow ? rankedSeries.slice(0, SERIES_CAP - 1) : rankedSeries;
    const restSeries = seriesOverflow ? rankedSeries.slice(SERIES_CAP - 1) : [];
    const seriesValues = seriesOverflow ? [...keptSeries, OTHER_LABEL] : keptSeries;

    const xValues = [...xRank.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const xTop = xValues.slice(0, BAR_TOP_N);
    const xRest = xValues.slice(BAR_TOP_N);

    function cellsFor(xVals: string[], sVal: string): Cell[] {
      const wanted = seriesOverflow && sVal === OTHER_LABEL ? restSeries : [sVal];
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
      for (const sVal of seriesValues) {
        const v = combinedValue(cellsFor([xVal], sVal), aggregate);
        row[sVal] = v === null ? null : roundTo(v, 4);
      }
      return row;
    });

    if (xRest.length > 0) {
      const row: Record<string, string | number | null> = { category: OTHER_LABEL };
      for (const sVal of seriesValues) {
        const v = combinedValue(cellsFor(xRest, sVal), aggregate);
        row[sVal] = v === null ? null : roundTo(v, 4);
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
      ...(measure.accum.unit ? { unit: measure.accum.unit } : {}),
      ...metaFrom(gate, classification, plotted),
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
  const measure = pickBestMeasure(measures);
  if (!measure) return null;
  const plotted = new Set([measure.name]);

  return withTotalsFallback(ctx, plotted, (gate) => {
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
      ...metaFrom(gate, classification, plotted),
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
  const temporalSource = primaryTemporal ? temporalSourceFor(primaryTemporal, monthParts) : null;

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
  return `تحتوي قاعدة البيانات على ${rows} سجلاً عبر ${fieldCount} حقلاً.`;
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
    // over several series), and the generic sentence is the honest answer.
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
    const data = (chartData as Record<string, unknown>[]).filter((r) => r.category !== OTHER_LABEL);
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
    if (vizConfig.type === "bar-h") sentence += ` من أصل ${vizConfig.categoryCount} فئة`;
    return sentence + ".";
  }

  return fallback;
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
  try {
    if (!Array.isArray(fields) || fields.length === 0) {
      return {
        statsJson: null,
        vizConfig: null,
        chartData: null,
        summaryAr: buildFallbackSummary(records.length, 0),
      };
    }

    const accumList = buildAccumulators(fields, records);
    const statsJson = buildStatsJson(accumList);
    const classification = classifyFields(accumList);

    const override = options.override === undefined ? getVizOverride(datasetId) : (options.override ?? undefined);
    const ctx: BuildContext = {
      datasetId,
      override,
      totalFields: collectTotalFields(accumList, new Set(classification.temporal.map((t) => t.name))),
    };
    const measures = resolveMeasures(classification, accumList, ctx);

    const { vizConfig, chartData } = buildVizConfig(ctx, records, classification, measures);
    const summaryAr = buildSummaryAr(vizConfig, chartData, records.length, fields.length);

    return { statsJson, vizConfig, chartData, summaryAr };
  } catch (err) {
    // Absolute last resort: never let a bug in this file crash the sync
    // loop for one dataset and take the rest of the run down with it.
    console.error(`[derived] computeDerivedFields failed for ${datasetId}:`, err);
    return {
      statsJson: null,
      vizConfig: null,
      chartData: null,
      summaryAr: buildFallbackSummary(records.length, fields?.length ?? 0),
    };
  }
}
