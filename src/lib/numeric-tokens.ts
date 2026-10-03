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
 *   - ranges and chains      "25-29", "100-199", "1-2-3", "25 – 29", "10%-20%", "1,000-2,000"
 *   - grouped numbers        "1,512,345", "1,512,345.67"
 *   - signed / decimal / %   "-49.5%", "+2.3%", "3.6 ٪"
 * A sentence-final "." after a number is NOT swallowed ("1500." -> "1500"),
 * and digits glued to Latin letters belong to that word ("km2", "Q1"), not to
 * a number of their own.
 *
 * Two safety nets sit behind the regex, because the whole bug class is "two
 * adjacent numeric isolates": `splitNumericRuns` merges numeric runs that touch
 * or are joined only by a dash, and `groupLtrRuns` additionally merges Latin
 * words and numbers that are separated by plain spaces ("Health 2000",
 * "CPI 2018", "2020 2025"), which an RTL paragraph would otherwise also show
 * back to front.
 */

/** One number, optionally with a percent sign: "1,512,345.67", "3.6 %". */
const NUM = String.raw`\d+(?:,\d{3})*(?:\.\d+)?(?:\s?[%٪])?`;
/** A range separator: a dash with no spaces, or with a space on BOTH sides (so "2025 -3.5%" is not a range). */
const SEP = String.raw`(?:\s[-–]\s|[-–])`;

export const NUMERIC_TOKEN_SOURCE =
  String.raw`(?<![A-Za-z])(?:` +
  // order matters: a year range / ISO date must win over the generic chain, the chain over the signed number
  String.raw`\d{4}[-–]\d{4}(?!\d)|\d{4}-\d{2}(?:-\d{2})?(?!\d)|` +
  `${NUM}(?:${SEP}${NUM})+|` +
  String.raw`[+-]?\d+(?:,\d{3})*(?:\.\d+)?(?:\s?[%٪])?` +
  `)`;

export interface TextRun {
  text: string;
  numeric: boolean;
}

/** Text that may sit between two numeric runs that still form ONE token ("1-2" + "-3"). */
const RANGE_GAP_RE = /^\s?[-–]\s?$/;

export function splitNumericRuns(text: string): TextRun[] {
  if (!text) return [];
  const raw: TextRun[] = [];
  const re = new RegExp(NUMERIC_TOKEN_SOURCE, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) raw.push({ text: text.slice(lastIndex, match.index), numeric: false });
    raw.push({ text: match[0], numeric: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) raw.push({ text: text.slice(lastIndex), numeric: false });

  // Safety net: never leave two numeric isolates side by side.
  const runs: TextRun[] = [];
  for (let i = 0; i < raw.length; i++) {
    const run = raw[i];
    const prev = runs[runs.length - 1];
    if (run.numeric && prev?.numeric) {
      prev.text += run.text;
      continue;
    }
    if (
      run.numeric === false &&
      RANGE_GAP_RE.test(run.text) &&
      prev?.numeric &&
      raw[i + 1]?.numeric
    ) {
      prev.text += run.text + raw[i + 1].text;
      i++;
      continue;
    }
    runs.push({ ...run });
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Left-to-right groups: Latin words + numbers
// ---------------------------------------------------------------------------

export interface LtrGroup {
  text: string;
  /** True when the text must be isolated as one `dir="ltr"` span. */
  ltr: boolean;
  /** `ltr` groups only: nothing but numbers (and the spaces between them). */
  digitsOnly: boolean;
  /** `ltr` groups only: the group split into numeric / plain parts (numeric parts get tabular figures). */
  parts: TextRun[];
}

/** A Latin word, with the joiners real words carry: "COVID-19", "Wi-Fi", "km/h", "v2.0", "O'Brien". */
const LATIN_WORD_RE = /[A-Za-z][A-Za-z0-9]*(?:[-'’./][A-Za-z0-9]+)*/g;
/** Plain spaces only: any other character (Arabic text or punctuation, a bracket) ends a group. */
const JOINING_SPACE_RE = /^[  ]+$/;

interface Token {
  text: string;
  kind: "num" | "latin" | "space" | "other";
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pushPlain = (chunk: string) => {
    // Split a plain chunk into maximal joining-space and non-space pieces.
    for (const piece of chunk.split(/([ \u00A0]+)/)) {
      if (piece === "") continue;
      tokens.push({ text: piece, kind: JOINING_SPACE_RE.test(piece) ? "space" : "other" });
    }
  };
  const pushNumbersAndPlain = (chunk: string) => {
    for (const run of splitNumericRuns(chunk)) {
      if (run.numeric) tokens.push({ text: run.text, kind: "num" });
      else pushPlain(run.text);
    }
  };
  // Latin words first (so "COVID-19" and "Q1" stay whole), numbers in what is left between them.
  let last = 0;
  for (const m of text.matchAll(LATIN_WORD_RE)) {
    const at = m.index ?? 0;
    if (at > last) pushNumbersAndPlain(text.slice(last, at));
    tokens.push({ text: m[0], kind: "latin" });
    last = at + m[0].length;
  }
  if (last < text.length) pushNumbersAndPlain(text.slice(last));
  return tokens;
}

/**
 * Splits text into plain runs and left-to-right groups. A group is a maximal
 * sequence of numbers and Latin words joined only by plain spaces that contains
 * AT LEAST ONE number ("Health 2000", "COVID-19 2021", "2020 2025",
 * "Health 2020-2025", "1,200 km2"). Latin words with no number next to them stay
 * in the RTL flow exactly as before (a lone Latin phrase is already read left to
 * right). Group edges are always alphanumeric or "%": leading/trailing spaces,
 * sentence punctuation, brackets and Arabic text stay outside. Joining the
 * `text` of every returned group restores the input.
 */
export function groupLtrRuns(text: string): LtrGroup[] {
  if (!text) return [];
  const out: LtrGroup[] = [];

  const pushPlain = (chunk: string) => {
    if (chunk === "") return;
    const last = out[out.length - 1];
    if (last && !last.ltr) last.text += chunk;
    else out.push({ text: chunk, ltr: false, digitsOnly: false, parts: [] });
  };

  let cur: Token[] = []; // numbers, Latin words and the single spaces between them; never ends with a space
  let pendingSpace = ""; // spaces seen after `cur`, kept only if another ltr token follows

  const flush = () => {
    if (cur.length > 0) {
      if (cur.some((t) => t.kind === "num")) {
        const parts: TextRun[] = [];
        for (const t of cur) {
          const numeric = t.kind === "num";
          const prev = parts[parts.length - 1];
          if (prev && prev.numeric === numeric) prev.text += t.text;
          else parts.push({ text: t.text, numeric });
        }
        out.push({
          text: parts.map((p) => p.text).join(""),
          ltr: true,
          digitsOnly: cur.every((t) => t.kind === "num" || t.kind === "space"),
          parts,
        });
      } else {
        pushPlain(cur.map((t) => t.text).join(""));
      }
      cur = [];
    }
    if (pendingSpace) {
      pushPlain(pendingSpace);
      pendingSpace = "";
    }
  };

  for (const token of tokenize(text)) {
    if (token.kind === "num" || token.kind === "latin") {
      if (cur.length > 0 && pendingSpace) {
        cur.push({ text: pendingSpace, kind: "space" }); // the joining space belongs to the group
        pendingSpace = "";
      }
      cur.push(token);
    } else if (token.kind === "space") {
      if (cur.length > 0) pendingSpace += token.text;
      else pushPlain(token.text);
    } else {
      flush();
      pushPlain(token.text);
    }
  }
  flush();
  return out;
}
