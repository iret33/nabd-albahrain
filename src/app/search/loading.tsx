import { CardGridSkeleton } from "@/components/skeletons";

export default function SearchLoading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <div className="h-9 w-32 animate-pulse rounded bg-line-light/70" />
      <div className="mt-2 h-4 w-2/3 max-w-xl animate-pulse rounded bg-line-light/70" />
      <div className="mt-6 h-12 w-full max-w-xl animate-pulse rounded-full bg-line-light/70" />
      <div className="mt-8">
        <CardGridSkeleton />
      </div>
    </div>
  );
}
