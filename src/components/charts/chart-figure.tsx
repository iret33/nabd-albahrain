import type { VizConfig } from "@/lib/sync/derived";
import { chartCaption, chartCaptionParts } from "@/lib/chart-data";
import { ChartLoader } from "@/components/charts/chart-loader";
import { ChartStats } from "@/components/charts/chart-stats";
import { ChartDataTable } from "@/components/charts/chart-data-table";

/** `chartCaptionParts` repeats this sentence; the chart's own footnote says it next to the dashed line. */
const PARTIAL_NOTE = "الفترة الأخيرة غير مكتملة";

/**
 * The dataset page's chart card, as a real `<figure>`:
 *
 *   <figure>
 *     <figcaption>   what is plotted: sum or mean, measure + unit, grain,
 *                    aggregated dimensions, excluded totals, caveats
 *     legend + toolbar + canvas   (client; Recharts loads lazily)
 *     stat row                    (server; latest / change / peak / trough)
 *     <details> data table        (server; the accessible alternative)
 *
 * The chart canvas is a `role="group"` named with the caption plus the
 * dataset's summary sentence, rather than `role="img"` on the whole figure:
 * `img` would make every child presentational, hiding the legend buttons, the
 * download buttons and the table from assistive technology, and would also
 * make the keyboard-navigable Recharts SVG (accessibilityLayer) unreachable.
 */
export function ChartFigure({
  datasetId,
  vizConfig,
  chartData,
  color,
  summaryAr,
}: {
  datasetId: string;
  vizConfig: VizConfig;
  chartData: unknown[];
  color: string;
  summaryAr: string | null;
}) {
  const parts = chartCaptionParts(vizConfig);
  const caption = chartCaption(vizConfig);
  const ariaLabel = [caption || parts.title, summaryAr].filter(Boolean).join(" ");
  const notes = parts.notes.filter((n) => n !== PARTIAL_NOTE);

  return (
    <figure aria-labelledby="chart-caption" className="m-0 rounded-2xl border border-line-light bg-white p-4 shadow-sm print:break-inside-avoid sm:p-6">
      <figcaption id="chart-caption">
        <span dir="auto" className="block break-words font-display text-base font-bold leading-7 text-sea-900 sm:text-lg">
          {parts.title}
        </span>
        {notes.length > 0 && (
          <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs leading-6 text-ink/70">
            {notes.map((note) => (
              <li key={note} dir="auto" className="break-words">
                {note}
              </li>
            ))}
          </ul>
        )}
      </figcaption>

      <div className="mt-4">
        <ChartLoader
          datasetId={datasetId}
          vizConfig={vizConfig}
          chartData={chartData}
          color={color}
          ariaLabel={ariaLabel}
          title={parts.title}
          notes={parts.notes}
        />
      </div>

      <ChartStats vizConfig={vizConfig} chartData={chartData} />
      <ChartDataTable vizConfig={vizConfig} chartData={chartData} caption={`بيانات الرسم: ${parts.title}`} />
    </figure>
  );
}
