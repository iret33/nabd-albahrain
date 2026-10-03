import { describe, expect, it } from "vitest";
import { escapeLike, normalizeSearch, tokenize } from "@/lib/search";
import { first, parsePage, parseQuery } from "@/lib/params";
import { rateLimit } from "@/lib/rate-limit";
import { formatRelativeAr, displayTitle } from "@/lib/format";

describe("normalizeSearch", () => {
  it("folds Arabic letter variants", () => {
    expect(normalizeSearch("إحصائيات الأسرة")).toBe(normalizeSearch("احصائيات الاسره"));
    expect(normalizeSearch("مدرسة")).toBe(normalizeSearch("مدرسه"));
    expect(normalizeSearch("على")).toBe(normalizeSearch("علي"));
  });
  it("strips diacritics and tatweel but keeps Arabic-Indic digits as ASCII", () => {
    expect(normalizeSearch("سَنَـة ٢٠٢٠")).toBe("سنه 2020");
  });
  it("lowercases Latin, replaces punctuation, collapses whitespace", () => {
    expect(normalizeSearch("  Covid-19  Cases!! ")).toBe("covid 19 cases");
  });
  it("handles empty input", () => {
    expect(normalizeSearch(null)).toBe("");
    expect(normalizeSearch("")).toBe("");
  });
});

describe("tokenize", () => {
  it("drops 1-char non-digit tokens, dedupes and caps", () => {
    expect(tokenize("a population population 2020 x")).toEqual(["population", "2020"]);
    expect(tokenize("a b c d e f g h i j k l m n").length).toBe(0);
    expect(tokenize("one two three four five six seven eight").length).toBe(6);
  });
});

describe("escapeLike", () => {
  it("escapes LIKE metacharacters", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
  });
});

describe("params", () => {
  it("parsePage rejects hostile values", () => {
    for (const bad of ["1e21", "Infinity", "0x10", "1.5", "-3", "", "abc", "999999999"]) {
      expect(parsePage(bad)).toBe(1);
    }
    expect(parsePage("7")).toBe(7);
    expect(parsePage(["3", "9"])).toBe(3);
    expect(parsePage("99999")).toBe(10_000);
  });
  it("first/parseQuery handle arrays and caps", () => {
    expect(first(["a", "b"])).toBe("a");
    expect(parseQuery(["  hello  ", "x"])).toBe("hello");
    expect(parseQuery("x".repeat(500)).length).toBe(100);
  });
});

describe("rateLimit", () => {
  it("blocks after the limit and reports retry-after", () => {
    const key = `t-${Math.random()}`;
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) expect(rateLimit(key, { limit: 3, windowMs: 60_000 }, now).ok).toBe(true);
    const blocked = rateLimit(key, { limit: 3, windowMs: 60_000 }, now + 1000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(59);
    expect(rateLimit(key, { limit: 3, windowMs: 60_000 }, now + 61_000).ok).toBe(true);
  });
});

describe("format helpers", () => {
  it("formatRelativeAr uses Latin digits and handles just-now", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    expect(formatRelativeAr(new Date("2026-10-03T11:55:00Z"), now)).toMatch(/5/);
    expect(formatRelativeAr(new Date("2026-10-03T11:55:00Z"), now)).not.toMatch(/[٠-٩]/);
    expect(formatRelativeAr(null)).toBe("—");
  });
  it("displayTitle prefers Arabic", () => {
    expect(displayTitle({ titleAr: " عنوان ", titleClean: "Title" })).toBe("عنوان");
    expect(displayTitle({ titleAr: null, titleClean: "Title" })).toBe("Title");
  });
});
