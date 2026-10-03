/**
 * Theme -> color mapping, per the project's design-system spec, plus the
 * categorical palette for multi-series charts.
 *
 * Keyword rules (checked in order, case-insensitive substring match against
 * the raw ODS theme string): economy/finance/trade, health, education,
 * environment, transport, labor/employment, population/social. Anything
 * that matches none of those gets a deterministic pick (hash of the theme
 * name) from the same 7-color list, so every theme always renders with a
 * stable color across requests/pages without needing a hand-maintained
 * exhaustive map of all ~24 themes actually observed on data.gov.bh.
 *
 * Two palettes, because one cannot do both jobs:
 *  - THEME_COLOR_PALETTE: the original decorative hues (large fills, tints).
 *    Pearl (2.25:1), teal (3.91:1) and amber (3.98:1) on white fail WCAG for
 *    text, and every theme chip renders white text on its theme color.
 *  - THEME_TEXT_COLOR_PALETTE: the same hues, darkened until each is >= 4.5:1
 *    against white (computed, and asserted in tests/derived/theme-colors.test.ts).
 *    `themeColor()` returns these, so chips, tags, stripes and chart accents
 *    are accessible by default; `themeDecorativeColor()` returns the originals.
 */

/** Decorative hues (NOT text-safe: pearl 2.25:1, teal 3.91:1, amber 3.98:1 on white). */
export const THEME_COLOR_PALETTE = [
  "#A6473F", // coral — economy / finance / trade
  "#3E8E7E", // teal — health
  "#C9A961", // pearl — education
  "#4C7A5E", // green — environment
  "#3D6B8C", // blue — transport
  "#B0713E", // amber/brown — labor / employment
  "#7A5C8C", // purple — population / social
] as const;

/** Same hues, each >= 4.5:1 on white (coral 5.84, teal 5.81, pearl 4.88, green 4.94, blue 5.71, amber 6.02, purple 5.62). */
export const THEME_TEXT_COLOR_PALETTE = [
  "#A6473F", // coral
  "#2F7062", // teal, darkened from #3E8E7E
  "#8A6D2B", // pearl, darkened from #C9A961
  "#4C7A5E", // green
  "#3D6B8C", // blue
  "#8F5521", // amber, darkened from #B0713E
  "#7A5C8C", // purple
] as const;

const KEYWORD_RULES: Array<{ re: RegExp; index: number }> = [
  { re: /(econom|financ|trade)/i, index: 0 },
  { re: /health/i, index: 1 },
  { re: /educat/i, index: 2 },
  { re: /environ/i, index: 3 },
  { re: /transport/i, index: 4 },
  { re: /(labor|labour|employ)/i, index: 5 },
  { re: /(population|social)/i, index: 6 },
];

/** Small deterministic string hash (djb2) — no Math.random, stable across runs/processes. */
function hashString(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return Math.abs(hash);
}

const FALLBACK_COLOR = "#6B7280"; // neutral gray for the "no theme" case only (4.83:1 on white)

function themeIndex(theme: string): number {
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(theme)) return rule.index;
  }
  return hashString(theme) % THEME_COLOR_PALETTE.length;
}

/**
 * Maps a raw theme string to a text-safe hex color (>= 4.5:1 on white, so
 * white chip text and colored link text both pass). `null`/empty themes get a
 * neutral gray.
 */
export function themeColor(theme: string | null | undefined): string {
  if (!theme || !theme.trim()) return FALLBACK_COLOR;
  return THEME_TEXT_COLOR_PALETTE[themeIndex(theme)];
}

/** The original decorative hue for a theme: for large fills/tints only, never behind or as text. */
export function themeDecorativeColor(theme: string | null | undefined): string {
  if (!theme || !theme.trim()) return FALLBACK_COLOR;
  return THEME_COLOR_PALETTE[themeIndex(theme)];
}

// ---------------------------------------------------------------------------
// Series palette
// ---------------------------------------------------------------------------

