import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render } from "./render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/",
}));

import { SearchForm } from "@/components/search-form";
import { FilterBar, ActiveFilterChips } from "@/components/filter-bar";
import { Pagination } from "@/components/pagination";
import { RecordsTable } from "@/components/records-table";
import { HeroStatBand } from "@/components/hero-stat-band";
import { Breadcrumb } from "@/components/breadcrumb";
import { EmptyState } from "@/components/empty-state";
import { QueryText } from "@/components/listing-results";
import { buildListParams } from "@/lib/list-query";

/** Every text-entry control in the markup with its class tokens. */
function controls(html: string): Array<{ tag: string; type: string | null; tokens: string[] }> {
  const out: Array<{ tag: string; type: string | null; tokens: string[] }> = [];
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2];
    const type = /\btype="([^"]*)"/.exec(attrs)?.[1] ?? null;
    if (m[1] === "input" && (type === "hidden" || type === "checkbox" || type === "radio" || type === "submit")) continue;
    out.push({ tag: m[1], type, tokens: (/\bclass="([^"]*)"/.exec(attrs)?.[1] ?? "").split(/\s+/) });
  }
  return out;
}

/**
 * iOS Safari zooms the page when a control with a computed font-size under 16px gets focus. A control is
 * safe when its base size is `text-base` and the 14px size only applies from `sm` up for a mouse
 * (`pointer-coarse:text-base` takes it back to 16px on touch screens of any width, e.g. a rotated phone).
 */
function expectNoFocusZoom(html: string, expectedCount: number) {
  const found = controls(html);
  expect(found).toHaveLength(expectedCount);
  for (const c of found) {
    expect(c.tokens, `${c.tag} ${c.type}`).toContain("text-base");
    expect(c.tokens, `${c.tag} ${c.type}`).not.toContain("text-sm");
    if (c.tokens.includes("sm:text-sm")) expect(c.tokens, `${c.tag} ${c.type}`).toContain("pointer-coarse:text-base");
    expect(c.tokens.some((t) => /^(?:max-)?text-(?:xs|\[)/.test(t))).toBe(false);
  }
}

describe("R5-06: no form control triggers iOS focus zoom", () => {
  it("header search (size sm)", () => {
    expectNoFocusZoom(render(createElement(SearchForm, { size: "sm" })), 1);
  });

  it("hero / page search (sizes md and lg stay 16px)", () => {
    expectNoFocusZoom(render(createElement(SearchForm, { size: "md" })), 1);
    expectNoFocusZoom(render(createElement(SearchForm, { size: "lg" })), 1);
  });

  it("filter bar: query box and all four selects", () => {
    const params = buildListParams({ q: "health" });
    const html = render(
      createElement(FilterBar, {
        action: "/search",
        params,
        facets: { themes: [{ theme: "Health", count: 3 }], publishers: [{ slug: "moh", name: "Ministry of Health", count: 3 }] },
        theme: null,
        publisher: null,
        showQuery: true,
      }),
    );
    expectNoFocusZoom(html, 5);
  });

  it("records search box and the page-jump number input", () => {
    const html = render(
      createElement(RecordsTable, {
        datasetId: "d",
        title: "T",
        fields: [{ name: "a", label: "A", type: "text" }],
        stats: null,
        page: { rows: [{ id: "1", data: { a: "x" } }], total: 1000, page: 3, pageSize: 25, totalPages: 40, sortField: null, sortDir: "asc", rq: null, sortFailed: false, searchFailed: false },
      }),
    );
    expectNoFocusZoom(html, 2);
  });

  it("pager jump input alone", () => {
    expectNoFocusZoom(render(createElement(Pagination, { page: 2, totalPages: 30, hrefForPage: (p: number) => `/x?page=${p}`, jump: { action: "/x" } })), 1);
  });
});

describe("R5-11: the compact pager can reach a distant page", () => {
  it("wraps the jump form instead of overflowing a 320px screen", () => {
    const html = render(createElement(Pagination, { page: 2000, totalPages: 4000, hrefForPage: (p: number) => `/x?page=${p}`, jump: { action: "/x" } }));
    expect(html).toMatch(/<form[^>]*class="flex flex-wrap items-center justify-center gap-2 text-sm"/);
    expect(html).toContain('max="4000"');
  });
});

describe("R5-10: phone hero stat band", () => {
  const items = [
    { label: "مجموعات", value: "85" },
    { label: "جهات", value: "22" },
    { label: "سجلات", value: "1,234,567,890" },
  ];
  const band = () => render(createElement(HeroStatBand, { items }));

  it("is a 2-column grid below sm (not a stacked column) and a row from sm", () => {
    const html = band();
    expect(html).toMatch(/<dl class="grid grid-cols-2 [^"]*sm:flex sm:flex-row/);
    expect(html).not.toContain("flex-col gap-6");
  });

  it("gives an odd last stat the full width, so a long number cannot overflow a half-width cell", () => {
    const cells = [...band().matchAll(/<div class="(min-w-0[^"]*)">/g)].map((m) => m[1].split(" "));
    expect(cells).toHaveLength(3);
    expect(cells[2]).toContain("col-span-2");
    expect(cells[2]).toContain("sm:col-span-1");
    expect(cells[0]).not.toContain("col-span-2");
    // a hairline between the first row's two cells, one above the second row, none that dangles
    expect(cells[1]).toContain("border-s");
    expect(cells[2]).toContain("border-t");
    expect(cells[2]).toContain("sm:border-t-0");
    // from sm the row keeps its start-side hairline on every item but the first
    expect(cells[0]).not.toContain("sm:border-s");
    expect(cells[1]).toContain("sm:border-s");
    expect(cells[2]).toContain("sm:border-s");
  });

  it("scales the number down on phones", () => {
    expect(band()).toContain("text-2xl font-bold sm:text-3xl");
  });

  it("four stats make a 2x2 grid with no spanning cell", () => {
    const html = render(createElement(HeroStatBand, { items: [...items, { label: "د", value: "4" }] }));
    expect(html).not.toContain("col-span-2");
  });
});

describe("R5-05: one long unbroken token cannot widen the page", () => {
  const long = "a".repeat(100);

  it("breadcrumb items break anywhere (the title of a slug-like dataset)", () => {
    const html = render(createElement(Breadcrumb, { items: [{ label: "الرئيسية", href: "/" }, { label: "COVID19_Vaccination_Statistics_By_Governorate_And_Age_Group_Cumulative_2021_2022_Final" }] }));
    // `anywhere`, not `break-word`: only `anywhere` lowers the flex item's min-content width
    expect(html.match(/<li class="[^"]*\[overflow-wrap:anywhere\]/g)).toHaveLength(2);
    expect(html).toContain("min-w-0");
  });

  it("the query text, the active filter chip and the empty state break anywhere", () => {
    expect(render(createElement(QueryText, { q: long }))).toContain("[overflow-wrap:anywhere]");

    const params = buildListParams({ q: long });
    const chips = render(createElement(ActiveFilterChips, { basePath: "/search", params }));
    expect(chips).toMatch(/<span class="min-w-0 \[overflow-wrap:anywhere\]">/);
    expect(chips).toMatch(/<a[^>]*class="[^"]*max-w-full min-w-0/);

    const empty = render(createElement(EmptyState, { title: "t", description: createElement(QueryText, { q: long }) }));
    expect(empty).toMatch(/<p class="[^"]*\[overflow-wrap:anywhere\]/);
  });
});
