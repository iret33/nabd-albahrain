/**
 * Pure, dependency-free helpers shared by the derivation engine (sync time,
 * `src/lib/sync/derived.ts`) and the view-model layer (render time,
 * `src/lib/chart-data.ts`). Nothing here imports from either of them, so the
 * rules below cannot drift between "what we persisted" and "what we show":
 *
 *   1. Total-row / total-series detection (two label tiers, plus a numeric
 *      "this value is the sum of its siblings" check for what labels miss).
 *   2. Token-aware aggregate inference (sum vs. mean).
 *   3. Period arithmetic (year / month), cadence detection and gap filling.
 *   4. Partial-trailing-period detection (row coverage + calendar).
 *   5. Name predicates: identifier-like measures, non-additive series names.
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

/**
 * Labels that OFTEN name a whole ("All", "All nationalities", "Both sexes",
 * "Kingdom of Bahrain", "جميع الجنسيات", "المملكة") but can also be a legitimate
 * part ("Bahrain" as a nationality, "Both" as a category). They are CANDIDATES
 * only: nothing is ever dropped or treated as a total because of the label
 * alone, it must also pass the numeric check below (`findNumericTotalSeries`,
 * `totalCellsAgree`).
 */
const EXTENDED_CANDIDATE_RES: RegExp[] = [
  /^all(?: [a-z][a-z ]*)?$/,
  /^both(?: sexes| sex| genders)?$/,
  /^(?:kingdom|kingdom of bahrain|bahrain|whole country|entire country|national|nationwide|whole population)$/,
  /^(?:جميع|كل|كافة) .+$/,
  /^(?:الكل|كلا الجنسين|الجنسين|المملكة|مملكة البحرين|البحرين)$/,
];

/**
 * A value that may be the total of its siblings: a loose total label ("Total
 * (all)", "Total Population", "Passengers Total") or one of the extended
 * candidates above, but NOT a strict total (those are accepted by label alone).
 */
export function isTotalCandidateLabel(label: string): boolean {
  if (typeof label !== "string" || label.length === 0 || label.length > 60) return false;
  if (isStrictTotalLabel(label)) return false;
  if (isLooseTotalLabel(label)) return true;
  const norm = normalizeTotalLabel(label);
  return EXTENDED_CANDIDATE_RES.some((re) => re.test(norm));
}

/** Relative tolerance for "the total equals the sum of its parts" (published parts drift by rounding). */
const TOTAL_REL_TOLERANCE = 0.005;
/** Share of the compared cells that must agree. */
const TOTAL_QUORUM = 0.8;
/** At least this many cells (periods) must be compared before anything is called a total. */
const TOTAL_MIN_CELLS = 3;

function sumTolerance(total: number, siblings: number, allIntegers: boolean): number {
  // Integer parts were each rounded, so the sum can drift by up to half a unit per part.
  return Math.max(Math.abs(total) * TOTAL_REL_TOLERANCE, allIntegers ? 0.5 * siblings : 0);
}

/**
 * Among `keys` (the series of a chart), the ONE whose values equal the sum of
 * all the others in at least 80% of the periods where every series is present,
 * judged on at least 3 such periods and at least 2 siblings (with a single
 * sibling "equal values" is a legitimate pair, not a total). Non-negative
 * values only; zero-sum periods carry no evidence and are skipped. Two
 * candidates passing is ambiguous: null. Only meaningful for ADDITIVE measures.
 * Returns null whenever the evidence is thin, so the safe answer is "no total".
 */
export function findNumericTotalSeries(
  rows: ReadonlyArray<Record<string, unknown>>,
  keys: readonly string[],
  opts: {
    /** Only these keys may be the total (the labels nominated them); default: any key. */
    candidates?: readonly string[];
    /** Minimum number of rows compared; default 3 (a bar chart has one row, so it passes 1 together with `candidates`). */
    minCells?: number;
  } = {},
): string | null {
  if (keys.length < 3) return null;
  const minCells = Math.max(1, opts.minCells ?? TOTAL_MIN_CELLS);
  const allowed = opts.candidates ? new Set(opts.candidates) : null;
  // Per usable row: the value of every key, their sum, and whether all are integers.
  const usable: Array<{ values: number[]; sum: number; integers: boolean }> = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const values: number[] = [];
    let sum = 0;
    let integers = true;
    let ok = true;
    for (const k of keys) {
      const v = (row as Record<string, unknown>)[k];
      if (!isFiniteNumber(v) || v < 0) {
        ok = false;
        break;
      }
      values.push(v);
      sum += v;
      if (!Number.isInteger(v)) integers = false;
    }
    if (ok) usable.push({ values, sum, integers });
  }
  if (usable.length < minCells) return null;

  let found: string | null = null;
  for (let i = 0; i < keys.length; i++) {
    if (allowed && !allowed.has(keys[i])) continue;
    let evaluated = 0;
    let agree = 0;
    for (const u of usable) {
      const others = u.sum - u.values[i];
      if (others <= 0) continue; // all siblings zero: no evidence either way
      evaluated++;
      if (Math.abs(u.values[i] - others) <= sumTolerance(u.values[i], keys.length - 1, u.integers)) agree++;
    }
    if (evaluated >= minCells && agree / evaluated >= TOTAL_QUORUM) {
      if (found !== null) return null; // two candidates: ambiguous
      found = keys[i];
    }
  }
  return found;
}

