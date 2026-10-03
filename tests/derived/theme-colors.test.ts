import { describe, expect, it } from "vitest";
import {
  SERIES_COLORS,
  THEME_COLOR_PALETTE,
  THEME_TEXT_COLOR_PALETTE,
  TOTAL_SERIES_COLOR,
  contrastRatio,
  deltaE2000,
  parseHex,
  seriesColorMap,
  seriesPalette,
  themeColor,
  themeDecorativeColor,
  toLab,
  type Rgb,
} from "@/lib/theme-colors";

const WHITE = "#FFFFFF";

// Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear RGB.
const CVD: Record<string, number[][]> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};
const lin = (c: number) => ((c / 255) <= 0.04045 ? c / 255 / 12.92 : (((c / 255) + 0.055) / 1.055) ** 2.4);
const gam = (v: number) => 255 * (Math.max(0, Math.min(1, v)) <= 0.0031308 ? 12.92 * Math.max(0, Math.min(1, v)) : 1.055 * Math.max(0, Math.min(1, v)) ** (1 / 2.4) - 0.055);
function simulate(rgb: Rgb, m: number[][]): Rgb {
  const l = rgb.map(lin);
  return m.map((row) => gam(row[0] * l[0] + row[1] * l[1] + row[2] * l[2])) as Rgb;
}

function minPairwise(colors: readonly string[], vision?: string): { d: number; pair: [string, string] } {
  let best = { d: Infinity, pair: ["", ""] as [string, string] };
  const rgbs = colors.map((c) => parseHex(c)!);
  const labs = rgbs.map((rgb) => toLab(vision ? simulate(rgb, CVD[vision]) : rgb));
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const d = deltaE2000(labs[i], labs[j]);
      if (d < best.d) best = { d, pair: [colors[i], colors[j]] };
    }
  }
  return best;
}

describe("contrast helper", () => {
  it("matches WCAG reference values", () => {
    expect(contrastRatio("#000000", WHITE)).toBeCloseTo(21, 5);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5);
    expect(contrastRatio("#767676", WHITE)).toBeCloseTo(4.54, 2); // the classic AA gray
    expect(contrastRatio("nope", WHITE)).toBe(1);
  });
});

