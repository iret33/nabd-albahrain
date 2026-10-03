/**
 * Field-aware cell formatting for the records table (and the dates in the
 * field dictionary). Pure: it turns a raw JSON cell plus what we know about its
 * column into a small render model; the component only maps the model to JSX.
 *
 * What it fixes over "every number through the en-US formatter":
 *  - Years, ids, codes and phone numbers are printed as typed ("2020", never
 *    "2,020"), using the `looksLikeYear` / `looksLikeIdentifier` flags the sync
 *    persists in `statsJson` (with a conservative name-based fallback for rows
 *    synced before those flags existed).
 *  - Doubles keep up to six fraction digits (a latitude is not "26.067").
 *  - `date` columns are formatted from their YYYY-MM-DD prefix as a civil date
 *    (no timezone shift: "2020-05-01T00:00:00+03:00" stays 1 May); `datetime`
 *    columns with an offset are shown in Bahrain time.
 *  - geo points become "26.2, 50.5" with an OpenStreetMap link; other objects
 *    become a short label with the (truncated) JSON in a tooltip, never a wall
 *    of GeoJSON in a cell.
 */

import type { FieldStats, StatsJson } from "@/lib/sync/derived";
import type { CatalogField } from "@/lib/sync/schemas";
import { formatDateTimeAr, formatNumber } from "@/lib/format";
import { resolveSortField } from "@/lib/records-query";

export interface ColumnMeta {
  name: string;
  /** Human label, falling back to the raw ODS name. */
  label: string;
  /** Lower-cased ODS type; unknown types are text. */
  type: string;
  stats: FieldStats | null;
  /** A quantity: end-aligned, tabular. False for years and identifiers. */
  numeric: boolean;
  /** Years and identifiers: digits printed as they are, never comma-grouped. */
  plainDigits: boolean;
  /** The data layer can order by this column (object-valued columns cannot). */
  sortable: boolean;
}

// Used only when a row has no statsJson flags (synced before they existed).
const IDENTIFIER_NAME_RE =
  /(^|[\s_-])(id|ids|code|codes|zip|postal|phone|mobile|cpr|serial|ref)($|[\s_-])|(^|[\s_-])(no|num|number)$|كود|رمز|معرف|هاتف|جوال/i;
const YEAR_NAME_RE = /(^|[\s_-])(year|yr)($|[\s_-])|^سنة|^عام/i;

function nameLooksPlain(field: CatalogField): boolean {
  const haystack = [field.name, field.label].filter((s): s is string => typeof s === "string");
  return haystack.some((s) => IDENTIFIER_NAME_RE.test(s) || YEAR_NAME_RE.test(s));
}

/** One ColumnMeta per named field, in schema order. `stats` may be null (older rows). */
export function buildColumns(fields: readonly CatalogField[], stats: StatsJson | null): ColumnMeta[] {
  const columns: ColumnMeta[] = [];
  for (const field of fields) {
    if (typeof field?.name !== "string" || field.name === "") continue;
    const type = (field.type ?? "text").toLowerCase();
    const fieldStats = stats?.[field.name] ?? null;
    const isInt = type === "int";
    const plainDigits = isInt && (fieldStats ? Boolean(fieldStats.looksLikeYear || fieldStats.looksLikeIdentifier) : nameLooksPlain(field));
    const numeric = !plainDigits && (type === "int" || type === "double" || (type === "text" && fieldStats?.numericLike === true));
    columns.push({
      name: field.name,
      label: field.label?.trim() || field.name,
      type,
      stats: fieldStats,
      numeric,
      plainDigits,
      sortable: resolveSortField([{ name: field.name, type }], field.name) !== null,
    });
  }
  return columns;
}

/** Percent complete, never rounded up to 100 while a value is missing; null when the rate is unknown. */
export function completenessPercent(nullRate: number | null | undefined): number | null {
  if (typeof nullRate !== "number" || !Number.isFinite(nullRate)) return null;
  const raw = (1 - Math.min(1, Math.max(0, nullRate))) * 100;
  if (raw >= 100) return 100;
  if (raw > 99.9) return 99.9;
  if (raw > 0 && raw < 0.1) return 0.1;
  return Math.round(raw * 10) / 10;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

const civilDateFormatter = new Intl.DateTimeFormat("ar-BH", {
  year: "numeric",
  month: "long",
  day: "numeric",
  numberingSystem: "latn",
  timeZone: "UTC",
});

/** "1 مايو 2020" for a calendar date, with no timezone conversion at all. Null for an impossible date. */
export function formatCivilDateAr(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 31 February over to March; reject instead of showing a different day.
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return civilDateFormatter.format(d);
}

export interface TemporalCell {
  text: string;
  /** Machine-readable value for a <time dateTime>. */
  iso: string;
}

/**
 * A date/datetime cell as Arabic text, or null when `raw` is not an ISO date.
 * `date`: the YYYY-MM-DD prefix as a civil date. `datetime` with an offset:
 * Bahrain time; without an offset (zone unknown): civil date + HH:mm as typed.
 */
export function formatTemporalValue(raw: unknown, type: string): TemporalCell | null {
  if (typeof raw !== "string") return null;
  const m = ISO_RE.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, offset] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const civil = formatCivilDateAr(year, month, day);
  if (!civil) return null;
  const isoDate = `${y}-${mo}-${d}`;

  if (type !== "datetime" || hh === undefined) return { text: civil, iso: isoDate };

  if (offset) {
    const tz = offset.toUpperCase() === "Z" ? "Z" : normalizeOffset(offset);
    const instant = new Date(`${isoDate}T${hh}:${mm}:${ss ?? "00"}${tz}`);
    if (Number.isNaN(instant.getTime())) return { text: `${civil}، ${hh}:${mm}`, iso: isoDate };
    return { text: formatDateTimeAr(instant), iso: instant.toISOString() };
  }
  return { text: `${civil}، ${hh}:${mm}`, iso: `${isoDate}T${hh}:${mm}` };
}

