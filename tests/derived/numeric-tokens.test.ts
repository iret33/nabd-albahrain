import { describe, expect, it } from "vitest";
import { splitNumericRuns } from "@/lib/numeric-tokens";

const numeric = (text: string) => splitNumericRuns(text).filter((r) => r.numeric).map((r) => r.text);

describe("splitNumericRuns (ArabicTextWithNumbers tokenization)", () => {
  it("the audit's sentence: month period, grouped number and signed percent stay whole", () => {
    // Old pattern gave ["1512345", "2026", "-03", "-49.5%"]: '2026' + '-03' were adjacent LTR isolates and rendered '-032026'.
    expect(numeric("آخر قيمة مسجلة: 1,512,345 في 2026-03، بتغير -49.5% عن الفترة السابقة")).toEqual(["1,512,345", "2026-03", "-49.5%"]);
    expect(numeric("آخر قيمة مسجلة: 1512345 في 2026-03، بتغير -49.5% عن الفترة السابقة")).toEqual(["1512345", "2026-03", "-49.5%"]);
  });

  it.each([
    ["2026-03", ["2026-03"]],
    ["2026-03-15", ["2026-03-15"]],
    ["2020-2025", ["2020-2025"]],
    ["1,512,345", ["1,512,345"]],
    ["1,512,345.67", ["1,512,345.67"]],
    ["-49.5%", ["-49.5%"]],
    ["+2.3%", ["+2.3%"]],
    ["3.6 %", ["3.6 %"]],
    ["3.6 ٪", ["3.6 ٪"]],
    ["42403", ["42403"]],
    ["-5", ["-5"]],
    ["0.0042", ["0.0042"]],
  ])("%s", (text, expected) => {
    expect(numeric(text)).toEqual(expected);
  });

  it("does not swallow a sentence-final period", () => {
    expect(numeric("الفئة الأعلى: «Capital» بقيمة 1500.")).toEqual(["1500"]);
    expect(splitNumericRuns("بقيمة 1500.").map((r) => r.text)).toEqual(["بقيمة ", "1500", "."]);
  });

  it("digits glued to Latin letters stay with their word (unit 'km2', 'Q1')", () => {
    expect(numeric("آخر قيمة مسجلة: 1,200 km2 في 2025")).toEqual(["1,200", "2025"]);
    expect(numeric("الربع Q1 2025")).toEqual(["2025"]);
  });

  it("month names around a year: only the year is numeric", () => {
    expect(numeric("في مارس 2026، بتغير +2.6% عن الفترة السابقة.")).toEqual(["2026", "+2.6%"]);
  });

  it("round-trips: joining the runs restores the text", () => {
    const text = "آخر قيمة مسجلة لفترة مكتملة: 42,403 في 2025، علماً بأن بيانات 2026 غير مكتملة.";
    expect(splitNumericRuns(text).map((r) => r.text).join("")).toBe(text);
    expect(numeric(text)).toEqual(["42,403", "2025", "2026"]);
  });

  it("no digits, empty and weird input", () => {
    expect(splitNumericRuns("")).toEqual([]);
    expect(splitNumericRuns("لا أرقام هنا")).toEqual([{ text: "لا أرقام هنا", numeric: false }]);
    expect(numeric("a - b")).toEqual([]);
  });

  it("the regex is stateless across calls (no /g lastIndex leak)", () => {
    for (let i = 0; i < 3; i++) expect(numeric("في 2026-03")).toEqual(["2026-03"]);
  });
});
