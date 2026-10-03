import Link from "next/link";
import type { ReactNode } from "react";
import type { StatsJson } from "@/lib/sync/derived";
import type { CatalogField } from "@/lib/sync/schemas";
import type { RecordsPage } from "@/lib/queries";
import { buildColumns, formatCell, type CellModel, type ColumnMeta } from "@/lib/cell-format";
import { recordsHref, recordsRange } from "@/lib/dataset-page";
import { MAX_RECORDS_QUERY_LENGTH } from "@/lib/records-query";
import { NOUNS } from "@/lib/arabic-count";
import { CountNoun } from "@/components/count-noun";
import { NumberLatin } from "@/components/number-latin";
import { Pagination } from "@/components/pagination";

function Cell({ model }: { model: CellModel }): ReactNode {
  switch (model.kind) {
    case "empty":
      return (
        <>
          <span aria-hidden="true" className="text-ink/60">
            —
          </span>
          <span className="sr-only">لا توجد قيمة</span>
        </>
      );
    case "number":
      return <NumberLatin value={model.text} />;
    case "boolean":
      return model.text;
    case "date":
      return (
        <time dateTime={model.iso} className="whitespace-nowrap">
          {model.text}
        </time>
      );
    case "geo":
      return (
        <a
          href={model.href}
          target="_blank"
          rel="noopener noreferrer"
          dir="ltr"
          aria-label={`عرض الموقع ${model.text} على خريطة OpenStreetMap`}
          className="tabular-figures inline-block whitespace-nowrap rounded underline decoration-pearl decoration-2 underline-offset-4 transition-colors hover:text-coral"
        >
          {model.text}
        </a>
      );
    case "object":
      return (
        <span title={model.title} className="whitespace-nowrap text-ink/70">
          {model.label}
        </span>
      );
    default:
      // `inline-block`, not `block`: a block span fills the cell, and its `dir="auto"` (LTR for Latin text or
      // digits) then resolves text-align against ITS direction, so the text lands on the opposite side from the
      // column header. As an atomic inline the cell's own `text-start`/`text-end` places it, shrink-wrapped, so
      // header and cell share one edge. It still truncates at 18rem (`overflow: hidden` needs a box, so a plain
      // inline span would lose the cap); `align-top` keeps the overflow-hidden box off the baseline.
      return (
        <span dir="auto" title={model.title} className="inline-block max-w-[18rem] truncate align-top">
          {model.text}
        </span>
      );
  }
}

function cellClass(column: ColumnMeta): string {
  const base = "px-4 py-2.5 align-top text-ink print:px-2 print:py-1 print:break-inside-avoid";
  if (column.numeric) return `${base} tabular-figures whitespace-nowrap text-end`;
  if (column.plainDigits) return `${base} tabular-figures whitespace-nowrap text-start`;
  return `${base} text-start`;
}

const buttonClass =
  "inline-flex min-h-11 items-center justify-center rounded-full bg-sea-900 px-5 text-sm font-bold text-sand-50 transition-colors hover:bg-sea-800";

/**
 * Server-paginated (25/page), server-sortable, searchable raw records table:
 * the one place raw DatasetRecord rows reach the client, and only a page at a
 * time. Sorting, searching and paging are plain links and a GET form (query
 * params), so this stays a Server Component with zero client JS.
 *
 *  - Cells are formatted per column (`src/lib/cell-format.ts`): years/ids are
 *    never comma-grouped, doubles keep their decimals, dates and coordinates
 *    are readable. Text is `dir="auto"` and truncated with the full value in a
 *    tooltip; numeric columns are end-aligned with tabular digits.
 *  - Headers are real `scope="col"` cells with `aria-sort`; only columns the
 *    data layer can order get a link. Sort and pager links are `nofollow`
 *    (every combination is a cold query; the page is `noindex` too).
 *  - The header row is sticky inside the scroll container, which is itself a
 *    keyboard-focusable, labelled region (wide tables scroll sideways). The
 *    container is `relative` on purpose: the `sr-only` texts inside cells are
 *    absolutely positioned, and without a positioned ancestor they escape the
 *    overflow clip and widen the whole page.
 *  - The search form renders even when nothing matches, so it can be cleared.
 *  - Past 10 pages the pager gets a "go to page" form (a GET form that keeps the
 *    search and sort), so page 1,500 of a 50,000-row table is one entry. A table
 *    wider than its box shows edge shadows where columns are hidden
 *    (`scroll-cue`, CSS only, where scroll-driven animations exist) and, on
 *    phones, a one-line hint.
 */
