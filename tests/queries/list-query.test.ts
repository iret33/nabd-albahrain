import { describe, expect, it } from "vitest";
import {
  activeFilters,
  buildListParams,
  defaultSortFor,
  listHref,
  pageHref,
  parseListParams,
  removeFilterHref,
  sinceCutoff,
} from "@/lib/list-query";

describe("parseListParams", () => {
  it("returns safe defaults for an empty query string", () => {
    expect(parseListParams({})).toEqual({
      q: "",
      tokens: [],
      theme: null,
      publisher: null,
      sort: "title",
      hasChart: false,
      since: null,
      page: 1,
    });
  });

  it("treats a missing params object as empty", () => {
    expect(parseListParams(undefined)).toEqual(parseListParams({}));
    expect(parseListParams(null)).toEqual(parseListParams({}));
  });

  it("parses every supported parameter", () => {
    const p = parseListParams({
      q: "  Live Births ",
      theme: "Health",
      publisher: "ministry-of-health",
      sort: "updated",
      chart: "1",
      since: "30d",
      page: "3",
    });
    expect(p).toEqual({
      q: "Live Births",
      tokens: ["live", "births"],
      theme: "Health",
      publisher: "ministry-of-health",
      sort: "updated",
      hasChart: true,
      since: "30d",
      page: 3,
    });
  });

  it("defaults to relevance when there is a query and title otherwise", () => {
    expect(parseListParams({ q: "health" }).sort).toBe("relevance");
    expect(parseListParams({}).sort).toBe("title");
    expect(defaultSortFor(["a"])).toBe("relevance");
  });

  it("falls back from relevance to title when the query has no usable token", () => {
    expect(parseListParams({ q: "a", sort: "relevance" }).sort).toBe("title");
    expect(parseListParams({ sort: "relevance" }).sort).toBe("title");
  });

  it("survives repeated keys, arrays and hostile values", () => {
    const p = parseListParams({
      q: ["first", "second"],
      page: ["2", "9"],
      sort: ["bogus"],
      since: "99y",
      chart: ["yes"],
      theme: "   ",
    });
    expect(p.q).toBe("first");
    expect(p.page).toBe(2);
    expect(p.sort).toBe("relevance");
    expect(p.since).toBeNull();
    expect(p.hasChart).toBe(true);
    expect(p.theme).toBeNull();
  });

  it("rejects page values that are not plain digits", () => {
    for (const bad of ["1e21", "Infinity", "0x10", "1.5", "-3", "", "abc", "NaN"]) {
      expect(parseListParams({ page: bad }).page).toBe(1);
    }
    expect(parseListParams({ page: "99999" }).page).toBe(10_000);
  });

  it("caps the query at 100 characters and the token count at 6", () => {
    const p = parseListParams({ q: "word ".repeat(80) });
    expect(p.q.length).toBeLessThanOrEqual(100);
    expect(p.tokens.length).toBeLessThanOrEqual(6);
    const many = parseListParams({ q: "aa bb cc dd ee ff gg hh" });
    expect(many.tokens).toHaveLength(6);
  });

  it("treats a query with nothing searchable as having no tokens", () => {
    for (const q of ["%", "_", "a", "!!", "  "]) {
      expect(parseListParams({ q }).tokens).toEqual([]);
    }
  });

  it("normalizes Arabic variants in tokens", () => {
    // hamza-on-alef -> alef, hamza-on-ya -> ya, Arabic-Indic digits -> ASCII
    expect(parseListParams({ q: "إحصائيات ٢٠٢٠" }).tokens).toEqual(["احصاييات", "2020"]);
    expect(parseListParams({ q: "احصاييات" }).tokens).toEqual(["احصاييات"]);
  });

  it("accepts URLSearchParams (route handlers) including the hasChart alias", () => {
    const p = parseListParams(new URLSearchParams("q=water&hasChart=true&page=2&q=ignored"));
    expect(p.q).toBe("water");
    expect(p.hasChart).toBe(true);
    expect(p.page).toBe(2);
  });

  it("does not resolve prototype members as parameters", () => {
    const p = parseListParams(JSON.parse('{"__proto__":"x","constructor":"y"}') as Record<string, string>);
    expect(p.q).toBe("");
    expect(parseListParams({}).theme).toBeNull();
  });
});

