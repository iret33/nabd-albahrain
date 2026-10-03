import { formatNumber, formatCompact } from "@/lib/format";

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
 *  - `maximumFractionDigits` caps decimals (defaults to the shared en-US
 *    formatter's three).
 *  - `compact` renders 1,512,345 as "1.5M" (axis labels, tight chips).
 * String values pass through untouched, as before.
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
    display = new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
  } else {
    display = formatNumber(value);
  }
  if (signed && typeof value === "number" && Number.isFinite(value) && value > 0) display = `+${display}`;

  return (
    <span dir="ltr" className={`tabular-figures inline-block ${className}`}>
      {display}
    </span>
  );
}