/** One cell of the record-level check: a candidate total and the siblings it sits next to. */
export interface TotalCell {
  candidate: number;
  siblings: number;
  /** The largest single sibling. */
  maxSibling: number;
  siblingCount: number;
  allIntegers: boolean;
}

/**
 * True when a candidate value behaves like the total of its siblings across
 * `cells` (same quorum / minimum evidence as `findNumericTotalSeries`): in
 * each cell candidate ~= sum of siblings, and never below the largest sibling.
 */
export function totalCellsAgree(cells: Iterable<TotalCell>): boolean {
  let evaluated = 0;
  let agree = 0;
  for (const c of cells) {
    if (c.siblingCount < 2 || c.siblings <= 0) continue;
    evaluated++;
    const tol = sumTolerance(c.candidate, c.siblingCount, c.allIntegers);
    if (Math.abs(c.candidate - c.siblings) <= tol && c.candidate >= c.maxSibling - tol) agree++;
  }
  return evaluated >= TOTAL_MIN_CELLS && agree / evaluated >= TOTAL_QUORUM;
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
  // ratios, speeds, scores and growth figures: summing twelve monthly values of any of these is meaningless
  "speed", "speeds", "expectancy", "utilization", "utilisation", "yield", "yields",
  "growth", "inflation", "score", "scores", "rank", "ranks", "concentration", "concentrations",
]);
const LATIN_PER_PHRASE_RE = /\bper\s*(?:capita|cent|hundred|thousand|million|\d[\d,]*)\b/;
/**
 * "per <word>" for any unit that is not a period of time: "students per
 * teacher", "population per km2" are ratios, while "visits per year" or "cases
 * per quarter" are counts within a period and stay additive.
 */
const LATIN_PER_UNIT_RE = /\bper\s+(?!(?:day|week|month|quarter|year|annum|hour|minute|second)s?\b)[a-z0-9]/;
/** Two further whole phrases that always name a ratio. */
const LATIN_RATIO_PHRASE_RE = /\bshare\s+of\b|\bload\s+factor\b/;
/** Arabic "لكل" (per), again unless the unit is a period of time. */
const ARABIC_PER_RE = /(?<![؀-ۿ])لكل\s+(?!(?:يوم|أسبوع|اسبوع|شهر|سنة|عام|ربع)(?![؀-ۿ]))\S/;
/** Arabic has no usable `\b`: plain substring match, per the spec. */
const ARABIC_MEAN_RE =
  /معدل|نسبة|متوسط|مؤشر|سعر|أسعار|اسعار|درجة الحرارة|مستوى|مستويات|الرقم القياسي|رقم قياسي|كثافة/;
