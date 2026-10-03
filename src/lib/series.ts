/**
 * Pure, dependency-free helpers shared by the derivation engine (sync time,
 * `src/lib/sync/derived.ts`) and the view-model layer (render time,
 * `src/lib/chart-data.ts`). Nothing here imports from either of them, so the
 * rules below cannot drift between "what we persisted" and "what we show":
 *
 *   1. Total-row / total-series detection (two tiers, see below).
 *   2. Token-aware aggregate inference (sum vs. mean).
 *   3. Period arithmetic (year / month), cadence detection and gap filling.
 *   4. Partial-trailing-period detection.
 */

export type Grain = "year" | "month";

/**
 * How a measure is collapsed within a period/category:
 *   - "sum":  additive counts/amounts (the default).
 *   - "mean": rates, percentages, indices, prices - NOT additive, never stacked.
 *   - "last": stocks/cumulative values - the latest observation in the period.
 *     Never inferred from labels (too unreliable); only reachable through
 *     `src/config/viz-overrides.ts`.
 */
export type Aggregate = "sum" | "mean" | "last";

// ---------------------------------------------------------------------------
// 1. Totals
// ---------------------------------------------------------------------------

/**
 * Government statistical tables very often carry an explicit "Total" value
 * next to its components (e.g. the airport dataset's `data_type` series is
 * "Passengers Total" plus embark/disembark/transit/transfers; Nationality =
 * Bahraini / Non-Bahraini / Total). Summing parts AND the total double counts,
 * so every consumer must decide which value is the total. Two tiers:
 *
 *  - STRICT (whole label is just "Total"): safe to DROP rows on dimensions
 *    that are not plotted, because no legitimate part is ever called exactly
 *    "Total" / "الإجمالي".
 *  - LOOSE (a word-boundary "total" anywhere, e.g. "Passengers Total"): only
 *    used on the plotted series dimension, and only when EXACTLY ONE value
 *    matches. "Total Imports" next to "Total Exports" are both legitimate
 *    parts, so two or more loose matches mean "ambiguous", never "pick one".
 */
const LATIN_TOTAL_RE = /(?<![a-z])(?<!sub[\s_-])(?:grand[\s_-]*)?totals?(?![a-z])|(?<![a-z])overall(?![a-z])/i;
// JS `\b` does not work on Arabic, so spell the word boundary out. "مجموعة"
// (group) and "مجموعات" must NOT match "مجموع" - hence the lookahead.
const ARABIC_TOTAL_RE = /(?<![؀-ۿ])(?:ال)?(?:[إا]جمالي|مجموع)(?![؀-ۿ])/;
const ARABIC_SUBTOTAL_RE = /فرعي/;

const STRICT_TOTAL_RES: RegExp[] = [
  /^(?:grand )?totals?$/,
  /^overall(?: total)?$/,
  /^(?:ال)?(?:[إا]جمالي|مجموع)(?: (?:العام|الكلي|الإجمالي|الاجمالي))?$/,
];

/**
 * Cheap necessary condition for every strict pattern above. The derivation
 * engine asks this for each row of high-cardinality text fields, so it must
 * not pay for normalization on the 99.99% of values that are plainly not totals.
 */
const STRICT_TOTAL_HINT_RE = /total|overall|جمالي|مجموع/i;

function normalizeTotalLabel(label: string): string {
  return label
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_\-–—:.()[\]]+/g, " ")
    .trim();
}

/** Strict tier: the whole label is "Total" / "Grand total" / "الإجمالي" / "المجموع" (case, spacing and punctuation tolerant). */
export function isStrictTotalLabel(label: string): boolean {
  if (typeof label !== "string" || label.length === 0 || label.length > 40) return false;
  if (!STRICT_TOTAL_HINT_RE.test(label)) return false;
  const norm = normalizeTotalLabel(label);
  return STRICT_TOTAL_RES.some((re) => re.test(norm));
}

/** Loose tier: a word-boundary total/overall/إجمالي/مجموع anywhere in the label ("Passengers Total"). Sub-totals do not count. */
export function isLooseTotalLabel(label: string): boolean {
  if (typeof label !== "string" || label.length === 0) return false;
  if (ARABIC_SUBTOTAL_RE.test(label)) return false;
  return LATIN_TOTAL_RE.test(label) || ARABIC_TOTAL_RE.test(label);
}

/**
 * The loose pattern as a plain RegExp, under the name chart-data.ts used before
 * the logic moved here. Prefer `isLooseTotalLabel` (it also rejects Arabic
 * sub-totals, which a bare regex cannot express without a second pass).
 */
export const TOTAL_SERIES_LABEL_PATTERN = new RegExp(`${LATIN_TOTAL_RE.source}|${ARABIC_TOTAL_RE.source}`, "i");

