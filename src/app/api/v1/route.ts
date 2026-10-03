/** GET /api/v1 — a pointer for people who paste the base URL into a browser. */

import { SITE_URL } from "@/lib/site";
import { jsonOk, preflight } from "@/lib/api-v1";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

export function GET() {
  return jsonOk({
    name: "Nabd Al-Bahrain open data API",
    version: 1,
    documentation: `${SITE_URL}/developers`,
    source: "https://data.gov.bh",
    endpoints: {
      datasets: `${SITE_URL}/api/v1/datasets`,
      dataset: `${SITE_URL}/api/v1/datasets/{id}`,
      records: `${SITE_URL}/api/v1/datasets/{id}/records`,
    },
  });
}
