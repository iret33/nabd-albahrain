import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { groupLtrRuns, splitNumericRuns } from "@/lib/numeric-tokens";
import { ArabicTextWithNumbers } from "@/components/arabic-text-with-numbers";

// vitest compiles the components with the classic JSX transform, which needs React in scope.
(globalThis as { React?: typeof React }).React = React;

const numeric = (text: string) => splitNumericRuns(text).filter((r) => r.numeric).map((r) => r.text);
const html = (text: string) => renderToStaticMarkup(createElement(ArabicTextWithNumbers, { text }));

describe("r3-06: ranges stay ONE left-to-right run (two adjacent isolates render back to front)", () => {
  it("the reviewer's sentence: '25-29' is one run (it was '25' + '-29', shown as '-2925')", () => {
    expect(numeric("الفئة الأعلى: «25-29» بقيمة 12,345 من أصل 18 فئة.")).toEqual(["25-29", "12,345", "18"]);
  });

  it.each([
    ["5-9", ["5-9"]],
    ["15-24", ["15-24"]],
    ["100-199", ["100-199"]],
    ["0-4", ["0-4"]],
    ["1-2-3", ["1-2-3"]],
    ["0.5-1.5", ["0.5-1.5"]],
    ["1,000-2,000", ["1,000-2,000"]],
    ["25 – 29", ["25 – 29"]],
    ["25 - 29", ["25 - 29"]],
    ["25–29", ["25–29"]],
    ["10-20%", ["10-20%"]],
    ["10%-20%", ["10%-20%"]],
    ["15-03-2024", ["15-03-2024"]],
    ["2025-3-5", ["2025-3-5"]],
    // unchanged shapes
    ["2026-03-15", ["2026-03-15"]],
    ["2026-03", ["2026-03"]],
    ["2020-2025", ["2020-2025"]],
    ["-49.5%", ["-49.5%"]],
    ["+2.3%", ["+2.3%"]],
    ["3.6 ٪", ["3.6 ٪"]],
    ["1500.", ["1500"]],
  ])("%s", (text, expected) => {
    expect(numeric(text)).toEqual(expected);
  });

  it("a signed number after a year stays separate ('2025 -3.5%'): the range separator is symmetric", () => {
    expect(numeric("بتغير 2025 -3.5%")).toEqual(["2025", "-3.5%"]);
  });

  it("a trailing '+' is outside the run ('65+')", () => {
    expect(numeric("65+ سنة")).toEqual(["65"]);
  });

  it("property: no corpus string ever yields two numeric runs side by side", () => {
    const corpus = [
      "1-2-3", "2020-2025-2026", "5-9 و 10-14 و 15-19", "10%-20%-30%", "25 – 29 – 33", "1,000-2,000-3,000", "0-4 5-9", "-5-3", "3--4", "7 -- 8",
      "٢٠٢٠", "2026-03-15-20", "12-", "-12", "1 - 2 - 3 - 4", "2020 - 2025", "COVID-19 2021",
    ];
    for (const text of corpus) {
      const runs = splitNumericRuns(text);
      for (let i = 1; i < runs.length; i++) expect(runs[i].numeric && runs[i - 1].numeric, `${text} -> ${JSON.stringify(runs)}`).toBe(false);
      expect(runs.map((r) => r.text).join("")).toBe(text);
    }
  });

  it("existing guarantees: only a 4-digit-year range or ISO keeps a dash whole elsewhere, sentence-final period is not swallowed", () => {
    expect(splitNumericRuns("بقيمة 1500.").map((r) => r.text)).toEqual(["بقيمة ", "1500", "."]);
    expect(numeric("a - b")).toEqual([]);
  });
});

describe("R5-08: a Latin word next to a number is isolated TOGETHER with it", () => {
  const groups = (text: string) => groupLtrRuns(text).map((g) => (g.ltr ? `[${g.text}]` : g.text));

  it.each([
    ["مؤشرات Health 2000", ["مؤشرات ", "[Health 2000]"]],
    ["مؤشر أسعار المستهلك CPI 2018 السنوي", ["مؤشر أسعار المستهلك ", "[CPI 2018]", " السنوي"]],
    ["تأثير COVID-19 2021", ["تأثير ", "[COVID-19 2021]"]],
    ["الفئة الأعلى: «Region 2» بقيمة 5.", ["الفئة الأعلى: «", "[Region 2]", "» بقيمة ", "[5]", "."]],
    ["المرحلة Phase 2", ["المرحلة ", "[Phase 2]"]],
    ["الفئة «Block 316»", ["الفئة «", "[Block 316]", "»"]],
    ["Health 2020-2025 نتائج", ["[Health 2020-2025]", " نتائج"]],
    ["2020 2025", ["[2020 2025]"]],
    ["آخر قيمة مسجلة: 1,200 km2 في 2025", ["آخر قيمة مسجلة: ", "[1,200 km2]", " في ", "[2025]"]],
    ["الربع Q1 2025", ["الربع ", "[Q1 2025]"]],
  ])("%s", (text, expected) => {
    expect(groups(text)).toEqual(expected);
  });

  it("a Latin phrase with no number, Arabic punctuation, brackets and sentence-final dots stay outside the group", () => {
    expect(groups("Ministry of Health")).toEqual(["Ministry of Health"]);
    expect(groups("مؤشرات Health، 2000")).toEqual(["مؤشرات Health، ", "[2000]"]);
    expect(groups("CPI (2018) السنوي")).toEqual(["CPI (", "[2018]", ") السنوي"]);
    expect(groups("بقيمة Health 5.")).toEqual(["بقيمة ", "[Health 5]", "."]);
  });

  it("round-trips and keeps a pure-number group flagged (tabular figures only apply to numbers)", () => {
    for (const text of ["مؤشرات Health 2000", "2020 2025", "آخر قيمة مسجلة: 42,403 في 2025، بتغير -49.5% عن الفترة السابقة.", "", " ", "abc", "٢٠٢٠"]) {
      expect(groupLtrRuns(text).map((g) => g.text).join("")).toBe(text);
    }
    const g = groupLtrRuns("مؤشرات Health 2000 و 2020 2025");
    expect(g.filter((x) => x.ltr).map((x) => x.digitsOnly)).toEqual([false, true]);
  });

  it("markup: a mixed group is ONE dir=ltr isolate with tabular figures only on its numbers; a pure number keeps the old markup", () => {
    expect(html("مؤشرات Health 2000")).toBe('مؤشرات <span dir="ltr" lang="en">Health <span class="tabular-figures">2000</span></span>');
    expect(html("في 2025")).toBe('في <span dir="ltr" class="tabular-figures">2025</span>');
    expect(html("الفئة الأعلى: «25-29» بقيمة 12,345")).toBe(
      'الفئة الأعلى: «<span dir="ltr" class="tabular-figures">25-29</span>» بقيمة <span dir="ltr" class="tabular-figures">12,345</span>',
    );
    expect(html("")).toBe("");
  });
});
