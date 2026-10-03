import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import { listingMetadata } from "@/lib/seo";
import { isRefinedRecordsView, parseRecordsParams } from "@/lib/dataset-page";
import { activeFilters, parseListParams } from "@/lib/list-query";

describe("robots.txt rules", () => {
  const out = robots();
  const rule = (Array.isArray(out.rules) ? out.rules[0] : out.rules) as { allow?: string | string[]; disallow?: string | string[] };
  const disallow = ([] as string[]).concat(rule.disallow ?? []);

  it("keeps the site crawlable and blocks only admin and the API", () => {
    expect(rule.allow).toBe("/");
    expect(disallow).toEqual(["/admin", "/api/"]);
  });

  it("does not hide ANY page that carries a noindex: a Disallow makes the crawler skip the tag (R2-12)", () => {
    // Every URL below answers `<meta name="robots" content="noindex, follow">` (see the page tests that follow).
    const noindexUrls = [
      "/search",
      "/search?q=health",
      "/categories/Health?sort=updated",
      "/categories/Health?q=x",
      "/categories/Health?chart=1",
      "/categories/Health?since=30d",
      "/categories/Health?publisher=ministry-of-health",
      "/publishers/ministry-of-health?theme=Health",
      "/publishers/ministry-of-health?sort=updated",
      "/dataset/abc?page=2",
      "/dataset/abc?sort=value&dir=asc",
      "/dataset/abc?rq=text",
      "/updates?days=7",
    ];
    for (const url of noindexUrls) {
      const blockedBy = disallow.filter((pattern) => url.startsWith(pattern.replace(/\*.*$/, "")));
      expect(blockedBy, `${url} must stay crawlable so its noindex is seen`).toEqual([]);
    }
  });

  it("advertises the sitemap", () => {
    expect(out.sitemap).toMatch(/\/sitemap\.xml$/);
  });
});

describe("the noindex that replaces the Disallow is really there", () => {
  const noindex = (m: ReturnType<typeof listingMetadata>) => (m.robots as { index?: boolean; follow?: boolean } | undefined) ?? {};

  it("filtered and sorted listings are noindex,follow and canonicalize to the plain listing", () => {
    const meta = listingMetadata({ title: "x", description: "d", path: "/categories/Health", page: 3, noindex: true });
    expect(noindex(meta)).toEqual({ index: false, follow: true });
    expect((meta.alternates as { canonical: string }).canonical).toBe("/categories/Health");
  });

  it("every listing filter the old Disallow patterns named is an active filter, hence noindex on the listing pages", () => {
    for (const [query, key] of [
      ["q=x", "q"],
      ["chart=1", "chart"],
      ["hasChart=1", "chart"],
      ["since=30d", "since"],
      ["publisher=a-b", "publisher"],
      ["theme=Health", "theme"],
    ] as const) {
      const params = parseListParams(new URLSearchParams(query));
      expect(activeFilters(params).map((f) => f.key), query).toContain(key);
    }
    expect(parseListParams(new URLSearchParams("sort=updated")).sort).toBe("updated");
  });

  it("a dataset's records view with page, sort, dir or rq is a 'refined view' (the dataset page marks it noindex)", () => {
    for (const query of ["page=2", "sort=value", "dir=desc", "rq=text"]) {
      const params = parseRecordsParams(Object.fromEntries(new URLSearchParams(query)));
      expect(isRefinedRecordsView(params), query).toBe(true);
    }
    expect(isRefinedRecordsView(parseRecordsParams({}))).toBe(false);
  });
});
