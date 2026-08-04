import Link from "next/link";
import { themeColor } from "@/lib/theme-colors";
import { formatDateAr } from "@/lib/format";
import { extractFeaturedMetric, looksTemporal } from "@/lib/chart-data";
import { asVizConfig, asChartData, type DatasetCardRow } from "@/lib/queries";
import { NumberLatin } from "@/components/number-latin";
import { Sparkline } from "@/components/charts/sparkline";

/**
 * The standard dataset card — reused on the home page's "الأحدث تحديثاً"
 * rail and the /categories/[theme] grid: colored theme tag, titleClean,
 * publisher, recordsCount, a mini sparkline when the chart is temporal,
 * and last-updated. Dashed top border on the footer + hover lift, per the
 * design spec's signature card treatment.
 */
export function DatasetCard({ dataset }: { dataset: DatasetCardRow }) {
  const vizConfig = asVizConfig(dataset.vizConfig);
  const chartData = asChartData(dataset.chartData);
  const color = themeColor(dataset.theme);
  const metric = looksTemporal(vizConfig) ? extractFeaturedMetric(vizConfig, chartData) : null;

  return (
    <Link
      href={`/dataset/${encodeURIComponent(dataset.id)}`}
      className="group flex flex-col rounded-2xl border border-line-light bg-white p-5 shadow-sm transition-all hover:-translate-y-[3px] hover:shadow-md"
    >
      {dataset.theme && (
        <span
          className="mb-3 inline-flex w-fit items-center rounded-full px-2.5 py-1 text-xs font-medium text-white"
          style={{ background: color }}
        >
          {dataset.theme}
        </span>
      )}

      <h3 className="font-display line-clamp-2 text-base font-bold leading-snug text-sea-900">
        {dataset.titleClean}
      </h3>
      {dataset.publisher && <p className="mt-1 line-clamp-1 text-xs text-ink/50">{dataset.publisher}</p>}

      {metric && metric.points.length > 1 && (
        <div className="mt-3">
          <Sparkline points={metric.points} color={color} />
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-dashed border-line-light pt-3 text-xs text-ink/50">
        <span>
          <NumberLatin value={dataset.recordsCount} /> سجل
        </span>
        <span>{dataset.lastSyncedAt ? formatDateAr(dataset.lastSyncedAt) : "لم تتم المزامنة بعد"}</span>
      </div>

      {dataset.syncStatus === "partial" && (
        <span className="mt-2 inline-block w-fit rounded bg-coral/10 px-2 py-0.5 text-[11px] font-medium text-coral">
          معاينة جزئية
        </span>
      )}
    </Link>
  );
}
