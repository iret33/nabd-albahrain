/**
 * Pure helpers for the "download the chart as a PNG" export: turning the live
 * Recharts SVG into a standalone image needs its CSS variables resolved (an
 * SVG drawn as an <img> cannot see the page's custom properties) and a bit of
 * text layout for the title block. Kept free of the DOM so both are testable;
 * `components/charts/chart-png.ts` supplies the browser parts.
 */

/** Fonts for text inside the exported SVG: the site font is unavailable to an SVG used as an image. */
export const EXPORT_FONT_FAMILY = "'IBM Plex Sans Arabic', Tahoma, 'Segoe UI', Arial, sans-serif";

/**
 * Replaces every `var(--token)` / `var(--token, fallback)` in serialized SVG
 * with the value `lookup` gives (else the fallback, else black). Everything the
 * chart references (`var(--ink)`, `var(--line-light)`) is a plain color.
 */
export function inlineCssVars(markup: string, lookup: (name: string) => string | null | undefined): string {
  return markup.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_all, name: string, fallback?: string) => {
    const value = lookup(name)?.trim();
    if (value) return value;
    const fb = fallback?.trim();
    return fb ? fb : "#000000";
  });
}

/**
 * Greedy word wrap using a caller-supplied width measurer (canvas
 * `measureText` in the browser). A single word wider than the budget is kept
 * whole on its own line; at most `maxLines` lines are returned, the last one
 * ellipsized when text was dropped.
 */
export function wrapWords(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
  maxLines = Infinity,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && measure(candidate) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/[\s.,;:،]+$/u, "")}…`;
    return kept;
  }
  return lines;
}
