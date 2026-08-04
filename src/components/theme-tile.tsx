import Link from "next/link";
import { themeColor } from "@/lib/theme-colors";
import { NumberLatin } from "@/components/number-latin";

/** A large colored category tile for /categories. */
export function ThemeTile({ theme, count }: { theme: string; count: number }) {
  const color = themeColor(theme);
  return (
    <Link
      href={`/categories/${encodeURIComponent(theme)}`}
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
        {theme.charAt(0)}
      </span>
      <h3 className="font-display text-lg font-bold text-sea-900">{theme}</h3>
      <p className="mt-1 text-sm text-ink/60">
        <NumberLatin value={count} /> مجموعة بيانات
      </p>
    </Link>
  );
}
