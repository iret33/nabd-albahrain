import type { ReactNode } from "react";

/**
 * `summaryAr` (and similar) are pre-baked Arabic sentences generated once at
 * sync time (`src/lib/sync/derived.ts`) with Latin-digit numbers already
 * embedded as plain text — e.g. "آخر قيمة مسجلة: 42403 في 2026، بتغير
 * -49.5% عن الفترة السابقة." Per the design spec, every numeric figure must
 * be wrapped in a `dir="ltr"` Latin-tabular-digit span even when it's part
 * of a larger Arabic sentence, not just when it's its own prop. Since these
 * sentences arrive as a single flat string (not structured pieces), this
 * component finds each numeric token (optionally signed, with a decimal
 * point, and an optional trailing `%`/`٪`) and wraps just that token —
 * everything else renders as plain Arabic text, untouched.
 */
const NUMERIC_TOKEN = /[+-]?\d[\d.,]*(?:\s?[%٪])?/g;

export function ArabicTextWithNumbers({ text }: { text: string }) {
  if (!text) return null;

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  const re = new RegExp(NUMERIC_TOKEN);
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <span key={key++} dir="ltr" className="tabular-figures">
        {match[0]}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));

  return <>{parts}</>;
}
