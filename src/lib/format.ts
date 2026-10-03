/**
 * Shared number/date formatting helpers. Every numeric figure in the UI
 * must use Latin tabular digits (per the design spec) even though the rest
 * of the UI is Arabic — these helpers centralize that so pages don't each
 * reinvent it.
 */

const numberFormatter = new Intl.NumberFormat("en-US");

/** All user-facing dates/times are shown in Bahrain local time (UTC+3, no DST). */
export const DISPLAY_TIME_ZONE = "Asia/Bahrain";

/** Formats an integer/float with Latin thousands separators — no locale digit swap. */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return numberFormatter.format(n);
}

/** Formats a date as an Arabic month name + Latin digits (Bahrain time), e.g. "4 أغسطس 2026". */
export function formatDateAr(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ar-BH", {
    year: "numeric",
    month: "long",
    day: "numeric",
    numberingSystem: "latn",
    timeZone: DISPLAY_TIME_ZONE,
  }).format(d);
}

/** Formats a datetime as an Arabic date + Latin-digit 24h time (Bahrain time), e.g. "4 أغسطس 2026، 23:16". */
export function formatDateTimeAr(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ar-BH", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    numberingSystem: "latn",
    timeZone: DISPLAY_TIME_ZONE,
  }).format(d);
}

/** Percent formatting for the summary/trend lines — Latin digits, one decimal. */
export function formatPercent(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}${Math.abs(n).toFixed(1)}%`;
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * data.gov.bh's `metas.default.description` comes through as simple HTML
 * (`<p>`, `<br>`, entity-escaped `&amp;`, etc. — confirmed live across
 * every dataset sampled during Phase 4). We don't render third-party HTML
 * directly (no sanitizer in the locked dependency list, and it's not
 * worth adding one for `<p>`/`<br>` tags) — instead turn block-level tags
 * into line breaks, strip everything else, and decode entities, so the
 * description reads as clean plain text instead of literal escaped
 * markup like "&lt;p&gt;...&lt;/p&gt;".
 */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  let text = html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  text = text.replace(/&[a-zA-Z#0-9]+;/g, (entity) => HTML_ENTITIES[entity] ?? entity);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

const compactFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Compact axis/tick number, e.g. 1512345 -> "1.5M". Latin digits. */
export function formatCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return compactFormatter.format(n);
}

const relativeFormatter = new Intl.RelativeTimeFormat("ar-u-nu-latn", { numeric: "auto" });

/**
 * "منذ 5 دقائق" / "قبل ساعتين" style relative time with Latin digits. `now` is
 * injectable for tests. Future dates render as "خلال …".
 */
export function formatRelativeAr(date: Date | string | null | undefined, now: Date = new Date()): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "—";
  const diffSec = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return relativeFormatter.format(0, "second");
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86400],
    ["week", 604800],
    ["month", 2592000],
    ["year", 31536000],
  ];
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let size = 60;
  for (const [u, sz] of units) {
    if (abs >= sz) {
      unit = u;
      size = sz;
    }
  }
  return relativeFormatter.format(Math.round(diffSec / size), unit);
}

/**
 * Primary display title: the portal's Arabic title when it has one, else the
 * cleaned English title. The other language (if different) is the subtitle.
 */
export function displayTitle(d: { titleAr?: string | null; titleClean: string }): string {
  return d.titleAr?.trim() || d.titleClean;
}

/** The secondary-language title to show muted under the primary one, or null. */
export function altTitle(d: { titleAr?: string | null; titleClean: string }): string | null {
  const ar = d.titleAr?.trim();
  return ar && ar !== d.titleClean ? d.titleClean : null;
}
