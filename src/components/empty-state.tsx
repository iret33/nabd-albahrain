/**
 * Plain-Arabic empty state, per the quality-floor spec — used everywhere
 * the database has nothing to show yet (before any sync, or a filtered
 * view with zero results) instead of crashing or rendering a blank page.
 */
export function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-line-light bg-white px-6 py-14 text-center">
      <p className="font-display text-lg font-bold text-sea-900">{title}</p>
      {description && <p className="mx-auto mt-2 max-w-md text-sm leading-7 text-ink/60">{description}</p>}
    </div>
  );
}
