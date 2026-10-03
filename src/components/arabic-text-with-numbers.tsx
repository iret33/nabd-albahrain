import { MixedBidiText } from "@/components/bidi";

/**
 * `summaryAr` (and similar) are pre-baked Arabic sentences generated once at
 * sync time (`src/lib/sync/derived.ts`) with Latin-digit numbers and source
 * labels already embedded as plain text, e.g. "آخر قيمة مسجلة: 42,403 في 2025،
 * بتغير -49.5% عن الفترة السابقة." Every numeric figure must be set in a
 * `dir="ltr"` tabular-digit span even inside an Arabic sentence, and a Latin
 * word next to a number ("مؤشرات Health 2000") must stay in one LTR isolate.
 *
 * The implementation lives in one place, `MixedBidiText` (components/bidi.tsx,
 * tokenized by `src/lib/text.ts` + `src/lib/numeric-tokens.ts`); this name is
 * kept for the call sites and tests that render stored summaries. Because it
 * runs at render time it also repairs summaries stored before the sync-time
 * formatting was fixed.
 */
export function ArabicTextWithNumbers({ text }: { text: string }) {
  return <MixedBidiText text={text} />;
}
