/**
 * Arabic counted-noun agreement for the nouns the site counts (سجل / حقل / فئة).
 * Pure. Digits are Latin and grouped, per the site-wide rule.
 *
 *   1      -> the singular + "واحد/واحدة"     سجل واحد
 *   2      -> the dual (no digit)              سجلان  (oblique after على/عبر/من: سجلين)
 *   3-10   -> digit + broken/sound plural      6 سجلات
 *   11+    -> digit + accusative singular      11 سجلًا
 *
 * Zero is NOT handled here on purpose: "0 سجلات" is not how a sentence about
 * an empty dataset reads, so callers write a whole-sentence branch for it.
 */

export interface NounForms {
  /** Singular, e.g. "سجل". */
  one: string;
  /** "واحد" / "واحدة" (agrees with the noun's gender). */
  oneNumber: string;
  /** Nominative dual, e.g. "سجلان". */
  dual: string;
  /** Oblique dual (after a preposition), e.g. "سجلين". */
  dualOblique: string;
  /** Plural used with 3-10, e.g. "سجلات". */
  few: string;
  /** Accusative singular used with 11+, e.g. "سجلًا". */
  many: string;
}

export const NOUNS = {
  record: { one: "سجل", oneNumber: "واحد", dual: "سجلان", dualOblique: "سجلين", few: "سجلات", many: "سجلًا" },
  field: { one: "حقل", oneNumber: "واحد", dual: "حقلان", dualOblique: "حقلين", few: "حقول", many: "حقلًا" },
  category: { one: "فئة", oneNumber: "واحدة", dual: "فئتان", dualOblique: "فئتين", few: "فئات", many: "فئةً" },
  /** A table row of a dataset (distinct from "record", the catalog's own word for one entry). */
  row: { one: "صف", oneNumber: "واحد", dual: "صفان", dualOblique: "صفين", few: "صفوف", many: "صفًا" },
} as const satisfies Record<string, NounForms>;

const grouped = new Intl.NumberFormat("en-US");

export interface CountParts {
  /** Grouped Latin digits to print before the noun, or null when the noun itself carries the count (1, 2). */
  number: string | null;
  /** The noun in the form agreeing with the count ("سجل واحد" is returned as noun "سجل واحد", number null). */
  noun: string;
}

/**
 * The count split into an optional digit string and the agreeing noun phrase,
 * so UI can render the digits through NumberLatin (dir="ltr", tabular) and the
 * noun as plain text. `oblique` selects the genitive/accusative dual
 * ("على سجلين") instead of the nominative ("سجلان").
 */
export function countParts(n: number, forms: NounForms, opts: { oblique?: boolean } = {}): CountParts {
  const count = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  if (count === 1) return { number: null, noun: `${forms.one} ${forms.oneNumber}` };
  if (count === 2) return { number: null, noun: opts.oblique ? forms.dualOblique : forms.dual };
  const digits = grouped.format(count);
  if (count >= 3 && count <= 10) return { number: digits, noun: forms.few };
  return { number: digits, noun: forms.many };
}

/** The same as one plain string: "سجل واحد", "سجلان", "6 سجلات", "1,200 سجلًا". */
export function countPhrase(n: number, forms: NounForms, opts: { oblique?: boolean } = {}): string {
  const { number, noun } = countParts(n, forms, opts);
  return number === null ? noun : `${number} ${noun}`;
}
