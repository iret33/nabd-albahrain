import { describe, expect, it } from "vitest";
import {
  JSON_LD_MAX_DESCRIPTION,
  JSON_LD_MAX_VARIABLES,
  buildBreadcrumbJsonLd,
  buildDatasetJsonLd,
  detectLanguages,
  jsonLdScript,
  truncateOnWord,
  type DatasetJsonLdInput,
} from "@/lib/jsonld";

const base: DatasetJsonLdInput = {
  siteUrl: "https://example.org",
  id: "live-births",
  name: "المواليد الأحياء",
  alternateName: "Live Births",
  description: "Births by governorate.",
  publisher: "Ministry of Health",
  theme: "Health",
  keywords: ["births", "health"],
  license: "Open Data License",
  sourceModified: new Date("2026-03-01T08:00:00Z"),
  officialPageUrl: "https://www.data.gov.bh/explore/dataset/live-births/",
  csvUrl: "https://data.gov.bh/api/explore/v2.1/catalog/datasets/live-births/exports/csv?use_labels=true",
  jsonUrl: "https://data.gov.bh/api/explore/v2.1/catalog/datasets/live-births/exports/json",
  fieldLabels: ["Year", "Governorate", "Births"],
};

describe("jsonLdScript", () => {
  it("escapes everything that could close or open an HTML context", () => {
    const out = jsonLdScript({ name: "</script><script>alert(1)</script><!-- & x" });
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).not.toContain("&");
    expect(out).toContain("\\u003c/script\\u003e");
  });

  it("round-trips through JSON.parse unchanged", () => {
    const data = { a: "</script>", b: ["x & y", "\u2028\u2029"], c: 3 };
    expect(JSON.parse(jsonLdScript(data))).toEqual(data);
  });
});

describe("truncateOnWord", () => {
  it("returns short text untouched apart from whitespace", () => {
    expect(truncateOnWord("  a   b \n c ", 50)).toBe("a b c");
    expect(truncateOnWord(null, 50)).toBe("");
  });

  it("cuts on a word boundary and adds an ellipsis within the budget", () => {
    const out = truncateOnWord("one two three four five six", 15);
    expect(out).toBe("one two three…");
    expect(out.length).toBeLessThanOrEqual(15);
  });

  it("hard-cuts a single very long word", () => {
    const out = truncateOnWord("x".repeat(100), 20);
    expect(out.length).toBe(20);
    expect(out.endsWith("…")).toBe(true);
  });

  it("does not leave dangling punctuation or split a surrogate pair", () => {
    expect(truncateOnWord("alpha beta, gamma delta", 12)).toBe("alpha beta…");
    const emoji = truncateOnWord(`ab ${"😀".repeat(10)}`, 6);
    expect(emoji).not.toMatch(/[\ud800-\udbff]…$/);
  });

  it("handles Arabic text and degenerate budgets", () => {
    const out = truncateOnWord("مجموعة بيانات عن المواليد الأحياء حسب المحافظة", 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith("…")).toBe(true);
    expect(truncateOnWord("abc", 0)).toBe("");
    expect(truncateOnWord("abc def", 1)).toBe("…");
  });
});

describe("detectLanguages", () => {
  it("reports the scripts present, Arabic by default", () => {
    expect(detectLanguages("المواليد", "Births")).toEqual(["ar", "en"]);
    expect(detectLanguages("Births")).toEqual(["en"]);
    expect(detectLanguages("2024", null)).toEqual(["ar"]);
  });
});

