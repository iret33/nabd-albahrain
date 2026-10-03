/**
 * The plotted data of a dataset chart as a plain table, shared by the three
 * things that need it: the on-page "show the chart as a table" alternative
 * (the accessible equivalent of the picture), the CSV download, and the PNG
 * export's footer. Pure: no DOM, no React.
 *
 * Column order and headers mirror what the chart draws (one column per series,
 * in legend order), so the table and the picture can never disagree.
 */

import type { VizConfig } from "@/lib/sync/derived";

export interface TableColumn {
  key: string;
  header: string;
  /** Values are numbers (end-aligned, tabular). False for the row-label column. */
  numeric: boolean;
}

export interface ChartTable {
  columns: TableColumn[];
  rows: Array<Record<string, unknown>>;
  /** Time-ordered rows: when the table is capped the most RECENT rows are kept. */
  temporal: boolean;
}

function withUnit(label: string, unit: string | undefined): string {
  if (!unit || label.includes(`(${unit})`) || label.includes(`[${unit}]`)) return label;
  return `${label} (${unit})`;
}

function isRow(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Null for table-type configs (nothing is plotted). */
export function chartTableModel(vizConfig: VizConfig | null, chartData: readonly unknown[] | null): ChartTable | null {
  if (!vizConfig || vizConfig.type === "table" || !Array.isArray(chartData)) return null;
  const rows = chartData.filter(isRow);
  const series = (keys: readonly string[]): TableColumn[] => keys.map((key) => ({ key, header: key, numeric: true }));

  switch (vizConfig.type) {
    case "area":
      return {
        temporal: true,
        rows,
        columns: [
          { key: "period", header: vizConfig.temporalLabel, numeric: false },
          { key: "value", header: withUnit(vizConfig.measureLabel, vizConfig.unit), numeric: true },
        ],
      };
    case "multi-line":
      return {
        temporal: true,
        rows,
        columns: [{ key: "period", header: vizConfig.temporalLabel, numeric: false }, ...series(vizConfig.seriesValues)],
      };
    case "bar-h":
      return {
        temporal: false,
        rows,
        columns: [
          { key: "category", header: vizConfig.dimensionLabel, numeric: false },
          { key: "value", header: withUnit(vizConfig.measureLabel, vizConfig.unit), numeric: true },
        ],
      };
    case "bar-stacked":
      return {
        temporal: false,
        rows,
        columns: [{ key: "category", header: vizConfig.xLabel, numeric: false }, ...series(vizConfig.seriesValues)],
      };
    case "histogram":
      return {
        temporal: false,
        rows,
        columns: [
          { key: "bucket", header: withUnit(vizConfig.measureLabel, vizConfig.unit), numeric: false },
          { key: "count", header: "العدد", numeric: true },
        ],
      };
    default:
      return null;
  }
}

export interface CappedRows<T> {
  rows: T[];
  total: number;
  /** How many rows were left out. */
  omitted: number;
}

/** Keeps at most `max` rows: the latest ones for time series, the first ones otherwise. */
export function capRows<T>(rows: readonly T[], max: number, keep: "start" | "end"): CappedRows<T> {
  const limit = Math.max(0, Math.floor(max));
  if (rows.length <= limit) return { rows: [...rows], total: rows.length, omitted: 0 };
  const kept = keep === "end" ? rows.slice(rows.length - limit) : rows.slice(0, limit);
  return { rows: kept, total: rows.length, omitted: rows.length - limit };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Cells a spreadsheet would run as a formula when the file is opened. */
const FORMULA_START_RE = /^[=+\-@\t\r]/;
/** "-5", "+3.2", "-5–0", "10%" and the like: plain numbers/ranges that cannot hide a function call. */
const PLAIN_NUMBERISH_RE = /^[+-]?\d[\d.,]*(?:\s*[–—-]\s*[+-]?\d[\d.,]*)?%?$/;

/**
 * One CSV field. Numbers are written bare; text that a spreadsheet could
 * evaluate (starts with = + - @, tab or CR) gets a leading apostrophe unless it
 * is just a number or range ("-5–0", a histogram bucket); anything containing a
 * comma, quote or line break is quoted with doubled quotes.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = String(value);
  if (FORMULA_START_RE.test(text) && !PLAIN_NUMBERISH_RE.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** UTF-8 byte order mark: without it Excel opens an Arabic CSV as Windows-1252 mojibake. */
export const CSV_BOM = "﻿";

/** The whole table as an Excel-friendly CSV (BOM, CRLF line ends, header row). */
export function buildCsv(table: ChartTable): string {
  const header = table.columns.map((c) => csvCell(c.header)).join(",");
  const lines = table.rows.map((row) => table.columns.map((c) => csvCell(row[c.key])).join(","));
  return `${CSV_BOM}${[header, ...lines].join("\r\n")}\r\n`;
}

/** `<dataset-id>-<suffix>.<ext>` with only filename-safe characters. */
export function downloadFilename(datasetId: string, suffix: string, ext: "csv" | "png"): string {
  const safe = (s: string) =>
    s
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "");
  const id = safe(datasetId).slice(0, 80) || "dataset";
  const tail = safe(suffix) || "chart";
  return `${id}-${tail}.${ext}`;
}
