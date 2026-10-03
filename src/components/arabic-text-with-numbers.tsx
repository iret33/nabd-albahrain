import { groupLtrRuns } from "@/lib/numeric-tokens";

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
 * "25-29", "1,512,345" and "-49.5%" whole (two adjacent LTR isolates in an RTL
 * paragraph are ordered right-to-left, which used to display "2026-03" as
 * "-032026"). For the same reason a Latin word that sits next to a number
 * ("مؤشرات Health 2000", "CPI 2018", "«Region 2»") is isolated TOGETHER with
 * it, so the phrase reads "Health 2000" and not "2000 Health". Because this
 * runs at render time it also repairs summaries that were stored before the
 * sync-time formatting was fixed.
 */
export function ArabicTextWithNumbers({ text }: { text: string }) {
  if (!text) return null;

  return (
    <>
      {groupLtrRuns(text).map((group, i) => {
        if (!group.ltr) return group.text;
        // Only a group made of numbers is set in tabular figures as a whole: on a
        // Latin phrase it would change the digit spacing of "COVID-19".
        if (group.digitsOnly) {
          return (
            <span key={i} dir="ltr" className="tabular-figures">
              {group.text}
            </span>
          );
        }
        return (
          <span key={i} dir="ltr" lang="en">
            {group.parts.map((part, j) =>
              part.numeric ? (
                <span key={j} className="tabular-figures">
                  {part.text}
                </span>
              ) : (
                part.text
              ),
            )}
          </span>
        );
      })}
    </>
  );
}
