/**
 * Tiny text helpers for bidirectional (Arabic UI, mostly English source data)
 * rendering. Pure: no React, no Next.
 */

import { NUMERIC_TOKEN_SOURCE } from "@/lib/numeric-tokens";

const ARABIC_LETTER = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-\uFEFF]/;
const LATIN_LETTER = /[A-Za-z]/;

/** True when the text contains at least one Arabic-script letter. */
export function hasArabic(text: string | null | undefined): boolean {
  return !!text && ARABIC_LETTER.test(text);
}

/**
 * Wraps `text` in a first-strong isolate (U+2068 ... U+2069) for places that
 * only take plain strings, such as `<option>` labels: "Health (12)" inside an
 * RTL control keeps its English words and the closing parenthesis in the right
 * order, and never reorders the Arabic around it.
 */
export function isolate(text: string): string {
  return `\u2068${text}\u2069`;
}

/**
 * The `lang` attribute a snippet of source data should carry inside the
 * `<html lang="ar">` page: "en" only when it has Latin letters and NO Arabic
 * ones, otherwise undefined (mixed Arabic + an English acronym is still Arabic
 * text, and a screen reader must not switch voice for it). Lets assistive tech
 * use the right voice for English dataset titles and publisher names.
 */
export function textLang(text: string | null | undefined): "en" | undefined {
  if (!text) return undefined;
  return LATIN_LETTER.test(text) && !ARABIC_LETTER.test(text) ? "en" : undefined;
}

// ---------------------------------------------------------------------------
// Left-to-right groups inside Arabic text
// ---------------------------------------------------------------------------

/** One piece of a string: an LTR group (Latin words and numbers) or everything else. */
export interface BidiRun {
  text: string;
  ltr: boolean;
}

const LATIN = "A-Za-z\\u00C0-\\u024F";
/** "Health", "COVID-19", "Q1", "R&D", "e-mail": a letter first, then letters, digits and inner joiners. */
const LATIN_WORD = `[${LATIN}][${LATIN}0-9]*(?:['’_./&-][${LATIN}0-9]+)*`;
/** A Latin word or a number (the numeric tokens of `numeric-tokens.ts`). */
const LTR_ITEM = `(?:${LATIN_WORD}|${NUMERIC_TOKEN_SOURCE})`;
/** Items separated by spaces, or by nothing at all ("2nd" is the number 2 and the word nd). */
const LTR_GROUP_SOURCE = `${LTR_ITEM}(?:[ \\u00A0]*${LTR_ITEM})*`;

/**
 * Splits `text` into runs, merging every ADJACENT Latin word and number into one
 * LTR group ("Health 2000", "CPI 2018", "COVID-19 2021", "Health 2020-2025",
 * "2020 2025"). Joining the runs restores the text.
 *
 * Why one group: in an RTL paragraph two adjacent LTR items are ordered
 * right-to-left, so wrapping only the number in its own `dir="ltr"` isolate
 * printed "مؤشرات Health 2000" as "2000 Health مؤشرات". A group is one isolate,
 * so its inside reads left to right and the Arabic around it keeps its order.
 * A group starts and ends on a letter, a digit or `%`: spaces, a sentence-final
 * dot, commas, Arabic punctuation and brackets stay outside it (a lone "(" or
 * "«" inside an LTR run would be drawn on the wrong side).
 */
export function splitBidiRuns(text: string): BidiRun[] {
  if (!text) return [];
  const runs: BidiRun[] = [];
  const re = new RegExp(LTR_GROUP_SOURCE, "g");
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[0] === "") {
      re.lastIndex++;
      continue;
    }
    if (match.index > last) runs.push({ text: text.slice(last, match.index), ltr: false });
    runs.push({ text: match[0], ltr: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), ltr: false });
  return runs;
}
