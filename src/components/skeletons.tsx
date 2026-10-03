/**
 * Loading skeleton blocks, in the site's visual voice (sand/white cards,
 * rounded-2xl, neutral blocks). `animate-pulse` respects prefers-reduced-motion
 * via the global CSS override in globals.css.
 *
 * Nothing in the public site streams behind a skeleton any more, on purpose:
 *  - Streamed content (a route-level `loading.tsx`, or an inline <Suspense>)
 *    arrives in a hidden template that an inline script reveals, so a browser
 *    without JavaScript kept the skeleton for good: an empty home page, a
 *    dataset page without its records table (R5-01). The data layer is cached
 *    and answers in tens of milliseconds, so streaming bought nothing.
 *  - A `loading.tsx` around `dataset/[id]` would also commit an HTTP 200 before
 *    `notFound()` could run, so a missing dataset would stop returning a 404.
 * Pages therefore await their data in place. Do not reintroduce a skeleton
 * boundary on a route that must read without JavaScript.
 *
 * The two exports left are what `src/app/updates/loading.tsx` still imports;
 * that file and these blocks go together once the updates page awaits in place.
 */

function Block({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-line-light/70 ${className}`} />;
}

export function DatasetCardSkeleton() {
  return (
    <div className="flex flex-col rounded-2xl border border-line-light bg-white p-5 shadow-sm">
      <Block className="mb-3 h-5 w-24 rounded-full" />
      <Block className="h-4 w-full" />
      <Block className="mt-2 h-4 w-3/4" />
      <Block className="mt-1 h-3 w-1/2" />
      <Block className="mt-4 h-10 w-full" />
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-dashed border-line-light pt-3">
        <Block className="h-3 w-16" />
        <Block className="h-3 w-20" />
      </div>
    </div>
  );
}

export function CardGridSkeleton({ count = 9 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <DatasetCardSkeleton key={i} />
      ))}
    </div>
  );
}
