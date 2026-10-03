"use client";

import type { SeriesSpec } from "@/lib/chart-model";

/**
 * Interactive legend: each series is a toggle button (`aria-pressed` = shown)
 * that hides or shows it in the chart. The order is the chart's own (for
 * stacked bars, the stack order), and the swatch repeats the line's dash
 * pattern, so the legend never relies on color alone.
 */
function Swatch({ spec, bar }: { spec: SeriesSpec; bar: boolean }) {
  return (
    <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true" focusable="false" className="shrink-0">
      {bar ? (
        <rect x="3" y="1" width="16" height="8" rx="2" fill={spec.color} />
      ) : (
        <line
          x1="0"
          y1="5"
          x2="22"
          y2="5"
          stroke={spec.color}
          strokeWidth="3"
          strokeLinecap={spec.dash ? "butt" : "round"}
          strokeDasharray={spec.dash}
        />
      )}
    </svg>
  );
}

export function ChartLegend({
  specs,
  hidden,
  bars,
  onToggle,
}: {
  specs: readonly SeriesSpec[];
  hidden: ReadonlySet<string>;
  /** Bar charts get filled swatches, line charts line swatches. */
  bars: boolean;
  onToggle: (key: string) => void;
}) {
  return (
    <ul
      aria-label="السلاسل المعروضة: اضغط على اسم سلسلة لإخفائها أو إظهارها"
      className="flex min-w-0 flex-1 basis-64 flex-wrap gap-2"
    >
      {specs.map((spec) => {
        const shown = !hidden.has(spec.key);
        return (
          <li key={spec.key} className="max-w-full">
            <button
              type="button"
              aria-pressed={shown}
              onClick={() => onToggle(spec.key)}
              className={`inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors ${
                shown
                  ? "border-ink/30 bg-white text-ink hover:border-coral"
                  : "border-line-light bg-sand-50 text-ink/70 line-through hover:border-coral"
              }`}
            >
              <span className={shown ? "" : "opacity-40"}>
                <Swatch spec={spec} bar={bars} />
              </span>
              <bdi className="truncate">{spec.label}</bdi>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
