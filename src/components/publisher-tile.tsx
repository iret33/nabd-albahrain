import Link from "next/link";
import { themeColor } from "@/lib/theme-colors";
import { NumberLatin } from "@/components/number-latin";

/**
 * A large colored tile for /publishers — same card-grid tile style as
 * ThemeTile on /categories, per the spec. Publishers don't have a themed
 * color of their own, so this reuses `themeColor()`'s deterministic hash
 * fallback (no publisher name matches the economy/health/etc. keyword
 * rules, so every publisher tile gets a stable hash-picked color from the
 * same 7-color palette) rather than introducing a second color system.
 */
export function PublisherTile({ slug, name, count }: { slug: string; name: string; count: number }) {
  const color = themeColor(name);
  return (
    <Link
      href={`/publishers/${slug}`}
      className="group relative overflow-hidden rounded-2xl border border-line-light bg-white p-6 shadow-sm transition-all hover:-translate-y-1 hover:shadow-lg"
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
      <h3 className="font-display line-clamp-2 text-lg font-bold text-sea-900">{name}</h3>
      <p className="mt-1 text-sm text-ink/60">
        <NumberLatin value={count} /> مجموعة بيانات
      </p>
    </Link>
  );
}