function normalizeOffset(offset: string): string {
  const sign = offset[0];
  const digits = offset.slice(1).replace(":", "");
  return `${sign}${digits.slice(0, 2)}:${digits.slice(2, 4) || "00"}`;
}

// ---------------------------------------------------------------------------
// Geo
// ---------------------------------------------------------------------------

export interface GeoPoint {
  lat: number;
  lon: number;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** `{lat, lon}` (also latitude/longitude/lng) with finite, in-range values; null for anything else. */
export function parseGeoPoint(value: unknown): GeoPoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const lat = num(o.lat ?? o.latitude);
  const lon = num(o.lon ?? o.lng ?? o.longitude);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

const GEO_STRING_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

/** "lat,lon" text as some exports write geo points. */
export function parseGeoString(value: string): GeoPoint | null {
  const m = GEO_STRING_RE.exec(value);
  if (!m) return null;
  return parseGeoPoint({ lat: Number(m[1]), lon: Number(m[2]) });
}

const round6 = (n: number) => String(Number(n.toFixed(6)));

/** "26.2, 50.5": at most six decimals, no trailing zeros. */
export function formatGeoPoint(p: GeoPoint): string {
  return `${round6(p.lat)}, ${round6(p.lon)}`;
}

export function openStreetMapUrl(p: GeoPoint): string {
  const lat = round6(p.lat);
  const lon = round6(p.lon);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`;
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

export type CellModel =
  | { kind: "empty" }
  | { kind: "text"; text: string; title?: string }
  | { kind: "number"; text: string }
  | { kind: "date"; text: string; iso: string }
  | { kind: "geo"; text: string; href: string }
  | { kind: "object"; label: string; title: string }
  | { kind: "boolean"; text: string };

const EMPTY: CellModel = { kind: "empty" };
const TITLE_FROM_LENGTH = 40;
const OBJECT_TITLE_MAX = 300;

const fractionFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

/** A number cell: whole numbers grouped (unless year/identifier), fractions up to six digits. */
export function formatNumberCell(value: number, plainDigits: boolean): string {
  if (!Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return plainDigits ? String(value) : formatNumber(value);
  // Below the last digit we print, the formatter would show "0": keep the real (exponent) form.
  if (Math.abs(value) < 1e-6) return String(value);
  return fractionFormatter.format(value);
}

function jsonTitle(value: unknown): string {
  try {
    const json = JSON.stringify(value) ?? "";
    return json.length > OBJECT_TITLE_MAX ? `${json.slice(0, OBJECT_TITLE_MAX)}…` : json;
  } catch {
    return "";
  }
}

function objectCell(value: object, col: ColumnMeta): CellModel {
  const point = parseGeoPoint(value);
  if (point && (col.type === "geo_point_2d" || col.type === "text")) {
    return { kind: "geo", text: formatGeoPoint(point), href: openStreetMapUrl(point) };
  }
  const title = jsonTitle(value);
  if (Array.isArray(value)) return { kind: "object", label: `قائمة (${value.length})`, title };
  const o = value as Record<string, unknown>;
  if (col.type === "geo_shape" || (typeof o.type === "string" && ("coordinates" in o || "geometry" in o))) {
    const geometry = o.geometry && typeof o.geometry === "object" ? (o.geometry as Record<string, unknown>) : o;
    const shape = typeof geometry.type === "string" ? geometry.type : null;
    return { kind: "object", label: shape ? `شكل جغرافي (${shape})` : "شكل جغرافي", title };
  }
  if (col.type === "file" || typeof o.filename === "string") {
    return { kind: "object", label: typeof o.filename === "string" ? o.filename : "ملف", title };
  }
  return { kind: "object", label: "كائن", title };
}

/** The render model of one cell. Never throws, whatever the stored JSON looks like. */
export function formatCell(value: unknown, col: ColumnMeta): CellModel {
  if (value === null || value === undefined || value === "") return EMPTY;
  if (typeof value === "boolean") return { kind: "boolean", text: value ? "نعم" : "لا" };
  if (typeof value === "number") return { kind: "number", text: formatNumberCell(value, col.plainDigits) };
  if (typeof value === "string") {
    if (col.type === "date" || col.type === "datetime") {
      const temporal = formatTemporalValue(value, col.type);
      if (temporal) return { kind: "date", ...temporal };
    }
    if (col.type === "geo_point_2d") {
      const point = parseGeoString(value);
      if (point) return { kind: "geo", text: formatGeoPoint(point), href: openStreetMapUrl(point) };
    }
    return value.length > TITLE_FROM_LENGTH ? { kind: "text", text: value, title: value } : { kind: "text", text: value };
  }
  if (typeof value === "object") return objectCell(value, col);
  return { kind: "text", text: String(value) };
}
