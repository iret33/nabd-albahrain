import { describe, expect, it } from "vitest";
import {
  buildColumns,
  completenessPercent,
  formatCell,
  formatCivilDateAr,
  formatGeoPoint,
  formatNumberCell,
  formatTemporalValue,
  openStreetMapUrl,
  parseGeoPoint,
  parseGeoString,
  type ColumnMeta,
} from "@/lib/cell-format";
import type { FieldStats, StatsJson } from "@/lib/sync/derived";

function stat(partial: Partial<FieldStats> & Pick<FieldStats, "name" | "type">): FieldStats {
  return { label: partial.name, nullRate: 0, distinctCount: 10, ...partial };
}

function col(type: string, extra: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name: "f",
    label: "F",
    type,
    stats: null,
    numeric: type === "int" || type === "double",
    plainDigits: false,
    sortable: true,
    ...extra,
  };
}

describe("buildColumns", () => {
  const fields = [
    { name: "year", label: "Year", type: "int" },
    { name: "value", label: "Value", type: "int" },
    { name: "price", label: "Price", type: "double" },
    { name: "code", label: "Code", type: "text" },
    { name: "location", label: "Location", type: "geo_point_2d" },
    { name: "area", label: null, type: "geo_shape" },
    { name: "", label: "no name", type: "text" },
  ];

  it("uses the statsJson flags: years and identifiers are plain digits, not quantities", () => {
    const stats: StatsJson = {
      year: stat({ name: "year", type: "int", looksLikeYear: true }),
      value: stat({ name: "value", type: "int" }),
      code: stat({ name: "code", type: "text", numericLike: true }),
    };
    const cols = buildColumns(fields, stats);
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(cols).toHaveLength(6);
    expect(byName.year).toMatchObject({ plainDigits: true, numeric: false });
    expect(byName.value).toMatchObject({ plainDigits: false, numeric: true });
    expect(byName.price).toMatchObject({ plainDigits: false, numeric: true });
    expect(byName.code).toMatchObject({ numeric: true, plainDigits: false });
    expect(byName.area.label).toBe("area");
  });

  it("marks identifier-flagged ints plain even when the name says nothing", () => {
    const cols = buildColumns([{ name: "n", label: "N", type: "int" }], {
      n: stat({ name: "n", type: "int", looksLikeIdentifier: true }),
    });
    expect(cols[0]).toMatchObject({ plainDigits: true, numeric: false });
  });

  it("falls back to token-anchored names when a row has no stats", () => {
    const cols = buildColumns(
      [
        { name: "year", label: "Year", type: "int" },
        { name: "civil_id", label: "Civil ID", type: "int" },
        { name: "phone_no", label: "Phone", type: "int" },
        { name: "paid", label: "Paid", type: "int" },
        { name: "north", label: "North", type: "int" },
        { name: "number_of_visitors", label: "Number of visitors", type: "int" },
        { name: "revenue_per_year", label: "Revenue per year", type: "int" },
      ],
      null,
    );
    const plain = Object.fromEntries(cols.map((c) => [c.name, c.plainDigits]));
    expect(plain).toEqual({
      year: true,
      civil_id: true,
      phone_no: true,
      paid: false,
      north: false,
      number_of_visitors: false,
      revenue_per_year: true, // "year" is a whole token here; stats would say otherwise, names cannot
    });
  });

  it("only offers sorting for columns the data layer can order", () => {
    const cols = buildColumns(fields, null);
    const sortable = Object.fromEntries(cols.map((c) => [c.name, c.sortable]));
    expect(sortable.location).toBe(false);
    expect(sortable.area).toBe(false);
    expect(sortable.value).toBe(true);
    expect(sortable.code).toBe(true);
  });
});

