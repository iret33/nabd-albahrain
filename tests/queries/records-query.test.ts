import { describe, expect, it } from "vitest";
import {
  MAX_RECORDS_QUERY_LENGTH,
  MAX_SORT_FIELD_LENGTH,
  NUMERIC_TEXT_JS,
  NUMERIC_TEXT_RE,
  normalizeRecordsQuery,
  resolveSortField,
} from "@/lib/records-query";

const fields = [
  { name: "year", label: "Year", type: "text" },
  { name: "value", label: "Value", type: "int" },
  { name: "rate", label: "Rate", type: "double" },
  { name: "geo", label: "Location", type: "geo_point_2d" },
  { name: "shape", label: "Shape", type: "geo_shape" },
  { name: "when", label: "When", type: "date" },
  { name: "untyped" },
];

describe("resolveSortField", () => {
  it("accepts only the dataset's own columns", () => {
    expect(resolveSortField(fields, "year")).toEqual({ name: "year", numeric: false });
    expect(resolveSortField(fields, "value")).toEqual({ name: "value", numeric: true });
    expect(resolveSortField(fields, "rate")).toEqual({ name: "rate", numeric: true });
    expect(resolveSortField(fields, "when")).toEqual({ name: "when", numeric: false });
    expect(resolveSortField(fields, "untyped")).toEqual({ name: "untyped", numeric: false });
  });

  it("rejects unknown, empty, non-string, oversized and object-valued columns", () => {
    expect(resolveSortField(fields, "nope")).toBeNull();
    expect(resolveSortField(fields, "")).toBeNull();
    expect(resolveSortField(fields, "  ")).toBeNull();
    expect(resolveSortField(fields, null)).toBeNull();
    expect(resolveSortField(fields, ["year", "value"])).toBeNull();
    expect(resolveSortField(fields, "geo")).toBeNull();
    expect(resolveSortField(fields, "shape")).toBeNull();
    expect(resolveSortField(fields, "y".repeat(MAX_SORT_FIELD_LENGTH + 1))).toBeNull();
    expect(resolveSortField(fields, "Year")).toBeNull(); // exact, case-sensitive match
    expect(resolveSortField(fields, "year; DROP TABLE x")).toBeNull();
  });

  it("returns null when the dataset has no fields", () => {
    expect(resolveSortField([], "year")).toBeNull();
  });
});

describe("normalizeRecordsQuery", () => {
  it("returns null for empty / non-string input", () => {
    expect(normalizeRecordsQuery(undefined)).toBeNull();
    expect(normalizeRecordsQuery(null)).toBeNull();
    expect(normalizeRecordsQuery("")).toBeNull();
    expect(normalizeRecordsQuery("   ")).toBeNull();
    expect(normalizeRecordsQuery(["a", "b"])).toBeNull();
    expect(normalizeRecordsQuery(5)).toBeNull();
  });

  it("trims and caps the text at 60 characters", () => {
    expect(normalizeRecordsQuery("  Muharraq ")?.text).toBe("Muharraq");
    expect(normalizeRecordsQuery("x".repeat(500))?.text).toHaveLength(MAX_RECORDS_QUERY_LENGTH);
  });

  it("escapes LIKE metacharacters so they match literally", () => {
    expect(normalizeRecordsQuery("50%")?.pattern).toBe("%50\\%%");
    expect(normalizeRecordsQuery("a_b")?.pattern).toBe("%a\\_b%");
    expect(normalizeRecordsQuery("c:\\dir")?.pattern).toBe("%c:\\\\dir%");
    // A bare wildcard is a one-character literal search, not "match everything".
    expect(normalizeRecordsQuery("%")?.pattern).toBe("%\\%%");
    expect(normalizeRecordsQuery("_")?.pattern).toBe("%\\_%");
  });

  it("strips control characters (a NUL byte would abort the Postgres statement)", () => {
    expect(normalizeRecordsQuery("a\u0000b")?.text).toBe("a b");
    expect(normalizeRecordsQuery("\u0000\u0001")).toBeNull();
  });

  it("keeps Arabic text untouched", () => {
    expect(normalizeRecordsQuery("المحرق")?.pattern).toBe("%المحرق%");
  });
});

describe("NUMERIC_TEXT_RE (guards the SQL ::numeric cast)", () => {
  it("contains no backslash, so cooked template strings cannot corrupt it", () => {
    expect(NUMERIC_TEXT_RE).not.toContain("\\");
  });

  it("accepts plain, signed, fractional and exponent forms", () => {
    for (const ok of ["0", "12", "-7", "3.14", "-0.5", "1e5", "1.2E-07", "1.5e+10", "007"]) {
      expect(NUMERIC_TEXT_JS.test(ok), ok).toBe(true);
    }
  });

  it("rejects dirty values that would make ::numeric throw", () => {
    for (const bad of ["", "abc", "1a2", "1,000", "12 ", " 12", "1e", "e5", "--1", "1.", ".5", "NaN", "Infinity", "1/2", "١٢", "1e99999"]) {
      expect(NUMERIC_TEXT_JS.test(bad), bad).toBe(false);
    }
  });

  it("bounds digit counts", () => {
    expect(NUMERIC_TEXT_JS.test("1".repeat(30))).toBe(true);
    expect(NUMERIC_TEXT_JS.test("1".repeat(31))).toBe(false);
  });
});