/**
 * Fixed, color-vision-safe categorical palette for multi-series charts
 * (multi-line / bar-stacked). Chosen numerically, not by eye: every color is
 * >= 3:1 against white (graphics threshold), and over all 8 the minimum
 * pairwise CIEDE2000 distance is 19.4 under normal vision and 15.2 / 15.1 /
 * 13.8 when simulated for protanopia / deuteranopia / tritanopia (Machado
 * 2009). The old hue-stepped palette measured 7.4-13.4 (normal) and 1.1-5.4
 * (deuteranopia) over the seven theme bases. Ordered so the first few entries
 * are the most mutually distinct. tests/derived/theme-colors.test.ts
 * recomputes all of this.
 */
export const SERIES_COLORS = [
  "#255DD4", // royal blue
  "#AF320B", // vermillion
  "#DC6397", // pink
  "#7C9B02", // olive
  "#904377", // plum
  "#3A8A5B", // green
  "#1D91FE", // bright blue
  "#5A4C46", // umber
] as const;

/** The neutral used for a chart's "total" series, which must read as a reference line rather than as one more category. */
export const TOTAL_SERIES_COLOR = "#17262A";

/**
 * Colors for a multi-series chart. The palette is the fixed color-vision-safe
 * `SERIES_COLORS`, rotated so index 0 is the entry nearest (CIEDE2000) to the
 * dataset's theme color — charts stay on-brand without inventing hues, and
 * the set stays safe whatever the theme. Deterministic. Asking for more than
 * 8 wraps around (callers should add a redundant encoding such as dashes).
 */
export function seriesPalette(baseHex: string, count: number): string[] {
  const n = Math.max(0, Math.floor(count));
  const start = nearestSeriesIndex(baseHex);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(SERIES_COLORS[(start + i) % SERIES_COLORS.length]);
  return out;
}

/**
 * Series name -> color for one chart. Non-total series take the rotated
 * palette in order; the total series (if any) gets the neutral
 * `TOTAL_SERIES_COLOR` so it is the same everywhere on the site.
 */
export function seriesColorMap(
  seriesValues: readonly string[],
  baseHex: string,
  totalKey?: string | null,
): Record<string, string> {
  const others = seriesValues.filter((s) => s !== totalKey);
  const palette = seriesPalette(baseHex, others.length);
  const out: Record<string, string> = {};
  let i = 0;
  for (const s of seriesValues) out[s] = s === totalKey ? TOTAL_SERIES_COLOR : palette[i++];
  return out;
}

function nearestSeriesIndex(baseHex: string): number {
  const base = parseHex(baseHex);
  if (!base) return 0;
  const baseLab = toLab(base);
  let best = 0;
  let bestDist = Infinity;
  SERIES_COLORS.forEach((c, i) => {
    const rgb = parseHex(c);
    if (!rgb) return;
    const d = deltaE2000(baseLab, toLab(rgb));
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

// ---------------------------------------------------------------------------
// Color math (exported for tests and for any caller that must check a pairing)
// ---------------------------------------------------------------------------

export type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function linear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an sRGB color. */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

/** WCAG contrast ratio (1..21) between two hex colors. */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = parseHex(hexA);
  const b = parseHex(hexB);
  if (!a || !b) return 1;
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export type Lab = [number, number, number];

/** sRGB -> CIE L*a*b* (D65). */
export function toLab(rgb: Rgb): Lab {
  const [r, g, b] = rgb.map(linear);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 colour difference. ~2 is a just-noticeable difference; >= 15 is clearly distinguishable on thin lines. */
export function deltaE2000(l1: Lab, l2: Lab): number {
  const rad = Math.PI / 180;
  const [L1, a1, b1] = l1;
  const [L2, a2, b2] = l2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => {
    const d = Math.atan2(b, a) / rad;
    return d < 0 ? d + 360 : d;
  };
  const h1p = C1p === 0 ? 0 : hue(b1, a1p);
  const h2p = C2p === 0 ? 0 : hue(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp: number;
  if (C1p * C2p === 0) hbp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
  else hbp = (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2;
  const T =
    1 -
    0.17 * Math.cos((hbp - 30) * rad) +
    0.24 * Math.cos(2 * hbp * rad) +
    0.32 * Math.cos((3 * hbp + 6) * rad) -
    0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}
