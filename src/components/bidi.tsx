import { splitNumericRuns } from "@/lib/numeric-tokens";
import { hasArabic, splitBidiRuns, textLang } from "@/lib/text";

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
 * Arabic text that contains Latin words or numbers ("السكان حسب الجنسية
 * 2010-2025", "مؤشرات Health 2000") goes through `MixedBidiText`, which puts
 * each adjacent run of Latin words and numbers in ONE LTR isolate.
 */
export function Bidi({ text, className }: { text: string; className?: string }) {
  return (
    <bdi dir="auto" lang={textLang(text)} className={className}>
      {hasArabic(text) ? <MixedBidiText text={text} /> : text}
    </bdi>
  );
}

/**
 * Arabic text with its Latin words and numbers each group set left-to-right.
 *
 * After an Arabic letter the bidi algorithm reads digits as Arabic numbers and
 * reverses a range ("2025-2010"), and two ADJACENT LTR items in an RTL paragraph
 * are ordered right-to-left ("Health 2000" printed as "2000 Health"), so every
 * run of Latin words and numbers is one `dir="ltr"` isolate (`splitBidiRuns`).
 * Only the numbers inside carry tabular digits: applying them to a whole phrase
 * would change the spacing of its letters.
 */
export function MixedBidiText({ text }: { text: string }) {
  if (!text) return null;
  return (
    <>
      {splitBidiRuns(text).map((run, i) => (run.ltr ? <LtrGroup key={i} text={run.text} /> : run.text))}
    </>
  );
}

function LtrGroup({ text }: { text: string }) {
  const pieces = splitNumericRuns(text);
  if (pieces.length === 1 && pieces[0].numeric) {
    return (
      <span dir="ltr" className="tabular-figures">
        {text}
      </span>
    );
  }
  return (
    <span dir="ltr">
      {pieces.map((piece, i) =>
        piece.numeric ? (
          <span key={i} className="tabular-figures">
            {piece.text}
          </span>
        ) : (
          piece.text
        ),
      )}
    </span>
  );
}
