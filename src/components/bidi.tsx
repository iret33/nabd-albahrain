import { ArabicTextWithNumbers } from "@/components/arabic-text-with-numbers";
import { hasArabic, textLang } from "@/lib/text";

/**
 * Inline bidi isolate for source-language text (dataset titles, publisher and
 * theme names) shown inside Arabic UI copy.
 *
 * `<bdi dir="auto">` keeps the text's own direction out of the surrounding
 * RTL paragraph, so an English title ending in ")" or "." keeps its trailing
 * punctuation at the end of the English run instead of jumping to the wrong
 * side, and "Ministry of Health" never reorders the Arabic words around it.
 * The block (and therefore its alignment) stays RTL, so English and Arabic
 * cards line up on the same edge. `lang="en"` is added for Latin-only text so
 * screen readers switch to an English voice (see `textLang`).
 *
 * Arabic text that contains numbers ("السكان حسب الجنسية 2010-2025") gets its
 * numeric runs wrapped as LTR (`ArabicTextWithNumbers`): after an Arabic letter
 * the bidi algorithm reads digits as Arabic numbers and reverses a range, which
 * would print "2025-2010".
 */
export function Bidi({ text, className }: { text: string; className?: string }) {
  return (
    <bdi dir="auto" lang={textLang(text)} className={className}>
      {hasArabic(text) ? <ArabicTextWithNumbers text={text} /> : text}
    </bdi>
  );
}