describe("theme colors: text-safe (>= 4.5:1 on white) vs decorative", () => {
  it("the decorative palette is unchanged and three of its hues FAIL as text (the audited bug)", () => {
    expect([...THEME_COLOR_PALETTE]).toEqual(["#A6473F", "#3E8E7E", "#C9A961", "#4C7A5E", "#3D6B8C", "#B0713E", "#7A5C8C"]);
    expect(contrastRatio("#C9A961", WHITE)).toBeLessThan(2.3); // pearl 2.25
    expect(contrastRatio("#3E8E7E", WHITE)).toBeLessThan(4.5); // teal 3.91
    expect(contrastRatio("#B0713E", WHITE)).toBeLessThan(4.5); // amber 3.98
  });

  it.each([...THEME_TEXT_COLOR_PALETTE])("%s is >= 4.5:1 against white (white chip text)", (hex) => {
    expect(contrastRatio(hex, WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it("each text-safe color keeps the hue family of its decorative original", () => {
    THEME_TEXT_COLOR_PALETTE.forEach((safe, i) => {
      const d = deltaE2000(toLab(parseHex(THEME_COLOR_PALETTE[i])!), toLab(parseHex(safe)!));
      expect(d).toBeLessThan(25);
    });
  });

  it("themeColor returns text-safe colors for every keyword rule and for hashed themes", () => {
    const themes = ["Economy", "Finance", "Trade", "Health", "Education", "Environment", "Transport", "Labor", "Employment", "Population", "Social", "Tourism", "Housing", "Energy", "الصحة", "x"];
    for (const t of themes) {
      expect(contrastRatio(themeColor(t), WHITE)).toBeGreaterThanOrEqual(4.5);
      expect(THEME_TEXT_COLOR_PALETTE).toContain(themeColor(t));
    }
    expect(contrastRatio(themeColor(null), WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(themeColor("   "), WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it("the keyword mapping is unchanged (education is still the pearl slot)", () => {
    expect(themeColor("Education")).toBe(THEME_TEXT_COLOR_PALETTE[2]);
    expect(themeDecorativeColor("Education")).toBe("#C9A961");
    expect(themeColor("Health")).toBe(THEME_TEXT_COLOR_PALETTE[1]);
    expect(themeDecorativeColor("Health")).toBe("#3E8E7E");
    expect(themeColor("Labor & Employment")).toBe(THEME_TEXT_COLOR_PALETTE[5]);
    expect(themeDecorativeColor("Labor & Employment")).toBe("#B0713E");
    // deterministic hash fallback
    expect(themeColor("Some Unmatched Theme")).toBe(themeColor("Some Unmatched Theme"));
  });
});

describe("series palette: verified numerically, not asserted by eye", () => {
  it("has 8 distinct colors", () => {
    expect(SERIES_COLORS).toHaveLength(8);
    expect(new Set(SERIES_COLORS).size).toBe(8);
  });

  it("every color is >= 3:1 against a white chart card (WCAG graphics threshold)", () => {
    for (const c of SERIES_COLORS) expect(contrastRatio(c, WHITE), c).toBeGreaterThanOrEqual(3);
  });

  it("minimum pairwise CIEDE2000 over all 8 is >= 19 under normal vision (old palette: 7.4-13.4)", () => {
    const { d, pair } = minPairwise(SERIES_COLORS);
    expect(d, pair.join(" vs ")).toBeGreaterThanOrEqual(19);
  });

  it.each([
    ["protanopia", 15],
    ["deuteranopia", 15],
    ["tritanopia", 13],
  ])("stays distinguishable under simulated %s (min CIEDE2000 >= %s; old palette: 1.1-5.4 deuteranopia)", (vision, floor) => {
    const { d, pair } = minPairwise(SERIES_COLORS, vision);
    expect(d, pair.join(" vs ")).toBeGreaterThanOrEqual(floor);
  });

  it("holds for every prefix size 2..8 (a 3-series chart is at least as safe as an 8-series one)", () => {
    for (let n = 2; n <= 8; n++) {
      expect(minPairwise(SERIES_COLORS.slice(0, n)).d).toBeGreaterThanOrEqual(19);
      expect(minPairwise(SERIES_COLORS.slice(0, n), "deuteranopia").d).toBeGreaterThanOrEqual(15);
    }
  });

  it("the total color is a neutral dark reference, not one of the categorical hues", () => {
    expect(SERIES_COLORS as readonly string[]).not.toContain(TOTAL_SERIES_COLOR);
    expect(contrastRatio(TOTAL_SERIES_COLOR, WHITE)).toBeGreaterThan(12);
  });
});

describe("seriesPalette(baseHex, count): rotated so index 0 is the entry nearest the theme color", () => {
  it("count entries, all from the safe palette, all distinct up to 8", () => {
    for (const base of THEME_TEXT_COLOR_PALETTE) {
      for (let n = 0; n <= 8; n++) {
        const p = seriesPalette(base, n);
        expect(p).toHaveLength(n);
        expect(new Set(p).size).toBe(n);
        for (const c of p) expect(SERIES_COLORS as readonly string[]).toContain(c);
      }
    }
  });

  it("index 0 is the palette color nearest to the base (coral -> vermillion, green -> green, purple -> plum)", () => {
    expect(seriesPalette("#A6473F", 3)[0]).toBe("#AF320B");
    expect(seriesPalette("#4C7A5E", 3)[0]).toBe("#3A8A5B");
    expect(seriesPalette("#7A5C8C", 3)[0]).toBe("#904377");
  });

  it("is a rotation: the order after index 0 follows the fixed palette order", () => {
    const p = seriesPalette("#A6473F", 8);
    const start = SERIES_COLORS.indexOf(p[0] as (typeof SERIES_COLORS)[number]);
    p.forEach((c, i) => expect(c).toBe(SERIES_COLORS[(start + i) % 8]));
  });

  it("wraps past 8 and tolerates a bad base / odd counts", () => {
    expect(seriesPalette("#A6473F", 10)).toHaveLength(10);
    expect(seriesPalette("not a color", 2)).toEqual([SERIES_COLORS[0], SERIES_COLORS[1]]);
    expect(seriesPalette("#A6473F", -3)).toEqual([]);
    expect(seriesPalette("#A6473F", 2.9)).toHaveLength(2);
  });

  it("deterministic", () => {
    expect(seriesPalette("#3D6B8C", 6)).toEqual(seriesPalette("#3D6B8C", 6));
  });
});

describe("seriesColorMap", () => {
  it("gives the total series the fixed neutral and the others the rotated palette in order", () => {
    const map = seriesColorMap(["Passengers Total", "Embark", "Disembark"], "#3D6B8C", "Passengers Total");
    expect(map["Passengers Total"]).toBe(TOTAL_SERIES_COLOR);
    const p = seriesPalette("#3D6B8C", 2);
    expect(map.Embark).toBe(p[0]);
    expect(map.Disembark).toBe(p[1]);
  });
  it("without a total every series gets a palette color", () => {
    const map = seriesColorMap(["A", "B"], "#3D6B8C");
    expect(Object.values(map)).toEqual(seriesPalette("#3D6B8C", 2));
  });
});
