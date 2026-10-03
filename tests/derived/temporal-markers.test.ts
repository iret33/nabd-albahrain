import { describe, expect, it } from "vitest";
import { parseTemporalValue } from "@/lib/temporal";

/** r3-07 / r3-15 unit tests for the parser additions (the end-to-end behaviour is in periods.test.ts). */

const year = (y: number, provisional = false) => ({ year: y, month: null, day: null, ...(provisional ? { provisional: true } : {}) });

describe("parseTemporalValue: provisional markers are stripped and reported", () => {
  it.each([
    ["2024*", year(2024, true)],
    ["2024 *", year(2024, true)],
    ["2024**", year(2024, true)],
    ["2024†", year(2024, true)],
    ["2024 (p)", year(2024, true)],
    ["2024(p)", year(2024, true)],
    ["2024 [p]", year(2024, true)],
    ["2024 (prov.)", year(2024, true)],
    ["2024 (provisional)", year(2024, true)],
    ["2024p", year(2024, true)],
    ["2024e", year(2024, true)],
    ["2024F", year(2024, true)],
    ["2024 est.", year(2024, true)],
    ["2024 estimated", year(2024, true)],
    ["2024 preliminary", year(2024, true)],
    ["2024 مؤقت", year(2024, true)],
    ["2024 (تقديري)", year(2024, true)],
    ["  2024*  ", year(2024, true)],
    ["Mar 2024*", { year: 2024, month: 3, day: null, provisional: true }],
    ["2024-03*", { year: 2024, month: 3, day: null, provisional: true }],
    ["2024-03-15 (p)", { year: 2024, month: 3, day: 15, provisional: true }],
  ])("%j", (raw, expected) => {
    expect(parseTemporalValue(raw)).toEqual(expected);
  });

  it.each([
    ["2024 Mar", { year: 2024, month: 3, day: null }], // a month name, NOT a marker
    ["2024 Dec", { year: 2024, month: 12, day: null }],
    ["2024 Jan", { year: 2024, month: 1, day: null }],
    ["2024 BHD", null],
    ["2024 (x)", null],
    ["2024 abc", null],
    ["*", null],
    ["p", null],
    ["(p)", null],
    ["1e", null],
    ["2024-13*", null],
    ["2024-02-30 (p)", null],
  ])("%j is not read as a provisional year", (raw, expected) => {
    expect(parseTemporalValue(raw)).toEqual(expected);
  });
});

describe("parseTemporalValue: year-grain shapes", () => {
  it.each([
    ["2024.0", year(2024)],
    ["2024.00", year(2024)],
    ["FY2024", year(2024)],
    ["fy 2024", year(2024)],
    ["2023/24", year(2023)],
    ["2023/2024", year(2023)],
    ["2023-2024", year(2023)],
    ["2023-24", year(2023)],
    ["2019/20", year(2019)],
    ["1999/00", year(1999)],
  ])("%j", (raw, expected) => {
    expect(parseTemporalValue(raw)).toEqual(expected);
  });

  it.each([
    ["2011/12", { year: 2011, month: 12, day: null }], // a valid month keeps its meaning
    ["2011-12", { year: 2011, month: 12, day: null }],
    ["2023/12", { year: 2023, month: 12, day: null }],
    ["2023/25", null], // not consecutive
    ["2020-2025", null], // a range, not a period
    ["2023/2025", null],
    ["2024.5", null],
    ["FY24", null],
    ["Q1 2024", null], // quarters are left unsupported on purpose (collapsing them to the year would sum four rows into one bar)
  ])("%j keeps its old meaning or stays unreadable", (raw, expected) => {
    expect(parseTemporalValue(raw)).toEqual(expected);
  });
});

describe("parseTemporalValue: input length cap", () => {
  it("values longer than 64 characters (after trimming) are null, shorter padded ones still parse", () => {
    expect(parseTemporalValue("2020-01-01" + " ".repeat(200))).toEqual({ year: 2020, month: 1, day: 1 });
    expect(parseTemporalValue("2020-01-01T10:00:00" + "0".repeat(60))).toBeNull();
    expect(parseTemporalValue("x".repeat(65))).toBeNull();
    expect(parseTemporalValue(`${"1".repeat(30)}${"2".repeat(40)}`)).toBeNull();
  });
});
