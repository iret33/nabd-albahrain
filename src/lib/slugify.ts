/**
 * Deterministic slugify — used to build stable URL segments from free-text
 * strings that don't already have one (publisher names; unlike themes, which
 * are short enough to just `encodeURIComponent` directly and round-trip
 * through `/categories/[theme]`).
 *
 * ASCII-only by design: every publisher name observed on data.gov.bh is plain
 * Latin text, and everything downstream (the URL, `isValidPublisherSlug`, the
 * API error text, cache tags) assumes `[a-z0-9-]`. The slug is also TOTAL: it
 * is never empty and never longer than `MAX_PUBLISHER_SLUG_LENGTH`, whatever
 * the name. Two cases used to break that:
 *  - a name with no Latin letters (an Arabic publisher) slugged to "" — one
 *    merged tile, a link to the `/publishers/` index, a `<loc>` for the
 *    index in the sitemap. It now gets `p-<hash>`, a stable hash of the
 *    normalized name, so each such publisher has its own valid, distinct URL;
 *  - a very long name slugged to a very long slug that the lookup then
 *    rejected (404 / 400). It is now cut and given `-<hash>` of the FULL name
 *    (a plain cut would merge two long names that share a prefix).
 * Every short Latin name keeps exactly the slug it always had, so indexed
 * URLs do not move.
 *
 * IMPORTANT: real synced data has at least one pair of publisher strings
 * that only differ by incidental whitespace around a `\` separator
 * ("Meteorological Directorate \ Ministry of Transportation and
 * Telecommunications" vs "...Directorate\Ministry..." with no spaces) —
 * i.e. slugify is NOT guaranteed injective over the raw `publisher`
 * column. Callers that need a slug -> publisher-name(s) mapping (the
 * /publishers pages) must group by slug and treat it as a possible
 * one-to-many relationship rather than assuming a unique inverse. The hash
 * input is normalized the same way (case, whitespace, separators) so those
 * variants also merge when they take the hashed forms.
 */

/** Longest publisher slug (what `isValidPublisherSlug` accepts). */
export const MAX_PUBLISHER_SLUG_LENGTH = 200;

/** Characters of the readable part kept in front of the hash of an over-long name. */
const LONG_SLUG_KEEP = 150;

/** cyrb53: a small, fast, pure 53-bit string hash (no `node:crypto`, so this module stays safe for client bundles). */
function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** The name as the hash sees it: NFKC, lowercase, one space between words, no space around separators. */
function hashInput(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s*[/\\]\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

/** 11 base-36 characters (53 bits). */
function shortHash(input: string): string {
  return hash53(hashInput(input)).toString(36).padStart(11, "0");
}

export function slugify(input: string): string {
  const ascii = input
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[/\\]/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // "Has no Latin letters": nothing readable survived. Digits alone count as nothing when letters of
  // another script were dropped ("وزارة 2024" would otherwise be "2024", shared by every such name).
  const nothingReadable = ascii === "" || (!/[a-z]/.test(ascii) && /[^\u0000-\u007f]/.test(input));
  if (nothingReadable) return `p-${shortHash(input)}`;

  if (ascii.length > MAX_PUBLISHER_SLUG_LENGTH) {
    return `${ascii.slice(0, LONG_SLUG_KEEP).replace(/-+$/, "")}-${shortHash(input)}`;
  }
  return ascii;
}