export function RecordsTable({
  datasetId,
  title,
  fields,
  stats,
  page: recordsPage,
}: {
  datasetId: string;
  /** The dataset's display title, for the table caption. */
  title: string;
  fields: readonly CatalogField[];
  stats: StatsJson | null;
  page: RecordsPage;
}) {
  const columns = buildColumns(fields, stats);
  const { sortField, sortDir, rq } = recordsPage;
  const view = { rq, sort: sortField, dir: sortDir };
  const range = recordsRange(recordsPage.page, recordsPage.pageSize, recordsPage.total, recordsPage.rows.length);
  const clearHref = recordsHref(datasetId, { sort: sortField, dir: sortDir });
  const searchId = `records-search-${datasetId}`.replace(/[^A-Za-z0-9_-]/g, "-");
  // The page-jump form carries the rest of the view as hidden fields, only when set (an empty `rq=` would
  // pollute the URL) and never `page`: the form's own number input is named `page`.
  const jumpFields: Array<readonly [string, string]> = [];
  if (rq) jumpFields.push(["rq", rq]);
  if (sortField) jumpFields.push(["sort", sortField], ["dir", sortDir]);

  return (
    <div id="records" className="scroll-mt-24">
      <form
        action={`/dataset/${encodeURIComponent(datasetId)}#records`}
        method="GET"
        role="search"
        aria-label="البحث في سجلات المجموعة"
        className="flex flex-wrap items-center gap-2 print:hidden"
      >
        <label htmlFor={searchId} className="sr-only">
          ابحث في السجلات
        </label>
        <input
          id={searchId}
          type="search"
          name="rq"
          defaultValue={rq ?? ""}
          maxLength={MAX_RECORDS_QUERY_LENGTH}
          placeholder="ابحث في السجلات"
          autoComplete="off"
          enterKeyHint="search"
          className="min-h-11 min-w-0 flex-1 basis-56 rounded-full border border-ink/55 bg-white px-4 text-base text-ink placeholder:text-ink/70 sm:max-w-sm sm:text-sm pointer-coarse:text-base"
        />
        {sortField && (
          <>
            <input type="hidden" name="sort" value={sortField} />
            <input type="hidden" name="dir" value={sortDir} />
          </>
        )}
        <button type="submit" className={buttonClass}>
          بحث
        </button>
        {rq && (
          <Link
            href={clearHref}
            rel="nofollow"
            className="inline-flex min-h-11 items-center rounded-full px-3 text-sm font-medium text-coral underline decoration-2 underline-offset-4"
          >
            مسح البحث
          </Link>
        )}
      </form>

      {recordsPage.searchFailed ? (
        <p role="status" className="mt-4 rounded-xl border border-coral/40 bg-coral/5 px-4 py-3 text-sm leading-7 text-ink/80">
          {recordsPage.throttled
            ? "طلبات البحث والفرز كثيرة الآن فلم يُنفَّذ طلبك. انتظر لحظات ثم أعد المحاولة، أو "
            : "تعذّر إكمال البحث الآن (استغرق وقتًا أطول من المسموح). جرّب كلمة أدق أو "}{" "}
          <Link href={clearHref} rel="nofollow" className="font-medium text-coral underline underline-offset-4">
            امسح البحث
          </Link>
          .
        </p>
      ) : recordsPage.rows.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-line-light bg-white px-6 py-12 text-center text-sm leading-7 text-ink/80">
          {rq ? (
            <>
              لا توجد سجلات تطابق «<bdi>{rq}</bdi>».{" "}
              <Link href={clearHref} rel="nofollow" className="font-medium text-coral underline underline-offset-4">
                مسح البحث
              </Link>
            </>
          ) : (
            "لا توجد سجلات لعرضها."
          )}
        </div>
      ) : (
        <>
          <p className="mt-4 text-xs leading-6 text-ink/70">
            {rq ? (
              <>
                نتائج البحث عن «<bdi>{rq}</bdi>»: <CountNoun n={recordsPage.total} forms={NOUNS.record} /> — يُعرض من{" "}
              </>
            ) : (
              <>يُعرض من </>
            )}
            <NumberLatin value={range.from} /> إلى <NumberLatin value={range.to} />
            {!rq && (
              <>
                {" "}
                من أصل <CountNoun n={recordsPage.total} forms={NOUNS.record} oblique />
              </>
            )}
            {recordsPage.sortFailed &&
              (recordsPage.throttled
                ? " — الفرز مشغول الآن فعُرضت السجلات بترتيبها الأصلي، أعد المحاولة بعد لحظات"
                : " — تعذّر الفرز فعُرضت السجلات بترتيبها الأصلي")}
            {/* Phones: the table is wider than the screen and nothing else says so (the edge shadows only show once it moves). */}
            <span aria-hidden="true" className="block sm:hidden print:hidden">
              ↔ مرّر الجدول أفقيًا لعرض باقي الأعمدة
            </span>
          </p>

          <div className="scroll-cue relative mt-2">
            <div
              role="region"
              aria-label="جدول السجلات (يمكن تمريره أفقيًا)"
              tabIndex={0}
              className="scroll-cue-track relative max-h-[65vh] overflow-auto rounded-2xl border border-line-light bg-white shadow-sm print:max-h-none print:overflow-visible"
            >
              <table className="w-full min-w-[640px] border-collapse text-sm print:min-w-0 print:text-[11px]">
                <caption className="sr-only">
                  {title} — السجلات من {range.from} إلى {range.to} من أصل {recordsPage.total}
                </caption>
                <thead>
                  <tr>
                    {columns.map((column) => {
                      const isSorted = sortField === column.name;
                      const ariaSort = !column.sortable ? undefined : isSorted ? (sortDir === "asc" ? "ascending" : "descending") : "none";
                      const nextDir = isSorted && sortDir === "asc" ? "desc" : "asc";
                      const align = column.numeric ? "text-end" : "text-start";
                      return (
                        <th
                          key={column.name}
                          scope="col"
                          aria-sort={ariaSort}
                          className={`sticky top-0 z-10 whitespace-nowrap bg-sand-50 px-4 py-2 print:static print:px-2 text-xs font-medium text-ink/80 shadow-[inset_0_-1px_0_var(--line-light)] ${align}`}
                        >
                          {column.sortable ? (
                            <Link
                              href={recordsHref(datasetId, { rq, sort: column.name, dir: nextDir })}
                              rel="nofollow"
                              title={`ترتيب حسب ${column.label}`}
                              className="inline-flex min-h-9 items-center gap-1 rounded transition-colors hover:text-coral"
                            >
                              <bdi>{column.label}</bdi>
                              <span aria-hidden="true" className={isSorted ? "text-coral" : "text-ink/50"}>
                                {isSorted ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                              </span>
                            </Link>
                          ) : (
                            <span className="inline-flex min-h-9 items-center">
                              <bdi>{column.label}</bdi>
                            </span>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {recordsPage.rows.map((row) => (
                    <tr key={row.id} className="border-b border-line-light/70 last:border-0 hover:bg-sand-50/60">
                      {columns.map((column) => (
                        <td key={column.name} className={cellClass(column)}>
                          <Cell model={formatCell(row.data[column.name], column)} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <Pagination
        page={recordsPage.page}
        totalPages={recordsPage.totalPages}
        hrefForPage={(p) => recordsHref(datasetId, { ...view, page: p })}
        jump={{ action: `/dataset/${encodeURIComponent(datasetId)}#records`, hidden: jumpFields }}
        nofollow
      />
    </div>
  );
}
