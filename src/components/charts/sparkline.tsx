"use client";

import { AreaChart, Area, ResponsiveContainer } from "recharts";
import type { TrendPoint } from "@/lib/chart-data";

/** A tiny, axis-less trend line for dataset cards and the featured-stats band. */
export function Sparkline({ points, color }: { points: TrendPoint[]; color: string }) {
  if (points.length < 2) return null;
  return (
    <div dir="ltr" className="h-10 w-full" aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <defs>
            <linearGradient id={`spark-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="y"
            stroke={color}
            strokeWidth={1.75}
            fill={`url(#spark-${color.replace("#", "")})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
