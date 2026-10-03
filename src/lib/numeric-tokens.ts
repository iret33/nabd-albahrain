/**
 * Splits a pre-baked Arabic sentence (e.g. `summaryAr`) into plain-text and
 * numeric runs so `ArabicTextWithNumbers` can wrap each numeric run in its
 * own `dir="ltr"` span. Kept as a plain .ts module (no JSX) so it is
 * unit-testable and the component stays a thin renderer.
 *
 * In an RTL paragraph two ADJACENT LTR isolates are ordered right-to-left,
 * so a token that is split in two renders reversed: the old pattern turned
 * "2026-03" into "2026" + "-03", displayed as "-032026". Hence the token
 * kinds below stay whole:
 *   - year ranges            "2020-2025"
 *   - ISO year-month / date  "2026-03", "2026-03-15"
 *   - grouped numbers        "1,512,345", "1,512,345.67"
 *   - signed / decimal / %   "-49.5%", "+2.3%", "3.6 ٪"
 * A sentence-final "." after a number is NOT swallowed ("1500." -> "1500").
 */
export const NUMERIC_TOKEN_SOURCE =
  String.raw`\d{4}[-–]\d{4}(?!\d)|\d{4}-\d{2}(?:-\d{2})?(?!\d)|[+-]?\d+(?:,\d{3})*(?:\.\d+)?(?:\s?[%٪])?`;

export interface TextRun {
  text: string;
  numeric: boolean;
}

export function splitNumericRuns(text: string): TextRun[] {
  if (!text) return [];
  const runs: TextRun[] = [];
  const re = new RegExp(NUMERIC_TOKEN_SOURCE, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) runs.push({ text: text.slice(lastIndex, match.index), numeric: false });
    runs.push({ text: match[0], numeric: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) runs.push({ text: text.slice(lastIndex), numeric: false });
  return runs;
}
