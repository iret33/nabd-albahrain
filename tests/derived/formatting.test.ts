import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NumberLatin } from "@/components/number-latin";
import { buildHeadlineSentence, formatChangePercent, formatDisplayNumber, formatSummaryNumber, type Headline } from "@/lib/headline";

// vitest compiles the components with the classic JSX transform, which needs React in scope.
(globalThis as { React?: typeof React }).React = React;

/** r3-12: ONE number convention and ONE percent-change convention across the sentence, the home card, the stats tiles and the tooltip. */

const render = (props: Parameters<typeof NumberLatin>[0]) => renderToStaticMarkup(createElement(NumberLatin, props)).replace(/<[^>]+>/g, "");

describe("formatDisplayNumber / formatSummaryNumber: one rule", () => {
  it.each([
    [12.3456, "12.35"],
    [112.37, "112.4"],
    [99.994, "99.99"],
    [999.96, "1,000"],
    [1234.5, "1,235"],
    [1497470.61, "1,497,471"],
    [4.4, "4.4"],
    [0.0042, "0.0042"],
    [-0.001, "-0.001"],
    [0.456, "0.46"],
    [0, "0"],
    [-0, "0"],
    [-12.3456, "-12.35"],
    [100, "100"],
  ])("%s -> %s (identical in the sentence and in the UI)", (n, expected) => {
    expect(formatSummaryNumber(n)).toBe(expected);
    expect(formatDisplayNumber(n)).toBe(expected);
  });

  it("they differ only for a missing value: a sentence never prints an em dash, the UI never prints a fake 0", () => {
    for (const n of [Number.NaN, Infinity, -Infinity]) {
      expect(formatSummaryNumber(n)).toBe("0");
      expect(formatDisplayNumber(n)).toBe("—");
    }
    expect(formatDisplayNumber(null)).toBe("—");
    expect(formatDisplayNumber(undefined)).toBe("—");
  });

  it("the home card and the stats tile (NumberLatin with no explicit cap) print the same digits as the sentence", () => {
    for (const n of [12.3456, 112.37, 1234.5, 4.4, 0.0042, -0.001, 3.6, 18620, 99.994]) {
      expect(render({ value: n }), String(n)).toBe(formatSummaryNumber(n));
    }
  });

  it("an explicit cap is the caller's choice and keeps its precision (the exact-data table asks for 4)", () => {
    expect(render({ value: 112.37, maximumFractionDigits: 2 })).toBe("112.37");
    expect(render({ value: 1234.5678, maximumFractionDigits: 4 })).toBe("1,234.5678");
  });
});

describe("NumberLatin never hides a real value as zero", () => {
  it.each([
    [0.0042, 2, "0.0042"], // Intl rounds to "0"
    [-0.001, 2, "-0.001"], // Intl prints "-0"
    [-0, undefined, "0"],
    [-0.0004, 0, "-0.0004"],
  ])("%s with max %s -> %s", (value, max, expected) => {
    expect(render({ value, maximumFractionDigits: max })).toBe(expected);
  });

  it("the table keeps full precision when it asks for it; years stay ungrouped; signed, compact, strings, NaN as before", () => {
    expect(render({ value: 12.3456, maximumFractionDigits: 4 })).toBe("12.3456");
    expect(render({ value: 2020, grouped: false })).toBe("2020");
    expect(render({ value: 5, signed: true })).toBe("+5");
    expect(render({ value: 1512345, compact: true })).toBe("1.5M");
    expect(render({ value: "12.5%" })).toBe("12.5%");
    expect(render({ value: Number.NaN })).toBe("—");
  });
});

describe("formatChangePercent: one rounding, one sign convention", () => {
  it.each([
    [2.57, "up", "+2.6%"],
    [-7.69, "down", "-7.7%"],
    [0.25, "up", "+0.3%"],
    [-0.25, "down", "-0.3%"], // the same digit as +0.25 (a Math.round(pct * 10) / 10 gave -0.2)
    [0.04, "flat", "0.0%"],
    [-0.04, "flat", "0.0%"], // never "-0.0%" and never "+0.0%"
    [0.049, "flat", "0.0%"],
    [0.05, "up", "+0.1%"],
    [0, "flat", "0.0%"],
    [-0, "flat", "0.0%"],
    [1234.56, "up", "+1,234.6%"],
    [Number.NaN, "flat", "0.0%"],
  ])("%s -> %s %s", (pct, direction, text) => {
    const out = formatChangePercent(pct);
    expect(out.direction).toBe(direction);
    expect(out.text).toBe(text);
  });

  it("the arrow direction and the text can never disagree (both derive from the rounded magnitude)", () => {
    for (let i = -300; i <= 300; i++) {
      const pct = i / 1000;
      const { direction, text } = formatChangePercent(pct);
      if (direction === "flat") expect(text).toBe("0.0%");
      else expect(text.startsWith(direction === "up" ? "+" : "-")).toBe(true);
    }
  });

  it("the lead sentence uses it", () => {
    const base: Headline = { value: 100, period: "2025", prevValue: 99, prevPeriod: "2024", changePct: 2.57, basis: "single" };
    for (const changePct of [2.57, -7.69, 0.04, -0.04, -0.25, 1234.56]) {
      const sentence = buildHeadlineSentence({ headline: { ...base, changePct }, grain: "year" });
      expect(sentence).toContain(`بتغير ${formatChangePercent(changePct).text} عن الفترة السابقة`);
    }
  });

  it("a provisional headline says so right after its period", () => {
    const h: Headline = { value: 13000, period: "2024", prevValue: null, prevPeriod: null, changePct: null, basis: "single", provisional: true };
    expect(buildHeadlineSentence({ headline: h, grain: "year" })).toBe("آخر قيمة مسجلة: 13,000 في 2024 (بيانات أولية).");
    expect(buildHeadlineSentence({ headline: h, grain: "year", partialPeriod: "2025" })).toBe(
      "آخر قيمة مسجلة لفترة مكتملة: 13,000 في 2024 (بيانات أولية)، علماً بأن بيانات 2025 غير مكتملة.",
    );
  });
});
