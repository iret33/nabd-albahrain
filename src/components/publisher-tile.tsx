import Link from "next/link";
import { themeColor } from "@/lib/theme-colors";
import { Bidi } from "@/components/bidi";
import { NumberLatin } from "@/components/number-latin";

/**
 * A large colored tile for /publishers — same card-grid tile style as
 * ThemeTile on /categories, per the spec. Publishers don't have a themed
 * color of their own, so this reuses `themeColor()`'s deterministic hash
 * fallback (no publisher name matches the economy/health/etc. keyword
 * rules, so every publisher tile gets a stable hash-picked color from the
 * same 7-color palette) rather than introducing a second color system.
 * Publisher names are source-language text: `<Bidi>` keeps an English name
 * (and its "&", "(", ")") intact inside the Arabic page.
 */
export function PublisherTile({
  slug,
  name,
  count,
  headingLevel = 2,
}: {
  slug: string;
  name: string;
  count: number;
  headingLevel?: 2 | 3 | 4;
}) {
  const color = themeColor(name);
  const Heading = `h${headingLevel}` as const;
  return (
    <Link
      href={`/publishers/${slug}`}
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
        {name.charAt(0)}
      </span>
      {/* dir="auto" + text-right: see the note in dataset-card.tsx (clamped source-language text). */}
      <Heading dir="auto" className="font-display line-clamp-2 text-right text-lg font-bold text-sea-900">
        <Bidi text={name} />
      </Heading>
      <p className="mt-1 text-sm text-ink-muted">
        <NumberLatin value={count} /> مجموعة بيانات
      </p>
    </Link>
  );
}
