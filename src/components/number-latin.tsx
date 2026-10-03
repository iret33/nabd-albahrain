import { formatCompact } from "@/lib/format";
import { formatDisplayNumber } from "@/lib/headline";

/**
 * Wraps a numeric figure in Latin tabular digits, per the design spec —
 * used everywhere a number appears in the (otherwise Arabic/RTL) UI.
 *
 * Always `dir="ltr"`, so a leading "-" / "+" stays on the correct side of
 * the digits inside an RTL paragraph.
 *
 *  - `grouped={false}` prints the digits as-is. Use it for years and
 *    identifiers (a year must read "2020", never "2,020").
 *  - `signed` prefixes "+" on positive numbers (change badges).
 *  - `maximumFractionDigits` caps decimals. Without it the number follows the
 *    site's ONE display convention (`formatDisplayNumber`, the same digits as the
 *    lead sentence: 2 decimals below 100, 1 below 1,000, none above, two
 *    significant digits below 1), so a card, a stats tile and the sentence print
 *    the same figure. The records table asks for more digits explicitly.
 *  - `compact` renders 1,512,345 as "1.5M" (axis labels, tight chips).
 * String values pass through untouched, as before.
 *
 * A value that rounds to zero never prints as "0" or "-0": 0.0042 under a cap of
 * two decimals falls back to two significant digits ("0.0042").
 */
export function NumberLatin({
  value,
  className = "",
  grouped = true,
  signed = false,
  maximumFractionDigits,
  compact = false,
}: {
  value: number | string;
  className?: string;
  grouped?: boolean;
  signed?: boolean;
  maximumFractionDigits?: number;
  compact?: boolean;
}) {
  let display: string;
  if (typeof value !== "number") {
    display = value;
  } else if (compact) {
    display = formatCompact(value);
  } else if (!Number.isFinite(value)) {
    display = "—";
  } else if (!grouped) {
    display =
      maximumFractionDigits === undefined
        ? String(value)
        : String(Number(value.toFixed(Math.max(0, Math.min(20, maximumFractionDigits)))));
  } else if (maximumFractionDigits !== undefined) {
    const capped = new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
    // Intl keeps a negative zero ("-0") and rounds 0.0042 to "0": both hide a real value.
    display = value !== 0 && (capped === "0" || capped === "-0") ? formatDisplayNumber(value) : capped;
  } else {
    display = formatDisplayNumber(value);
  }
  if (signed && typeof value === "number" && Number.isFinite(value) && value > 0) display = `+${display}`;

  return (
    <span dir="ltr" className={`tabular-figures inline-block ${className}`}>
      {display}
    </span>
  );
}
