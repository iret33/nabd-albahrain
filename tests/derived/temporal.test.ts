import { describe, expect, it } from "vitest";
import {
  ARABIC_MONTH_NAMES,
  createTemporalParser,
  isMonthOnlyName,
  isQuarterOnlyName,
  looksTemporalName,
  looksYearName,
  parseMonthPart,
  parseTemporalValue,
} from "@/lib/temporal";

const ym = (year: number, month: number | null, day: number | null = null) => ({ year, month, day });

describe("parseTemporalValue: accepted shapes", () => {
  it.each([
    ["2020", ym(2020, null)],
    [2020, ym(2020, null)],
    ["1900", ym(1900, null)],
    ["2100", ym(2100, null)],
    ["2020-03", ym(2020, 3)],
    ["2020-03-15", ym(2020, 3, 15)],
    ["2020-03-15T10:00:00", ym(2020, 3, 15)], // naive datetime keeps its wall-clock date
    ["2020-03-15 10:00:00", ym(2020, 3, 15)],
    ["2020-03-00", ym(2020, 3)], // day 0 = unknown day
    ["2020-00-00", ym(2020, null)], // month and day unknown
    ["2020/03", ym(2020, 3)],
    ["2020/3", ym(2020, 3)],
    ["2020/03/15", ym(2020, 3, 15)],
    ["2020.03", ym(2020, 3)],
    ["15/03/2020", ym(2020, 3, 15)],
    ["15-03-2020", ym(2020, 3, 15)],
    ["15.03.2020", ym(2020, 3, 15)],
    ["1/3/2020", ym(2020, 3, 1)],
    ["March 2020", ym(2020, 3)],
    ["Mar 2020", ym(2020, 3)],
    ["mar 2020", ym(2020, 3)],
    ["MARCH-2020", ym(2020, 3)],
    ["Sept 2020", ym(2020, 9)],
    ["Dec, 2021", ym(2021, 12)],
    ["2020 March", ym(2020, 3)],
    ["مارس 2020", ym(2020, 3)],
    ["أبريل 2021", ym(2021, 4)],
    ["ابريل 2021", ym(2021, 4)],
    ["أغسطس 2019", ym(2019, 8)],
    ["كانون الثاني 2020", ym(2020, 1)],
    ["تشرين الأول 2020", ym(2020, 10)],
    ["٢٠٢٠", ym(2020, null)], // Arabic-Indic digits
    ["مارس ٢٠٢٠", ym(2020, 3)],
  ])("%j", (input, expected) => {
    expect(parseTemporalValue(input)).toEqual(expected);
  });
});

describe("parseTemporalValue: the legacy-Date false positives are gone", () => {
  // Every one of these parsed through `new Date(s)` before (to 2001-xx or 19xx/20xx).
  it.each(["1", "12", "0", "32", "99", "Month 1", "Item 12", "Zone 3", "hello 5", "Ward 5", "Block 3", "Candidate 1", "Mar-20", "12/2020x"])(
    "%j is not temporal",
    (input) => {
      expect(parseTemporalValue(input)).toBeNull();
    },
  );

  it.each([
    ["2020-13", "month 13"],
    ["2020-00", "month 0"],
    ["2020-1234", "not ISO"],
    ["2020-02-31", "no such day"],
    ["2020-04-31", "no such day"],
    ["31/02/2020", "no such day"],
    ["13/13/2020", "no such month"],
    ["1899", "before 1900"],
    ["2101", "after 2100"],
    ["1850-01", "before 1900"],
    ["2020.5", "decimal, not YYYY.MM"],
    ["2020.50", "month 50"],
    ["2020/13", "month 13"],
    ["2020-03T10:00", "time without a day"],
    ["", "empty"],
    ["   ", "blank"],
    ["N/A", "text"],
  ])("%j (%s) -> null", (input) => {
    expect(parseTemporalValue(input)).toBeNull();
  });

  it("non-string / non-integer inputs", () => {
    expect(parseTemporalValue(2020.5)).toBeNull();
    expect(parseTemporalValue(1850)).toBeNull();
    expect(parseTemporalValue(2150)).toBeNull();
    expect(parseTemporalValue(Number.NaN)).toBeNull();
    expect(parseTemporalValue(Infinity)).toBeNull();
    expect(parseTemporalValue(null)).toBeNull();
    expect(parseTemporalValue(undefined)).toBeNull();
    expect(parseTemporalValue({})).toBeNull();
    expect(parseTemporalValue(true)).toBeNull();
  });

  it("day-first, never month-first: 03/04/2020 is 3 April", () => {
    expect(parseTemporalValue("03/04/2020")).toEqual(ym(2020, 4, 3));
    expect(parseTemporalValue("13/04/2020")).toEqual(ym(2020, 4, 13));
  });
});