describe("formatNumberCell", () => {
  it("groups whole numbers but leaves years and ids alone", () => {
    expect(formatNumberCell(1234567, false)).toBe("1,234,567");
    expect(formatNumberCell(2020, true)).toBe("2020");
    expect(formatNumberCell(2020, false)).toBe("2,020");
    expect(formatNumberCell(-4500, false)).toBe("-4,500");
  });

  it("keeps up to six fraction digits", () => {
    expect(formatNumberCell(26.0667, false)).toBe("26.0667");
    expect(formatNumberCell(50.557712, false)).toBe("50.557712");
    expect(formatNumberCell(0.123456789, false)).toBe("0.123457");
    expect(formatNumberCell(1234.5, false)).toBe("1,234.5");
  });

  it("does not collapse a tiny value to 0 or throw on non-finite input", () => {
    expect(formatNumberCell(0.00000012, false)).toBe("1.2e-7");
    expect(formatNumberCell(0, false)).toBe("0");
    expect(formatNumberCell(Number.NaN, false)).toBe("—");
    expect(formatNumberCell(Infinity, false)).toBe("—");
  });
});

describe("dates", () => {
  it("formats a calendar date with no timezone shift", () => {
    expect(formatCivilDateAr(2020, 5, 1)).toContain("2020");
    expect(formatCivilDateAr(2020, 5, 1)).toMatch(/\b1\b/);
    // Not the previous day, which a UTC+3 -> UTC conversion of a midnight offset date would give.
    expect(formatTemporalValue("2020-05-01T00:00:00+03:00", "date")?.text).toMatch(/\b1\b/);
    expect(formatTemporalValue("2020-05-01T00:00:00+03:00", "date")?.iso).toBe("2020-05-01");
  });

  it("rejects impossible dates and non-dates", () => {
    expect(formatCivilDateAr(2021, 2, 31)).toBeNull();
    expect(formatCivilDateAr(2021, 13, 1)).toBeNull();
    expect(formatTemporalValue("2021-02-31", "date")).toBeNull();
    expect(formatTemporalValue("hello", "date")).toBeNull();
    expect(formatTemporalValue(42, "date")).toBeNull();
    expect(formatTemporalValue("2020", "date")).toBeNull();
  });

  it("shows a datetime with an offset in Bahrain time", () => {
    const cell = formatTemporalValue("2020-05-01T22:30:00Z", "datetime");
    expect(cell?.iso).toBe("2020-05-01T22:30:00.000Z");
    // 22:30 UTC is 01:30 on 2 May in Bahrain (UTC+3).
    expect(cell?.text).toContain("01:30");
    expect(cell?.text).toMatch(/\b2\b/);
  });

  it("accepts spaces, short offsets and fractional seconds", () => {
    expect(formatTemporalValue("2020-05-01 10:00:00+03", "datetime")?.text).toContain("10:00");
    expect(formatTemporalValue("2020-05-01T10:00:00.123+0300", "datetime")?.text).toContain("10:00");
  });

  it("shows a zone-less datetime as typed instead of guessing a timezone", () => {
    const cell = formatTemporalValue("2020-05-01T10:15:00", "datetime");
    expect(cell?.text).toContain("10:15");
    expect(cell?.iso).toBe("2020-05-01T10:15");
  });

  it("drops the time of a datetime value in a date column", () => {
    expect(formatTemporalValue("2020-05-01T23:59:00", "date")?.text).not.toContain("23:59");
  });
});

describe("geo points", () => {
  it("parses object and string forms and rejects bad ones", () => {
    expect(parseGeoPoint({ lat: 26.2, lon: 50.5 })).toEqual({ lat: 26.2, lon: 50.5 });
    expect(parseGeoPoint({ latitude: "26.2", longitude: "50.5" })).toEqual({ lat: 26.2, lon: 50.5 });
    expect(parseGeoPoint({ lat: 91, lon: 50 })).toBeNull();
    expect(parseGeoPoint({ lat: 26, lon: 181 })).toBeNull();
    expect(parseGeoPoint({ lat: "x", lon: 1 })).toBeNull();
    expect(parseGeoPoint([26, 50])).toBeNull();
    expect(parseGeoPoint(null)).toBeNull();
    expect(parseGeoString("26.2, 50.5")).toEqual({ lat: 26.2, lon: 50.5 });
    expect(parseGeoString("26.2;50.5")).toBeNull();
  });

  it("formats with at most six decimals and links to OpenStreetMap", () => {
    expect(formatGeoPoint({ lat: 26.2, lon: 50.5 })).toBe("26.2, 50.5");
    expect(formatGeoPoint({ lat: 26.12345678, lon: 50.1 })).toBe("26.123457, 50.1");
    expect(openStreetMapUrl({ lat: 26.2, lon: 50.5 })).toBe(
      "https://www.openstreetmap.org/?mlat=26.2&mlon=50.5#map=15/26.2/50.5",
    );
  });
});

