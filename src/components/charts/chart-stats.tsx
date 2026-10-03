import type { ReactNode } from "react";
import type { VizConfig } from "@/lib/sync/derived";
import { extractTrendSeries, summarizeSeries, type SeriesPoint } from "@/lib/chart-data";
import { formatChangePercent, formatPeriodAr } from "@/lib/headline";
import { isAdjacentPeriod } from "@/lib/series";
import { NumberLatin } from "@/components/number-latin";

/**
 * The numbers an analyst reaches for first, under a temporal chart: the latest
 * value, the change against the previous period and against the same period a
 * year earlier, and the peak and trough. Computed on the server from the same
 * series the headline uses (`extractTrendSeries`), so a labeled total is never
 * summed with its parts and a partial trailing period is excluded from every
 * figure.
 *
 * Change badges are green/red only when the plotted values are SUMS (counts,
 * totals), where up is simply more of something; for rates, means and "last
 * value" series the direction is shown but neutral, because "up" is not
 * inherently good or bad there. Direction is always carried by an arrow and a
 * sign too, never by color alone, and the sign sits in a `dir="ltr"` span so
 * "-" and "+" stay on the right side of the digits in an RTL line.
 */
function ChangeBadge({ pct, additive }: { pct: number; additive: boolean }) {
  // ONE rounding/sign rule shared with the lead sentence and the home card (headline.ts):
  // a change that rounds to 0.0 is flat, with no sign and no arrow direction.
  const change = formatChangePercent(pct);
  const flat = change.direction === "flat";
  const up = change.direction === "up";
  const tone = flat || !additive ? "bg-sand-100 text-ink" : up ? "bg-[#e7f2eb] text-[#1f6b45]" : "bg-[#f8e9e7] text-[#9c3a33]";
  const spoken = flat ? "بلا تغيير" : `${up ? "ارتفاع" : "انخفاض"} بنسبة ${change.magnitude}%`;
  return (
    <span
      dir="ltr"
      className={`tabular-figures inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-sm font-bold ${tone}`}
    >
      <span aria-hidden="true" className="text-[10px]">
        {flat ? "■" : up ? "▲" : "▼"}
      </span>
      <span aria-hidden="true">{change.text}</span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
}

function Tile({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-line-light bg-sand-50/70 px-3 py-2.5">
      <dt className="text-xs text-ink/70">{label}</dt>
      <dd className="mt-1 break-words font-display text-base font-bold text-sea-900">{children}</dd>
      {sub && <dd className="mt-0.5 text-xs text-ink/70">{sub}</dd>}
    </div>
  );
}

function Value({ value, unit }: { value: number; unit?: string }) {
  return (
    <>
      <NumberLatin value={value} />
      {unit && (
        <span className="ms-1 text-xs font-normal text-ink/70">
          <bdi>{unit}</bdi>
        </span>
      )}
    </>
  );
}

const Period = ({ period }: { period: string }) => <bdi className="tabular-figures">{formatPeriodAr(period)}</bdi>;

export function ChartStats({ vizConfig, chartData }: { vizConfig: VizConfig; chartData: unknown[] }) {
  if (vizConfig.type !== "area" && vizConfig.type !== "multi-line") return null;
  const trend = extractTrendSeries(vizConfig, chartData);
  if (!trend) return null;

  // extractTrendSeries already left a partial trailing period out.
  const summary = summarizeSeries(trend.points, vizConfig.grain, { partial: false });
  const { latest, prev, min, max } = summary;
  if (!latest) return null;

  const additive = vizConfig.aggregate === "sum";
  const unit = vizConfig.unit;
  const step = vizConfig.periodStep ?? 1;
  const prevAdjacent = prev ? isAdjacentPeriod(prev.period, latest.period, vizConfig.grain, step) : false;
  const showYoy = summary.yoyPct !== null && !(vizConfig.grain === "year" && prevAdjacent);
  const showRange = trend.points.length >= 3 && min && max && min.value !== max.value;

  const basis =
    trend.basis === "total-series"
      ? "السلسلة الإجمالية"
      : trend.basis === "sum-of-series"
        ? "مجموع السلاسل المعروضة"
        : null;

  const point = (p: SeriesPoint) => <Period period={p.period} />;

  return (
    <div className="mt-5 border-t border-dashed border-line-light pt-4">
      <h3 className="text-xs font-medium text-ink/70">
        أبرز الأرقام{basis ? ` — ${basis}` : ""}
        {!additive && " (قيم غير قابلة للجمع، لذا تُعرض التغيّرات دون تلوين)"}
      </h3>
      <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="آخر قيمة" sub={point(latest)}>
          <Value value={latest.value} unit={unit} />
        </Tile>
        {prev && summary.changePct !== null && (
          <Tile
            label={prevAdjacent ? "التغير عن الفترة السابقة" : "التغير عن آخر فترة متاحة"}
            sub={prevAdjacent ? undefined : point(prev)}
          >
            <ChangeBadge pct={summary.changePct} additive={additive} />
          </Tile>
        )}
        {showYoy && summary.yoyPct !== null && (
          <Tile label={vizConfig.grain === "year" ? "التغير عن السنة السابقة" : "التغير عن الشهر نفسه قبل سنة"}>
            <ChangeBadge pct={summary.yoyPct} additive={additive} />
          </Tile>
        )}
        {showRange && max && (
          <Tile label="الذروة" sub={point(max)}>
            <Value value={max.value} unit={unit} />
          </Tile>
        )}
        {showRange && min && (
          <Tile label="الأدنى" sub={point(min)}>
            <Value value={min.value} unit={unit} />
          </Tile>
        )}
      </dl>
    </div>
  );
}
