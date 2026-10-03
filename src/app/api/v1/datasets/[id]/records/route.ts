/**
 * GET /api/v1/datasets/{id}/records — the stored rows, by keyset pagination.
 *
 *   after   a record id from the previous response's `nextAfter` (default: from the start)
 *   limit   1..1000 (default 100); rows come back ORDER BY id
 *   format  json (default) | csv
 *
 * Keyset, not OFFSET: page 500 costs the same as page 1. A cursor is valid only within
 * one GENERATION of the dataset's rows: a sync that changes a dataset replaces ALL its
 * rows (new, higher ids), so a cursor issued before it points at rows that no longer
 * exist. Rather than silently restart from row 1 (a duplicated prefix under new ids),
 * such a request is answered 409 `cursor_expired` with a `restart` URL; see
 * `getDatasetRecordsAfter`.
 *
 * `format=csv` ignores `limit` and STREAMS every remaining row (UTF-8 with a BOM so
 * Excel reads Arabic; cells that a spreadsheet would execute are neutralized, see
 * `csvCell`), batch by batch, so memory stays flat however large the dataset is. It is
 * one stream: if the dataset is replaced mid-download the stream ERRORS (a failed
 * download, never a truncated file that looks complete) and the client retries. Partial
 * datasets serve their stored rows only (`partial: true`, `X-Dataset-Partial: true`);
 * the header describes the DATASET, not the export.
 *
 * Abuse limits (`@/lib/api-limits`): a per-client request budget on every call, a much
 * smaller one for CSV, and a cap on concurrent CSV streams per client and per server.
 */

import { getDatasetRecordsAfter, getRecordsMeta } from "@/lib/queries";
import { StaleCursorError } from "@/lib/records-query";
import { SITE_URL } from "@/lib/site";
import { acquireCsvSlot, guardApi, wantsCsv } from "@/lib/api-limits";
import { createCsvStream } from "@/lib/csv-export";
import {
  ApiParamError,
  CACHE_PUBLIC,
  API_RECORDS_MAX_LIMIT,
  badRequest,
  corsHeaders,
  csvContentDisposition,
  cursorExpired,
  jsonOk,
  notFound,
  parseDatasetId,
  parseRecordsQuery,
  preflight,
  serverError,
} from "@/lib/api-v1";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const url = new URL(req.url);
  const csv = wantsCsv(url.searchParams);
  const limited = guardApi(req, csv ? "csv" : "read");
  if (limited) return limited;

  // The export slot, once taken, belongs to the stream. Until the stream exists it is given back here.
  let release: (() => void) | null = null;
  // The same request without `after`, for a 409's `restart`.
  let restart = "";
  try {
    const id = parseDatasetId((await ctx.params).id);
    if (!id) return notFound("Dataset");
    const query = parseRecordsQuery(url.searchParams);
    const base = `${SITE_URL}/api/v1/datasets/${encodeURIComponent(id)}/records`;
    restart = query.format === "csv" ? `${base}?format=csv` : `${base}?limit=${query.limit}`;

    if (query.format === "csv") {
      const slot = acquireCsvSlot(req); // before reading anything: a refused export costs nothing
      if (slot instanceof Response) return slot;
      release = slot.release;

      const meta = await getRecordsMeta(id);
      if (!meta) return notFound("Dataset");
      const first = await getDatasetRecordsAfter({ datasetId: id, after: query.after, limit: API_RECORDS_MAX_LIMIT });
      if (!first) return notFound("Dataset");

      const body = createCsvStream({
        columns: meta.fields.map((f) => f.name),
        first,
        next: (after) => getDatasetRecordsAfter({ datasetId: id, after, limit: API_RECORDS_MAX_LIMIT }),
        onEnd: slot.release,
        onAbort: (err) =>
          console.error(
            `[api/v1/records csv] ${id}: export aborted:`,
            err instanceof StaleCursorError ? "the dataset was replaced mid-export" : err,
          ),
      });
      const response = new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": csvContentDisposition(id),
          "Cache-Control": CACHE_PUBLIC,
          "X-Dataset-Partial": String(meta.syncStatus === "partial"),
          ...corsHeaders(),
        },
      });
      release = null; // handed over: the stream frees the slot when it ends, fails or is cancelled
      return response;
    }

    const meta = await getRecordsMeta(id);
    if (!meta) return notFound("Dataset");
    const page = await getDatasetRecordsAfter({ datasetId: id, after: query.after, limit: query.limit });
    if (!page) return notFound("Dataset");
    return jsonOk({
      id,
      partial: meta.syncStatus === "partial",
      /** Rows this mirror stores and serves; `recordsCount` is the portal's own (larger for partial datasets). */
      storedRecordsCount: meta.sourceCount,
      recordsCount: meta.recordsCount,
      removed: meta.removed,
      limit: query.limit,
      count: page.rows.length,
      nextAfter: page.nextAfter,
      next: page.nextAfter ? `${base}?after=${encodeURIComponent(page.nextAfter)}&limit=${query.limit}` : null,
      records: page.rows,
    });
  } catch (err) {
    if (err instanceof ApiParamError) return badRequest(err);
    if (err instanceof StaleCursorError) return cursorExpired(restart);
    console.error("[api/v1/datasets/:id/records] failed:", err);
    return serverError();
  } finally {
    release?.();
  }
}
