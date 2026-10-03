import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { render } from "./render";
import { Bidi, MixedBidiText } from "@/components/bidi";
import { splitBidiRuns } from "@/lib/text";

const ltr = (text: string) => splitBidiRuns(text).filter((r) => r.ltr).map((r) => r.text);

describe("splitBidiRuns (R5-08: one LTR group per adjacent Latin words and numbers)", () => {
  it("the audit's title: 'Health 2000' is ONE isolate, not a number next to a loose word", () => {
    // Before: only '2000' was isolated, the word stayed in the RTL flow and the pair displayed as '2000 Health'.
    expect(ltr("مؤشرات Health 2000")).toEqual(["Health 2000"]);
    expect(splitBidiRuns("مؤشرات Health 2000")).toEqual([
      { text: "مؤشرات ", ltr: false },
      { text: "Health 2000", ltr: true },
    ]);
  });

  it.each([
    ["مؤشر أسعار المستهلك CPI 2018 السنوي", ["CPI 2018"]],
    ["تأثير COVID-19 2021", ["COVID-19 2021"]],
    ["المرحلة Phase 2 من المشروع", ["Phase 2"]],
    ["الفئة الأعلى: «Region 2» بقيمة 1,500.", ["Region 2", "1,500"]],
    ["المؤشر Health 2020-2025 للفترة", ["Health 2020-2025"]],
    ["من 2020 2025 فقط", ["2020 2025"]],
    ["الربع Q1 2025", ["Q1 2025"]],
    ["الترتيب 2nd بين الدول", ["2nd"]],
    ["مساحة 1,200 km2 تقريبًا", ["1,200 km2"]],
    ["بتغير -49.5% عن الفترة", ["-49.5%"]],
    ["في 2026-03، بتغير +2.6% عن", ["2026-03", "+2.6%"]],
  ])("%s", (text, groups) => {
    expect(ltr(text)).toEqual(groups);
  });

  it("keeps spaces, sentence-final dots, Arabic punctuation and brackets OUTSIDE the group", () => {
    expect(splitBidiRuns("بقيمة 1500.").map((r) => r.text)).toEqual(["بقيمة ", "1500", "."]);
    expect(ltr("المؤشر (CPI 2018) السنوي")).toEqual(["CPI 2018"]);
    expect(ltr("المؤشر CPI، 2018")).toEqual(["CPI", "2018"]);
    expect(ltr("المؤشر CPI. 2018")).toEqual(["CPI", "2018"]);
    for (const group of ltr("«Health 2000» و(Phase 2) و CPI 2018 .")) {
      expect(group).toMatch(/^[A-Za-z0-9]/);
      expect(group).toMatch(/[A-Za-z0-9%]$/);
    }
  });

  it("does not merge groups that an Arabic word separates", () => {
    expect(ltr("Health والاقتصاد Education")).toEqual(["Health", "Education"]);
  });

  it("round-trips: joining the runs restores the text", () => {
    for (const text of [
      "مؤشرات Health 2000",
      "آخر قيمة مسجلة: 1,512,345 في 2026-03، بتغير -49.5% عن الفترة السابقة.",
      "الفئة الأعلى: «Region 2» بقيمة 650,000 من أصل 4 فئات.",
      "  ",
      "نص عربي فقط",
      "COVID-19",
    ]) {
      expect(splitBidiRuns(text).map((r) => r.text).join("")).toBe(text);
    }
  });

  it("copes with empty and hostile input", () => {
    expect(splitBidiRuns("")).toEqual([]);
    expect(splitBidiRuns("a-".repeat(5000)).map((r) => r.text).join("")).toBe("a-".repeat(5000));
    expect(ltr("١٢٣ ثم ٤٥٦")).toEqual([]);
  });
});

describe("MixedBidiText / Bidi markup", () => {
  it("wraps the whole phrase in one dir=ltr span and puts tabular digits on the number only", () => {
    const html = render(createElement(MixedBidiText, { text: "مؤشرات Health 2000" }));
    expect(html).toBe('مؤشرات <span dir="ltr">Health <span class="tabular-figures">2000</span></span>');
  });

  it("keeps a purely numeric group as one tabular span, as before", () => {
    expect(render(createElement(MixedBidiText, { text: "في 2026-03" }))).toBe('في <span dir="ltr" class="tabular-figures">2026-03</span>');
  });

  it("is used by Bidi for Arabic text, and Latin-only text stays untouched", () => {
    expect(render(createElement(Bidi, { text: "مؤشرات Health 2000" }))).toContain('<span dir="ltr">Health ');
    expect(render(createElement(Bidi, { text: "Health 2000 (Final)" }))).toBe('<bdi dir="auto" lang="en">Health 2000 (Final)</bdi>');
  });
});
