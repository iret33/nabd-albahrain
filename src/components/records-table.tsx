import Link from "next/link";
import type { ReactNode } from "react";
import type { CatalogField } from "@/lib/sync/schemas";
import type { RecordsPage } from "@/lib/queries";
import { NumberLatin } from "@/components/number-latin";
import { Pagination } from "@/components/pagination";

function cellDisplay(value: unknown): ReactNode {
  if (value === null || value === undefined || value === "") return <span className="text-ink/30">—</span>;
  if (typeof value === "number") return <NumberLatin value={value} />;
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  if (typeof value === "object") return <span className="text-ink/40">{JSON.stringify(value)}</span>;
  return String(value);
}

/**
 * Server-paginated (25/page), server-sortable raw records table — the one
 * place raw DatasetRecord rows reach the client, and only a page at a
 * time. Sorting/pagination are plain links (query params), so this stays
 * a Server Component with zero client JS.
 */
export function RecordsTable({
  datasetId,
  fields,
  page: recordsPage,
}: {
  datasetId: string;
  fields: CatalogField[];
  page: RecordsPage;
}) {
  const columns = fields.filter((f): f is CatalogField & { name: string } => Boolean(f.name));

  function hrefFor(page: number, sort?: string, dir?: "asc" | "desc"): string {
    const params = new URLSearchParams();
    params.set("page", String(page));
    if (sort) {
      params.set("sort", sort);
      params.set("dir", dir ?? "asc");
    }
    return `/dataset/${encodeURIComponent(datasetId)}?${params.toString()}#records`;
  }

  function headerHref(fieldName: string): string {
    const isCurrentSort = recordsPage.sortField === fieldName;
    const nextDir: "asc" | "desc" = isCurrentSort && recordsPage.sortDir === "asc" ? "desc" : "asc";
    return hrefFor(1, fieldName, nextDir);
  }

  if (recordsPage.rows.length === 0) {
    return (
      <div id="records" className="rounded-2xl border border-dashed border-line-light bg-white px-6 py-12 text-center text-sm text-ink/60">
        لا توجد سجلات لعرضها.
      </div>
    );
  }

  return (
    <div id="records">
      <div className="overflow-x-auto rounded-2xl border border-line-light bg-white shadow-sm">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line-light bg-sand-50 text-xs text-ink/60">
              {columns.map((f) => {
                const isSorted = recordsPage.sortField === f.name;
                return (
                  <th key={f.name} className="whitespace-nowrap px-4 py-3 text-start font-medium">
                    <Link href={headerHref(f.name)} className="inline-flex items-center gap-1 rounded transition-colors hover:text-coral">
                      {(f.label && f.label.trim()) || f.name}
                      {isSorted && <span aria-hidden="true">{recordsPage.sortDir === "asc" ? "▲" : "▼"}</span>}
                    </Link>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {recordsPage.rows.map((row) => (
              <tr key={row.id} className="border-b border-line-light/70 last:border-0 hover:bg-sand-50/60">
                {columns.map((f) => (
                  <td key={f.name} className="px-4 py-2.5 text-ink/80">
                    {cellDisplay(row.data[f.name])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        page={recordsPage.page}
        totalPages={recordsPage.totalPages}
        hrefForPage={(p) => hrefFor(p, recordsPage.sortField ?? undefined, recordsPage.sortDir)}
      />
    </div>
  );
}