/** "عدد ..." = "number of ...": a count, even of schools called "متوسطة" or of "مستويات". */
const ARABIC_COUNT_PREFIX_RE = /^(?:ال)?عدد(?![؀-ۿ])/;
/** Under a count prefix only a STATED rate or ratio makes the measure non-additive. */
const ARABIC_COUNT_MEAN_RE = /معدل|نسبة/;
/** "متوسطة/المتوسطة/متوسطات" are the feminine/plural ADJECTIVE (intermediate schools), not "average". */
const ARABIC_INTERMEDIATE_RE = /(?:ال)?متوسط(?:ة|ات)/g;
/** "Number of Level 3 schools", "Number of price changes": what follows names WHAT is counted. */
const LATIN_COUNT_PREFIX_RE = /^\s*(?:the\s+)?(?:total\s+)?(?:number|no\.?|count|quantity)\s+of\b/i;
const COUNTED_QUALIFIER_TOKENS = new Set([
  "level", "levels", "price", "prices", "index", "indices", "indexes", "temperature", "temperatures",
  "humidity", "density", "score", "scores", "rank", "ranks", "speed", "speeds", "yield", "yields",
  "growth", "concentration", "concentrations",
]);
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
  const trimmed = text.trim();
  if (ARABIC_PER_RE.test(trimmed)) return true;
  if (ARABIC_COUNT_PREFIX_RE.test(trimmed)) {
    if (ARABIC_COUNT_MEAN_RE.test(trimmed)) return true;
  } else {
    const arabic = /مدرس|مدارس/.test(trimmed) ? trimmed.replace(ARABIC_INTERMEDIATE_RE, " ") : trimmed;
    if (ARABIC_MEAN_RE.test(arabic)) return true;
  }
  if (BARE_INDEX_POINT_RE.test(trimmed)) return true;
  const lower = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  if (LATIN_PER_PHRASE_RE.test(lower) || LATIN_PER_UNIT_RE.test(lower) || LATIN_RATIO_PHRASE_RE.test(lower)) return true;
  const counted = LATIN_COUNT_PREFIX_RE.test(trimmed);
  return latinTokens(text).some((t) => LATIN_MEAN_TOKENS.has(t) && !(counted && COUNTED_QUALIFIER_TOKENS.has(t)));
}

/** "km/h", "µg/m3", "BHD/kg": a slash inside a UNIT is a ratio of two quantities. */
function hasSlashUnit(unit: string | null | undefined): boolean {
  return !!unit && /\S\s*\/\s*\S/.test(unit);
}

/** The same for a label's trailing "(km/h)" / "[BHD/kg]"; a slash elsewhere ("Imports/Exports (BHD)") is just a list. */
function hasTrailingParenSlash(label: string | null | undefined): boolean {
  if (!label) return false;
  const paren = label.trim().match(/[([]\s*([^()[\]]{1,24}?)\s*[)\]]\s*$/);
  return !!paren && hasSlashUnit(paren[1]);
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
  return isMeanLikeText(input.name) ||
    isMeanLikeText(input.label) ||
    isMeanLikeText(input.unit) ||
    hasSlashUnit(input.unit) ||
    hasTrailingParenSlash(input.label)
    ? "mean"
    : "sum";
}

/**
 * Words that make a label's trailing parenthetical a UNIT rather than a
 * qualifier. "(Public)", "(Total)" or "(2020 census)" qualify the measure and
 * must never be printed after its value ("1,200 Public"), so only a
 * parenthetical made entirely of these words (and numbers, as in "per 1000")
 * is accepted.
 */
const UNIT_WORDS = new Set([
  // currencies and money scales
  "bd", "bhd", "usd", "sar", "aed", "kwd", "eur", "gbp", "dollar", "dollars", "dinar", "dinars",
  "thousand", "thousands", "million", "millions", "billion", "billions", "mn", "bn", "k",
  // length, area, volume, mass, energy, containers
  "km", "km2", "m", "m2", "m3", "cm", "mm", "ha", "hectare", "hectares", "sqm", "sqkm",
  "kg", "g", "mg", "t", "ton", "tons", "tonne", "tonnes", "l", "litre", "litres", "liter", "liters",
  "mw", "kw", "mwh", "kwh", "gwh", "mcm", "bbl", "barrel", "barrels", "teu",
  // counts and time
  "person", "persons", "people", "unit", "units", "household", "households", "case", "cases",
  "day", "days", "hour", "hours", "h", "hr", "hrs", "minute", "minutes", "week", "weeks", "month", "months", "year", "years",
  "ppm", "ppb", "mph",
  // ratios
  "percent", "percentage", "pct", "per", "capita", "cent", "of", "in", "points", "point",
  // Arabic
  "دينار", "بحريني", "طن", "كم", "كيلومتر", "متر", "مربع", "مكعب", "هكتار", "ألف", "الف", "مليون", "مليار",
  "شخص", "نسمة", "وحدة", "يوم", "ساعة", "شهر", "سنة", "لتر", "كيلوغرام", "كجم", "برميل", "حاوية", "مئوية",
]);

