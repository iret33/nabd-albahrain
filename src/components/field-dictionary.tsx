import type { StatsJson } from "@/lib/sync/derived";
import type { CatalogField } from "@/lib/sync/schemas";
import { buildColumns } from "@/lib/cell-format";
import { fieldTypeLabelAr } from "@/lib/dataset-page";
import { NumberLatin } from "@/components/number-latin";
import { FieldProfile } from "@/components/field-profile";

/**
 * "قاموس الحقول (N)": one collapsed `<details>` listing every column with its
 * Arabic type badge, label, the raw ODS name (what the exports and the API
 * call it, so always LTR code), the portal's description and the measured
 * profile. A Server Component: expanding it is native `<details>`, zero JS.
 *
 * Handles rows without `statsJson` (synced before the stats existed) by
 * showing the schema only, plus one line saying the statistics are pending.
 */
export function FieldDictionary({
  fields,
  stats,
  className = "",
}: {
  fields: readonly CatalogField[];
  stats: StatsJson | null;
  className?: string;
}) {
  const columns = buildColumns(fields, stats);
  if (columns.length === 0) return null;
  const descriptions = new Map(fields.map((f) => [f.name, f.description?.trim() ?? ""]));
  const hasStats = columns.some((c) => c.stats !== null);

  return (
    <details className={`group rounded-2xl border border-line-light bg-white shadow-sm ${className}`}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-5 py-3 font-display text-lg font-bold text-sea-900 [&::-webkit-details-marker]:hidden">
        <span>
          قاموس الحقول (<NumberLatin value={columns.length} />)
        </span>
        <svg
          viewBox="0 0 20 20"
          className="h-4 w-4 shrink-0 text-ink/70 motion-safe:transition-transform group-open:rotate-180"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M5 8l5 5 5-5" />
        </svg>
      </summary>

      <div className="border-t border-line-light px-5 pb-2 pt-3">
        <p className="text-sm leading-7 text-ink/70">
          أنواع الحقول وأسماؤها كما ترد في المصدر{hasStats ? "، مع ملخص إحصائي محسوب من السجلات المخزّنة." : "."}
        </p>
        {!hasStats && (
          <p className="mt-1 text-xs leading-6 text-ink/70">لم تُحسب الإحصاءات لهذه المجموعة بعد.</p>
        )}
        <ul className="mt-2 divide-y divide-line-light">
          {columns.map((column) => {
            const description = descriptions.get(column.name);
            return (
              <li key={column.name} className="grid gap-x-8 gap-y-3 py-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-words font-medium text-sea-900">
                      <bdi>{column.label}</bdi>
                    </span>
                    <span className="rounded-full border border-line-light bg-sand-50 px-2 py-0.5 text-xs text-ink/80">
                      {fieldTypeLabelAr(column.type)}
                    </span>
                  </div>
                  {column.label !== column.name && (
                    <code
                      dir="ltr"
                      className="mt-1 inline-block max-w-full break-all rounded bg-sand-100 px-1.5 py-0.5 text-xs text-ink"
                    >
                      {column.name}
                    </code>
                  )}
                  {description && (
                    <p dir="auto" className="mt-2 break-words text-right text-sm leading-6 text-ink/80">
                      {description}
                    </p>
                  )}
                </div>
                <FieldProfile column={column} />
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}
