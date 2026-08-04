/**
 * computeDerivedFields — Phase 3 implementation.
 *
 * Given one dataset's full export array plus its ODS `fields[]` schema
 * metadata, computes (deterministically, no AI/LLM calls):
 *
 *   - statsJson: per-field stats (nullRate, distinctCount, numeric
 *     min/max/mean, temporal min/max, top-10 for low-cardinality text).
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
 * per-field parallel arrays), which keeps memory bounded even on the
 * largest datasets.
 *
 * This function must never throw: a single dataset's derived-field
 * computation failing must never crash the sync loop (same rule the spec
 * applies to network/schema errors elsewhere in the sync engine). The
 * outermost try/catch below is a deliberate extra safety net on top of
 * that existing rule.
 */

import type { CatalogField } from "./schemas";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FieldStats {
  name: string;
  label: string;
  /** Normalized ODS type: text | int | double | date | datetime | boolean | geo_point_2d | geo_shape | file. */
  type: string;
  nullRate: number;
  distinctCount: number | "1000+";
  /** Numeric fields: actual min/max. Temporal fields: min/max as the original raw representative values. */
  min?: number | string;
  max?: number | string;
  mean?: number;
  /** Only for text fields with distinctCount <= 30. */
  topValues?: Array<{ value: string; count: number }>;
  /** From the field's `annotations.unit`, when present (e.g. "km2"). */
  unit?: string;
}

export type StatsJson = Record<string, FieldStats>;

export interface GeoFieldMeta {
  name: string;
  label: string;
  type: string;
}

export type Aggregate = "sum" | "mean";
export type Grain = "year" | "month";

export type VizConfig =
  | {
      type: "area";
      geoFields: GeoFieldMeta[];
      temporalField: string;
      temporalLabel: string;
      grain: Grain;
      measureField: string;
      measureLabel: string;
      unit?: string;
      aggregate: Aggregate;
    }
  | {
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
    }
  | {
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
    }
  | {
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
    }
  | {
      type: "histogram";
      geoFields: GeoFieldMeta[];
      measureField: string;
      measureLabel: string;
      unit?: string;
      binCount: number;
      min: number;
      max: number;
    }
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

// ---------------------------------------------------------------------------
// Constants (regexes from the spec)
// ---------------------------------------------------------------------------

const TEMPORAL_NAME_RE = /(year|date|month|quarter|سنة|تاريخ|شهر|ربع)/i;
const MEASURE_EXCLUDE_RE = /^(id|.*_id|code|.*_code)$/i;
const RATE_LABEL_RE = /(rate|percent|ratio|average|معدل|نسبة|متوسط)/i;
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

/** Latin-digit number formatting for Arabic sentences — no grouping, trims trailing zeros. */
function formatNumberAr(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  const decimals = Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2;
  return String(Number(n.toFixed(decimals)));
}

function extractUnit(field: CatalogField): string | null {
  const raw = (field as unknown as Record<string, unknown>).annotations;
  if (raw && typeof raw === "object") {
    const unit = (raw as Record<string, unknown>).unit;
    if (typeof unit === "string" && unit.trim() !== "") return unit.trim();
  }
  return null;
}

/**
 * Parse a raw export value as a temporal point. Handles the two shapes
 * actually observed live on data.gov.bh: bare 4-digit year strings/numbers
 * (the export shape for ODS "date" fields with timeserie_precision:"year",
 * e.g. "year": "2020") and real ISO date/datetime strings. Falls back to
 * the native Date parser for anything else. Returns null if unparseable or
 * implausible (year outside 1900-2100).
 */
function parseTemporalValue(raw: unknown): { year: number; month: number | null } | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    if (Number.isInteger(raw) && raw >= 1900 && raw <= 2100) return { year: raw, month: null };
    return null;
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "") return null;

  if (/^\d{4}$/.test(s)) {
    const year = Number(s);
    return year >= 1900 && year <= 2100 ? { year, month: null } : null;
  }

  const iso = s.match(/^(\d{4})-(\d{2})(?:-\d{2})?/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12) return { year, month };
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const year = d.getUTCFullYear();
    if (year >= 1900 && year <= 2100) return { year, month: d.getUTCMonth() + 1 };
  }

  return null;
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

  total: number;
  nonNull: number;

  distinct: Set<string>;
  distinctCapped: boolean;
  freq: Map<string, number>; // only populated for type === "text"

  numSum: number;
  numSumSq: number;
  numCount: number;
  numMin: number | null;
  numMax: number | null;

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
}

