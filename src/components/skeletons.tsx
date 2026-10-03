/**
 * Loading skeletons, in the site's visual voice (RTL, sand/white cards,
 * rounded-2xl, pearl-ish neutral blocks) — used by the route segments'
 * loading.tsx files. `animate-pulse` respects prefers-reduced-motion via
 * the global CSS override in globals.css.
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

/**
 * Filter bar + card grid, the shape of a listing's results. Used as the inline
 * <Suspense> fallback of /categories/[theme] and /publishers/[slug]: those pages
 * validate the theme/slug (a real 404) BEFORE this boundary, so the skeleton
 * can stream without ever committing a 200 for an unknown value.
 */
export function ListResultsSkeleton({ count = 9 }: { count?: number }) {
  return (
    <div aria-hidden="true">
      <Block className="h-44 w-full rounded-2xl sm:h-32" />
      <div className="mt-6">
        <CardGridSkeleton count={count} />
      </div>
    </div>
  );
}

export function ThemeTileSkeleton() {
  return (
    <div className="rounded-2xl border border-line-light bg-white p-6">
      <Block className="mb-4 h-10 w-10 rounded-full" />
      <Block className="h-5 w-2/3" />
      <Block className="mt-2 h-3 w-1/3" />
    </div>
  );
}

export function ThemeTileGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <ThemeTileSkeleton key={i} />
      ))}
    </div>
  );
}

export function HeroStatBandSkeleton() {
  return (
    <div className="mt-10 flex flex-wrap gap-x-8 gap-y-6 border-t border-line-dark pt-8">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i}>
          <Block className="h-3 w-20 bg-sand-100/20" />
          <Block className="mt-2 h-8 w-16 bg-sand-100/20" />
        </div>
      ))}
    </div>
  );
}

/**
 * Full dataset-detail page shape. Kept for reference/reuse, but
 * deliberately NOT wired as `dataset/[id]/loading.tsx`: a route-level
 * `loading.tsx` wraps the whole page (including the `notFound()` check) in
 * a Suspense boundary, which makes Next.js commit an HTTP 200 status
 * before the not-found decision is known — confirmed empirically during
 * Phase 4 (a missing dataset id returned 200 with the not-found.tsx body
 * instead of a real 404 status). Since a correct 404 status matters more
 * than a route-level skeleton here, the dataset page instead renders its
 * header/chart/stats synchronously (fast — cached queries) and only wraps
 * the records table in an inline <Suspense> using `RecordsTableSkeleton`
 * below, which streams safely because it's *after* the notFound() check
 * has already resolved.
 */
export function DatasetDetailSkeleton() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <Block className="h-4 w-40" />
      <Block className="mt-4 h-9 w-3/4" />
      <Block className="mt-3 h-5 w-full" />
      <Block className="mt-1 h-5 w-2/3" />

      <div className="mt-8 rounded-2xl border border-line-light bg-white p-6 shadow-sm">
        <Block className="h-72 w-full sm:h-80" />
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Block key={i} className="h-16 w-36" />
        ))}
      </div>

      <div className="mt-10">
        <RecordsTableSkeleton />
      </div>
    </div>
  );
}

/** Just the table block itself — used as the inline Suspense fallback for the records section. */
export function RecordsTableSkeleton() {
  return <Block className="h-64 w-full rounded-2xl" />;
}