function isUnitText(candidate: string): boolean {
  if (/[%٪]/.test(candidate)) return true;
  const tokens = candidate
    .replace(/²/g, "2")
    .replace(/³/g, "3")
    .toLowerCase()
    .split(/[^a-z0-9\u0600-\u06FF]+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  let words = 0;
  for (const t of tokens) {
    if (/^\d+$/.test(t)) continue; // "per 1000"
    if (!UNIT_WORDS.has(t)) return false;
    words++;
  }
  return words > 0;
}

/**
 * Fallback unit extraction for sources that carry no `annotations.unit`:
 * a trailing "(km2)" / "[BHD]" / "(%)" in the label whose content is made of
 * unit words (never a qualifier such as "(Public)"), an Arabic "بالـ…"
 * phrase, or a bare "%". Returns null when nothing unit-like is found.
 */
export function inferUnitFromLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const text = label.trim();
  const paren = text.match(/[([]\s*([^()[\]]{1,24}?)\s*[)\]]\s*$/);
  if (paren) {
    const candidate = paren[1].trim();
    if (candidate && isUnitText(candidate)) return candidate;
  }
  const arabic = text.match(/\s(بال[\u0600-\u06FF]+(?:\s[\u0600-\u06FF]+)?)\s*$/);
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

/** What one period of a month-grain chart contains: row count and, when the rows carry dates, the latest day of the month seen. */
export interface PeriodCoverage {
  period: string;
  count: number;
  /** Greatest day-of-month among the period's rows; 0/undefined when the rows are day-less. */
  maxDay?: number;
}

/** A period more than this many days short of its own historical trailing slack is judged by the calendar, not the count. */
const CALENDAR_LOOKBACK = 6;
/** Calendar judgement needs a regular cadence: complete months must end within a week of month end (daily / business-day / weekly). */
const CALENDAR_MAX_LEARNED_SLACK = 6;
/** ...and the last period must ALSO have fewer rows than this share of the prior median (one weak signal never hides a period). */
const CALENDAR_COUNT_RATIO = 0.95;

function daysInMonthOf(period: string): number | null {
  const p = parsePeriod(period);
  if (!p || p.month === null) return null;
  return new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
}

/**
 * Calendar-based completeness for daily / weekly / business-day data, which
 * the row-count rule above misses when the last month is cut at day 24-29
 * (a 24-day month still has 77% of the rows of a 31-day one).
 *
 * "Slack" = days between a month's latest row and the month's end. The
 * dataset's own complete months show how large it normally is (0 for daily
 * data, up to 2-3 for business days, up to 6 for weekly data). The last period
 * is partial when its slack exceeds the largest prior slack AND it also has
 * visibly fewer rows. Judged only with >= 2 dated prior periods and a regular
 * cadence (largest prior slack <= 6): monthly-dated or event-log data fall
 * through to the count rule. Day-less periods are never judged here.
 */
export function detectPartialLastPeriodByCalendar(coverage: readonly PeriodCoverage[]): boolean {
  if (coverage.length < 3) return false;
  const last = coverage[coverage.length - 1];
  const lastDays = daysInMonthOf(last.period);
  if (!last.maxDay || last.maxDay < 1 || lastDays === null || last.maxDay > lastDays) return false;

  const prior = coverage.slice(Math.max(0, coverage.length - 1 - CALENDAR_LOOKBACK), coverage.length - 1);
  const slacks: number[] = [];
  for (const p of prior) {
    const days = daysInMonthOf(p.period);
    if (days === null || !p.maxDay || p.maxDay < 1 || p.maxDay > days) continue;
    slacks.push(days - p.maxDay);
  }
  if (slacks.length < 2) return false;
  const learned = Math.max(...slacks);
  if (learned > CALENDAR_MAX_LEARNED_SLACK) return false;
  if (lastDays - last.maxDay <= learned) return false;

  const med = median(prior.map((p) => p.count));
  return med > 0 && last.count < CALENDAR_COUNT_RATIO * med;
}

/** The count rule OR the calendar rule. `coverage` is ascending, one entry per period that has data. */
export function isLastPeriodPartial(coverage: readonly PeriodCoverage[]): boolean {
  return detectPartialLastPeriod(coverage.map((c) => c.count)) || detectPartialLastPeriodByCalendar(coverage);
}

// ---------------------------------------------------------------------------
// 5. Name predicates
// ---------------------------------------------------------------------------

function normalizeNameWords(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, " ")
    .trim();
}

/**
 * Whole-label identifier names: a numeric column that is an address part, a
 * phone/CPR or a register number, never a quantity. The WHOLE normalized name
 * must be one of these (optionally followed by no/number/num/nr/id/code), so
 * "Road Accidents", "Building Permits", "Road Length", "Zone Population" and
 * "Passengers Number" stay measures. Words that are also plausible counts when
 * bare ("Case", "Permit", "Order") only count WITH the number suffix.
 */
