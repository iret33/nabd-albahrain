import { describe, expect, it, vi } from "vitest";
import { metadataChanged, metadataFromCatalogEntry, parseSourceModified } from "@/lib/sync/metadata";
import { parseCatalogEntry } from "@/lib/sync/schemas";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const HOUR = 3_600_000;

function entry(modified: string | undefined) {
  const parsed = parseCatalogEntry({
    dataset_id: "d1",
    fields: [{ name: "year", label: "Year", type: "text" }],
    metas: { default: { title: "D1", records_count: 5, ...(modified === undefined ? {} : { modified }) } },
  });
  if (!parsed.ok) throw new Error(parsed.issue);
  return parsed.entry;
}

describe("parseSourceModified (R2-14)", () => {
  it("keeps a credible past date and a date up to a day ahead (clock skew)", () => {
    expect(parseSourceModified("2026-01-15T08:00:00+00:00", NOW)).toEqual({ date: new Date("2026-01-15T08:00:00Z"), ignored: false });
    const inAnHour = new Date(NOW + HOUR).toISOString();
    expect(parseSourceModified(inAnHour, NOW)).toEqual({ date: new Date(inAnHour), ignored: false });
    const edge = new Date(NOW + 24 * HOUR).toISOString();
    expect(parseSourceModified(edge, NOW).ignored).toBe(false);
  });

  it("ignores a date more than a day ahead, however far", () => {
    for (const raw of [new Date(NOW + 48 * HOUR).toISOString(), "9999-12-31T23:59:59Z", "2099-01-01"]) {
      expect(parseSourceModified(raw, NOW), raw).toEqual({ date: null, ignored: true });
    }
  });

  it("ignores an extended-year string (a valid Date that Prisma would refuse) and a pre-epoch date", () => {
    expect(parseSourceModified("+010000-01-01T00:00:00Z", NOW)).toEqual({ date: null, ignored: true });
    expect(parseSourceModified("-000001-01-01T00:00:00Z", NOW)).toEqual({ date: null, ignored: true });
    expect(parseSourceModified("1969-12-31T23:59:59Z", NOW)).toEqual({ date: null, ignored: true });
    expect(parseSourceModified("1970-01-01T00:00:00Z", NOW).ignored).toBe(false);
  });

  it("an absent or unparseable value is null WITHOUT being 'ignored' (nothing to warn about)", () => {
    for (const raw of [undefined, null, "", "not a date"]) {
      expect(parseSourceModified(raw, NOW), String(raw)).toEqual({ date: null, ignored: false });
    }
    // some engines read this as year 10000, others reject it: null either way
    expect(parseSourceModified("10000-01-01", NOW).date).toBeNull();
  });
});

describe("metadataFromCatalogEntry: sourceModified", () => {
  it("stores null for a bad future date and reports it once per call", () => {
    const seen = vi.fn();
    const meta = metadataFromCatalogEntry(entry("9999-12-31T23:59:59Z"), { nowMs: NOW, onIgnoredModified: seen });
    expect(meta.sourceModified).toBeNull();
    expect(seen).toHaveBeenCalledWith("9999-12-31T23:59:59Z");
  });

  it("does not report a normal or absent date", () => {
    const seen = vi.fn();
    expect(metadataFromCatalogEntry(entry("2026-01-01T00:00:00Z"), { nowMs: NOW, onIgnoredModified: seen }).sourceModified).toEqual(
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(metadataFromCatalogEntry(entry(undefined), { nowMs: NOW, onIgnoredModified: seen }).sourceModified).toBeNull();
    expect(seen).not.toHaveBeenCalled();
  });

  it("is stable: the same bad input never reads as a change (a clamped value would rewrite the row every run)", () => {
    const first = metadataFromCatalogEntry(entry("9999-12-31T23:59:59Z"), { nowMs: NOW });
    const stored = { ...first, fieldsJson: first.fieldsJson };
    for (const later of [NOW, NOW + HOUR, NOW + 5 * 24 * HOUR]) {
      const again = metadataFromCatalogEntry(entry("9999-12-31T23:59:59Z"), { nowMs: later });
      expect(metadataChanged(again, stored), `at +${later - NOW}ms`).toBe(false);
    }
  });

  it("flips exactly once when the portal fixes the value", () => {
    const bad = metadataFromCatalogEntry(entry("9999-12-31T23:59:59Z"), { nowMs: NOW });
    const fixed = metadataFromCatalogEntry(entry("2026-10-01T00:00:00Z"), { nowMs: NOW });
    expect(metadataChanged(fixed, bad)).toBe(true);
    expect(metadataChanged(fixed, { ...fixed })).toBe(false);
  });
});
