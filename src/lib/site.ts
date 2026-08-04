/**
 * Canonical site origin, used by `metadataBase`, sitemap.ts, and
 * robots.ts. Reads `NEXT_PUBLIC_SITE_URL` (already in .env.example, set to
 * http://localhost:3000 for local dev) and falls back to the project's
 * documented eventual production domain so a build without that env var
 * set still emits sane absolute URLs instead of localhost ones.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://data.hekkapp.com").replace(/\/+$/, "");
