/**
 * Side-effect module: load `.env.local` then `.env` from the working directory
 * into `process.env` WITHOUT overriding anything already set (real environment
 * variables win, then `.env.local`, then `.env`).
 *
 * Why the CLI needs it: Next.js loads these files for the web server, but
 * `tsx src/lib/sync/cli.ts` (`pnpm sync`) is a plain Node process, and Prisma
 * only ever reads `.env`. Without this, a developer's `DATABASE_URL` /
 * `ODS_BASE_URL` in `.env.local` is silently ignored and the real portal gets
 * tried. It must be the FIRST import of the CLI entry: ES modules evaluate
 * their imports in order, and `./engine`, `@/lib/prisma` and the sync config
 * read the environment when they load.
 *
 * Harmless in production: the image ships no env files (see .dockerignore).
 */
import { existsSync } from "node:fs";
import path from "node:path";

for (const file of [".env.local", ".env"]) {
  const full = path.resolve(process.cwd(), file);
  if (!existsSync(full)) continue;
  try {
    process.loadEnvFile(full); // Node >= 20.12; never overrides an already-set variable
  } catch (err) {
    console.warn(`[sync-cli] Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
