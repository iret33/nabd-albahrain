import { splitNumericRuns } from "@/lib/numeric-tokens";

/**
 * `summaryAr` (and similar) are pre-baked Arabic sentences generated once at
 * sync time (`src/lib/sync/derived.ts`) with Latin-digit numbers already
 * embedded as plain text — e.g. "آخر قيمة مسجلة: 42,403 في 2025، بتغير
 * -49.5% عن الفترة السابقة." Per the design spec, every numeric figure must
 * be wrapped in a `dir="ltr"` Latin-tabular-digit span even when it's part
 * of a larger Arabic sentence, not just when it's its own prop. Since these
 * sentences arrive as a single flat string (not structured pieces), this
 * component finds each numeric token and wraps just that token —
 * everything else renders as plain Arabic text, untouched.
 *
 * Tokenization lives in `src/lib/numeric-tokens.ts`: it keeps "2026-03",
 * "1,512,345" and "-49.5%" whole (two adjacent LTR isolates in an RTL
 * paragraph are ordered right-to-left, which used to display "2026-03" as
 * "-032026"). Because this runs at render time it also repairs summaries
 * that were stored before the sync-time formatting was fixed.
 */
export function ArabicTextWithNumbers({ text }: { text: string }) {
  if (!text) return null;

  return (
    <>
      {splitNumericRuns(text).map((run, i) =>
        run.numeric ? (
          <span key={i} dir="ltr" className="tabular-figures">
            {run.text}
          </span>
        ) : (
          run.text
        ),
      )}
    </>
  );
}
