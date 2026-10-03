import type { VizConfig } from "@/lib/sync/derived";
import { capRows, chartTableModel } from "@/lib/chart-table";
import { NumberLatin } from "@/components/number-latin";

/** Rows rendered into the page; the CSV download carries all of them. */
export const CHART_TABLE_MAX_ROWS = 60;

/**
 * "عرض بيانات الرسم كجدول": the plotted numbers as a real table, inside a
 * native `<details>` (a Server Component, so zero client JS and the HTML cost
 * only appears once per page). This is the accessible equivalent of the
 * picture: a screen-reader or keyboard user can read every value, and anyone
 * can read an exact number the tooltip would only show on hover.
 *
 * Capped at 60 rows to keep the HTML small; time series keep their most
 * RECENT rows, and a note points to the CSV for the rest. Missing values (gaps)
 * are shown as a dash and announced as "لا بيانات".
 */
export function ChartDataTable({
  vizConfig,
  chartData,
  caption,
}: {
  vizConfig: VizConfig;
  chartData: unknown[];
  /** Accessible caption: what the table contains. */
  caption: string;
}) {
  const table = chartTableModel(vizConfig, chartData);
  if (!table || table.rows.length === 0) return null;
  const capped = capRows(table.rows, CHART_TABLE_MAX_ROWS, table.temporal ? "end" : "start");
  const [rowHeader, ...valueColumns] = table.columns;

  return (
    <details className="group mt-4 rounded-xl border border-line-light bg-white">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-2 text-sm font-medium text-sea-900 hover:text-coral [&::-webkit-details-marker]:hidden">
        <span>عرض بيانات الرسم كجدول</span>
        <svg
          viewBox="0 0 20 20"
          className="h-4 w-4 shrink-0 motion-safe:transition-transform group-open:rotate-180"
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

      <div className="border-t border-line-light px-2 pb-3 pt-3 sm:px-4">
        {capped.omitted > 0 && (
          <p className="mb-2 px-2 text-xs leading-6 text-ink/70">
            {table.temporal ? "عُرضت آخر " : "عُرضت أول "}
            <NumberLatin value={capped.rows.length} /> {table.temporal ? "فترة" : "صفًا"} من أصل{" "}
            <NumberLatin value={capped.total} /> — نزّل ملف CSV للحصول على كامل البيانات.
          </p>
        )}
        <div
          role="region"
          aria-label="جدول بيانات الرسم (يمكن تمريره)"
          tabIndex={0}
          className="relative max-h-96 overflow-auto rounded-lg border border-line-light"
        >
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="sticky top-0 z-10 whitespace-nowrap bg-sand-50 px-3 py-2 text-start text-xs font-medium text-ink/80 shadow-[inset_0_-1px_0_var(--line-light)]"
                >
                  <bdi>{rowHeader.header}</bdi>
                </th>
                {valueColumns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className="sticky top-0 z-10 whitespace-nowrap bg-sand-50 px-3 py-2 text-end text-xs font-medium text-ink/80 shadow-[inset_0_-1px_0_var(--line-light)]"
                  >
                    <bdi>{column.header}</bdi>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {capped.rows.map((row, index) => (
                <tr key={index} className="border-b border-line-light/70 last:border-0">
                  <th scope="row" className="whitespace-nowrap px-3 py-1.5 text-start font-medium text-ink">
                    <bdi dir={table.temporal ? "ltr" : "auto"} className="tabular-figures">
                      {String(row[rowHeader.key] ?? "")}
                    </bdi>
                  </th>
                  {valueColumns.map((column) => {
                    const value = row[column.key];
                    return (
                      <td key={column.key} className="tabular-figures whitespace-nowrap px-3 py-1.5 text-end text-ink">
                        {typeof value === "number" && Number.isFinite(value) ? (
                          <NumberLatin value={value} maximumFractionDigits={4} />
                        ) : (
                          <>
                            <span aria-hidden="true" className="text-ink/60">
                              —
                            </span>
                            <span className="sr-only">لا بيانات</span>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}
