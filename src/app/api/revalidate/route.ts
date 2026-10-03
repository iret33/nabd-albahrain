/**
 * POST /api/revalidate — drop Next.js data-cache entries by tag.
 *
 * Auth: bearer SYNC_TOKEN or the admin cookie (isSyncRequestAuthorized).
 * Body (all optional): `{ tags?: string[], datasetIds?: string[] }`.
 * `tags` defaults to `["datasets"]` (every list/aggregate query);
 * every `datasetIds` entry adds the tag `dataset:<id>` (that dataset's detail
 * and records pages). Responds `{ revalidated: string[] }`.
 *
 * Why this route exists: `revalidateTag` only takes effect when it is called
 * synchronously inside a request handler — the tags are flushed once, when
 * the handler returns its Response. Called later from a finished route, from
 * the CLI or from a timer it is a silent no-op (or throws). The sync engine
 * therefore POSTs here when a run ends (src/lib/sync/notify.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { z } from "zod";
import { isSyncRequestAuthorized } from "@/lib/sync/auth";
import { readTextCapped } from "@/lib/sync/body";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

const BodySchema = z.object({
  tags: z
    .array(z.string().regex(/^[A-Za-z0-9_:.\-]{1,200}$/))
    .max(50)
    .optional(),
  // Next ignores tags longer than 256 characters ("dataset:" is 8 of them).
  datasetIds: z.array(z.string().min(1).max(240)).max(1000).optional(),
});

export async function POST(req: NextRequest) {
  if (!(await isSyncRequestAuthorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const text = await readTextCapped(req, MAX_BODY_BYTES);
  if (text === null) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  let json: unknown = {};
  if (text.trim() !== "") {
    try {
      json = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }
  }
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const tags = new Set<string>(parsed.data.tags ?? ["datasets"]);
  for (const id of parsed.data.datasetIds ?? []) tags.add(`dataset:${id}`);

  // Synchronously, inside the handler: that is what makes it take effect.
  for (const tag of tags) revalidateTag(tag);

  return NextResponse.json({ revalidated: [...tags] }, { headers: { "Cache-Control": "no-store" } });
}
