import { CardGridSkeleton } from "@/components/skeletons";

export default function UpdatesLoading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12" aria-hidden="true">
      <div className="h-9 w-48 animate-pulse rounded bg-line-light/70" />
      <div className="mt-2 h-4 w-2/3 max-w-xl animate-pulse rounded bg-line-light/70" />
      <div className="mt-6 h-20 w-full animate-pulse rounded-2xl bg-line-light/70 sm:h-16" />
      <div className="mt-6 flex gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-11 w-24 animate-pulse rounded-full bg-line-light/70" />
        ))}
      </div>
      <div className="mt-8">
        <CardGridSkeleton count={9} />
      </div>
    </div>
  );
}
