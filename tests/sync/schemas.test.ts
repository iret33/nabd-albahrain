import { describe, expect, it } from "vitest";
import { CatalogPageSchema, parseCatalogEntry } from "@/lib/sync/schemas";
import { metadataChanged, metadataFromCatalogEntry } from "@/lib/sync/metadata";
import { computeSourceVersion } from "@/lib/sync/version";

const good = {
  dataset_id: "live-births",
  fields: [{ name: "year", label: "Year", type: "text" }],
  metas: { default: { title: "Live Births", theme: ["Health"], records_count: 12, modified: "2026-01-01T00:00:00+00:00" } },
};

function meta(overrides: Record<string, unknown>) {
  return { ...good, metas: { default: { ...good.metas.default, ...overrides } } };
}

describe("parseCatalogEntry: the four probes from the audit", () => {
  it("accepts records_count as a numeric string", () => {
    const r = parseCatalogEntry(meta({ records_count: "12" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.metas?.default?.records_count).toBe(12);
  });

  it("accepts theme as a bare string", () => {
    const r = parseCatalogEntry(meta({ theme: "Health" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.metas?.default?.theme).toEqual(["Health"]);
  });

  it("drops a field without a name instead of rejecting the entry", () => {
    const r = parseCatalogEntry({ ...good, fields: [{ label: "no name" }, { name: "year", type: "text" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.fields?.map((f) => f.name)).toEqual(["year"]);
  });

  it("accepts title: null", () => {
    expect(parseCatalogEntry(meta({ title: null })).ok).toBe(true);
  });
});

describe("parseCatalogEntry: what is still rejected (and reported)", () => {
  it("rejects a non-numeric records_count with the offending path", () => {
    const r = parseCatalogEntry(meta({ records_count: "n/a" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.datasetId).toBe("live-births");
      expect(r.issue).toMatch(/records_count/);
    }
  });

  it("rejects an entry without a usable dataset_id", () => {
    const r = parseCatalogEntry({ fields: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.datasetId).toBeNull();
    expect(parseCatalogEntry(null).ok).toBe(false);
    expect(parseCatalogEntry("x").ok).toBe(false);
  });

  it("still names the dataset when only another leaf is broken", () => {
    const r = parseCatalogEntry({ dataset_id: "x", fields: "oops" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.datasetId).toBe("x");
  });
});

describe("tolerant new metas", () => {
  it("reads title_ar, license, language and keyword as array or string", () => {
    const a = parseCatalogEntry(meta({ title_ar: "عنوان", license: "ODL", language: "ar", keyword: ["a", " b ", "a", 5] }));
    expect(a.ok && a.entry.metas?.default).toMatchObject({
      title_ar: "عنوان",
      license: "ODL",
      language: "ar",
      keyword: ["a", "b"],
    });
    const b = parseCatalogEntry(meta({ keyword: "labour, jobs؛ census،tax" }));
    expect(b.ok && b.entry.metas?.default?.keyword).toEqual(["labour", "jobs؛ census", "tax"]);
  });

  it("never rejects an entry over cosmetic surprises", () => {
    const r = parseCatalogEntry(meta({ title_ar: 5, license: { name: "x" }, keyword: { a: 1 }, language: [], data_processed: {} }));
    expect(r.ok).toBe(true);
  });

  it("works when none of the new fields exist", () => {
    const r = parseCatalogEntry(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const m = metadataFromCatalogEntry(r.entry);
      expect(m.titleAr).toBeNull();
      expect(m.keywords).toEqual([]);
      expect(m.license).toBeNull();
    }
  });
});

describe("CatalogPageSchema envelope", () => {
  it("only needs total_count and results", () => {
    expect(CatalogPageSchema.parse({ total_count: 2, results: [good, "garbage"] }).results).toHaveLength(2);
    expect(CatalogPageSchema.parse({ total_count: "3", results: [] }).total_count).toBe(3);
  });

  it("fails hard when the envelope itself is wrong", () => {
    expect(() => CatalogPageSchema.parse({ results: [] })).toThrow();
    expect(() => CatalogPageSchema.parse({ total_count: 1 })).toThrow();
    expect(() => CatalogPageSchema.parse({ total_count: 1, results: {} })).toThrow();
  });
});

describe("computeSourceVersion", () => {
  const entry = (m: Record<string, unknown>, fields = good.fields) => {
    const r = parseCatalogEntry({ dataset_id: "d", fields, metas: { default: m } });
    if (!r.ok) throw new Error(r.issue);
    return r.entry;
  };

  it("is stable for identical input", () => {
    const m = { modified: "2026-01-01", records_count: 5 };
    expect(computeSourceVersion(entry(m))).toBe(computeSourceVersion(entry({ ...m })));
  });

  it("changes when any version input changes", () => {
    const base = { modified: "2026-01-01", data_processed: "d1", metadata_processed: "m1", records_count: 5 };
    const v0 = computeSourceVersion(entry(base));
    expect(computeSourceVersion(entry({ ...base, modified: "2026-01-02" }))).not.toBe(v0);
    expect(computeSourceVersion(entry({ ...base, data_processed: "d2" }))).not.toBe(v0);
    expect(computeSourceVersion(entry({ ...base, metadata_processed: "m2" }))).not.toBe(v0);
    expect(computeSourceVersion(entry({ ...base, records_count: 6 }))).not.toBe(v0);
    expect(computeSourceVersion(entry(base, [{ name: "year" }, { name: "extra" }] as typeof good.fields))).not.toBe(v0);
  });

  it("ignores field order and degrades to modified + records_count when portal fields are absent", () => {
    const f1 = [{ name: "a" }, { name: "b" }] as typeof good.fields;
    const f2 = [{ name: "b" }, { name: "a" }] as typeof good.fields;
    expect(computeSourceVersion(entry({ modified: "x" }, f1))).toBe(computeSourceVersion(entry({ modified: "x" }, f2)));
    expect(computeSourceVersion(entry({ modified: "x", records_count: 1 }))).toMatch(/^v1\|x\|\|\|1\|/);
  });

  it("is an opaque string (never a clock value)", () => {
    expect(typeof computeSourceVersion(entry({}))).toBe("string");
  });
});

describe("metadataFromCatalogEntry / metadataChanged", () => {
  it("builds a normalized searchText over Arabic and English parts", () => {
    const r = parseCatalogEntry(
      meta({ title: "2021 Population Census", title_ar: "التعداد السكاني ٢٠٢١", keyword: ["إحصاء"], publisher: "IGA", description: "Census of population" }),
    );
    if (!r.ok) throw new Error(r.issue);
    const m = metadataFromCatalogEntry(r.entry);
    expect(m.titleClean).toBe("Population Census");
    // raw title kept for the year, Arabic digits folded to ASCII, alef/ya folded
    expect(m.searchText).toContain("2021 population census");
    expect(m.searchText).toContain("التعداد السكاني 2021");
    expect(m.searchText).toContain("احصاء");
  });

  it("clamps records_count into Postgres int range", () => {
    const r = parseCatalogEntry(meta({ records_count: 99_999_999_999 }));
    if (!r.ok) throw new Error(r.issue);
    expect(metadataFromCatalogEntry(r.entry).recordsCount).toBe(2_147_483_647);
  });

  it("detects no change when only jsonb key order differs", () => {
    const r = parseCatalogEntry(good);
    if (!r.ok) throw new Error(r.issue);
    const next = metadataFromCatalogEntry(r.entry);
    const stored = {
      ...next,
      fieldsJson: [{ type: "text", label: "Year", name: "year" }],
    };
    expect(metadataChanged(next, stored)).toBe(false);
    expect(metadataChanged({ ...next, title: "Other" }, stored)).toBe(true);
    expect(metadataChanged({ ...next, keywords: ["k"] }, stored)).toBe(true);
    // an entry without `fields` must not look like a change (we keep what is stored)
    expect(metadataChanged({ ...next, fieldsJson: null }, { ...stored, fieldsJson: [{ name: "zzz" }] })).toBe(false);
  });
});
