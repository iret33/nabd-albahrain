/**
 * Atom 1.0 (RFC 4287) feed builder for /feed.xml. Pure: strings in, string out.
 *
 * Why hand-built: the feed is a few dozen elements and a dependency for it
 * would be the biggest thing in this file. What matters is getting the
 * details right, so they live here where they can be unit-tested:
 *
 *  - every interpolated value is XML-escaped, and characters that are not
 *    allowed in XML 1.0 at all (control characters, lone surrogates) are
 *    dropped: dataset titles and descriptions are third-party text, and one
 *    stray U+000B would make the whole feed unparseable for every reader;
 *  - dates are RFC 3339 in UTC ("2026-09-30T08:05:00Z");
 *  - entries are ordered newest first (ties by id) and capped, whatever order
 *    the caller passes them in, and an entry with no usable date is skipped
 *    (Atom requires `updated`; inventing one would show it as "new" forever).
 */

export interface AtomEntry {
  /** Stable unique id, normally the absolute URL of the item. */
  id: string;
  title: string;
  /** Absolute URL of the HTML page. */
  url: string;
  /** Last modification of the underlying data. */
  updated: Date | string | null | undefined;
  summary?: string | null;
  /** Publisher, rendered as the entry author. */
  author?: string | null;
  /** Theme, rendered as a category. */
  category?: string | null;
}

export interface AtomFeedInput {
  /** Absolute URL of the feed itself (rel="self" and the feed id). */
  selfUrl: string;
  /** Absolute URL of the HTML page the feed mirrors. */
  siteUrl: string;
  title: string;
  subtitle?: string;
  /** Feed-level author when entries carry none of their own. */
  author: string;
  lang?: string;
  entries: readonly AtomEntry[];
  /** `updated` of an empty feed. Defaults to the newest entry, else this. */
  fallbackUpdated?: Date;
  /** Entries kept after sorting. Default 50. */
  limit?: number;
}

/**
 * Drops what XML 1.0 forbids outright: C0 controls except tab/LF/CR, U+FFFE/U+FFFF
 * and unpaired surrogates (`for...of` walks code points, so a valid surrogate pair
 * arrives whole and a lone half arrives alone).
 */
function stripInvalidXmlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    const allowed =
      cp === 0x9 ||
      cp === 0xa ||
      cp === 0xd ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff);
    if (allowed) out += ch;
  }
  return out;
}

/** Escape text for element content or a double-quoted attribute value. */
export function escapeXml(value: string): string {
  return stripInvalidXmlChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** RFC 3339 in UTC without milliseconds, e.g. "2026-09-30T08:05:00Z". */
export function atomDate(value: Date | string): string {
  const d = toDate(value);
  if (!d) throw new RangeError("atomDate: invalid date");
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function element(name: string, value: string, attrs = ""): string {
  return `<${name}${attrs}>${escapeXml(value)}</${name}>`;
}

export const ATOM_CONTENT_TYPE = "application/atom+xml; charset=utf-8";

export function buildAtomFeed(input: AtomFeedInput): string {
  const limit = Number.isSafeInteger(input.limit) && (input.limit as number) > 0 ? (input.limit as number) : 50;

  const dated = input.entries
    .map((entry) => ({ entry, updated: toDate(entry.updated) }))
    .filter((x): x is { entry: AtomEntry; updated: Date } => x.updated !== null)
    .sort((a, b) => b.updated.getTime() - a.updated.getTime() || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0))
    .slice(0, limit);

  const feedUpdated = dated[0]?.updated ?? input.fallbackUpdated ?? new Date(0);

  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escapeXml(input.lang ?? "ar")}">`,
    `  ${element("id", input.selfUrl)}`,
    `  ${element("title", input.title)}`,
    ...(input.subtitle ? [`  ${element("subtitle", input.subtitle)}`] : []),
    `  ${element("updated", atomDate(feedUpdated))}`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(input.selfUrl)}"/>`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(input.siteUrl)}"/>`,
    `  <author>${element("name", input.author)}</author>`,
    `  ${element("generator", "نبض البحرين")}`,
  ];

  for (const { entry, updated } of dated) {
    lines.push("  <entry>");
    lines.push(`    ${element("id", entry.id)}`);
    lines.push(`    ${element("title", entry.title)}`);
    lines.push(`    <link rel="alternate" type="text/html" href="${escapeXml(entry.url)}"/>`);
    lines.push(`    ${element("updated", atomDate(updated))}`);
    if (entry.author) lines.push(`    <author>${element("name", entry.author)}</author>`);
    if (entry.category) lines.push(`    <category term="${escapeXml(entry.category)}"/>`);
    if (entry.summary) lines.push(`    ${element("summary", entry.summary, ' type="text"')}`);
    lines.push("  </entry>");
  }

  lines.push("</feed>");
  return `${lines.join("\n")}\n`;
}
