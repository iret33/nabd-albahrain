/**
 * Relevance ranking for dataset search. Pure and synchronous so it can be
 * unit-tested exhaustively: the query layer filters candidates in SQL
 * (every token must occur in `Dataset.searchText`) and then orders the few
 * hundred survivors here, because a weighted "where did the word match"
 * score is awkward in SQL and the whole catalog is only ~512 rows.
 *
 * Scoring (tokens are already normalized by `tokenize()` in `search.ts`;
 * each field is normalized the same way before comparing, so alef/ya/ta
 * variants, diacritics and Arabic-Indic digits all line up):
 *
 *   +10  the whole phrase (tokens joined by a space) occurs in a title, read
 *        either as written or with the Arabic article/clitic stripped from each
 *        title word (the tokens had theirs stripped: "تعداد السكان" is the
 *        phrase "تعداد سكان", which only the stripped title contains)
 *   per token:
 *   +5   token occurs in a title (Arabic or English)
 *   +2   token occurs in the publisher or the theme (independent of the title)
 *   +1   token matched somewhere else only (description or keywords) — the
 *        SQL filter already guaranteed it matched, so "not in title,
 *        publisher or theme" means "description-only" without loading the
 *        (large) description text.
 *
 * Ties break on the source's modified date (newest first, undated last) and
 * finally on id, so the order is total and stable across requests.
 */

import { normalizeSearch, stripArabicPrefix } from "@/lib/search";

export const RANK_WEIGHTS = {
  phraseInTitle: 10,
  tokenInTitle: 5,
  tokenInMeta: 2,
  tokenElsewhere: 1,
} as const;

export interface RankableFields {
  /** Every title variant (cleaned English title, Arabic title, ...). */
  titles: ReadonlyArray<string | null | undefined>;
  publisher: string | null | undefined;
  theme: string | null | undefined;
}

/** Score one dataset against already-normalized `tokens`. Returns 0 when there are no tokens. */
export function scoreMatch(fields: RankableFields, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;

  const titles = fields.titles.map((t) => normalizeSearch(t)).filter((t) => t.length > 0);
  const meta = [normalizeSearch(fields.publisher), normalizeSearch(fields.theme)].filter((t) => t.length > 0);

  let score = 0;
  const phrase = tokens.join(" ");
  // Query tokens come out of `tokenize` without their ال/بال/لل prefix, so the phrase has to be looked for in
  // the title the same way: as written (an unprefixed phrase) or word by word stripped (a prefixed one).
  const strippedTitles = titles.map((t) => t.split(" ").map(stripArabicPrefix).join(" "));
  if (titles.some((t) => t.includes(phrase)) || strippedTitles.some((t) => t.includes(phrase))) {
    score += RANK_WEIGHTS.phraseInTitle;
  }

  for (const token of tokens) {
    const inTitle = titles.some((t) => t.includes(token));
    const inMeta = meta.some((m) => m.includes(token));
    if (inTitle) score += RANK_WEIGHTS.tokenInTitle;
    if (inMeta) score += RANK_WEIGHTS.tokenInMeta;
    if (!inTitle && !inMeta) score += RANK_WEIGHTS.tokenElsewhere;
  }
  return score;
}

export interface RankedItem {
  id: string;
  score: number;
  sourceModified: Date | null;
}

function timeOf(d: Date | null): number {
  return d === null ? Number.NEGATIVE_INFINITY : d.getTime();
}

/** Newest source-modified first; undated rows last. Ties by id ascending. */
export function compareByUpdated(
  a: { id: string; sourceModified: Date | null },
  b: { id: string; sourceModified: Date | null },
): number {
  const ta = timeOf(a.sourceModified);
  const tb = timeOf(b.sourceModified);
  if (ta !== tb) return tb > ta ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Highest score first, then `compareByUpdated`. */
export function compareRanked(a: RankedItem, b: RankedItem): number {
  if (a.score !== b.score) return b.score - a.score;
  return compareByUpdated(a, b);
}