describe("buildDatasetJsonLd", () => {
  it("builds the full Dataset with absolute URLs and official distributions", () => {
    const ld = buildDatasetJsonLd(base);
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("Dataset");
    expect(ld.name).toBe("المواليد الأحياء");
    expect(ld.alternateName).toBe("Live Births");
    expect(ld.url).toBe("https://example.org/dataset/live-births");
    expect(ld.identifier).toBe("live-births");
    expect(ld.creator).toEqual({ "@type": "Organization", name: "Ministry of Health" });
    expect(ld.keywords).toEqual(["births", "health", "Health"]);
    expect(ld.license).toBe("Open Data License");
    expect(ld.dateModified).toBe("2026-03-01T08:00:00.000Z");
    expect(ld.inLanguage).toEqual(["ar", "en"]);
    expect(ld.isAccessibleForFree).toBe(true);
    expect(ld.includedInDataCatalog).toEqual({ "@type": "DataCatalog", name: "data.gov.bh", url: "https://www.data.gov.bh" });
    expect(ld.sameAs).toBe(base.officialPageUrl);
    expect(ld.variableMeasured).toEqual(["Year", "Governorate", "Births"]);
    expect(ld.distribution).toEqual([
      { "@type": "DataDownload", encodingFormat: "text/csv", contentUrl: base.csvUrl },
      { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: base.jsonUrl },
    ]);
  });

  it("encodes the id in the canonical url", () => {
    expect(buildDatasetJsonLd({ ...base, id: "a b/c" }).url).toBe("https://example.org/dataset/a%20b%2Fc");
  });

  it("drops absent optional properties instead of emitting nulls", () => {
    const ld = buildDatasetJsonLd({
      siteUrl: "https://example.org",
      id: "x",
      name: "Only a name",
      officialPageUrl: base.officialPageUrl,
      csvUrl: base.csvUrl,
      jsonUrl: base.jsonUrl,
    });
    for (const key of ["alternateName", "creator", "keywords", "license", "dateModified", "variableMeasured"]) {
      expect(ld).not.toHaveProperty(key);
    }
    expect(ld.description).toBe("Only a name");
    expect(JSON.stringify(ld)).not.toContain("null");
  });

  it("skips an unparseable modified date and blank publisher/license", () => {
    const ld = buildDatasetJsonLd({ ...base, sourceModified: "not a date", publisher: "  ", license: "" });
    expect(ld).not.toHaveProperty("dateModified");
    expect(ld).not.toHaveProperty("creator");
    expect(ld).not.toHaveProperty("license");
  });

  it("does not repeat an alternate name equal to the name", () => {
    expect(buildDatasetJsonLd({ ...base, alternateName: base.name })).not.toHaveProperty("alternateName");
  });

  it("truncates the description to 5000 characters and variables to 20 unique labels", () => {
    const ld = buildDatasetJsonLd({
      ...base,
      description: "word ".repeat(3000),
      fieldLabels: Array.from({ length: 40 }, (_, i) => `field ${i % 30}`),
    });
    expect((ld.description as string).length).toBeLessThanOrEqual(JSON_LD_MAX_DESCRIPTION);
    expect((ld.variableMeasured as string[]).length).toBe(JSON_LD_MAX_VARIABLES);
    expect(new Set(ld.variableMeasured as string[]).size).toBe(JSON_LD_MAX_VARIABLES);
  });

  it("advertises no official links for a removed dataset", () => {
    const ld = buildDatasetJsonLd({ ...base, removed: true });
    expect(ld).not.toHaveProperty("sameAs");
    expect(ld).not.toHaveProperty("distribution");
  });

  it("survives hostile text through the script serializer", () => {
    const ld = buildDatasetJsonLd({ ...base, name: "</script><img src=x onerror=alert(1)>", description: "<b>bold</b>" });
    const script = jsonLdScript(ld);
    expect(script).not.toMatch(/<\/?script/i);
    expect(JSON.parse(script).name).toBe("</script><img src=x onerror=alert(1)>");
  });
});

describe("buildBreadcrumbJsonLd", () => {
  it("numbers items consecutively and skips empty names", () => {
    const ld = buildBreadcrumbJsonLd([
      { name: "الرئيسية", url: "https://example.org" },
      { name: " ", url: "https://example.org/categories/" },
      { name: "Health", url: "https://example.org/categories/Health" },
      { name: "Live births", url: "https://example.org/dataset/live-births" },
    ]);
    expect(ld["@type"]).toBe("BreadcrumbList");
    expect(ld.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "الرئيسية", item: "https://example.org" },
      { "@type": "ListItem", position: 2, name: "Health", item: "https://example.org/categories/Health" },
      { "@type": "ListItem", position: 3, name: "Live births", item: "https://example.org/dataset/live-births" },
    ]);
  });
});
