/**
 * Shared number/date formatting helpers. Every numeric figure in the UI
 * must use Latin tabular digits (per the design spec) even though the rest
 * of the UI is Arabic — these helpers centralize that so pages don't each
 * reinvent it.
 */

const numberFormatter = new Intl.NumberFormat("en-US");

/** Formats an integer/float with Latin thousands separators — no locale digit swap. */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return numberFormatter.format(n);
}

/** Formats a date as an Arabic month name + Latin digits, e.g. "4 أغسطس 2026". */
export function formatDateAr(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ar-BH", {
    year: "numeric",
    month: "long",
    day: "numeric",
    numberingSystem: "latn",
    timeZone: "UTC",
  }).format(d);
}

/** Formats a datetime as an Arabic date + Latin-digit time, e.g. "4 أغسطس 2026، 23:16". */
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
    numberingSystem: "latn",
    timeZone: "UTC",
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
