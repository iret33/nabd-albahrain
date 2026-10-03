import { describe, expect, it } from "vitest";
import robots from "@/app/robots";

describe("robots.txt rules", () => {
  const out = robots();
  const rule = (Array.isArray(out.rules) ? out.rules[0] : out.rules) as { allow?: string | string[]; disallow?: string | string[] };
  const disallow = ([] as string[]).concat(rule.disallow ?? []);

  it("keeps the site crawlable but blocks admin, API and search", () => {
    expect(rule.allow).toBe("/");
    for (const p of ["/admin", "/api/", "/search"]) expect(disallow).toContain(p);
  });

  it("blocks the records-table sort/page URL space on dataset pages", () => {
    for (const p of ["/dataset/*?*sort=", "/dataset/*?*dir=", "/dataset/*?*page=", "/dataset/*?*rq="]) {
      expect(disallow).toContain(p);
    }
  });

  it("keeps ?page= crawlable on /categories and /publishers", () => {
    expect(disallow.some((p) => /^\/(categories|publishers)\/\*\?\*page=$/.test(p))).toBe(false);
  });

  it("blocks the listing filter URL space", () => {
    for (const p of ["/categories/*?*sort=", "/categories/*?*q=", "/publishers/*?*sort=", "/publishers/*?*q="]) {
      expect(disallow).toContain(p);
    }
  });

  it("advertises the sitemap", () => {
    expect(out.sitemap).toMatch(/\/sitemap\.xml$/);
  });
});
