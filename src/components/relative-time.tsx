"use client";

import { useEffect, useState } from "react";
import { formatDateAr, formatDateTimeAr, formatRelativeAr } from "@/lib/format";

/**
 * A timestamp that reads "منذ 5 دقائق" and keeps itself current.
 *
 * Pages are server-rendered and cached, so a relative string computed on the
 * server would be frozen at render time ("قبل 5 دقائق" forever). Instead the
 * server (and the first client render) emit the ABSOLUTE Bahrain-time DATE,
 * which is deterministic, so hydration always matches; once mounted the text
 * switches to the relative form and refreshes every 30 seconds. The first
 * paint is the short date-only form (not date + time) so the swap barely
 * changes the line's width and the freshness strip does not re-wrap (a
 * measured ~0.06 CLS at 360px with the long form). The full absolute time
 * stays available in the `title` tooltip and the machine-readable `dateTime`
 * attribute.
 */
export function RelativeTime({
  iso,
  className,
  fallback = "—",
}: {
  iso: string | null | undefined;
  className?: string;
  fallback?: string;
}) {
  const [relative, setRelative] = useState<string | null>(null);

  useEffect(() => {
    if (!iso) return;
    const update = () => setRelative(formatRelativeAr(iso));
    update();
    const timer = setInterval(update, 30_000);
    return () => clearInterval(timer);
  }, [iso]);

  if (!iso) return <span className={className}>{fallback}</span>;
  const absolute = formatDateTimeAr(iso);
  return (
    <time dateTime={iso} title={`${absolute} (بتوقيت البحرين)`} className={className} suppressHydrationWarning>
      {relative ?? formatDateAr(iso)}
    </time>
  );
}
