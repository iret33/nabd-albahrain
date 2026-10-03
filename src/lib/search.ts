/**
 * Arabic-aware search helpers shared by the sync engine (which stores the
 * normalized `Dataset.searchText`) and the query layer (which normalizes the
 * user's query the same way, so both sides always agree).
 */

/** Characters of the Arabic tashkeel block + superscript alef + tatweel. */
const DIACRITICS_AND_TATWEEL = /[ً-ٰٟـ]/g;

/**
 * Lowercase, Unicode-normalize and fold Arabic orthographic variants so that
 * أ/إ/آ/ٱ -> ا, ى -> ي, ة -> ه, ؤ -> و, ئ -> ي, strip diacritics and tatweel,
 * map Arabic-Indic / Persian digits to ASCII, replace punctuation with spaces
 * and collapse whitespace.
 *
 * Order matters: digits are mapped BEFORE any range-based stripping because
 * U+0660-0669 sit next to the diacritic range.
 */
export function normalizeSearch(input: string | null | undefined): string {
  if (!input) return "";
  let s = input.normalize("NFKC").toLowerCase();
  s = s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  s = s.replace(DIACRITICS_AND_TATWEEL, "");
  s = s
    .replace(/[آأإٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " ");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Split a user query into at most `maxTokens` normalized tokens. One-character
 * non-digit tokens are dropped (they match nearly everything); duplicates are
 * removed. The raw query is capped at 100 characters first.
 */
export function tokenize(query: string | null | undefined, maxTokens = 6): string[] {
  const normalized = normalizeSearch((query ?? "").slice(0, 100));
  if (!normalized) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of normalized.split(" ")) {
    if (token.length < 2 && !/^\d$/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= maxTokens) break;
  }
  return out;
}

/** Escape `\`, `%` and `_` so user text is matched literally by LIKE/ILIKE. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}

/** Build the stored `Dataset.searchText` from the searchable metadata parts. */
export function buildSearchText(parts: Array<string | string[] | null | undefined>): string {
  return normalizeSearch(
    parts
      .flatMap((p) => (Array.isArray(p) ? p : [p]))
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .join(" "),
  );
}
