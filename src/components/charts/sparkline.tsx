import { sparklinePath, type TrendPoint } from "@/lib/chart-data";

/**
 * A tiny, axis-less trend line for dataset cards and the featured-stats band.
 *
 * A pure server component: no "use client", no Recharts. It used to pull the
 * Recharts client bundle (and a ResizeObserver per card) onto every list page
 * just to draw 40px of line, and rendered nothing during SSR so sparklines
 * popped in after hydration. The geometry is plain SVG from `sparklinePath`:
 * a stretchy 100 x 40 viewBox (`preserveAspectRatio="none"`) with a
 * non-scaling stroke, so it fills any width at a constant line weight, with
 * zero JS and no layout shift. Decorative only (`aria-hidden`): the number it
 * accompanies carries the meaning.
 */
export function Sparkline({ points, color }: { points: TrendPoint[]; color: string }) {
  const { line, area } = sparklinePath(points, 100, 40);
  if (!line) return null;
  return (
    <div dir="ltr" className="h-10 w-full" aria-hidden="true">
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        className="block h-full w-full overflow-visible"
        focusable="false"
      >
        <path d={area} fill={color} fillOpacity={0.15} stroke="none" />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
