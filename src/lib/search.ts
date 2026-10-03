/**
 * Arabic-aware search helpers shared by the sync engine (which stores the
 * normalized `Dataset.searchText`) and the query layer (which normalizes the
 * user's query the same way, so both sides always agree).
 */

/** Characters of the Arabic tashkeel block + superscript alef + tatweel. */
const DIACRITICS_AND_TATWEEL = /[ً-ٰٟـ]/g;

/**
 * Lowercase, Unicode-normalize and fold Arabic orthographic variants so that
 * أ/إ/آ/ٱ -> ا, ى -> ي, ة -> ه, ؤ -> و, ئ -> ي, strip diacritics and tatweel,
 * fold the Persian/Urdu letter forms ی -> ي and ک -> ك (a title or a query
 * typed on a Persian keyboard layout must meet the Arabic spelling), map
 * Arabic-Indic / Persian digits to ASCII, replace punctuation with spaces and
 * collapse whitespace.
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
    .replace(/ی/g, "ي")
    .replace(/ک/g, "ك")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " ");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * The definite article and the one-letter clitics that glue to it: ال (the),
 * وال (and the), بال (with/in the), كال (like the), فال (so the), لل (for the:
 * ل + ال contract to لل). At least three letters must remain after the prefix.
 */
const ARABIC_ARTICLE_PREFIX = /^(?:وال|بال|كال|فال|لل|ال)(.{3,})$/u;

/**
 * A normalized word without its leading article/clitic, when at least three
 * letters remain ("المطار" -> "مطار", "بالمطار" -> "مطار", "للمطار" -> "مطار");
 * otherwise the word unchanged ("الله" and "ال" stay as they are). Stripped once, never in a loop.
 * Only ever applied to QUERY words (and, for the phrase bonus, to the words of a
 * title when comparing, see `ranking.ts`), never to what is stored:
 * matching is substring (`searchText LIKE '%word%'`), so the stripped word is a
 * suffix of the original and finds every spelling of the noun that the original
 * would find, plus the bare noun and the other prefixed forms. Bare و/ب/ل/ك/ف are NOT
 * stripped on their own: they begin real words (وزارة, بحرين, بنك, لجنة, كهرباء).
 */
export function stripArabicPrefix(word: string): string {
  const m = ARABIC_ARTICLE_PREFIX.exec(word);
  return m ? m[1] : word;
}

/**
 * Split a user query into at most `maxTokens` normalized tokens. One-character
 * non-digit tokens are dropped (they match nearly everything); the Arabic definite
 * article / clitic prefix is stripped from each token (see `stripArabicPrefix`);
 * duplicates are removed AFTER that, so "مطار المطار" is one token. The raw query is
 * capped at 100 characters first.
 */
export function tokenize(query: string | null | undefined, maxTokens = 6): string[] {
  const normalized = normalizeSearch((query ?? "").slice(0, 100));
  if (!normalized) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of normalized.split(" ")) {
    const token = stripArabicPrefix(word);
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

// ---------------------------------------------------------------------------
// Indexing HTML
// ---------------------------------------------------------------------------

/** Named entities worth decoding for search; any other `&name;` is dropped (it must not become the token "eacute"). */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["nbsp", " "],
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["ndash", "–"],
  ["mdash", "—"],
  ["hellip", "…"],
  ["laquo", "«"],
  ["raquo", "»"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["bull", "•"],
  ["middot", "·"],
  ["copy", "©"],
  ["reg", "®"],
  ["trade", "™"],
  ["deg", "°"],
  ["plusmn", "±"],
  ["times", "×"],
  ["divide", "÷"],
  ["shy", ""],
]);

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi, (_whole, body: string) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      // Reject what String.fromCodePoint would throw on, surrogates and control characters (they are noise, not text).
      const valid = Number.isInteger(cp) && cp >= 0x20 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
      return valid ? String.fromCodePoint(cp) : " ";
    }
    // A Map, not an object literal: `&constructor;` must not resolve to Object.prototype's member.
    return NAMED_ENTITIES.get(body.toLowerCase()) ?? " ";
  });
}

/**
 * Visible text of a (possibly HTML) metadata value, for INDEXING: `<style>`/`<script>` blocks and comments
 * dropped, every other tag replaced by a SPACE (so `<li>Rain</li><li>Wind</li>` stays two words, which a
 * display-oriented stripper would glue into "RainWind"), entities decoded (numeric ones too: `&#1575;`
 * is an Arabic letter). Without this, a description's markup was indexed as words and "href", "style",
 * "table", "https" or "nbsp" matched datasets that never mention them.
 *
 * A tag must start with a letter, `/` or `!`, so a plain-text "5 < 6" or "a <3 b" is left alone.
 * Decoding runs twice so a double-encoded `&amp;nbsp;` does not leave "nbsp" behind. Every scan is
 * linear, so a description made of thousands of unclosed openers cannot stall the sync.
 */
export function htmlToSearchText(value: string): string {
  if (!value.includes("<") && !value.includes("&")) return value;
  const text = stripComments(stripBlocks(stripBlocks(value, "script"), "style")).replace(/<\/?[A-Za-z][^<>]*>/g, " ");
  return decodeEntities(decodeEntities(text));
}

/** `<tag ...>` ... `</tag>` blocks removed whole. Linear: a closer is searched for once per opener, and only forward. */
function stripBlocks(text: string, tag: "script" | "style"): string {
  const open = new RegExp(`<${tag}\\b[^<>]*>`, "gi");
  const close = new RegExp(`</${tag}\\s*>`, "gi");
  let out = "";
  let pos = 0;
  for (;;) {
    open.lastIndex = pos;
    const opener = open.exec(text);
    if (!opener) break;
    close.lastIndex = opener.index + opener[0].length;
    const closer = close.exec(text);
    if (!closer) break; // no closer anywhere after this opener, so none after a later one either
    out += `${text.slice(pos, opener.index)} `;
    pos = closer.index + closer[0].length;
  }
  return out + text.slice(pos);
}

/** `<!-- ... -->` removed. Same linear scan. */
function stripComments(text: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    const start = text.indexOf("<!--", pos);
    if (start < 0) break;
    const end = text.indexOf("-->", start + 4);
    if (end < 0) break;
    out += `${text.slice(pos, start)} `;
    pos = end + 3;
  }
  return out + text.slice(pos);
}

/**
 * Build the stored `Dataset.searchText` from the searchable metadata parts. Every part goes through
 * `htmlToSearchText` (only the description is HTML in practice, but the portal's other fields are not
 * guaranteed to be clean either); the result is normalized like a query. The QUERY side is
 * deliberately not stripped: users type `<` and `>` into the search box as ordinary punctuation.
 */
export function buildSearchText(parts: Array<string | string[] | null | undefined>): string {
  return normalizeSearch(
    parts
      .flatMap((p) => (Array.isArray(p) ? p : [p]))
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .map(htmlToSearchText)
      .join(" "),
  );
}
