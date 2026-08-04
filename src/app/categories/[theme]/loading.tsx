import { CardGridSkeleton } from "@/components/skeletons";

export default function ThemeLoading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <div className="h-4 w-20 animate-pulse rounded bg-line-light/70" />
      <div className="mt-2 h-9 w-56 animate-pulse rounded bg-line-light/70" />
      <div className="mt-2 h-4 w-24 animate-pulse rounded bg-line-light/70" />
      <div className="mt-8">
        <CardGridSkeleton />
      </div>
    </div>
  );
}
