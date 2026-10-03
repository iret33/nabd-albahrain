/**
 * GET /api/v1/datasets/{id} — one dataset: metadata, field dictionary and
 * per-field statistics. Datasets the portal has removed still answer (200,
 * `removed: true`), like their page does; an id that never existed is 404.
 */

import { asFields, asStatsJson, asVizConfig, getDatasetById } from "@/lib/queries";
import { stripHtml } from "@/lib/format";
import { SITE_URL } from "@/lib/site";
import { guardApi } from "@/lib/api-limits";
import { jsonOk, notFound, parseDatasetId, preflight, serverError, toDatasetSummary } from "@/lib/api-v1";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const limited = guardApi(req);
  if (limited) return limited;
  try {
    const id = parseDatasetId((await ctx.params).id);
    if (!id) return notFound("Dataset");
    const d = await getDatasetById(id);
    if (!d) return notFound("Dataset");

    const apiBase = `${SITE_URL}/api/v1/datasets/${encodeURIComponent(id)}`;
    const iso = (v: Date | null) => (v ? v.toISOString() : null);
    return jsonOk({
      ...toDatasetSummary(d),
      description: stripHtml(d.description) || null,
      keywords: d.keywords,
      license: d.license,
      summaryAr: d.summaryAr,
      /** "ok" | "partial" | ...: a partial dataset stores only its first rows (see `storedRecordsCount`). */
      syncStatus: d.syncStatus,
      partial: d.syncStatus === "partial",
      /** Rows this mirror actually stores and serves (`recordsCount` is the portal's own figure). */
      storedRecordsCount: d.sourceCount,
      lastCheckedAt: iso(d.lastCheckedAt),
      removed: d.removedAt !== null,
      removedAt: iso(d.removedAt),
      chartType: asVizConfig(d.vizConfig)?.type ?? null,
      fields: asFields(d.fieldsJson).map((f) => ({ name: f.name, label: f.label ?? null, type: f.type ?? null })),
      stats: asStatsJson(d.statsJson),
      links: {
        records: `${apiBase}/records`,
        recordsCsv: `${apiBase}/records?format=csv`,
      },
    });
  } catch (err) {
    console.error("[api/v1/datasets/:id] failed:", err);
    return serverError();
  }
}
