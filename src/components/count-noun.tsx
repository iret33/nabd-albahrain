import { countParts, type NounForms } from "@/lib/arabic-count";
import { NumberLatin } from "@/components/number-latin";

/**
 * A count with its Arabic noun in the agreeing form ("سجل واحد", "سجلان",
 * "6 سجلات", "1,200 سجلًا"; see `src/lib/arabic-count.ts`). The digits go
 * through NumberLatin (dir="ltr", tabular, grouped) and only when the noun does
 * not already carry the count, so "سجلان" never prints a stray "2".
 *
 * `oblique` is for a count that follows a preposition ("من أصل سجلين", not
 * "سجلان"). Zero is the caller's call: "0 سجلًا" is not Arabic, so branch to
 * a sentence of its own ("لا توجد سجلات") before reaching for this.
 */
export function CountNoun({ n, forms, oblique = false }: { n: number; forms: NounForms; oblique?: boolean }) {
  const parts = countParts(n, forms, { oblique });
  return (
    <>
      {parts.number !== null && (
        <>
          <NumberLatin value={Math.round(n)} />{" "}
        </>
      )}
      {parts.noun}
    </>
  );
}
