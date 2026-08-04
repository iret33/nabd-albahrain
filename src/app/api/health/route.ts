/**
 * GET /api/health — cheap liveness check for the Docker Compose `app`
 * service healthcheck (Phase 8). Deliberately does NOT touch Postgres —
 * a DB hiccup should surface as a normal 5xx on real pages, not flap the
 * container's health status and trigger restarts on top of a database
 * problem. Just proves the Next.js server itself is up and responding.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true });
}
