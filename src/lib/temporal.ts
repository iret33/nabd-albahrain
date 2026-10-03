/**
 * Strict temporal parsing for the derivation engine.
 *
 * The previous implementation fell back to the V8 legacy `new Date(string)`
 * parser, which turns "1".."12" into 2001-01..2001-12, "Item 12" into
 * 2001-12, reads "03/04/2020" as March 4 (Bahrain writes day first) and
 * "Mar-20" as 2001-03-20. Here only an explicit whitelist is accepted, every
 * result is range-checked (1900 <= year <= 2100, real calendar days), and
 * the only place a runtime date parser is used is for strings that carry an
 * explicit offset ("Z", "+03:00"), which are converted to Asia/Bahrain
 * before the calendar parts are read.
 */

export interface TemporalParts {
  year: number;
  /** null for a bare year. */
  month: number | null;
  /** null unless the source value carried a day. */
  day: number | null;
  /**
   * Present (true) only when the source value carried a provisional/estimate
   * marker ("2024*", "2024 (p)", "2024e", "2024 prov."). The marker is stripped
   * from the period, never silently: callers decide how to flag the figure.
   */
  provisional?: true;
}

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

// ---------------------------------------------------------------------------
// Month names (English + Arabic, Gulf/MSA and Levantine)
// ---------------------------------------------------------------------------

/** Folds alef variants / ta marbuta-free forms so "أغسطس" and "اغسطس" look up the same. */
function foldArabic(s: string): string {
  return s.replace(/[أإآ]/g, "ا").replace(/[ً-ٟـ]/g, "");
}

const MONTH_NAME_TABLE: Array<[number, string[]]> = [
  [1, ["january", "jan", "يناير", "كانون الثاني"]],
  [2, ["february", "feb", "فبراير", "شباط"]],
  [3, ["march", "mar", "مارس", "اذار"]],
  [4, ["april", "apr", "ابريل", "نيسان"]],
  [5, ["may", "مايو", "ماي", "ايار"]],
  [6, ["june", "jun", "يونيو", "يونيه", "حزيران"]],
  [7, ["july", "jul", "يوليو", "يوليه", "تموز"]],
  [8, ["august", "aug", "اغسطس", "اب"]],
  [9, ["september", "sept", "sep", "سبتمبر", "ايلول"]],
  [10, ["october", "oct", "اكتوبر", "تشرين الاول"]],
  [11, ["november", "nov", "نوفمبر", "تشرين الثاني"]],
  [12, ["december", "dec", "ديسمبر", "كانون الاول"]],
];

const MONTH_LOOKUP = new Map<string, number>();
for (const [month, names] of MONTH_NAME_TABLE) {
  for (const n of names) MONTH_LOOKUP.set(foldArabic(n).toLowerCase(), month);
}

