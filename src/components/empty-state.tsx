import type { ReactNode } from "react";

/**
 * Plain-Arabic empty state, per the quality-floor spec — used everywhere
 * the database has nothing to show yet (before any sync, or a filtered
 * view with zero results) instead of crashing or rendering a blank page.
 * `children` is for next-step links ("remove a filter", "see everything").
 */
export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  /** Plain text, or nodes when it quotes user text that needs a bidi isolate. */
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-ink/30 bg-white px-6 py-14 text-center">
      <p className="font-display text-lg font-bold text-sea-900">{title}</p>
      {description && (
        // `anywhere`: the description may quote what the visitor typed, and a pasted URL has no break point.
        <p className="mx-auto mt-2 max-w-md text-sm leading-7 text-ink-muted [overflow-wrap:anywhere]">{description}</p>
      )}
      {children && <div className="mt-5 flex flex-wrap items-center justify-center gap-3">{children}</div>}
    </div>
  );
}