function newAccum(field: CatalogField): Accum {
  const label = (field.label && field.label.trim()) || field.name;
  return {
    name: field.name,
    label,
    type: normalizeType(field.type),
    unit: extractUnit(field),
    looksTemporalByName: TEMPORAL_NAME_RE.test(field.name) || TEMPORAL_NAME_RE.test(label),
    total: 0,
    nonNull: 0,
    distinct: new Set(),
    distinctCapped: false,
    freq: new Map(),
    numSum: 0,
    numSumSq: 0,
    numCount: 0,
    numMin: null,
    numMax: null,
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
  };
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
          }
        }
        if (!acc.distinctCapped && acc.type === "text") {
          acc.freq.set(key, (acc.freq.get(key) ?? 0) + 1);
        }
      }

      if (acc.type === "int" || acc.type === "double") {
        const n = toNumber(raw);
        if (n !== null) {
          acc.numCount++;
          acc.numSum += n;
          acc.numSumSq += n * n;
          acc.numMin = acc.numMin === null ? n : Math.min(acc.numMin, n);
          acc.numMax = acc.numMax === null ? n : Math.max(acc.numMax, n);

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

      if (acc.type === "date" || acc.type === "datetime") {
        const parsed = parseTemporalValue(raw);
        if (parsed) {
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

      if ((acc.type === "text" || acc.type === "int") && acc.looksTemporalByName) {
        acc.sampleAttempts++;
        if (parseTemporalValue(raw) !== null) acc.sampleOk++;
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
}

function classifyFields(accumList: Accum[]): Classification {
  const temporal: ClassifiedField[] = [];
  const measure: ClassifiedField[] = [];
  const dimension: DimensionField[] = [];
  const geo: ClassifiedField[] = [];

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

    const isRowIndex =
      (acc.rowIndexCandidate && acc.numCount >= 5) || GENERIC_INDEX_NAME_RE.test(acc.name);
    const isCoordinate = COORDINATE_RE.test(acc.name) || COORDINATE_RE.test(acc.label);
    if (
      (acc.type === "int" || acc.type === "double") &&
      !MEASURE_EXCLUDE_RE.test(acc.name) &&
      !isRowIndex &&
      !isCoordinate
    ) {
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

  return { temporal, measure, dimension, geo };
}

function measureVariance(acc: Accum): number {
  if (acc.numCount === 0) return 0;
  const mean = acc.numSum / acc.numCount;
  const v = acc.numSumSq / acc.numCount - mean * mean;
  return v > 0 ? v : 0;
}

/** "best" measure = highest non-null count with non-constant variance (spec's area-chart rule, reused everywhere a single measure must be picked). */
function pickBestMeasure(measures: ClassifiedField[]): ClassifiedField | null {
  const withData = measures.filter((m) => m.accum.numCount > 0);
  if (withData.length === 0) return null;
  const nonConstant = withData.filter((m) => measureVariance(m.accum) > 1e-9);
  const pool = nonConstant.length > 0 ? nonConstant : withData;
  return [...pool].sort((a, b) => {
    if (b.accum.numCount !== a.accum.numCount) return b.accum.numCount - a.accum.numCount;
    return measureVariance(b.accum) - measureVariance(a.accum);
  })[0];
}

function aggregateKindFor(measure: ClassifiedField): Aggregate {
  return RATE_LABEL_RE.test(measure.name) || RATE_LABEL_RE.test(measure.label) ? "mean" : "sum";
}

function geoMeta(geo: ClassifiedField[]): GeoFieldMeta[] {
  return geo.map((g) => ({ name: g.name, label: g.label, type: g.accum.type }));
}

// ---------------------------------------------------------------------------
// Chart builders — each does its own light second pass over `records` for
// just the 2-3 fields it needs, and returns null (rather than a degenerate
// chart) if it can't actually produce data, so the caller falls through to
// the next rule in the decision tree.
// ---------------------------------------------------------------------------

type Built = { vizConfig: VizConfig; chartData: unknown[] };

function periodKeyFor(parsed: { year: number; month: number | null }, grain: Grain): string {
  return grain === "year" ? String(parsed.year) : `${parsed.year}-${pad2(parsed.month ?? 1)}`;
}

function grainFor(temporalField: ClassifiedField): Grain {
  return temporalField.accum.temporalYearOnly && temporalField.accum.temporalParsed > 0 ? "year" : "month";
}

function buildArea(
  records: Record<string, unknown>[],
  temporalField: ClassifiedField,
  measures: ClassifiedField[],
  geoFields: GeoFieldMeta[],
): Built | null {
  const measure = pickBestMeasure(measures);
  if (!measure) return null;
  const grain = grainFor(temporalField);
  const aggregate = aggregateKindFor(measure);

  const groups = new Map<string, { sum: number; count: number }>();
  for (const row of records) {
    const parsed = parseTemporalValue(row[temporalField.name]);
    if (!parsed) continue;
    const val = toNumber(row[measure.name]);
    if (val === null) continue;
    const period = periodKeyFor(parsed, grain);
    const g = groups.get(period) ?? { sum: 0, count: 0 };
    g.sum += val;
    g.count += 1;
    groups.set(period, g);
  }
  if (groups.size === 0) return null;

  const periods = downsampleEvenly([...groups.keys()].sort(), MAX_CHART_POINTS);
  const chartData = periods.map((period) => {
    const g = groups.get(period)!;
    const value = aggregate === "mean" ? g.sum / g.count : g.sum;
    return { period, value: roundTo(value, 4) };
  });

  const vizConfig: VizConfig = {
    type: "area",
    geoFields,
    temporalField: temporalField.name,
    temporalLabel: temporalField.label,
    grain,
    measureField: measure.name,
    measureLabel: measure.label,
    aggregate,
    ...(measure.accum.unit ? { unit: measure.accum.unit } : {}),
  };
  return { vizConfig, chartData };
}

function buildMultiLine(
  records: Record<string, unknown>[],
  temporalField: ClassifiedField,
  measures: ClassifiedField[],
  seriesDim: DimensionField,
  geoFields: GeoFieldMeta[],
): Built | null {
  const measure = pickBestMeasure(measures);
  if (!measure) return null;
  const grain = grainFor(temporalField);
  const aggregate = aggregateKindFor(measure);

  const periodSeries = new Map<string, Map<string, { sum: number; count: number }>>();
  const seriesTotals = new Map<string, number>();

  for (const row of records) {
    const parsed = parseTemporalValue(row[temporalField.name]);
    if (!parsed) continue;
    const cat = toDisplayString(row[seriesDim.name]);
    if (cat === null) continue;
    const val = toNumber(row[measure.name]);
    if (val === null) continue;
    const period = periodKeyFor(parsed, grain);
    let byCat = periodSeries.get(period);
    if (!byCat) {
      byCat = new Map();
      periodSeries.set(period, byCat);
    }
    const g = byCat.get(cat) ?? { sum: 0, count: 0 };
    g.sum += val;
    g.count += 1;
    byCat.set(cat, g);
    seriesTotals.set(cat, (seriesTotals.get(cat) ?? 0) + Math.abs(val));
  }
  if (periodSeries.size === 0) return null;

  let seriesValues = [...seriesTotals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const seriesOverflow = seriesValues.length > SERIES_CAP;
  if (seriesOverflow) seriesValues = seriesValues.slice(0, SERIES_CAP);

  const periods = downsampleEvenly([...periodSeries.keys()].sort(), MAX_CHART_POINTS);
  const chartData = periods.map((period) => {
    const byCat = periodSeries.get(period);
    const row: Record<string, string | number | null> = { period };
    for (const cat of seriesValues) {
      const g = byCat?.get(cat);
      row[cat] = g ? roundTo(aggregate === "mean" ? g.sum / g.count : g.sum, 4) : null;
    }
    return row;
  });

  const vizConfig: VizConfig = {
    type: "multi-line",
    geoFields,
    temporalField: temporalField.name,
    temporalLabel: temporalField.label,
    grain,
    measureField: measure.name,
    measureLabel: measure.label,
    aggregate,
    seriesField: seriesDim.name,
    seriesLabel: seriesDim.label,
    seriesValues,
    seriesOverflow,
    ...(measure.accum.unit ? { unit: measure.accum.unit } : {}),
  };
  return { vizConfig, chartData };
}

function buildBarH(
  records: Record<string, unknown>[],
  dim: ClassifiedField,
  measures: ClassifiedField[],
  geoFields: GeoFieldMeta[],
): Built | null {
  const measure = pickBestMeasure(measures);
  if (!measure) return null;
  const aggregate = aggregateKindFor(measure);

  const groups = new Map<string, { sum: number; count: number }>();
  for (const row of records) {
    const cat = toDisplayString(row[dim.name]);
    if (cat === null) continue;
    const val = toNumber(row[measure.name]);
    if (val === null) continue;
    const g = groups.get(cat) ?? { sum: 0, count: 0 };
    g.sum += val;
    g.count += 1;
    groups.set(cat, g);
  }
  if (groups.size === 0) return null;

  const finalized = [...groups.entries()]
    .map(([category, g]) => ({
      category,
      value: aggregate === "mean" ? g.sum / g.count : g.sum,
      sum: g.sum,
      count: g.count,
    }))
    .sort((a, b) => b.value - a.value);

  const top = finalized.slice(0, BAR_TOP_N);
  const rest = finalized.slice(BAR_TOP_N);

  const chartData: Array<{ category: string; value: number }> = top.map((r) => ({
    category: r.category,
    value: roundTo(r.value, 4),
  }));
  if (rest.length > 0) {
    const restSum = rest.reduce((s, r) => s + r.sum, 0);
    const restCount = rest.reduce((s, r) => s + r.count, 0);
    const restValue = aggregate === "mean" ? (restCount > 0 ? restSum / restCount : 0) : restSum;
    chartData.push({ category: OTHER_LABEL, value: roundTo(restValue, 4) });
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
  };
  return { vizConfig, chartData };
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
  records: Record<string, unknown>[],
  dimensions: DimensionField[],
  measures: ClassifiedField[],
  geoFields: GeoFieldMeta[],
): Built | null {
  const measure = pickBestMeasure(measures);
  if (!measure) return null;
  const aggregate = aggregateKindFor(measure);

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

  const cellMap = new Map<string, Map<string, { sum: number; count: number }>>();
  const xTotals = new Map<string, number>();
  const seriesTotals = new Map<string, number>();

  for (const row of records) {
    const xVal = toDisplayString(row[xDim.name]);
    const sVal = toDisplayString(row[seriesDim.name]);
    if (xVal === null || sVal === null) continue;
    const val = toNumber(row[measure.name]);
    if (val === null) continue;
    let bySeries = cellMap.get(xVal);
    if (!bySeries) {
      bySeries = new Map();
      cellMap.set(xVal, bySeries);
    }
    const g = bySeries.get(sVal) ?? { sum: 0, count: 0 };
    g.sum += val;
    g.count += 1;
    bySeries.set(sVal, g);
    xTotals.set(xVal, (xTotals.get(xVal) ?? 0) + Math.abs(val));
    seriesTotals.set(sVal, (seriesTotals.get(sVal) ?? 0) + Math.abs(val));
  }
  if (cellMap.size === 0) return null;

  let seriesValues = [...seriesTotals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const seriesOverflow = seriesValues.length > SERIES_CAP;
  if (seriesOverflow) seriesValues = seriesValues.slice(0, SERIES_CAP);

  const xValues = [...xTotals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const xTop = xValues.slice(0, BAR_TOP_N);
  const xRest = xValues.slice(BAR_TOP_N);

  function cellValue(xVal: string, sVal: string): number | null {
    const g = cellMap.get(xVal)?.get(sVal);
    if (!g) return null;
    return aggregate === "mean" ? g.sum / g.count : g.sum;
  }

  const chartData: Array<Record<string, string | number | null>> = xTop.map((xVal) => {
    const row: Record<string, string | number | null> = { category: xVal };
    for (const sVal of seriesValues) {
      const v = cellValue(xVal, sVal);
      row[sVal] = v === null ? null : roundTo(v, 4);
    }
    return row;
  });

  if (xRest.length > 0) {
    const row: Record<string, string | number | null> = { category: OTHER_LABEL };
    for (const sVal of seriesValues) {
      let sum = 0;
      let count = 0;
      let any = false;
      for (const xVal of xRest) {
        const g = cellMap.get(xVal)?.get(sVal);
        if (g) {
          sum += g.sum;
          count += g.count;
          any = true;
        }
      }
      row[sVal] = any ? roundTo(aggregate === "mean" ? sum / count : sum, 4) : null;
    }
    chartData.push(row);
  }

  const vizConfig: VizConfig = {
    type: "bar-stacked",
    geoFields,
    xField: xDim.name,
    xLabel: xDim.label,
    seriesField: seriesDim.name,
    seriesLabel: seriesDim.label,
    seriesValues,
    seriesOverflow,
    measureField: measure.name,
    measureLabel: measure.label,
    aggregate,
    otherBucketed: xRest.length > 0,
    ...(measure.accum.unit ? { unit: measure.accum.unit } : {}),
  };
  return { vizConfig, chartData };
}

function buildHistogram(
  records: Record<string, unknown>[],
  measures: ClassifiedField[],
  geoFields: GeoFieldMeta[],
): Built | null {
  const measure = pickBestMeasure(measures);
  if (!measure) return null;
  const acc = measure.accum;
  if (acc.numCount === 0 || acc.numMin === null || acc.numMax === null || acc.numMin === acc.numMax) return null;

  const BIN_COUNT = 10;
  const min = acc.numMin;
  const max = acc.numMax;
  const width = (max - min) / BIN_COUNT;
  const counts = new Array(BIN_COUNT).fill(0) as number[];

  for (const row of records) {
    const v = toNumber(row[measure.name]);
    if (v === null) continue;
    const idx = clampIndex(Math.floor((v - min) / width), BIN_COUNT - 1);
    counts[idx]++;
  }

  const chartData = counts.map((count, i) => ({
    bucket: `${formatNumberAr(min + i * width)}–${formatNumberAr(min + (i + 1) * width)}`,
    rangeMin: roundTo(min + i * width, 4),
    rangeMax: roundTo(min + (i + 1) * width, 4),
    count,
  }));

  const vizConfig: VizConfig = {
    type: "histogram",
    geoFields,
    measureField: measure.name,
    measureLabel: measure.label,
    binCount: BIN_COUNT,
    min: roundTo(min, 4),
    max: roundTo(max, 4),
    ...(measure.accum.unit ? { unit: measure.accum.unit } : {}),
  };
  return { vizConfig, chartData };
}

// ---------------------------------------------------------------------------
// Decision tree (item 4 in the spec) — first match wins. Each builder
// returns null when the structural match doesn't yield real data (e.g. a
// "temporal" field whose values happen not to parse), in which case we
// fall through to the next rule rather than persisting an empty chart.
// ---------------------------------------------------------------------------

function buildVizConfig(
  records: Record<string, unknown>[],
  classification: Classification,
): { vizConfig: VizConfig; chartData: unknown[] | null } {
  const { temporal, measure, dimension, geo } = classification;
  const geoFields = geoMeta(geo);
  const seriesAbleDims = dimension.filter((d) => d.seriesAble);
  const primaryTemporal = temporal[0];

  if (primaryTemporal && measure.length > 0 && seriesAbleDims.length > 0) {
    const built = buildMultiLine(records, primaryTemporal, measure, seriesAbleDims[0], geoFields);
    if (built) return built;
  }

  if (primaryTemporal && measure.length > 0) {
    const built = buildArea(records, primaryTemporal, measure, geoFields);
    if (built) return built;
  }

  if (dimension.length === 1 && measure.length > 0) {
    const built = buildBarH(records, dimension[0], measure, geoFields);
    if (built) return built;
  }

  if (dimension.length >= 2 && measure.length > 0) {
    const built = buildBarStacked(records, dimension, measure, geoFields);
    if (built) return built;
  }

  if (dimension.length === 0 && temporal.length === 0 && measure.length > 0 && records.length >= 20) {
    const built = buildHistogram(records, measure, geoFields);
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

function sumSeriesRow(row: Record<string, unknown>, seriesValues: string[] | undefined): number | null {
  if (!seriesValues) return null;
  let sum = 0;
  let any = false;
  for (const k of seriesValues) {
    const v = row[k];
    if (typeof v === "number") {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

function valueOfBarRow(row: Record<string, unknown>, vizConfig: VizConfig): number | null {
  if (vizConfig.type === "bar-h") return typeof row.value === "number" ? row.value : null;
  if (vizConfig.type === "bar-stacked") return sumSeriesRow(row, vizConfig.seriesValues);
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
    const last = data[data.length - 1];
    const prev = data.length > 1 ? data[data.length - 2] : null;
    const period = typeof last.period === "string" ? last.period : null;
    const latest = vizConfig.type === "area"
      ? typeof last.value === "number" ? last.value : null
      : sumSeriesRow(last, vizConfig.seriesValues);
    if (period === null || latest === null) return fallback;

    let sentence = `آخر قيمة مسجلة: ${formatNumberAr(latest)}`;
    if (vizConfig.unit) sentence += ` ${vizConfig.unit}`;
    sentence += ` في ${period}`;

    if (prev) {
      const prevValue = vizConfig.type === "area"
        ? typeof prev.value === "number" ? prev.value : null
        : sumSeriesRow(prev, vizConfig.seriesValues);
      if (prevValue !== null && prevValue !== 0) {
        const pct = ((latest - prevValue) / Math.abs(prevValue)) * 100;
        const sign = pct >= 0 ? "+" : "-";
        sentence += `، بتغير ${sign}${Math.abs(pct).toFixed(1)}% عن الفترة السابقة`;
      }
    }
    return sentence + ".";
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

    let sentence = `الفئة الأعلى: «${top.category}» بقيمة ${formatNumberAr(topValue)}`;
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
    const { vizConfig, chartData } = buildVizConfig(records, classification);
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
