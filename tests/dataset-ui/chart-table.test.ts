import { describe, expect, it } from "vitest";
import { CSV_BOM, buildCsv, capRows, chartTableModel, csvCell, downloadFilename } from "@/lib/chart-table";
import type { VizConfig } from "@/lib/sync/derived";

const area = {
  type: "area",
  geoFields: [],
  temporalField: "year",
  temporalLabel: "السنة",
  grain: "year",
  measureField: "value",
  measureLabel: "Passengers",
  unit: "persons",
  aggregate: "sum",
} as VizConfig;

const multi = {
  type: "multi-line",
  geoFields: [],
  temporalField: "year",
  temporalLabel: "Year",
  grain: "year",
  measureField: "value",
  measureLabel: "Value",
  aggregate: "sum",
  seriesField: "nat",
  seriesLabel: "Nationality",
  seriesValues: ["Total", "Bahraini", "Non-Bahraini"],
  seriesOverflow: false,
  totalKey: "Total",
} as VizConfig;

describe("chartTableModel", () => {
  it("is null for tables and missing data", () => {
    expect(chartTableModel(null, [])).toBeNull();
    expect(chartTableModel({ type: "table", geoFields: [], reason: "geo" }, [])).toBeNull();
    expect(chartTableModel(area, null)).toBeNull();
  });

  it("builds area columns with the unit in the measure header", () => {
    const t = chartTableModel(area, [{ period: "2024", value: 5 }, "junk", null, { period: "2025", value: null }]);
    expect(t?.temporal).toBe(true);
    expect(t?.columns).toEqual([
      { key: "period", header: "السنة", numeric: false },
      { key: "value", header: "Passengers (persons)", numeric: true },
    ]);
    expect(t?.rows).toHaveLength(2);
  });

  it("keeps one column per series in legend order", () => {
    const t = chartTableModel(multi, [{ period: "2024", Total: 3, Bahraini: 1, "Non-Bahraini": 2 }]);
    expect(t?.columns.map((c) => c.key)).toEqual(["period", "Total", "Bahraini", "Non-Bahraini"]);
  });

  it("builds bar, stacked and histogram shapes", () => {
    const bar = chartTableModel(
      { type: "bar-h", geoFields: [], dimensionField: "g", dimensionLabel: "Governorate", measureField: "v", measureLabel: "Births", aggregate: "sum", categoryCount: 1, otherBucketed: false },
      [{ category: "North", value: 3 }],
    );
    expect(bar?.columns.map((c) => c.key)).toEqual(["category", "value"]);
    expect(bar?.temporal).toBe(false);

    const stacked = chartTableModel(
      { type: "bar-stacked", geoFields: [], xField: "x", xLabel: "Governorate", seriesField: "t", seriesLabel: "Type", seriesValues: ["Public", "Private"], seriesOverflow: false, measureField: "v", measureLabel: "Schools", aggregate: "sum", otherBucketed: false },
      [{ category: "North", Public: 1, Private: 2 }],
    );
    expect(stacked?.columns.map((c) => c.key)).toEqual(["category", "Public", "Private"]);

    const hist = chartTableModel(
      { type: "histogram", geoFields: [], measureField: "v", measureLabel: "Age", unit: "years", binCount: 10, min: 0, max: 100 },
      [{ bucket: "0–10", count: 4 }],
    );
    expect(hist?.columns).toEqual([
      { key: "bucket", header: "Age (years)", numeric: false },
      { key: "count", header: "العدد", numeric: true },
    ]);
  });

  it("does not repeat a unit already in the label", () => {
    const t = chartTableModel({ ...area, measureLabel: "Area (km2)", unit: "km2" } as VizConfig, []);
    expect(t?.columns[1].header).toBe("Area (km2)");
  });
});

describe("capRows", () => {
  const rows = Array.from({ length: 100 }, (_, i) => i);
  it("keeps the latest rows of a time series and the first rows otherwise", () => {
    expect(capRows(rows, 3, "end")).toEqual({ rows: [97, 98, 99], total: 100, omitted: 97 });
    expect(capRows(rows, 3, "start")).toEqual({ rows: [0, 1, 2], total: 100, omitted: 97 });
  });
  it("returns everything when it fits", () => {
    expect(capRows([1, 2], 60, "end")).toEqual({ rows: [1, 2], total: 2, omitted: 0 });
  });
});

describe("csvCell", () => {
  it("writes numbers bare, nulls empty and plain text unchanged", () => {
    expect(csvCell(12.5)).toBe("12.5");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(Number.NaN)).toBe("");
    expect(csvCell("Bahrain")).toBe("Bahrain");
    expect(csvCell("البحرين")).toBe("البحرين");
  });

  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("neutralises spreadsheet formulas", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\",\"x\")")).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell("+1+cmd|' /C calc'!A0")).toBe(`'+1+cmd|' /C calc'!A0`);
    expect(csvCell("@SUM(1,1)")).toBe(`"'@SUM(1,1)"`);
    expect(csvCell("-cmd|' /C calc'!A0")).toBe(`'-cmd|' /C calc'!A0`);
    expect(csvCell("\t=1")).toBe("'\t=1");
  });

  it("leaves numeric-looking labels and histogram buckets untouched", () => {
    expect(csvCell("-5–0")).toBe("-5–0");
    expect(csvCell("-12.5%")).toBe("-12.5%");
    expect(csvCell("+3")).toBe("+3");
    expect(csvCell("10–20")).toBe("10–20");
  });
});

describe("buildCsv", () => {
  it("starts with a UTF-8 BOM, uses CRLF and one column per series", () => {
    const table = chartTableModel(multi, [
      { period: "2024", Total: 3, Bahraini: 1, "Non-Bahraini": 2 },
      { period: "2025", Total: null, Bahraini: 1.5 },
    ])!;
    const csv = buildCsv(table);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.slice(1)).toBe("Year,Total,Bahraini,Non-Bahraini\r\n2024,3,1,2\r\n2025,,1.5,\r\n");
  });

  it("escapes a hostile series name in the header", () => {
    const table = chartTableModel(
      { ...multi, seriesValues: ["=SUM(A1)", 'Q"2'] } as VizConfig,
      [{ period: "2024", "=SUM(A1)": 1, 'Q"2': 2 }],
    )!;
    expect(buildCsv(table)).toContain(`Year,'=SUM(A1),"Q""2"`);
  });
});

describe("downloadFilename", () => {
  it("keeps only filename-safe characters", () => {
    expect(downloadFilename("live-births", "chart", "csv")).toBe("live-births-chart.csv");
    expect(downloadFilename("a/b c?d", "chart data", "png")).toBe("a-b-c-d-chart-data.png");
  });
  it("falls back for empty or non-latin ids and caps the length", () => {
    expect(downloadFilename("مواليد", "chart", "csv")).toBe("dataset-chart.csv");
    expect(downloadFilename("x".repeat(300), "chart", "csv").length).toBeLessThanOrEqual(80 + "-chart.csv".length);
  });
});
