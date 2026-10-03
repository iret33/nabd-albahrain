import { describe, expect, it } from "vitest";
import {
  STALE_AFTER_HOURS,
  fieldTypeLabelAr,
  isRefinedRecordsView,
  isStale,
  langOf,
  officialLinks,
  parseRecordsParams,
  recordsHref,
  recordsRange,
} from "@/lib/dataset-page";

describe("parseRecordsParams", () => {
  it("defaults when nothing is given", () => {
    expect(parseRecordsParams({})).toEqual({ page: 1, sort: null, dir: null, rq: null });
    expect(parseRecordsParams(null)).toEqual({ page: 1, sort: null, dir: null, rq: null });
  });

  it("reads page, sort, dir and rq", () => {
    expect(parseRecordsParams({ page: "3", sort: " year ", dir: "desc", rq: "  manama " })).toEqual({
      page: 3,
      sort: "year",
      dir: "desc",
      rq: "manama",
    });
  });

  it("rejects hostile page numbers instead of crashing", () => {
    for (const page of ["1.5", "Infinity", "1e21", "-3", "0x10", "abc", "", "123456"]) {
      expect(parseRecordsParams({ page }).page).toBeGreaterThanOrEqual(1);
    }
    expect(parseRecordsParams({ page: "1.5" }).page).toBe(1);
    expect(parseRecordsParams({ page: "1e21" }).page).toBe(1);
  });

  it("takes the first value of a repeated param (?sort=a&sort=b)", () => {
    expect(parseRecordsParams({ sort: ["a", "b"], dir: ["desc", "asc"], rq: ["x", "y"], page: ["2", "9"] })).toEqual({
      page: 2,
      sort: "a",
      dir: "desc",
      rq: "x",
    });
  });

  it("caps rq at 60 characters, ignores an unknown dir and an absurd sort", () => {
    expect(parseRecordsParams({ rq: "x".repeat(200) }).rq).toHaveLength(60);
    expect(parseRecordsParams({ dir: "sideways" }).dir).toBeNull();
    expect(parseRecordsParams({ sort: "s".repeat(500) }).sort).toBeNull();
    expect(parseRecordsParams({ rq: "   " }).rq).toBeNull();
  });
});

describe("isRefinedRecordsView", () => {
  it("is false only for the default first page", () => {
    expect(isRefinedRecordsView(parseRecordsParams({}))).toBe(false);
    expect(isRefinedRecordsView(parseRecordsParams({ page: "1" }))).toBe(false);
    expect(isRefinedRecordsView(parseRecordsParams({ page: "2" }))).toBe(true);
    expect(isRefinedRecordsView(parseRecordsParams({ sort: "year" }))).toBe(true);
    expect(isRefinedRecordsView(parseRecordsParams({ dir: "desc" }))).toBe(true);
    expect(isRefinedRecordsView(parseRecordsParams({ rq: "abc" }))).toBe(true);
  });
});

describe("recordsHref", () => {
  it("is the bare table anchor for the default view", () => {
    expect(recordsHref("seaports")).toBe("/dataset/seaports#records");
    expect(recordsHref("seaports", { page: 1, sort: null, dir: null, rq: null })).toBe("/dataset/seaports#records");
  });

  it("carries rq, sort, dir and page in a stable order", () => {
    expect(recordsHref("seaports", { rq: "cargo", sort: "value", dir: "desc", page: 4 })).toBe(
      "/dataset/seaports?rq=cargo&sort=value&dir=desc&page=4#records",
    );
  });

  it("defaults dir to asc when a sort is given and drops dir without a sort", () => {
    expect(recordsHref("a", { sort: "x" })).toBe("/dataset/a?sort=x&dir=asc#records");
    expect(recordsHref("a", { dir: "desc" })).toBe("/dataset/a#records");
  });

  it("encodes the id and free text", () => {
    expect(recordsHref("a b", { rq: "50% & más" })).toBe("/dataset/a%20b?rq=50%25+%26+m%C3%A1s#records");
  });

  it("round-trips through parseRecordsParams", () => {
    const href = recordsHref("x", { rq: "a b", sort: "year", dir: "desc", page: 7 });
    const query = Object.fromEntries(new URLSearchParams(href.slice(href.indexOf("?") + 1, href.indexOf("#"))));
    expect(parseRecordsParams(query)).toEqual({ page: 7, sort: "year", dir: "desc", rq: "a b" });
  });
});

describe("recordsRange", () => {
  it("gives the 1-based window of the current page", () => {
    expect(recordsRange(1, 25, 60, 25)).toEqual({ from: 1, to: 25 });
    expect(recordsRange(3, 25, 60, 10)).toEqual({ from: 51, to: 60 });
  });
  it("is 0-0 for an empty page", () => {
    expect(recordsRange(1, 25, 0, 0)).toEqual({ from: 0, to: 0 });
  });
});

describe("isStale", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it("flags a check older than 48 hours", () => {
    expect(STALE_AFTER_HOURS).toBe(48);
    expect(isStale(hoursAgo(49), null, now)).toBe(true);
    expect(isStale(hoursAgo(47), null, now)).toBe(false);
    expect(isStale(hoursAgo(48), null, now)).toBe(false);
  });

  it("falls back to the last sync, and never flags a dataset that has neither", () => {
    expect(isStale(null, hoursAgo(100), now)).toBe(true);
    expect(isStale(undefined, hoursAgo(1), now)).toBe(false);
    expect(isStale(null, null, now)).toBe(false);
  });

  it("prefers the check over an older sync", () => {
    expect(isStale(hoursAgo(1), hoursAgo(500), now)).toBe(false);
  });

  it("ignores an invalid date", () => {
    expect(isStale(new Date("nope"), null, now)).toBe(false);
  });
});

describe("officialLinks", () => {
  it("points straight at the portal and encodes the id", () => {
    const l = officialLinks("a b");
    expect(l.csvUrl).toBe("https://data.gov.bh/api/explore/v2.1/catalog/datasets/a%20b/exports/csv?use_labels=true");
    expect(l.jsonUrl).toBe("https://data.gov.bh/api/explore/v2.1/catalog/datasets/a%20b/exports/json");
    expect(l.officialPageUrl).toBe("https://www.data.gov.bh/explore/dataset/a%20b/");
  });
});

describe("fieldTypeLabelAr", () => {
  it("names the ODS types in Arabic", () => {
    expect(fieldTypeLabelAr("text")).toBe("نص");
    expect(fieldTypeLabelAr("int")).toBe("عدد صحيح");
    expect(fieldTypeLabelAr("double")).toBe("عدد عشري");
    expect(fieldTypeLabelAr("date")).toBe("تاريخ");
    expect(fieldTypeLabelAr("geo_point_2d")).toBe("موقع جغرافي");
  });
  it("treats unknown and missing types as text", () => {
    expect(fieldTypeLabelAr("weird")).toBe("نص");
    expect(fieldTypeLabelAr(null)).toBe("نص");
    expect(fieldTypeLabelAr("INT")).toBe("عدد صحيح");
  });
});

describe("langOf", () => {
  it("marks Latin-only text as English and leaves Arabic or mixed text alone", () => {
    expect(langOf("Live Births")).toBe("en");
    expect(langOf("المواليد")).toBeUndefined();
    expect(langOf("المواليد (GDP)")).toBeUndefined();
    expect(langOf("2024")).toBeUndefined();
    expect(langOf(null)).toBeUndefined();
  });
});
