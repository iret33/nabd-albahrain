/**
 * GET /api/v1/datasets/{id}/records — the stored rows, by keyset pagination.
 *
 *   after   a record id from the previous response's `nextAfter` (default: from the start)
 *   limit   1..1000 (default 100); rows come back ORDER BY id
 *   format  json (default) | csv
 *
 * Keyset, not OFFSET: page 500 costs the same as page 1 and rows added by a
 * sync never shift a reader's position. `format=csv` ignores `limit` and
 * STREAMS every remaining row (UTF-8 with a BOM so Excel reads Arabic; cells
 * that a spreadsheet would execute are neutralized, see `csvCell`), batch by
 * batch, so memory stays flat however large the dataset is. Partial datasets
 * serve their stored rows only (`partial: true`, `X-Dataset-Partial: true`).
 */

import { getDatasetRecordsAfter, getRecordsMeta, type RecordsMeta } from "@/lib/queries";
import { SITE_URL } from "@/lib/site";
import {
  ApiParamError,
  CACHE_PUBLIC,
  CSV_BOM,
  CSV_MAX_ROWS,
  API_RECORDS_MAX_LIMIT,
  badRequest,
  corsHeaders,
  csvContentDisposition,
  csvRow,
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

type Row = { id: string; data: Record<string, unknown> };

/** Pull-based stream: each `pull` loads one 1000-row batch, so a slow client never makes the server buffer the dataset. */
function csvStream(meta: RecordsMeta, startAfter: string | null): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let columns = meta.fields.map((f) => f.name);
  let headerSent = false;
  let after = startAfter;
  let sent = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const batch = await getDatasetRecordsAfter({ datasetId: meta.id, after, limit: API_RECORDS_MAX_LIMIT });
        const rows: Row[] = batch?.rows ?? [];

        let chunk = "";
        if (!headerSent) {
          // A dataset with no field dictionary still gets sensible columns: the first row's keys.
          if (columns.length === 0 && rows.length > 0) columns = Object.keys(rows[0].data);
          chunk += CSV_BOM + csvRow(columns);
          headerSent = true;
        }
        for (const row of rows) chunk += csvRow(columns.map((c) => row.data[c]));
        controller.enqueue(encoder.encode(chunk));

        sent += rows.length;
        after = batch?.nextAfter ?? null;
        if (after === null || rows.length === 0 || sent >= CSV_MAX_ROWS) controller.close();
      } catch (err) {
        // Headers are long gone: abort the connection so the client sees a failed download, not a truncated "complete" file.
        console.error("[api/v1/records csv] stream failed:", err);
        controller.error(err);
      }
    },
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const id = parseDatasetId((await ctx.params).id);
    if (!id) return notFound("Dataset");
    const query = parseRecordsQuery(new URL(req.url).searchParams);

    const meta = await getRecordsMeta(id);
    if (!meta) return notFound("Dataset");
    const partial = meta.syncStatus === "partial";

    if (query.format === "csv") {
      return new Response(csvStream(meta, query.after), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": csvContentDisposition(id),
          "Cache-Control": CACHE_PUBLIC,
          "X-Dataset-Partial": String(partial),
          "Access-Control-Expose-Headers": "Content-Disposition, X-Dataset-Partial",
          ...corsHeaders(),
        },
      });
    }

    const page = await getDatasetRecordsAfter({ datasetId: id, after: query.after, limit: query.limit });
    if (!page) return notFound("Dataset");
    const base = `${SITE_URL}/api/v1/datasets/${encodeURIComponent(id)}/records`;
    return jsonOk({
      id,
      partial,
      /** Rows this mirror stores and serves; `recordsCount` is the portal's own (larger for partial datasets). */
      storedRecordsCount: meta.sourceCount,
      recordsCount: meta.recordsCount,
      removed: meta.removed,
      limit: query.limit,
      count: page.rows.length,
      nextAfter: page.nextAfter,
      next: page.nextAfter ? `${base}?after=${page.nextAfter}&limit=${query.limit}` : null,
      records: page.rows,
    });
  } catch (err) {
    if (err instanceof ApiParamError) return badRequest(err);
    console.error("[api/v1/datasets/:id/records] failed:", err);
    return serverError();
  }
}
