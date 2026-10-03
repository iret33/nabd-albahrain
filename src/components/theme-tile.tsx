import Link from "next/link";
import { themeColor } from "@/lib/theme-colors";
import { Bidi } from "@/components/bidi";
import { NumberLatin } from "@/components/number-latin";

/**
 * A large colored category tile for /categories. `headingLevel` defaults to 2
 * (the page's h1 is the title); the whole tile is the link, so the tile reads
 * "name, N datasets" as one target.
 */
export function ThemeTile({
  theme,
  count,
  headingLevel = 2,
}: {
  theme: string;
  count: number;
  headingLevel?: 2 | 3 | 4;
}) {
  const color = themeColor(theme);
  const Heading = `h${headingLevel}` as const;
  return (
    <Link
      href={`/categories/${encodeURIComponent(theme)}`}
      className="group relative block h-full overflow-hidden rounded-2xl border border-line-light bg-white p-6 shadow-sm transition-all hover:shadow-lg motion-safe:hover:-translate-y-1"
    >
      <span
        className="absolute inset-y-0 right-0 w-1.5 transition-all group-hover:w-2"
        style={{ background: color }}
        aria-hidden="true"
      />
      <span
        className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-full text-sm font-bold text-white"
        style={{ background: color }}
        aria-hidden="true"
      >
        {theme.charAt(0)}
      </span>
      {/* dir="auto" + text-right: see the note in dataset-card.tsx (clamped source-language text). */}
      <Heading dir="auto" className="font-display line-clamp-2 text-right text-lg font-bold text-sea-900">
        <Bidi text={theme} />
      </Heading>
      <p className="mt-1 text-sm text-ink-muted">
        <NumberLatin value={count} /> مجموعة بيانات
      </p>
    </Link>
  );
}
