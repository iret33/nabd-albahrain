import { describe, expect, it } from "vitest";
import {
  absoluteUrl,
  alternatesFor,
  breadcrumbJsonLd,
  jsonLd,
  listingMetadata,
  openGraphFor,
  truncateText,
  websiteJsonLd,
} from "@/lib/seo";
import { SITE_URL } from "@/lib/site";

describe("truncateText", () => {
  it("returns short text unchanged (whitespace collapsed)", () => {
    expect(truncateText("  a   b\n c ")).toBe("a b c");
    expect(truncateText(null)).toBe("");
  });

  it("cuts at a word boundary with an ellipsis and stays within the limit", () => {
    const text = "word ".repeat(100);
    const out = truncateText(text, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/wor…$/);
  });

  it("hard-cuts a single very long word and strips trailing punctuation before the ellipsis", () => {
    expect(truncateText("x".repeat(300), 50)).toBe(`${"x".repeat(49)}…`);
    expect(truncateText("alpha beta, gamma delta epsilon zeta", 20)).toBe("alpha beta, gamma…");
  });

  it("works on Arabic text", () => {
    const out = truncateText("مجموعة بيانات عن المواليد الأحياء حسب المحافظة ".repeat(10), 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("jsonLd", () => {
  it("cannot be used to close the script element or inject markup", () => {
    const out = jsonLd({ name: `</script><script>alert(1)</script> & <b>`, sep: "a\u2028b\u2029c" });
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).not.toContain("&");
    expect(out).not.toContain("\u2028");
    expect(JSON.parse(out).name).toBe(`</script><script>alert(1)</script> & <b>`);
    expect(JSON.parse(out).sep).toBe("a\u2028b\u2029c");
  });
});

describe("JSON-LD builders", () => {
  it("builds a WebSite with a SearchAction pointing at /search", () => {
    const ld = websiteJsonLd();
    expect(ld["@type"]).toBe("WebSite");
    expect(ld.url).toBe(`${SITE_URL}/`);
    expect(ld.potentialAction.target.urlTemplate).toBe(`${SITE_URL}/search?q={search_term_string}`);
    expect(ld.inLanguage).toBe("ar");
  });

  it("builds a BreadcrumbList starting at home with 1-based positions and absolute urls", () => {
    const ld = breadcrumbJsonLd([{ name: "الفئات", path: "/categories" }, { name: "الصحة" }]);
    expect(ld.itemListElement.map((i) => i.position)).toEqual([1, 2, 3]);
    expect(ld.itemListElement[0].item).toBe(`${SITE_URL}/`);
    expect(ld.itemListElement[1].item).toBe(`${SITE_URL}/categories`);
    expect(ld.itemListElement[2]).not.toHaveProperty("item");
  });
});

describe("listingMetadata", () => {
  const base = { title: "الصحة", description: "d", path: "/categories/%D8%A7" };

  it("canonicalizes page 1 to the plain path", () => {
    const m = listingMetadata({ ...base, page: 1 });
    expect(m.alternates?.canonical).toBe(base.path);
    expect(m.title).toBe("الصحة");
    expect(m.robots).toBeUndefined();
  });

  it("canonicalizes page N>1 to itself and says so in the title", () => {
    const m = listingMetadata({ ...base, page: 3 });
    expect(m.alternates?.canonical).toBe(`${base.path}?page=3`);
    expect(String(m.title)).toContain("صفحة 3");
  });

  it("folds filtered views into the plain listing and marks them noindex,follow", () => {
    const m = listingMetadata({ ...base, page: 3, noindex: true });
    expect(m.alternates?.canonical).toBe(base.path);
    expect(m.robots).toEqual({ index: false, follow: true });
    expect(String(m.title)).not.toContain("صفحة");
  });

  it("keeps the Atom feed advertisement on every override of `alternates`", () => {
    expect(alternatesFor("/x").types).toEqual({ "application/atom+xml": [{ url: "/feed.xml", title: expect.any(String) }] });
  });
});

describe("openGraphFor / absoluteUrl", () => {
  it("keeps type, siteName and locale and suffixes the site name once", () => {
    const og = openGraphFor({ title: "آخر التحديثات", description: "d", path: "/updates" });
    expect(og).toMatchObject({ type: "website", siteName: "نبض البحرين", locale: "ar_BH", title: "آخر التحديثات | نبض البحرين" });
  });

  it("names the brand image explicitly (a page-level openGraph/twitter object would otherwise drop it)", () => {
    const og = openGraphFor({ title: "x", description: "d", path: "/x" });
    expect(og.images).toEqual([{ url: "/opengraph-image.png", width: 1200, height: 630, alt: expect.any(String) }]);
    const m = listingMetadata({ title: "x", description: "d", path: "/x" });
    expect(m.twitter).toMatchObject({ card: "summary_large_image", images: [{ url: "/twitter-image.png", width: 1200, height: 630 }] });
  });

  it("does not repeat the brand for the home page title", () => {
    expect(openGraphFor({ title: "نبض البحرين", description: "d", path: "/" }).title).toBe("نبض البحرين | Nabd Al-Bahrain");
  });

  it("builds absolute urls from the site origin", () => {
    expect(absoluteUrl("/updates")).toBe(`${SITE_URL}/updates`);
    expect(absoluteUrl("updates")).toBe(`${SITE_URL}/updates`);
  });
});