describe("parseTemporalValue: explicit offsets are converted to Asia/Bahrain", () => {
  it("UTC midnight-minus-3h is local midnight of the NEXT day/month", () => {
    // 2020-03-31T21:30:00Z is 2020-04-01 00:30 in Bahrain (UTC+3).
    expect(parseTemporalValue("2020-03-31T21:30:00Z")).toEqual(ym(2020, 4, 1));
    expect(parseTemporalValue("2020-03-31T21:00:00.000Z")).toEqual(ym(2020, 4, 1));
  });
  it("a +03:00 offset keeps the local date; other offsets are converted", () => {
    expect(parseTemporalValue("2020-04-01T00:30:00+03:00")).toEqual(ym(2020, 4, 1));
    expect(parseTemporalValue("2020-03-31T23:30:00+00:00")).toEqual(ym(2020, 4, 1));
    expect(parseTemporalValue("2020-03-31T10:00:00-05:00")).toEqual(ym(2020, 3, 31));
  });
  it("crosses a year boundary", () => {
    expect(parseTemporalValue("2019-12-31T22:00:00Z")).toEqual(ym(2020, 1, 1));
  });
  it("a naive datetime is left alone", () => {
    expect(parseTemporalValue("2020-03-31T23:30:00")).toEqual(ym(2020, 3, 31));
  });
});

describe("createTemporalParser (memoized)", () => {
  it("returns exactly what parseTemporalValue returns, including cached nulls", () => {
    const parse = createTemporalParser();
    for (const input of ["2020", 2020, "2020-03-15", "Item 12", "", null, undefined, {}, "2020", 2020, "Item 12"]) {
      expect(parse(input)).toEqual(parseTemporalValue(input));
    }
  });
  it("is bounded: past maxEntries it still answers correctly without growing", () => {
    const parse = createTemporalParser(3);
    for (let y = 2000; y < 2010; y++) expect(parse(String(y))).toEqual({ year: y, month: null, day: null });
    expect(parse("2000")).toEqual({ year: 2000, month: null, day: null });
  });
});

describe("parseMonthPart", () => {
  it.each([
    [1, 1],
    [12, 12],
    ["1", 1],
    ["01", 1],
    ["12", 12],
    ["March", 3],
    ["mar", 3],
    ["مارس", 3],
    ["ديسمبر", 12],
    ["١٢", 12],
  ])("%j -> %s", (input, expected) => {
    expect(parseMonthPart(input)).toBe(expected);
  });
  it.each([0, 13, 1.5, "13", "0", "Item 12", "", null, undefined, "2020"])("%j -> null", (input) => {
    expect(parseMonthPart(input)).toBeNull();
  });
});

describe("looksTemporalName (word boundaries, camelCase, plurals, Arabic)", () => {
  it.each([
    "year",
    "Year",
    "years",
    "reportYear",
    "OrderDate",
    "dates",
    "date_of_birth",
    "Month",
    "months",
    "birth_month",
    "quarter",
    "Quarters",
    "Year2020",
    "Fiscal Year",
    "السنة",
    "سنة",
    "السنوات",
    "تاريخ",
    "تاريخ الميلاد",
    "الشهر",
    "شهر",
    "الربع",
    "ربع",
    "شهر التسجيل",
  ])("%j looks temporal", (name) => {
    expect(looksTemporalName(name)).toBe(true);
  });

  // The old unbounded /(year|date|month|quarter|سنة|تاريخ|شهر|ربع)/ matched all of these.
  it.each(["update", "Update count", "Candidates", "candidate", "Mandate", "Validated", "dated", "yearly", "monthly", "مربع", "أربعة", "المربعات", "n", "value", ""])(
    "%j does not",
    (name) => {
      expect(looksTemporalName(name)).toBe(false);
    },
  );
});

describe("looksYearName / isMonthOnlyName / isQuarterOnlyName", () => {
  it("year names", () => {
    for (const n of ["year", "Year", "reportYear", "fy", "السنة", "سنة الإصدار", "العام", "عام"]) expect(looksYearName(n)).toBe(true);
    for (const n of ["yearly", "n", "value", "update", "عامل", ""]) expect(looksYearName(n)).toBe(false);
  });
  it("month-only names: the whole name is just 'month'", () => {
    for (const n of ["Month", "month", "months", "month_no", "Month Number", "الشهر", "شهر", "رقم الشهر"]) expect(isMonthOnlyName(n)).toBe(true);
    for (const n of ["Duration (months)", "month_of_birth", "Monthly rate", "Date", "Year", "شهر التسجيل", ""]) expect(isMonthOnlyName(n)).toBe(false);
  });
  it("quarter-only names", () => {
    for (const n of ["Quarter", "qtr", "الربع", "ربع"]) expect(isQuarterOnlyName(n)).toBe(true);
    for (const n of ["Quarterly value", "Month", ""]) expect(isQuarterOnlyName(n)).toBe(false);
  });
});

describe("ARABIC_MONTH_NAMES", () => {
  it("has 12 names and matches the Intl ar-BH long month names the rest of the UI uses", () => {
    expect(ARABIC_MONTH_NAMES).toHaveLength(12);
    const fmt = new Intl.DateTimeFormat("ar-BH", { month: "long", timeZone: "UTC" });
    const intl = Array.from({ length: 12 }, (_, i) => fmt.format(new Date(Date.UTC(2026, i, 15))));
    expect([...ARABIC_MONTH_NAMES]).toEqual(intl);
  });
});