export interface TotalSeriesPick {
  /** The single total value, or null when there is none or it is ambiguous. */
  key: string | null;
  /** Every value matching the loose tier. */
  matches: string[];
  /** Two or more candidates and no unique strict one: any headline built from this series set is unreliable. */
  ambiguous: boolean;
}

/**
 * Picks the total among a dimension's values. A unique STRICT match wins even
 * when other values also contain the word ("Total" next to "Total Imports");
 * otherwise exactly one LOOSE match is the total; two or more is ambiguous.
 * A dimension with a single value has nothing to be a total of.
 */
export function findTotalSeries(values: readonly string[]): TotalSeriesPick {
  if (values.length < 2) return { key: null, matches: [], ambiguous: false };
  const matches = values.filter(isLooseTotalLabel);
  const strict = values.filter(isStrictTotalLabel);
  if (strict.length === 1) return { key: strict[0], matches, ambiguous: false };
  if (matches.length === 1) return { key: matches[0], matches, ambiguous: false };
  return { key: null, matches, ambiguous: matches.length >= 2 };
}

/** The single total value among `values`, or null (none, or ambiguous). */
export function pickTotalSeriesKey(values: readonly string[]): string | null {
  return findTotalSeries(values).key;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Sums the numeric series cells of one chart row. `requireAll` makes a row
 * with ANY missing/non-numeric series return null (a series absent in a
 * period must not look like a drop to zero); the default sums what exists.
 */
export function sumSeriesRow(
  row: Record<string, unknown>,
  seriesValues: readonly string[] | undefined,
  opts: { requireAll?: boolean } = {},
): number | null {
  if (!seriesValues || seriesValues.length === 0) return null;
  let sum = 0;
  let any = false;
  for (const k of seriesValues) {
    const v = row[k];
    if (isFiniteNumber(v)) {
      sum += v;
      any = true;
    } else if (opts.requireAll) {
      return null;
    }
  }
  return any ? sum : null;
}

// ---------------------------------------------------------------------------
// 2. Aggregate inference (sum vs mean)
// ---------------------------------------------------------------------------

/**
 * Latin words that mark a NON-additive measure. Matched as whole tokens after
 * splitting camelCase/snake_case, so "registRATIOn", "opeRATIOns", "duRATIOn",
 * "sepaRATE" never match (the old unbounded substring regex averaged counts
 * like "Number of Registrations") while "passengerRate" / "unemployment_rate"
 * do. Index/level/price/temperature are included because summing a CPI or a
 * price over months and categories yields numbers like 42,000 instead of ~110.
 */
const LATIN_MEAN_TOKENS = new Set([
  "rate", "rates",
  "percent", "percents", "percentage", "percentages", "pct",
  "ratio", "ratios", "proportion", "proportions",
  "average", "averages", "avg", "mean", "median",
  "index", "indices", "indexes",
  "level", "levels",
  "price", "prices",
  "temperature", "temperatures", "humidity", "density",
]);
const LATIN_PER_PHRASE_RE = /\bper\s*(?:capita|cent|hundred|thousand|million|\d[\d,]*)\b/;
/** Arabic has no usable `\b`: plain substring match, per the spec. */
const ARABIC_MEAN_RE =
  /معدل|نسبة|متوسط|مؤشر|سعر|أسعار|اسعار|درجة الحرارة|مستوى|مستويات|الرقم القياسي|رقم قياسي|كثافة/;
/** A bare "Point"/"Points" label is how the CPI datasets name the index value. */
const BARE_INDEX_POINT_RE = /^(?:points?|نقطة|نقاط)$/i;

function latinTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** True when `text` (a field name, label or unit) says the measure is a rate/percent/index/price/average. */
export function isMeanLikeText(text: string | null | undefined): boolean {
  if (!text) return false;
  if (/[%٪]/.test(text)) return true;
  if (ARABIC_MEAN_RE.test(text)) return true;
  if (BARE_INDEX_POINT_RE.test(text.trim())) return true;
  const lower = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  if (LATIN_PER_PHRASE_RE.test(lower)) return true;
  return latinTokens(text).some((t) => LATIN_MEAN_TOKENS.has(t));
}

/**
 * Heuristic aggregate for a measure: "mean" when its name, label or unit says
 * it is a rate/percent/index/price/average, else "sum". Never returns "last".
 */
export function inferAggregate(input: {
  name?: string | null;
  label?: string | null;
  unit?: string | null;
}): "sum" | "mean" {
  return isMeanLikeText(input.name) || isMeanLikeText(input.label) || isMeanLikeText(input.unit) ? "mean" : "sum";
}

/**
 * Fallback unit extraction for sources that carry no `annotations.unit`:
 * a trailing "(km2)" / "[BHD]" / "(%)" in the label, an Arabic "بالـ…"
 * phrase, or a bare "%". Returns null when nothing unit-like is found.
 */
export function inferUnitFromLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const text = label.trim();
  const paren = text.match(/[([]\s*([^()[\]]{1,24}?)\s*[)\]]\s*$/);
  if (paren) {
    const candidate = paren[1].trim();
    const notAUnit = /^\d{1,4}$/.test(candidate) || /^(total|sum|avg|average|mean|count|number|no|n|ar|en|arabic|english)$/i.test(candidate);
    if (candidate && !notAUnit) return candidate;
  }
  const arabic = text.match(/\s(بال[؀-ۿ]+(?:\s[؀-ۿ]+)?)\s*$/);
  if (arabic) return arabic[1].trim();
  if (/[%٪]/.test(text)) return "%";
  return null;
}

