/**
 * Theme -> color mapping, per the project's design-system spec.
 *
 * Keyword rules (checked in order, case-insensitive substring match against
 * the raw ODS theme string): economy/finance/trade, health, education,
 * environment, transport, labor/employment, population/social. Anything
 * that matches none of those gets a deterministic pick (hash of the theme
 * name) from the same 7-color list, so every theme always renders with a
 * stable color across requests/pages without needing a hand-maintained
 * exhaustive map of all ~24 themes actually observed on data.gov.bh.
 */

export const THEME_COLOR_PALETTE = [
  "#A6473F", // coral — economy / finance / trade
  "#3E8E7E", // teal — health
  "#C9A961", // pearl — education
  "#4C7A5E", // green — environment
  "#3D6B8C", // blue — transport
  "#B0713E", // amber/brown — labor / employment
  "#7A5C8C", // purple — population / social
] as const;

const KEYWORD_RULES: Array<{ re: RegExp; color: string }> = [
  { re: /(econom|financ|trade)/i, color: THEME_COLOR_PALETTE[0] },
  { re: /health/i, color: THEME_COLOR_PALETTE[1] },
  { re: /educat/i, color: THEME_COLOR_PALETTE[2] },
  { re: /environ/i, color: THEME_COLOR_PALETTE[3] },
  { re: /transport/i, color: THEME_COLOR_PALETTE[4] },
  { re: /(labor|labour|employ)/i, color: THEME_COLOR_PALETTE[5] },
  { re: /(population|social)/i, color: THEME_COLOR_PALETTE[6] },
];

/** Small deterministic string hash (djb2) — no Math.random, stable across runs/processes. */
function hashString(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return Math.abs(hash);
}

const FALLBACK_COLOR = "#6B7280"; // neutral gray for the "no theme" case only

/** Maps a raw theme string to a hex color. `null`/empty themes get a neutral gray. */
export function themeColor(theme: string | null | undefined): string {
  if (!theme || !theme.trim()) return FALLBACK_COLOR;
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(theme)) return rule.color;
  }
  const idx = hashString(theme) % THEME_COLOR_PALETTE.length;
  return THEME_COLOR_PALETTE[idx];
}

/**
 * Derives a small palette of visually-distinct colors for a multi-series
 * chart (multi-line / bar-stacked), anchored on the dataset's theme color
 * so charts stay on-brand instead of introducing an unrelated categorical
 * palette. Rotates hue while keeping saturation/lightness in a readable
 * band; deterministic (no randomness) so the same series always gets the
 * same color across renders.
 */
export function seriesPalette(baseHex: string, count: number): string[] {
  const { h, s, l } = hexToHsl(baseHex);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const hue = (h + i * (360 / Math.max(count, 5)) * 0.55) % 360;
    const lightness = clamp(l + (i % 2 === 0 ? 0 : 12) - Math.floor(i / 2) * 4, 24, 72);
    out.push(hslToHex(hue, clamp(s, 35, 70), lightness));
  }
  return out;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

function hslToHex(h: number, s: number, l: number): string {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lNorm - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
