/**
 * GET /api/v1/datasets — the catalog, filtered, ranked and paged.
 *
 *   q             free text (max 100 chars); Arabic and English, multi-word, orthography-folded
 *   theme         exact theme name (see `facets.themes` in any response)
 *   publisher     publisher slug (see `facets.publishers`)
 *   sort          relevance | updated | title | records   (default: relevance with q, else title)
 *   updated_since ISO 8601 date or date-time: only datasets the SOURCE modified at/after it
 *   page          1-based (default 1)
 *   limit         1..100 (default 30)
 *
 * Same engine as the website's search (`listDatasets`), so a result here is
 * what the page shows. Validation and the cache/CORS policy: `@/lib/api-v1`.
 */

import { listDatasets } from "@/lib/queries";
import { guardApi } from "@/lib/api-limits";
import {
  ApiParamError,
  badRequest,
  jsonError,
  jsonOk,
  parseDatasetsQuery,
  preflight,
  serverError,
  toDatasetSummary,
} from "@/lib/api-v1";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

export async function GET(req: Request) {
  const limited = guardApi(req);
  if (limited) return limited;
  try {
    const query = parseDatasetsQuery(new URL(req.url).searchParams);
    const result = await listDatasets(query.list, { pageSize: query.limit, updatedSince: query.updatedSince });

    if (result.status === "unknown-theme") return jsonError(404, "unknown_theme", "No such theme. Valid names are listed in facets.themes.", { parameter: "theme" });
    if (result.status === "unknown-publisher") {
      return jsonError(404, "unknown_publisher", "No such publisher. Valid slugs are listed in facets.publishers.", { parameter: "publisher" });
    }
    if (result.status === "query-too-short") {
      throw new ApiParamError("q", "q must contain at least one word of two or more characters (or a number)");
    }

    // The data layer clamps a page past the end to the last page; an API client that asked for page 99
    // must get an empty page 99, not a silent copy of page 3.
    const pastEnd = query.list.page !== undefined && query.list.page !== null && query.list.page > result.totalPages;
    return jsonOk({
      total: result.total,
      page: pastEnd ? (query.list.page as number) : result.page,
      limit: query.limit,
      totalPages: result.totalPages,
      results: pastEnd ? [] : result.items.map(toDatasetSummary),
      facets: {
        themes: result.facets.themes.map((t) => ({ theme: t.theme, count: t.count })),
        publishers: result.facets.publishers.map((p) => ({ slug: p.slug, name: p.name, count: p.count })),
      },
    });
  } catch (err) {
    if (err instanceof ApiParamError) return badRequest(err);
    console.error("[api/v1/datasets] failed:", err);
    return serverError();
  }
}
