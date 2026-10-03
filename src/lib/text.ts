/**
 * Tiny text helpers for bidirectional (Arabic UI, mostly English source data)
 * rendering. Pure: no React, no Next.
 */

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
