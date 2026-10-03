import Link from "next/link";
import { themeColor } from "@/lib/theme-colors";
import { Bidi } from "@/components/bidi";
import { NumberLatin } from "@/components/number-latin";

/**
 * A single theme chip for the home page's category rail — colored 3px
 * right-border (per the design spec's "chip right-border" signature
 * element), theme name, dataset count. The accent border is a physical
 * `border-right` (not a logical `border-inline-end`) so it stays on the
 * visual right in this RTL app, matching the same physical-right accent
 * treatment used by `ThemeTile`/`PublisherTile`'s colored stripe — a
 * logical `inline-end` would render on the visual *left* under `dir="rtl"`,
 * contradicting the spec's explicit "right-border" signature.
 *
 * `themeColor()` is the text-safe palette, so the accent and any colored text
 * pass contrast; the count uses `text-ink-muted` (the old ink/50 was 3.1:1).
 * 44px tall: chips are tap targets on the phone-width home rail.
 */
export function ThemeChip({ theme, count }: { theme: string; count: number }) {
  const color = themeColor(theme);
  return (
    <Link
      href={`/categories/${encodeURIComponent(theme)}`}
      className="flex min-h-11 items-center gap-2 rounded-lg border border-line-light bg-white px-3 py-2 text-sm text-ink/80 shadow-sm transition-all hover:shadow-md motion-safe:hover:-translate-y-0.5"
      style={{ borderRight: `3px solid ${color}` }}
    >
      <span className="font-medium">
        <Bidi text={theme} />
      </span>
      <span className="text-xs text-ink-muted">
        <NumberLatin value={count} />
      </span>
    </Link>
  );
}
