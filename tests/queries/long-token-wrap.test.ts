import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R5-05: an unbroken 100-character ?q= (a pasted URL) widened /search to ~900px on a 360px phone, header and
 * all. The fix is one inherited CSS property, `overflow-wrap: anywhere` (NOT `break-word`: only `anywhere` lowers
 * the min-content width a flex item refuses to shrink below), on the heading and on the results area that echoes
 * the query (the active-query chip, the empty-state sentence). It is verified in a browser (scrollWidth ==
 * clientWidth at 320/360 px); this test only keeps the class from being dropped by a refactor.
 */
const read = (file: string) => fs.readFileSync(path.join(__dirname, "../../src/app", file), "utf8");
const ANYWHERE = "[overflow-wrap:anywhere]";

describe("long unbroken tokens wrap instead of widening the page", () => {
  it("the search heading, which echoes the query, wraps", () => {
    expect(read("search/page.tsx")).toMatch(/<h1 className="[^"]*\[overflow-wrap:anywhere\][^"]*"/);
  });

  it.each(["search/page.tsx", "categories/[theme]/page.tsx", "publishers/[slug]/page.tsx"])(
    "%s wraps its results area (chip and empty state echo the query)",
    (file) => {
      expect(read(file)).toMatch(new RegExp(`<div className="mt-8 ${ANYWHERE.replace(/[[\]]/g, "\\$&")}">`));
    },
  );
});
