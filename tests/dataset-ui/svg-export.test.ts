import { describe, expect, it } from "vitest";
import { EXPORT_FONT_FAMILY, inlineCssVars, wrapWords } from "@/lib/svg-export";

describe("inlineCssVars", () => {
  const vars: Record<string, string> = { "--ink": " #17262A ", "--line-light": "#e3dcca" };
  const lookup = (name: string) => vars[name];

  it("replaces every var() in attributes and inline styles", () => {
    const svg = '<text fill="var(--ink)" style="stroke: var(--line-light); color: var( --ink )">x</text>';
    expect(inlineCssVars(svg, lookup)).toBe('<text fill="#17262A" style="stroke: #e3dcca; color: #17262A">x</text>');
  });

  it("falls back to the declared fallback, then to black", () => {
    expect(inlineCssVars('fill="var(--missing, #123456)"', lookup)).toBe('fill="#123456"');
    expect(inlineCssVars('fill="var(--missing)"', lookup)).toBe('fill="#000000"');
  });

  it("treats an empty custom property as missing", () => {
    expect(inlineCssVars('fill="var(--ink)"', () => "  ")).toBe('fill="#000000"');
  });

  it("leaves markup without variables alone", () => {
    const svg = '<path d="M0 0L10 10" stroke="#fff"/>';
    expect(inlineCssVars(svg, lookup)).toBe(svg);
  });

  it("exports a font stack with a system fallback", () => {
    expect(EXPORT_FONT_FAMILY).toContain("sans-serif");
  });
});

describe("wrapWords", () => {
  const measure = (s: string) => s.length;

  it("wraps greedily at the width", () => {
    expect(wrapWords("aaa bbb ccc ddd", 7, measure)).toEqual(["aaa bbb", "ccc ddd"]);
  });

  it("keeps a word wider than the budget whole on its own line", () => {
    expect(wrapWords("a bbbbbbbbbb c", 5, measure)).toEqual(["a", "bbbbbbbbbb", "c"]);
  });

  it("limits the lines and ellipsizes the last one", () => {
    const lines = wrapWords("one two three four five six seven", 9, measure, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
  });

  it("returns nothing for empty text", () => {
    expect(wrapWords("   ", 10, measure)).toEqual([]);
  });
});
