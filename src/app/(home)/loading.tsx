import { HeroStatBandSkeleton, CardGridSkeleton } from "@/components/skeletons";

export default function HomeLoading() {
  return (
    <>
      <section className="bg-sea-900 text-sand-50">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <div className="h-4 w-32 animate-pulse rounded bg-sand-100/20" />
          <div className="mt-3 h-10 w-64 animate-pulse rounded bg-sand-100/20 sm:h-14" />
          <div className="mt-4 h-5 w-full max-w-xl animate-pulse rounded bg-sand-100/20" />
          <HeroStatBandSkeleton />
        </div>
      </section>
      <div className="pearl-lattice" aria-hidden="true" />
      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <CardGridSkeleton count={6} />
      </section>
    </>
  );
}