function lookupMonthName(text: string): number | null {
  const key = foldArabic(text.trim().replace(/\s+/g, " ")).toLowerCase().replace(/\.$/, "");
  return MONTH_LOOKUP.get(key) ?? null;
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g;
const HAS_ARABIC_INDIC_DIGIT = /[٠-٩۰-۹]/;

function toLatinDigits(s: string): string {
  // Fast path: nearly every value is plain ASCII, and this runs once per row.
  if (!HAS_ARABIC_INDIC_DIGIT.test(s)) return s;
  return s.replace(ARABIC_INDIC_DIGITS, (d) => {
    const code = d.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

function validYear(year: number): boolean {
  return Number.isInteger(year) && year >= MIN_YEAR && year <= MAX_YEAR;
}

/** A real calendar day (rejects 2020-02-31). */
function validDate(year: number, month: number, day: number): boolean {
  if (!validYear(year) || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

let bahrainParts: Intl.DateTimeFormat | null = null;

/** Calendar parts of an instant in Asia/Bahrain (UTC+3, no DST), via Intl rather than getUTC*(). */
function bahrainCalendarParts(ms: number): { year: number; month: number; day: number } | null {
  try {
    bahrainParts ??= new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Bahrain",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    const parts = bahrainParts.formatToParts(new Date(ms));
    const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const out = { year: pick("year"), month: pick("month"), day: pick("day") };
    return Number.isFinite(out.year) && Number.isFinite(out.month) && Number.isFinite(out.day) ? out : null;
  } catch {
    return null;
  }
}

const ISO_RE = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:$|[T ](.+)$)/;
const HAS_OFFSET_RE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
const DAY_FIRST_RE = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/;
const SLASH_YM_RE = /^(\d{4})\/(\d{1,2})(?:\/(\d{1,2}))?$/;
const DOT_YM_RE = /^(\d{4})\.(\d{2})(?:\.(\d{2}))?$/;
const NAME_THEN_YEAR_RE = /^(.+?)[\s,/.-]+(\d{4})$/;
const YEAR_THEN_NAME_RE = /^(\d{4})[\s,/.-]+(.+)$/;

/**
 * No legitimate temporal value is longer than an ISO datetime with an offset
 * (~35 chars; Arabic month names ~16). The cap keeps the two backtracking
 * patterns above linear: `NAME_THEN_YEAR_RE` is quadratic on a long run of
 * separators (a 40,000-dot cell took 1.6 s, 100,000 took 10 s), and it runs on
 * every cell of a date-like column. Measured on the TRIMMED value, so padded
 * real dates still parse.
 */
export const MAX_TEMPORAL_LENGTH = 64;

/** "2024.0": how a spreadsheet export prints an integer year. */
const FLOAT_YEAR_RE = /^(\d{4})\.0+$/;
/** "FY2024" / "FY 2024": a fiscal year, named by the year it is booked under. */
const FISCAL_YEAR_RE = /^fy\s?(\d{4})$/i;
/** "2023/24", "2023/2024", "2023-2024": a fiscal/academic year, accepted ONLY when the second year is exactly the next one. */
const SPAN_YEAR_RE = /^(\d{4})\s?[/-]\s?(\d{2}|\d{4})$/;

/**
 * Provisional / estimate markers a statistical table appends to the newest
 * period. A whitelist on purpose: a generic "any 3 letters" rule would turn
 * "2024 Mar" or "2024 BHD" into a year. Each alternative strips one marker:
 *   "2024*", "2024 †"          symbols
 *   "2024 (p)", "2024(prov.)"   parenthesised word
 *   "2024p", "2024e"            a single letter glued to a digit
 *   "2024 est.", "2024 مؤقت"    a separate word
 */
const PROVISIONAL_WORDS = "p|r|e|f|est|prov|prelim|preliminary|provisional|estimate|estimated|revised|مؤقت|مؤقتة|تقديري|تقديرية|أولي|أولية";
const MARKER_SYMBOL_RE = /\s*[*†‡]+$/;
const MARKER_PAREN_RE = new RegExp(`\\s*[(\\[]\\s*(?:${PROVISIONAL_WORDS})\\s*\\.?\\s*[)\\]]$`, "i");
const MARKER_GLUED_RE = /(?<=\d)[prefPREF]$/;
const MARKER_WORD_RE = new RegExp(`\\s+(?:est|prov|prelim|preliminary|provisional|estimate|estimated|revised|مؤقت|مؤقتة|تقديري|تقديرية|أولي|أولية)\\.?$`, "i");

/** Strips ONE trailing provisional marker; null when the value carries none. */
function stripProvisionalMarker(s: string): string | null {
  for (const re of [MARKER_SYMBOL_RE, MARKER_PAREN_RE, MARKER_WORD_RE, MARKER_GLUED_RE]) {
    const m = re.exec(s);
    if (m && m.index > 0) return s.slice(0, m.index).trimEnd();
  }
  return null;
}

/**
 * Parse a raw export value as a temporal point. Accepted shapes only:
 *   - a bare 4-digit year (string, or an integer number) in 1900..2100;
 *   - ISO `YYYY-MM`, `YYYY-MM-DD`, optionally followed by `T`/space + time.
 *     Strings with an explicit offset are converted to Asia/Bahrain first;
 *     naive datetimes keep their wall-clock date;
 *   - `YYYY/MM`, `YYYY/MM/DD`, `YYYY.MM`;
 *   - day-first `DD/MM/YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY`;
 *   - "MMM YYYY" / "MMMM YYYY" (either order) with English or Arabic names.
 * Anything else - "1".."12", "Item 12", "Mar-20", "2020-13" - is null.
 */
export function parseTemporalValue(raw: unknown): TemporalParts | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return Number.isInteger(raw) && validYear(raw) ? { year: raw, month: null, day: null } : null;
  }
  if (typeof raw !== "string") return null;
  const s = toLatinDigits(raw.trim());
  if (s === "" || s.length > MAX_TEMPORAL_LENGTH) return null;

  // The overwhelmingly common shape first: no marker can follow a bare year.
  if (/^\d{4}$/.test(s)) return parseCore(s);

  // A trailing provisional marker is stripped BEFORE parsing so it can never be
  // swallowed as a "time" ("2024-03-15 (p)") and is always reported, never silently.
  const stripped = stripProvisionalMarker(s);
  if (stripped !== null && stripped !== "") {
    const inner = parseCore(stripped);
    if (inner) return { ...inner, provisional: true };
  }
  return parseCore(s);
}

/** The whitelist proper, on a trimmed, Latin-digit, length-capped string. */
function parseCore(s: string): TemporalParts | null {
  if (/^\d{4}$/.test(s)) {
    const year = Number(s);
    return validYear(year) ? { year, month: null, day: null } : null;
  }

  // Year-grain shapes that the month patterns below would otherwise reject
  // ("2024.00" and "2023/24" both look like an invalid month to them).
  const yearish = FLOAT_YEAR_RE.exec(s) ?? FISCAL_YEAR_RE.exec(s);
  if (yearish) {
    const year = Number(yearish[1]);
    return validYear(year) ? { year, month: null, day: null } : null;
  }
  const span = SPAN_YEAR_RE.exec(s);
  if (span) {
    const first = Number(span[1]);
    const second = Number(span[2]);
    // Only a span whose second year is exactly the next one is a fiscal/academic year ("2023/24" -> 2023).
    // A two-digit second part that is a valid month ("2023/12", "2011-12") keeps its month meaning.
    const adjacent =
      span[2].length === 4 ? second === first + 1 : second === (first + 1) % 100 && !(second >= 1 && second <= 12);
    if (adjacent && validYear(first)) return { year: first, month: null, day: null };
  }

  const iso = ISO_RE.exec(s);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = iso[3] === undefined ? null : Number(iso[3]);
    const time = iso[4];
    // Some systems export a month or a year as "2020-03-00" / "2020-00-00" (day/month 0 = unknown).
    if (day === 0 && time === undefined && validYear(year)) {
      if (month === 0) return { year, month: null, day: null };
      if (month >= 1 && month <= 12) return { year, month, day: null };
    }
    if (day === null) {
      if (time !== undefined) return null; // "2020-03T10:00" is not a thing
      return validYear(year) && month >= 1 && month <= 12 ? { year, month, day: null } : null;
    }
    if (!validDate(year, month, day)) return null;
    if (time !== undefined && HAS_OFFSET_RE.test(time.trim())) {
      const instant = Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T${time.trim()}`);
      if (Number.isFinite(instant)) {
        const local = bahrainCalendarParts(instant);
        if (local && validYear(local.year)) return { year: local.year, month: local.month, day: local.day };
      }
    }
    return { year, month, day };
  }

  const dayFirst = DAY_FIRST_RE.exec(s);
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const month = Number(dayFirst[3]);
    const year = Number(dayFirst[4]);
    return validDate(year, month, day) ? { year, month, day } : null;
  }

  const ym = SLASH_YM_RE.exec(s) ?? DOT_YM_RE.exec(s);
  if (ym) {
    const year = Number(ym[1]);
    const month = Number(ym[2]);
    const day = ym[3] === undefined ? null : Number(ym[3]);
    if (day === null) return validYear(year) && month >= 1 && month <= 12 ? { year, month, day: null } : null;
    return validDate(year, month, day) ? { year, month, day } : null;
  }

  const nameYear = NAME_THEN_YEAR_RE.exec(s);
  if (nameYear) {
    const month = lookupMonthName(nameYear[1]);
    const year = Number(nameYear[2]);
    if (month !== null && validYear(year)) return { year, month, day: null };
  }
  const yearName = YEAR_THEN_NAME_RE.exec(s);
  if (yearName) {
    const month = lookupMonthName(yearName[2]);
    const year = Number(yearName[1]);
    if (month !== null && validYear(year)) return { year, month, day: null };
  }

  return null;
}

/**
 * A per-call memoizing `parseTemporalValue`. A temporal column has few
 * distinct values relative to its rows (8 years x 300,000 rows, or a few
 * thousand dates), and the derivation engine parses the same column in
 * several passes, so caching by raw value removes most of the parsing work.
 * The cache is bounded (after `maxEntries` distinct values it stops growing)
 * and lives as long as the returned function, i.e. one dataset's derivation.
 */
export function createTemporalParser(maxEntries = 20_000): (raw: unknown) => TemporalParts | null {
  const cache = new Map<string | number, TemporalParts | null>();
  return (raw) => {
    if (typeof raw !== "string" && typeof raw !== "number") return null;
    // Oversized junk is never a date and must not be kept alive as a cache key.
    if (typeof raw === "string" && raw.length > 4 * MAX_TEMPORAL_LENGTH) return null;
    const hit = cache.get(raw); // a cached "unparseable" is null, a miss is undefined
    if (hit !== undefined) return hit;
    const parsed = parseTemporalValue(raw);
    if (cache.size < maxEntries) cache.set(raw, parsed);
    return parsed;
  };
}

/**
 * A month-of-year value on its own (not a point in time): an integer 1..12
 * or an English/Arabic month name. Used to recognise a "Month" column that
 * must be combined with a sibling year column instead of being treated as
 * a standalone temporal field.
 */
export function parseMonthPart(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 1 && raw <= 12 ? raw : null;
  if (typeof raw !== "string") return null;
  const s = toLatinDigits(raw.trim());
  if (/^\d{1,2}$/.test(s)) {
    const n = Number(s);
    return n >= 1 && n <= 12 ? n : null;
  }
  return lookupMonthName(s);
}

// ---------------------------------------------------------------------------
// Field-name heuristics
// ---------------------------------------------------------------------------

/** Latin names are matched as whole words after camelCase splitting ("reportYear", "OrderDate", "months"); "update", "candidate", "mandate" do not match. */
const LATIN_TEMPORAL_NAME_RE = /(?:^|[^a-z])(?:years?|dates?|months?|quarters?)(?:[^a-z]|$)/i;
/** "سنة" and "تاريخ" are distinctive enough as substrings; "شهر"/"ربع" need boundaries (an optional "ال") so "مربع" and "أربعة" do not match. */
const ARABIC_TEMPORAL_PLAIN_RE = /سنة|سنوات|تاريخ/;
const ARABIC_TEMPORAL_BOUNDED_RE = /(?:^|[\s_-])(?:ال)?(?:شهر|ربع)(?:[\s_-]|$)/;

/** Does a field name/label look temporal? Replaces the unbounded spec regex (see audit finding temporal-parse-leniency). */
export function looksTemporalName(text: string): boolean {
  if (!text) return false;
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return (
    LATIN_TEMPORAL_NAME_RE.test(spaced) || ARABIC_TEMPORAL_PLAIN_RE.test(text) || ARABIC_TEMPORAL_BOUNDED_RE.test(text)
  );
}

const LATIN_YEAR_NAME_RE = /(?:^|[^a-z])(?:years?|yr|fy)(?:[^a-z]|$)/i;
const ARABIC_YEAR_NAME_RE = /سنة|(?:^|[\s_-])(?:ال)?عام(?:[\s_-]|$)/;

/** Does a field name/label say "year"? Used (with a 1900..2100 integer range) to keep years from being comma-grouped as "2,020". */
export function looksYearName(text: string): boolean {
  if (!text) return false;
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return LATIN_YEAR_NAME_RE.test(spaced) || ARABIC_YEAR_NAME_RE.test(text);
}

const MONTH_ONLY_NAME_RE = /^(?:the )?months?(?: (?:no|num|number|nr|name))?$|^(?:ال)?شهر(?: (?:رقم|الرقم))?$|^رقم الشهر$/;
const QUARTER_ONLY_NAME_RE = /^(?:the )?(?:quarter|qtr)(?: (?:no|num|number))?$|^(?:ال)?ربع$/;

function normalizeFieldWords(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[\s_\-]+/g, " ")
    .trim();
}

/** The whole field name/label is just "Month" / "month_no" / "الشهر" (not "Duration (months)"). */
export function isMonthOnlyName(text: string): boolean {
  return !!text && MONTH_ONLY_NAME_RE.test(normalizeFieldWords(text));
}

/** The whole field name/label is just "Quarter" / "qtr" / "الربع". */
export function isQuarterOnlyName(text: string): boolean {
  return !!text && QUARTER_ONLY_NAME_RE.test(normalizeFieldWords(text));
}

export const ARABIC_MONTH_NAMES = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
] as const;