describe("formatCell", () => {
  it("renders empty values as empty", () => {
    for (const v of [null, undefined, ""]) expect(formatCell(v, col("text"))).toEqual({ kind: "empty" });
  });

  it("renders booleans in Arabic", () => {
    expect(formatCell(true, col("text"))).toEqual({ kind: "boolean", text: "نعم" });
    expect(formatCell(false, col("text"))).toEqual({ kind: "boolean", text: "لا" });
  });

  it("renders numbers per the column flags", () => {
    expect(formatCell(2020, col("int", { plainDigits: true }))).toEqual({ kind: "number", text: "2020" });
    expect(formatCell(1500, col("int"))).toEqual({ kind: "number", text: "1,500" });
    expect(formatCell(26.0667, col("double"))).toEqual({ kind: "number", text: "26.0667" });
  });

  it("renders ISO strings in date columns and leaves them alone in text columns", () => {
    const date = formatCell("2020-05-01", col("date"));
    expect(date).toMatchObject({ kind: "date", iso: "2020-05-01" });
    expect(formatCell("2020-05-01", col("text"))).toEqual({ kind: "text", text: "2020-05-01" });
    expect(formatCell("not a date", col("date"))).toEqual({ kind: "text", text: "not a date" });
  });

  it("renders geo points as a link and other objects as a short label with a tooltip", () => {
    expect(formatCell({ lat: 26.2, lon: 50.5 }, col("geo_point_2d"))).toEqual({
      kind: "geo",
      text: "26.2, 50.5",
      href: "https://www.openstreetmap.org/?mlat=26.2&mlon=50.5#map=15/26.2/50.5",
    });
    expect(formatCell("26.2,50.5", col("geo_point_2d"))).toMatchObject({ kind: "geo", text: "26.2, 50.5" });

    const shape = formatCell({ type: "Feature", geometry: { type: "Polygon", coordinates: [[1, 2]] } }, col("geo_shape"));
    expect(shape).toMatchObject({ kind: "object", label: "شكل جغرافي (Polygon)" });

    const outOfRange = formatCell({ lat: 500, lon: 1 }, col("geo_point_2d"));
    expect(outOfRange).toMatchObject({ kind: "object", label: "كائن" });

    expect(formatCell([1, 2, 3], col("text"))).toMatchObject({ kind: "object", label: "قائمة (3)" });
    expect(formatCell({ filename: "a.pdf", url: "x" }, col("file"))).toMatchObject({ kind: "object", label: "a.pdf" });
  });

  it("truncates the tooltip JSON of a huge object", () => {
    const cell = formatCell({ big: "x".repeat(5000) }, col("text"));
    expect(cell.kind).toBe("object");
    if (cell.kind === "object") expect(cell.title.length).toBeLessThanOrEqual(301);
  });

  it("adds a tooltip only for long text", () => {
    expect(formatCell("short", col("text"))).toEqual({ kind: "text", text: "short" });
    const long = "x".repeat(80);
    expect(formatCell(long, col("text"))).toEqual({ kind: "text", text: long, title: long });
  });

  it("never throws on a circular object", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => formatCell(o, col("text"))).not.toThrow();
  });
});

describe("completenessPercent", () => {
  it("is exact at the ends and never rounds a gap up to 100", () => {
    expect(completenessPercent(0)).toBe(100);
    expect(completenessPercent(1)).toBe(0);
    expect(completenessPercent(0.5)).toBe(50);
    expect(completenessPercent(0.0004)).toBe(99.9);
    expect(completenessPercent(0.9996)).toBe(0.1);
    expect(completenessPercent(0.123)).toBe(87.7);
  });
  it("clamps nonsense input", () => {
    expect(completenessPercent(-1)).toBe(100);
    expect(completenessPercent(7)).toBe(0);
  });
  it("is null when the rate is unknown (a damaged or older stats row)", () => {
    expect(completenessPercent(undefined)).toBeNull();
    expect(completenessPercent(null)).toBeNull();
    expect(completenessPercent(Number.NaN)).toBeNull();
  });
});