const BARE_IDENTIFIER_NOUNS =
  "phone|mobile|tel|telephone|fax|cpr|building|bldg|road|block|flat|apartment|house|plot|parcel|shop|unit|po box|pobox|p o box|zip|postal code|plate|chassis";
const SUFFIXED_IDENTIFIER_NOUNS =
  "licen[cs]e|registration|reg|permit|case|file|account|reference|ref|serial|passport|civil|cr|tax|invoice|receipt|ticket|tender|contract|order|policy|claim|booking|id card|national";
const ID_SUFFIX = "(?: (?:no|num|number|nr|id|code))";
const LATIN_IDENTIFIER_NAME_RE = new RegExp(
  `^(?:(?:${BARE_IDENTIFIER_NOUNS})${ID_SUFFIX}?|(?:${SUFFIXED_IDENTIFIER_NOUNS})${ID_SUFFIX})$`,
);
const ARABIC_IDENTIFIER_NAME_RE =
  /^(?:(?:ال)?(?:هاتف|جوال|مبنى|عمارة|بناية|طريق|شارع|مجمع|شقة|قطعة|منزل)|رقم\s+(?!قياسي)[؀-ۿ]+(?:\s+[؀-ۿ]+)?)$/;

/** True when a field name or label is, as a whole, an identifier/address-part name ("Phone", "Building", "Road No", "License Number", "رقم الهاتف"). */
export function isIdentifierLikeName(text: string | null | undefined): boolean {
  if (!text) return false;
  const norm = normalizeNameWords(text);
  if (norm === "" || norm.length > 40) return false;
  return LATIN_IDENTIFIER_NAME_RE.test(norm) || ARABIC_IDENTIFIER_NAME_RE.test(norm);
}

/**
 * A series NAME that says its values do not add up with its siblings: an
 * explicit "%" or per-N, or a rate/ratio/average/index/price word. Narrower than
 * `isMeanLikeText` on purpose: "Primary Level", "Low Density Housing" and
 * "Price Category" are real partitions and must keep their summed headline.
 */
const NON_ADDITIVE_NAME_TOKENS = new Set([
  "rate", "rates", "ratio", "ratios", "percent", "percents", "percentage", "percentages", "pct",
  "proportion", "proportions", "average", "averages", "avg", "mean", "median",
  "index", "indices", "indexes", "price", "prices",
]);
const ARABIC_NON_ADDITIVE_NAME_RE = /(?<![؀-ۿ])(?:ال)?(?:معدل(?:ات)?|نسبة|نسب|متوسط|مؤشر(?:ات)?|سعر|أسعار|اسعار)(?![؀-ۿ])/;

export function isNonAdditiveSeriesName(name: string | null | undefined): boolean {
  if (!name) return false;
  if (/[%٪]/.test(name)) return true;
  if (LATIN_PER_PHRASE_RE.test(name.toLowerCase())) return true;
  if (ARABIC_NON_ADDITIVE_NAME_RE.test(name)) return true;
  return latinTokens(name).some((t) => NON_ADDITIVE_NAME_TOKENS.has(t));
}

/**
 * A series DIMENSION whose values are different quantities rather than parts of
 * one ("Indicator", "Measure", "Metric", "Variable", "Parameter", "Pollutant",
 * "المؤشر", "البند"): summing its values mixes units. Matched as whole words on
 * the field name and label (machine names like indicator_name / dataType too).
 * Never bare "type" or "category": "Type of School" and "Nationality" are
 * partitions.
 */
const INDICATOR_DIMENSION_RE =
  /(?:^| )(?:indicators?|measures?|metrics?|variables?|parameters?|pollutants?|data types?|datatypes?)(?: |$)/;
const ARABIC_INDICATOR_DIMENSION_RE =
  /(?<![؀-ۿ])(?:ال)?(?:مؤشر(?:ات)?|قياس|مقياس|بند|متغير(?:ات)?|ملوث(?:ات)?)(?![؀-ۿ])|نوع البيانات/;

export function isIndicatorDimensionName(...names: Array<string | null | undefined>): boolean {
  return names.some((n) => {
    if (!n) return false;
    const norm = normalizeNameWords(n);
    return INDICATOR_DIMENSION_RE.test(norm) || ARABIC_INDICATOR_DIMENSION_RE.test(norm);
  });
}
