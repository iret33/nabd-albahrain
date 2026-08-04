/**
 * Generic, deterministic slugify — used to build stable URL segments from
 * free-text strings that don't already have one (publisher names; unlike
 * themes, which are short enough to just `encodeURIComponent` directly and
 * round-trip through `/categories/[theme]`).
 *
 * ASCII-only by design: every publisher name observed on data.gov.bh is
 * plain Latin text (Arabic/original-language names aren't in the synced
 * `publisher` field), so a Latin-only slug is sufficient here.
 *
 * IMPORTANT: real synced data has at least one pair of publisher strings
 * that only differ by incidental whitespace around a `\` separator
 * ("Meteorological Directorate \ Ministry of Transportation and
 * Telecommunications" vs "...Directorate\Ministry..." with no spaces) —
 * i.e. slugify is NOT guaranteed injective over the raw `publisher`
 * column. Callers that need a slug -> publisher-name(s) mapping (the
 * /publishers pages) must group by slug and treat it as a possible
 * one-to-many relationship rather than assuming a unique inverse.
 */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[/\\]/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