// ---------------------------------------------------------------------------
// 3. Periods: arithmetic, cadence, gap filling
// ---------------------------------------------------------------------------

export interface PeriodParts {
  year: number;
  month: number | null;
}

/** Parses a persisted period key: "2026" (year grain) or "2026-03" (month grain). */
export function parsePeriod(period: string): PeriodParts | null {
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(period);
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] === undefined ? null : Number(m[2]);
  if (month !== null && (month < 1 || month > 12)) return null;
  return { year, month };
}

/** Ordinal of a period on its grain's integer line (years, or months since year 0). */
export function periodIndex(period: string, grain: Grain): number | null {
  const p = parsePeriod(period);
  if (!p) return null;
  return grain === "year" ? p.year : p.year * 12 + ((p.month ?? 1) - 1);
}

function periodFromIndex(index: number, grain: Grain): string {
  if (grain === "year") return String(index);
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${month < 10 ? "0" : ""}${month}`;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Upper bound for gap-filled periods (1900-2100 is 2,412 months, so this never bites real data). */
const MAX_FILLED_PERIODS = 5000;

/**
 * Fills the missing periods between the first and last of an ascending,
 * de-duplicated list so gaps are drawn as gaps instead of silently bridged.
 * The step is the greatest common divisor of the observed spacings, so a
 * regular quarterly (step 3) or biennial series is NOT broken into isolated
 * dots, while 2015, 2016, 2019 still reveals the missing 2017 and 2018.
 */
export function fillPeriodGaps(periods: readonly string[], grain: Grain): { periods: string[]; step: number } {
  const idx: number[] = [];
  for (const p of periods) {
    const i = periodIndex(p, grain);
    if (i === null) return { periods: [...periods], step: 1 };
    idx.push(i);
  }
  if (idx.length < 2) return { periods: [...periods], step: 1 };
  let step = 0;
  for (let i = 1; i < idx.length; i++) step = gcd(step, idx[i] - idx[i - 1]);
  if (step <= 0) return { periods: [...periods], step: 1 };
  const count = (idx[idx.length - 1] - idx[0]) / step + 1;
  if (count > MAX_FILLED_PERIODS) return { periods: [...periods], step };
  const out: string[] = [];
  for (let i = idx[0]; i <= idx[idx.length - 1]; i += step) out.push(periodFromIndex(i, grain));
  return { periods: out, step };
}

/** True when `prev` is exactly one cadence step before `cur`. */
export function isAdjacentPeriod(prev: string, cur: string, grain: Grain, step = 1): boolean {
  const a = periodIndex(prev, grain);
  const b = periodIndex(cur, grain);
  return a !== null && b !== null && b - a === step;
}

// ---------------------------------------------------------------------------
// 4. Partial trailing period
// ---------------------------------------------------------------------------

/** Median of a non-empty list (0 for an empty one). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const PARTIAL_RATIO = 0.75;
const PARTIAL_LOOKBACK = 5;
const PARTIAL_MIN_PRIOR = 3;

/**
 * True when the LAST period looks incomplete (a year-to-date or half-filled
 * month), judged by row coverage: its row count - summed across ALL series
 * of the period - is below 75% of the median of the up-to-5 periods before
 * it, and at least 3 such prior periods exist. `counts` are the per-period
 * row counts of the periods that HAVE data, ascending, evaluated on the full
 * list (before downsampling, before gap filling).
 *
 * Known limit, by design: a table with exactly one row per year cannot be
 * judged this way (a year-to-date value has count 1 like every other year);
 * it only catches tables whose row coverage per period varies (category x
 * month tables, daily/weekly sources). Only meaningful for sum aggregation.
 */
export function detectPartialLastPeriod(counts: readonly number[]): boolean {
  if (counts.length < PARTIAL_MIN_PRIOR + 1) return false;
  const last = counts[counts.length - 1];
  const prior = counts.slice(Math.max(0, counts.length - 1 - PARTIAL_LOOKBACK), counts.length - 1);
  const med = median(prior);
  return med > 0 && last < PARTIAL_RATIO * med;
}