describe("buildListParams", () => {
  it("is idempotent", () => {
    const once = buildListParams({ q: "Health Care", theme: "Health", sort: "records", hasChart: true, since: "1y", page: 4 });
    expect(buildListParams(once)).toEqual(once);
  });

  it("ignores caller-supplied tokens (always derived from q)", () => {
    const p = buildListParams({ q: "water", tokens: ["evil"] } as never);
    expect(p.tokens).toEqual(["water"]);
  });

  it("sanitizes non-integer / unsafe pages", () => {
    expect(buildListParams({ page: 2.5 }).page).toBe(1);
    expect(buildListParams({ page: Infinity }).page).toBe(1);
    expect(buildListParams({ page: Number.NaN }).page).toBe(1);
    expect(buildListParams({ page: 1e21 }).page).toBe(1);
    expect(buildListParams({ page: 0 }).page).toBe(1);
    expect(buildListParams({ page: 42 }).page).toBe(42);
  });
});

describe("href helpers", () => {
  const base = buildListParams({ q: "health", theme: "Health", sort: "updated", hasChart: true, since: "30d", page: 3 });

  it("serializes only non-default values", () => {
    expect(listHref("/search", buildListParams({}))).toBe("/search");
    expect(listHref("/search", buildListParams({ q: "water" }))).toBe("/search?q=water");
  });

  it("round-trips through parseListParams", () => {
    const href = listHref("/search", base);
    const parsed = parseListParams(new URL(href, "http://x").searchParams);
    expect(parsed).toEqual(base);
  });

  it("keeps every filter when changing the page", () => {
    const href = pageHref("/search", base, 4);
    expect(parseListParams(new URL(href, "http://x").searchParams)).toEqual({ ...base, page: 4 });
  });

  it("resets to page 1 when a filter changes", () => {
    const href = listHref("/search", base, { sort: "records" });
    expect(parseListParams(new URL(href, "http://x").searchParams).page).toBe(1);
    expect(parseListParams(new URL(href, "http://x").searchParams).sort).toBe("records");
  });

  it("omits params the path already carries", () => {
    const href = listHref("/categories/Health", base, {}, ["theme"]);
    expect(href).not.toContain("theme=");
    expect(href).toContain("q=health");
  });

  it("removeFilterHref drops exactly one filter", () => {
    const noChart = new URL(removeFilterHref("/search", base, "chart"), "http://x").searchParams;
    expect(noChart.get("chart")).toBeNull();
    expect(noChart.get("theme")).toBe("Health");
    expect(noChart.get("since")).toBe("30d");
    expect(noChart.get("page")).toBeNull();
    const noQ = new URL(removeFilterHref("/search", base, "q"), "http://x").searchParams;
    expect(noQ.get("q")).toBeNull();
    // The sort that was explicit stays explicit; "relevance" does not survive losing the query.
    expect(parseListParams(noQ).sort).toBe("updated");
  });

  it("a default sort does not stick to a new query", () => {
    const browse = buildListParams({ theme: "Health" });
    const href = listHref("/search", browse, { q: "water" });
    expect(new URL(href, "http://x").searchParams.get("sort")).toBeNull();
  });

  it("encodes awkward values", () => {
    const href = listHref("/search", buildListParams({ q: "a&b=c d" }));
    expect(new URL(href, "http://x").searchParams.get("q")).toBe("a&b=c d");
  });

  it("activeFilters lists chips and honors omit", () => {
    expect(activeFilters(base).map((f) => f.key)).toEqual(["q", "theme", "chart", "since"]);
    expect(activeFilters(base, ["theme"]).map((f) => f.key)).toEqual(["q", "chart", "since"]);
  });
});

describe("sinceCutoff", () => {
  const now = new Date("2026-10-03T00:00:00Z");
  it("computes the window start", () => {
    expect(sinceCutoff("30d", now).toISOString()).toBe("2026-09-03T00:00:00.000Z");
    expect(sinceCutoff("1y", now).toISOString()).toBe("2025-10-03T00:00:00.000Z");
  });
});
