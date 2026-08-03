# نبض البحرين (Nabd Al-Bahrain)

An independent, unofficial, Arabic-first public dashboard that mirrors and
visualizes every dataset published on Bahrain's official open data portal
([data.gov.bh](https://data.gov.bh)) — currently ~512 datasets from 35+
government entities.

This project is **not** affiliated with the Government of Bahrain or
data.gov.bh. Every page attributes the official source and links back to it.

## Tech stack

- [Next.js 15](https://nextjs.org) (App Router, TypeScript, React Server
  Components, `output: 'standalone'`)
- [Tailwind CSS v4](https://tailwindcss.com) (CSS-first config, design
  tokens in `src/app/globals.css`)
- [Prisma](https://www.prisma.io) + PostgreSQL 16
- [Recharts](https://recharts.org) for charts
- [Zod](https://zod.dev) for validating every external API response
- [pnpm](https://pnpm.io) as the package manager

## Project status

**Phase 2 of 9 — sync engine.** Phase 1 set up the app shell, design
system, database connection, and tooling. This phase adds the real data
models (`Dataset`, `DatasetRecord`, `SyncLog`, `SyncLock`) and the sync
engine that pulls the full catalog + every dataset's records from
data.gov.bh into local Postgres (see [Sync engine](#sync-engine) below).
The home page (`src/app/page.tsx`) is still a placeholder — dataset
browsing/search pages, charts, computed stats/summaries, and the admin
dashboard land in later phases.

## Local development

### Prerequisites

- Node.js 20+
- pnpm (`corepack enable && corepack prepare pnpm@latest --activate`, or
  `npm install -g pnpm` if corepack isn't available)
- Docker + Docker Compose (for local Postgres) — see the fallback below if
  Docker isn't available on your machine

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start Postgres

```bash
docker compose up -d
```

This starts a single `db` service (`postgres:16-alpine`) bound to
`127.0.0.1:5432`, with a named volume (`pgdata`) and a healthcheck. This
compose file is for **local dev only** — the production compose file
(adding an `app` service) is created in a later phase.

#### Local dev without Docker

If Docker/Colima genuinely cannot run in your environment, install Postgres
16 directly instead:

```bash
brew install postgresql@16
brew services start postgresql@16
createuser -s nabd
createdb -O nabd nabd
psql -d nabd -c "ALTER USER nabd WITH PASSWORD 'nabd';"
```

Then point `DATABASE_URL` in `.env` at `localhost:5432` as usual (see
`.env.example`) — the app doesn't care whether Postgres is containerized.

### 3. Configure environment variables

```bash
cp .env.example .env
```

The defaults in `.env.example` match the `docker compose` service above, so
no edits are needed for local dev. Fill in real random values for
`ADMIN_TOKEN` / `SYNC_TOKEN` before deploying anywhere non-local.

### 4. Run database migrations

```bash
pnpm exec prisma migrate dev
```

### 5. Run the dev server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Design system

"Bahraini sea & pearl" — dark sea-navy surfaces for hero/bands, a warm sand
background for content, pearl-gold as the signature accent, and muted coral
as the action color. Tokens live as CSS variables in
`src/app/globals.css` and are exposed through the Tailwind v4 theme (via
`@theme inline`), so utilities like `bg-sea-900`, `text-pearl`,
`border-line-light`, etc. work directly in JSX.

- Display font: **Tajawal** (700/900) — `font-display`
- Body/UI font: **IBM Plex Sans Arabic** (400/500/600) — the default
  `font-sans`
- All numeric figures use Latin tabular digits: wrap the number in an
  inline `<span dir="ltr" className="tabular-figures">`.
- The whole UI chrome is Arabic/RTL (`<html lang="ar" dir="rtl">`). Dataset
  titles and field labels stay in their original language — never
  machine-translated.

`src/components/site-header.tsx` and `src/components/site-footer.tsx` are
shared across every page via `src/app/layout.tsx`. The footer carries the
mandatory attribution line linking to https://data.gov.bh.

## Data source

Bahrain's official open data portal, an OpenDataSoft Explore API v2.1
instance at `https://data.gov.bh/api/explore/v2.1` (~512 datasets from 35+
government entities as of this writing). The sync engine (`src/lib/sync/`)
is the only thing that talks to it:

- `GET /catalog/datasets?limit=100&offset=N` — paginated catalog (100 at a
  time), used to upsert every `Dataset`'s metadata.
- `GET /catalog/datasets/{id}/exports/json` — full per-dataset export (flat
  JSON array, no pagination cap), used to populate `DatasetRecord`.

Every request goes through a shared polite HTTP client
(`src/lib/sync/http.ts`) that enforces: a concurrency cap of 3 in-flight
requests, a ~250ms stagger between request starts, exponential backoff with
2 retries on HTTP 429/5xx, a 120s timeout on export requests, and a custom
`User-Agent: nabd-albahrain/1.0 (...)` header. Every response is validated
with tolerant Zod schemas (`src/lib/sync/schemas.ts`, `.passthrough()` +
optional fields throughout) so an unexpected extra key never throws.

## Sync engine

`src/lib/sync/engine.ts` exports `runSync(opts)`, callable from any context
(CLI today, a later API route). `src/lib/sync/cli.ts` is the CLI wrapper:

```bash
pnpm sync                              # full sync: all ~512 datasets
pnpm sync -- --limit 10                # only sync records for the first 10 (catalog order)
pnpm sync -- --dataset <dataset_id>    # only sync records for one dataset
pnpm sync -- --force                   # re-fetch records even if unchanged since last sync
```

What a run does:

1. Acquires `SyncLock` (a singleton row) so only one sync runs at a time —
   aborts with a clear message if another sync is already running, unless
   that lock is stale (`since` older than 2 hours), in which case it's
   auto-released first. Always released in a `finally`.
2. Fetches the **full** catalog (all pages) and upserts every `Dataset`'s
   metadata — title/`titleClean` (leading numeric index prefix like `"2. "`
   stripped), description, primary theme (`theme[0]`, `null` if empty),
   publisher, `recordsCount`, `fieldsJson`, `sourceModified`.
3. For each dataset in scope (all / `--limit` / `--dataset`), with
   concurrency 3: skips re-fetching records if `sourceModified` hasn't
   advanced past `lastSyncedAt`, unless `--force`. Otherwise fetches the
   full export, applies a size guard (>300,000 rows: store only the first
   50,000 and mark `syncStatus="partial"`, but still hand the *full* array
   to `computeDerivedFields()`), and replaces that dataset's
   `DatasetRecord` rows in a transaction (delete + batched inserts of
   1,000). One dataset's failure is caught and recorded — it never stops
   the loop.
4. Writes one `SyncLog` row per run (processed/succeeded/failed counts +
   `failuresJson`).

`computeDerivedFields()` (`src/lib/sync/derived.ts`) — which fills in
`statsJson`/`vizConfig`/`chartData`/`summaryAr` — is a stub in this phase;
it's already wired into the sync loop with the right signature for Phase 3
to implement without restructuring anything.

## Scripts

```bash
pnpm dev             # start dev server
pnpm build            # production build
pnpm start            # run the standalone production build
pnpm lint             # eslint
pnpm sync             # run the data.gov.bh sync (see above)
pnpm exec prisma studio        # inspect the database
pnpm exec prisma migrate dev   # apply/create migrations
```
