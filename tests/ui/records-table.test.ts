import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { render, textOf } from "./render";
import { RecordsTable } from "@/components/records-table";
import type { RecordsPage } from "@/lib/queries";
import type { CatalogField } from "@/lib/sync/schemas";

const fields: CatalogField[] = [
  { name: "governorate", label: "Governorate", type: "text" },
  { name: "year", label: "Year", type: "int" },
];

function page(over: Partial<RecordsPage> = {}): RecordsPage {
  return {
    rows: [{ id: "1", data: { governorate: "Capital", year: 2015 } }],
    total: 1,
    page: 1,
    pageSize: 25,
    totalPages: 1,
    sortField: null,
    sortDir: "asc",
    rq: null,
    sortFailed: false,
    searchFailed: false,
    ...over,
  };
}

const table = (p: RecordsPage) => render(createElement(RecordsTable, { datasetId: "live-births", title: "Live Births", fields, stats: null, page: p }));

describe("RecordsTable (R5-03: header and cell share one edge)", () => {
  it("renders default text cells as shrink-wrapped inline-blocks, not full-width blocks", () => {
    const html = table(page());
    // A block span fills the cell and resolves text-align against its own (LTR) direction, which put
    // 'Capital' 215px away from its 'Governorate' header. Truncation at 18rem must survive the change.
    expect(html).toMatch(/<span dir="auto" class="inline-block max-w-\[18rem\] truncate align-top">Capital<\/span>/);
    expect(html).not.toMatch(/class="block max-w-\[18rem\] truncate"/);
  });
});

describe("RecordsTable (R5-04: Arabic number-noun agreement)", () => {
  const caption = (total: number, rowCount = Math.min(total, 25), extra: Partial<RecordsPage> = {}) =>
    textOf(table(page({ total, rows: Array.from({ length: rowCount }, (_, i) => ({ id: String(i), data: { governorate: "x" } })), ...extra })));

  it.each([
    [1, "من أصل سجل واحد"],
    [2, "من أصل سجلين"],
    [3, "من أصل 3 سجلات"],
    [10, "من أصل 10 سجلات"],
    [11, "من أصل 11 سجلًا"],
    [44, "من أصل 44 سجلًا"],
    [100000, "من أصل 100,000 سجلًا"],
  ])("%i records: ... %s", (total, expected) => {
    expect(caption(total)).toContain(expected);
  });

  it("states a search's hits without a verb that would need agreement", () => {
    const text = caption(6, 6, { rq: "cap" });
    expect(text).toContain("نتائج البحث عن «cap»: 6 سجلات");
    expect(caption(2, 2, { rq: "cap" })).toContain("نتائج البحث عن «cap»: سجلان");
    expect(caption(1, 1, { rq: "cap" })).toContain("نتائج البحث عن «cap»: سجل واحد");
  });
});

describe("RecordsTable (R5-11: pager jump and scroll cue)", () => {
  it("offers the page-jump form past 10 pages, carrying only the view that is set", () => {
    const html = table(page({ total: 100000, totalPages: 4000, page: 2000, sortField: "year", sortDir: "desc", rq: "cap" }));
    expect(html).toContain('name="page"');
    expect(html).toContain('action="/dataset/live-births#records"');
    expect(html).toContain('<input type="hidden" name="rq" value="cap"/>');
    expect(html).toContain('<input type="hidden" name="sort" value="year"/>');
    expect(html).toContain('<input type="hidden" name="dir" value="desc"/>');
    // the jump form's own number input is `page`: a stale hidden `page` field would shadow it
    expect(html).not.toContain('type="hidden" name="page"');
  });

  it("does not emit empty or default hidden fields", () => {
    const html = table(page({ total: 1000, totalPages: 40, page: 3 }));
    const jump = html.slice(html.indexOf('name="page"') - 400);
    expect(jump).not.toContain('name="rq"');
    expect(jump).not.toContain('name="sort"');
    expect(jump).not.toContain('name="dir"');
  });

  it("has no jump form on a short table", () => {
    expect(table(page({ total: 80, totalPages: 4, page: 1 }))).not.toContain('name="page"');
  });

  it("wraps the scrolling region in the scroll-cue (edge shadows) and says so on phones", () => {
    const html = table(page());
    expect(html).toMatch(/<div class="scroll-cue relative mt-2"><div role="region"[^>]*class="scroll-cue-track /);
    expect(textOf(html)).toContain("مرّر الجدول أفقيًا لعرض باقي الأعمدة");
    expect(html).toMatch(/<span aria-hidden="true" class="block sm:hidden print:hidden">/);
  });
});
