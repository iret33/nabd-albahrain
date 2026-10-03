import type { ReactNode } from "react";

/**
 * One labelled fact on the dataset page ("السجلات: 1,234"). Renders a
 * `<dt>`/`<dd>` pair, so callers put a group of them inside a `<dl>` and
 * assistive tech announces label and value together. Extracted from the
 * dataset page so the facts grid and any future page share one look.
 */
export function StatChip({
  label,
  value,
  note,
  className = "",
}: {
  label: string;
  value: ReactNode;
  /** A small qualifier under the value, e.g. "عُرض 5,000 من 120,000 سجل". */
  note?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-w-0 rounded-xl border border-line-light bg-white px-4 py-3 shadow-sm print:break-inside-avoid ${className}`}>
      <dt className="text-xs text-ink/70">{label}</dt>
      <dd className="mt-1 break-words font-display text-lg font-bold text-sea-900">{value}</dd>
      {note && <dd className="mt-1 text-xs font-normal leading-5 text-ink/70">{note}</dd>}
    </div>
  );
}
