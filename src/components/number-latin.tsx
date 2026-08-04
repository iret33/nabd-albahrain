import { formatNumber } from "@/lib/format";

/**
 * Wraps a numeric figure in Latin tabular digits, per the design spec —
 * used everywhere a number appears in the (otherwise Arabic/RTL) UI.
 */
export function NumberLatin({
  value,
  className = "",
}: {
  value: number | string;
  className?: string;
}) {
  const display = typeof value === "number" ? formatNumber(value) : value;
  return (
    <span dir="ltr" className={`tabular-figures inline-block ${className}`}>
      {display}
    </span>
  );
}
