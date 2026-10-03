import { describe, expect, it, vi } from "vitest";
import { derive, field, years, months, type Rec } from "./helpers";
import { chartCaptionParts } from "@/lib/chart-data";
import { computeDerivedFields, type VizConfig } from "@/lib/sync/derived";
import { parseTemporalValue, createTemporalParser } from "@/lib/temporal";

/** Group F3 regressions r3-07 (provisional / unreadable periods), r3-08 (calendar completeness), r3-15 (robustness). */

type Area = Extract<VizConfig, { type: "area" }>;
type Multi = Extract<VizConfig, { type: "multi-line" }>;

const GENERIC_SENTENCE = /^(?:لا )?تحتوي مجموعة البيانات على /;

// ---------------------------------------------------------------------------
// r3-07
// ---------------------------------------------------------------------------
describe("r3-07: a provisional newest period is charted, flagged, and quoted as provisional", () => {
  const births = (labels: string[], valueOf = (i: number) => 12000 + i * 100): Rec[] => labels.map((l, i) => ({ year: l, births: valueOf(i) }));
  const fields = [field("year", "text", "Year"), field("births", "int", "Births")];
  const ten = years(2014, 2023).map(String);

  it.each(["2024*", "2024 (p)", "2024p", "2024(p)", "2024 *", "2024†", "2024e", "2024 est.", "2024 مؤقت"])(
    "%j is the 2024 period, not a dropped row: headline 2024 is flagged provisional",
    async (label) => {
      const { viz, rows, summaryAr } = await derive(births([...ten, label]), fields);
      const v = viz as Area;
      expect(v.type).toBe("area");
      expect(rows[rows.length - 1]).toEqual({ period: "2024", value: 13000 });
      expect(v.headline).toMatchObject({ period: "2024", value: 13000, provisional: true });
      expect(v.provisionalPeriods).toEqual(["2024"]);
      expect(summaryAr).toBe("آخر قيمة مسجلة: 13,000 في 2024 (بيانات أولية)، بتغير +0.8% عن الفترة السابقة.");
      expect(chartCaptionParts(v).notes).toContain("بيانات 2024 أولية");
    },
  );

  it("'2024.0' is a plain year (a spreadsheet's integer), not provisional", async () => {
    const { viz, rows } = await derive(births([...ten, "2024.0"]), fields);
    expect((viz as Area).provisionalPeriods).toBeUndefined();
    expect((viz as Area).headline).toMatchObject({ period: "2024" });
    expect(rows[rows.length - 1].period).toBe("2024");
  });

  it("a SHORT table (5 years + '2024*') stays a temporal chart: it used to degrade to a ranking of years", async () => {
    const { viz, summaryAr } = await derive(births([...years(2019, 2023).map(String), "2024*"]), fields);
    expect(viz.type).toBe("area");
    expect(summaryAr).toContain("في 2024 (بيانات أولية)");
    expect(summaryAr).not.toContain("الفئة الأعلى");
  });

  it("year x category with a provisional last year keeps the temporal series", async () => {
    const records: Rec[] = [];
    for (const y of [...years(2016, 2023).map(String), "2024*"]) for (const c of ["A", "B", "C"]) records.push({ year: y, cat: c, births: 100 });
    const { viz, rows } = await derive(records, [field("year", "text", "Year"), field("cat", "text", "Category"), field("births", "int", "Births")]);
    const v = viz as Multi;
    expect(v.type).toBe("multi-line");
    expect(rows[rows.length - 1]).toMatchObject({ period: "2024", A: 100, B: 100, C: 100 });
    expect(v.provisionalPeriods).toEqual(["2024"]);
    expect(v.headline).toMatchObject({ period: "2024", value: 300, provisional: true });
  });

  it("month names after a year ('2024 Mar') keep month grain (a generic 3-letter marker rule would have made them years)", async () => {
    const recs: Rec[] = ["2024 Jan", "2024 Feb", "2024 Mar", "2024 Apr"].map((l, i) => ({ date: l, births: 10 + i }));
    const { viz, rows } = await derive(recs, [field("date", "text", "Date"), field("births", "int", "Births")]);
    expect((viz as Area).grain).toBe("month");
    expect(rows.map((r) => r.period)).toEqual(["2024-01", "2024-02", "2024-03", "2024-04"]);
    expect((viz as Area).provisionalPeriods).toBeUndefined();
  });

  it("'2024' and '2024*' rows for the same period: the final value wins, the provisional row is not added on top", async () => {
    const recs = births([...ten, "2024", "2024*"]);
    recs[recs.length - 1].births = 9999; // a preliminary figure next to the restated final one
    const { viz, rows } = await derive(recs, fields);
    const v = viz as Area;
    expect(rows[rows.length - 1]).toEqual({ period: "2024", value: 13000 }); // not 13000 + 9999
    expect(v.supersededProvisionalRows).toBe(1);
    expect(v.provisionalPeriods).toBeUndefined();
    expect(chartCaptionParts(v).notes.join(" ")).toContain("صفوف أولية استُبعدت");
  });

  it("fiscal / academic year labels chart at year grain (FY2024, 2023/24, 2023/2024)", async () => {
    for (const mk of [(y: number) => `FY${y}`, (y: number) => `${y}/${String(y + 1).slice(2)}`, (y: number) => `${y}/${y + 1}`]) {
      const { viz, rows } = await derive(years(2015, 2024).map((y, i) => ({ year: mk(y), births: 100 + i })), fields);
      expect((viz as Area).grain).toBe("year");
      expect(rows[0].period).toBe("2015");
      expect(rows[rows.length - 1].period).toBe("2024");
    }
  });

  it("rows whose period cannot be read are COUNTED (and stated in the caption), null-measure rows are not", async () => {
    const recs: Rec[] = [
      ...years(1980, 2023).map((y) => ({ year: String(y), births: 100 })),
      { year: "Q1 2024", births: 5 },
      { year: "Q2 2024", births: 6 },
      { year: "Q3 2024", births: null }, // no value: not a dropped PERIOD
    ];
    const { viz } = await derive(recs, [field("year", "text", "Year"), field("births", "int", "Births")]);
    const v = viz as Area;
    expect(v.droppedPeriodRows).toBe(2);
    expect(chartCaptionParts(v).notes.join(" ")).toContain("صفوف استُبعدت لأن تاريخها غير مفهوم: 2");
  });

  it("a clean table carries none of the new optional fields", async () => {
    const { viz } = await derive(births(ten), fields);
    const v = viz as Area;
    for (const k of ["provisionalPeriods", "droppedPeriodRows", "supersededProvisionalRows", "headlineWithheld"] as const) expect(v[k], k).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// r3-08
// ---------------------------------------------------------------------------
describe("r3-08: a month cut at day 24-29 is partial, whatever its row count says", () => {
  const f = [field("date", "date", "Date"), field("cnt", "int", "Count")];
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  /** One row of 1000 per day from `start` through `end` (inclusive). */
  function daily(start: string, end: string, weekdaysOnly = false, stepDays = 1): Rec[] {
    const out: Rec[] = [];
    const last = Date.parse(`${end}T00:00:00Z`);
    for (let t = Date.parse(`${start}T00:00:00Z`); t <= last; t += stepDays * 86_400_000) {
      const d = new Date(t);
      if (weekdaysOnly && (d.getUTCDay() === 0 || d.getUTCDay() === 6)) continue;
      out.push({ date: iso(d), cnt: 1000 });
    }
    return out;
  }

  it.each([5, 15, 22, 23, 24, 25, 28, 29])("daily rows through Sep %i: the last month is partial and the headline is August", async (day) => {
    const { viz, summaryAr } = await derive(daily("2025-01-01", `2025-09-${String(day).padStart(2, "0")}`), f);
    const v = viz as Area;
    expect(v.lastPeriodPartial, `Sep ${day}`).toBe(true);
    expect(v.headline).toMatchObject({ period: "2025-08", value: 31000, changePct: null });
    expect(summaryAr).toContain("غير مكتملة");
  });

  it("through Sep 30 the month is complete and keeps its (tiny) change", async () => {
    const { viz } = await derive(daily("2025-01-01", "2025-09-30"), f);
    const v = viz as Area;
    expect(v.lastPeriodPartial).toBe(false);
    expect(v.headline).toMatchObject({ period: "2025-09", value: 30000 });
  });

  it("business-day data: a complete month ending on a weekend is NOT flagged, one cut mid-month is", async () => {
    const complete = await derive(daily("2025-01-01", "2025-08-29", true), f); // Aug 31 is a Sunday
    expect((complete.viz as Area).lastPeriodPartial).toBe(false);
    expect((complete.viz as Area).headline?.period).toBe("2025-08");
    const cut = await derive(daily("2025-01-01", "2025-08-20", true), f);
    expect((cut.viz as Area).lastPeriodPartial).toBe(true);
  });

  it("weekly data with 3 of the last month's 4 weeks is partial (was a fake -25%)", async () => {
    const complete = await derive(daily("2025-01-06", "2025-09-29", false, 7), f); // Mondays, last one Sep 29
    expect((complete.viz as Area).lastPeriodPartial).toBe(false);
    const cut = await derive(daily("2025-01-06", "2025-09-15", false, 7), f);
    expect((cut.viz as Area).lastPeriodPartial).toBe(true);
    expect((cut.viz as Area).headline?.period).toBe("2025-08");
  });

  it("a short daily table (only 3 months, which the count rule cannot judge) is judged by the calendar", async () => {
    const { viz } = await derive(daily("2025-07-01", "2025-09-10"), f);
    expect((viz as Area).lastPeriodPartial).toBe(true);
    expect((viz as Area).headline?.period).toBe("2025-08");
    expect((await derive(daily("2025-07-01", "2025-09-30"), f)).viz as Area).toHaveProperty("lastPeriodPartial", false);
  });

  it("February uses the real number of days (non-leap and leap)", async () => {
    expect(((await derive(daily("2024-11-01", "2025-02-28"), f)).viz as Area).lastPeriodPartial).toBe(false);
    expect(((await derive(daily("2023-11-01", "2024-02-29"), f)).viz as Area).lastPeriodPartial).toBe(false);
    expect(((await derive(daily("2023-11-01", "2024-02-28"), f)).viz as Area).lastPeriodPartial).toBe(true); // one day of a leap February missing
  });

  it("first-of-month dated monthly data (one row per month) is not touched: it never was partial", async () => {
    const recs: Rec[] = months(2024, 2025).slice(0, 21).map((ym) => ({ date: `${ym}-01`, cnt: 1000 }));
    const { viz } = await derive(recs, f);
    expect((viz as Area).lastPeriodPartial).toBe(false);
    expect((viz as Area).headline?.period).toBe("2025-09");
  });

  it("irregular event-log data (no regular cadence) falls back to the count rule", async () => {
    const recs: Rec[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (const ym of months(2025, 2025).slice(0, 9)) for (let k = 0; k < 20; k++) recs.push({ date: `${ym}-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`, cnt: 1 });
    const { viz } = await derive(recs, f);
    expect((viz as Area).lastPeriodPartial).toBe(false);
  });

  it("a day-less month column is never judged by the calendar", async () => {
    const recs: Rec[] = [];
    for (const y of [2024, 2025]) for (let m = 1; m <= 12; m++) if (y * 100 + m <= 202509) for (let k = 0; k < 10; k++) recs.push({ year: String(y), month: String(m), cnt: 1 });
    const { viz } = await derive(recs, [field("year", "text", "Year"), field("month", "text", "Month"), field("cnt", "int", "Count")]);
    expect((viz as Area).lastPeriodPartial).toBe(false);
  });

  it("viz-overrides can pin the newest period: 'complete' never hides it, 'partial' always does", async () => {
    const cut = daily("2025-01-01", "2025-09-24");
    expect(((await derive(cut, f, { lastPeriod: "complete" })).viz as Area).lastPeriodPartial).toBe(false);
    const complete = daily("2025-01-01", "2025-09-30");
    const pinned = await derive(complete, f, { lastPeriod: "partial" });
    expect((pinned.viz as Area).lastPeriodPartial).toBe(true);
    expect((pinned.viz as Area).headline?.period).toBe("2025-08");
  });

  it("means are never flagged (a short month does not distort an average)", async () => {
    const recs = daily("2025-01-01", "2025-09-24").map((r) => ({ ...r, rate: 4 }));
    const { viz } = await derive(recs, [field("date", "date", "Date"), field("rate", "double", "Unemployment Rate")]);
    expect((viz as Area).lastPeriodPartial).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// r3-15
// ---------------------------------------------------------------------------
describe("r3-15: junk cells and malformed rows cannot freeze or disable derivation", () => {
  it("a 100,000-character separator run parses in milliseconds (it took 10 s)", () => {
    for (const junk of [".".repeat(100_000), "2020" + ".".repeat(50_000) + "a\nb", "x" + "-".repeat(80_000) + "2020"]) {
      const t = Date.now();
      expect(parseTemporalValue(junk)).toBeNull();
      expect(Date.now() - t).toBeLessThan(200);
    }
  });

  it("padded real dates still parse after the length cap; an oversized value is not cached", () => {
    expect(parseTemporalValue("   2020-01-01   ")).toEqual({ year: 2020, month: 1, day: 1 });
    expect(parseTemporalValue("2020-01-01T10:00:00+03:00")).toMatchObject({ year: 2020, month: 1, day: 1 });
    const parse = createTemporalParser(4);
    expect(parse("y".repeat(10_000))).toBeNull();
    expect(parse("2020")).toEqual({ year: 2020, month: null, day: null });
  });

  it("one 40,000-dot cell among 1,000 real dates does not stall derivation", async () => {
    const recs: Rec[] = [];
    for (let i = 0; i < 1000; i++) recs.push({ date: `2020-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`, cnt: 1 });
    recs.push({ date: ".".repeat(40_000), cnt: 1 });
    const t = Date.now();
    const out = await derive(recs, [field("date", "text", "Date"), field("cnt", "int", "Count")]);
    expect(Date.now() - t).toBeLessThan(1500);
    expect(out.viz.type).toBe("area");
  });

  it("a null / non-object element in records no longer disables all derivation (one aggregate warning)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const recs = [...years(2014, 2023).map((y) => ({ year: String(y), v: y })), null, 5, ["x"], "str"] as unknown as Rec[];
      const out = await computeDerivedFields("t", recs, [field("year", "text", "Year"), field("v", "int", "V")], { override: null });
      expect((out.vizConfig as Area).type).toBe("area");
      expect(out.statsJson).not.toBeNull();
      expect(out.summaryAr).toMatch(/^آخر قيمة مسجلة/);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("4 record(s) are not objects");
    } finally {
      warn.mockRestore();
    }
  });

  it("a table made only of junk rows still returns the generic sentence, never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = await computeDerivedFields("t", [null, null] as unknown as Rec[], [field("a", "text", "A")], { override: null });
      expect(out.summaryAr).toMatch(GENERIC_SENTENCE);
    } finally {
      warn.mockRestore();
    }
  });
});
