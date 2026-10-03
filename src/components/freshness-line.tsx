import { RelativeTime } from "@/components/relative-time";

export interface FreshnessItem {
  /** Arabic label, e.g. "آخر تحقق من المصدر". */
  label: string;
  /** ISO timestamp (or null when unknown — renders an em dash). */
  iso: string | null | undefined;
}

/**
 * A compact "how fresh is this data" strip: one label + live relative time per
 * item (see RelativeTime), plus an optional notice for a failed/stale state.
 *
 * Callers choose the items so the same component serves the portal-wide
 * summary (last checked / last data change) and a dataset's own timeline
 * (source modified / last synced / last checked) without this component
 * knowing about either.
 */
export function FreshnessLine({
  items,
  notice,
  tone = "light",
  className = "",
}: {
  items: FreshnessItem[];
  /** Shown as a small highlighted line, e.g. "آخر محاولة تحديث فشلت". */
  notice?: string | null;
  /** "dark" for use on the sea-900 hero / footer bands. */
  tone?: "light" | "dark";
  className?: string;
}) {
  const text = tone === "dark" ? "text-sand-100/85" : "text-ink/70";
  const noticeColor = tone === "dark" ? "bg-pearl/20 text-pearl" : "bg-coral/10 text-coral";
  return (
    <div className={`flex flex-col gap-1.5 text-xs ${text} ${className}`}>
      <dl className="flex flex-wrap gap-x-5 gap-y-1">
        {items.map((item) => (
          <div key={item.label} className="flex items-baseline gap-1.5">
            <dt>{item.label}:</dt>
            <dd className="font-medium">
              <RelativeTime iso={item.iso} />
            </dd>
          </div>
        ))}
      </dl>
      {notice && <p className={`w-fit rounded-md px-2 py-0.5 font-medium ${noticeColor}`}>{notice}</p>}
    </div>
  );
}
