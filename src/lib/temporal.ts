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

function toLatinDigits(s: string): string {
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
  if (s === "") return null;

  if (/^\d{4}$/.test(s)) {
    const year = Number(s);
    return validYear(year) ? { year, month: null, day: null } : null;
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
