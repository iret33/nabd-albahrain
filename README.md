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

**Phase 4 of 9 — public-facing pages.** Phase 1 set up the app shell,
design system, database connection, and tooling. Phase 2 added the real
data models (`Dataset`, `DatasetRecord`, `SyncLog`, `SyncLock`) and the sync
engine that pulls the full catalog + every dataset's records from
data.gov.bh into local Postgres (see [Sync engine](#sync-engine) below).
Phase 3 implemented `computeDerivedFields()` (`src/lib/sync/derived.ts`):
per-field `statsJson`, a rule-based `vizConfig`/`chartData` chart
recommendation, and a template-based Arabic `summaryAr` (see
[Visualization-inference engine](#visualization-inference-engine) below).
This phase builds the actual public site on top of all of that — every page
is a Server Component reading Postgres directly via Prisma (no client-side
fetch waterfalls):

- **`/`** — dark hero with live portal stats (dataset/publisher/record
  counts, last sync time), a hand-curated "featured stats" band
  (`src/config/featured.ts`, big number + sparkline per entry, degrades
  gracefully if an entry isn't synced yet), a category rail (every theme as
  a colored chip with its dataset count), "الأحدث تحديثاً" (9 most
  recently-synced datasets), and a dark CTA band linking to `/categories`.
- **`/categories`** — every theme as a large colored tile with its dataset
  count.
- **`/categories/[theme]`** — server-paginated (30/page) grid of dataset
  cards for one theme.
- **`/dataset/[id]`** — breadcrumb, title, `summaryAr` as a lead sentence,
  the Recharts chart picked by `vizConfig` (chart canvas wrapped
  `dir="ltr"` so time axes read left-to-right, custom tooltip/legend forced
  `dir="rtl"`), stat chips, direct links to the official CSV/JSON exports
  and dataset page (never proxied), and a server-paginated (25/page),
  sortable-by-column-header records table — the one place raw
  `DatasetRecord` rows reach the client, 25 at a time. A `syncStatus:
  "partial"` badge shows when a dataset's size guard capped storage.

Theme → color mapping (`src/lib/theme-colors.ts`), Latin-tabular-digit
number/date formatting (`src/lib/format.ts`), and the cached Prisma query
layer (`src/lib/queries.ts`, `unstable_cache` tagged `"datasets"` /
`"dataset:{id}"`) are shared across all of the above. Loading skeletons
(`src/components/skeletons.tsx`) and plain-Arabic empty states
(`src/components/empty-state.tsx`) cover the pre-sync / partially-synced /
zero-result cases everywhere. Search, the admin dashboard, and wiring
`revalidateTag()` into the sync engine are later phases.

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

`computeDerivedFields(datasetId, records, fields)` (`src/lib/sync/derived.ts`)
fills in `statsJson`/`vizConfig`/`chartData`/`summaryAr` — see
[Visualization-inference engine](#visualization-inference-engine) below.

## Visualization-inference engine

`src/lib/sync/derived.ts` computes, per dataset, entirely deterministically
(no AI/LLM calls) from that dataset's full synced records + its ODS
`fields[]` schema:

- **`statsJson`** — per field: `nullRate`, `distinctCount` (capped at
  `"1000+"`), numeric `min`/`max`/`mean`, temporal `min`/`max` (as the
  original raw values), and the top 10 values by frequency for text fields
  with ≤30 distinct values. A field's `annotations.unit` (e.g. `"km2"`),
  when the source provides one, is carried through as `unit`.
- **Field classification** — each field is classified as **temporal**
  (`date`/`datetime` type, or a `text`/`int` field whose name/label looks
  temporal and ≥90% of sampled values parse as a year or date),
  **measure** (`int`/`double`, excluding `id`/`code`-style names, generic
  row-index columns, and longitude/latitude coordinate fields — see the
  "deviations from spec" note below), or **dimension** (`text`, 2-30
  distinct values; "series-able" at ≤8).
- **`vizConfig` + `chartData`** — a first-match-wins decision tree picks one
  of `multi-line` / `area` / `bar-h` / `bar-stacked` / `histogram` /
  `table`, and pre-aggregates `chartData` accordingly (sum by default, mean
  when the measure's label looks like a rate/percent/average). `chartData`
  is always pre-aggregated and capped at 500 points — never a raw record
  dump, per the Recharts rule in the spec. Every chart builder falls back
  to the next rule in the tree (and ultimately to `table`) if it can't
  actually produce real data, so a structural match on paper never
  persists an empty chart.
- **`summaryAr`** — a short template-based Arabic sentence generated from
  whichever chart was produced (temporal / categorical / a generic
  row+field-count fallback for `table`/`histogram`), gracefully dropping
  any clause it can't fill in (never prints `undefined` or an empty
  placeholder).

**Deviations from the spec worth knowing about**, found while eyeballing
real synced datasets (`pnpm sync -- --limit 10 --force` plus several
individually-targeted datasets — temporal, categorical, geo, tiny/weird):

- The spec's measure-exclusion regex (`/^(id|.*_id|code|.*_code)$/i`)
  doesn't catch two patterns that are extremely common across this
  specific catalog and were confirmed to produce actively wrong charts:
  a bare `"n"` row-index column present on almost every dataset (usually
  caught by a general "dense +1 sequence" heuristic, but some datasets
  restart `n` per facet, which breaks that heuristic while leaving a
  fully-non-null column that then wins "best measure" over the real,
  partly-null measure on non-null count alone — confirmed live on
  `01-caa-monthly-passenger-movement-at-bahrain-international-airport`,
  where `n` was beating the real `value` field), and longitude/latitude
  coordinate fields on the ~37 "geographical-locations-of-*" datasets
  (confirmed live on `geographical-locations-of-cinemas`, where
  `x_longitude`/`y_latitude` were valid measure candidates before this
  fix). Both are now excluded from measure classification alongside the
  spec's own id/code regex.
- Known, intentionally-not-"fixed" limitation: the spec's rate/mean regex
  (`/(rate|percent|ratio|average|معدل|نسبة|متوسط)/i`) doesn't match
  economic index fields labeled just "Point" or "Level" (e.g. the CPI
  dataset), so those get summed (the spec's default) across every category
  and month within a year for the `area` chart, producing a large, not
  very meaningful "index total". This is a real limitation of a
  regex-only, non-semantic classifier; widening the regex to catch
  "index"/"point"/"level" felt too speculative/overfit to add unasked, so
  it's left as-is and flagged here for a later phase to revisit if it
  matters for the UI.
- `computeDerivedFields`'s signature was extended from Phase 2's stub
  `(datasetId, records)` to `(datasetId, records, fields)` — classification
  needs each field's schema type/label/annotations, which only exist in
  `Dataset.fieldsJson`, not in the record rows themselves. `engine.ts`'s
  call site was updated accordingly (it already had `dataset` in scope).

## Public pages

Phase 4's routes — see [Project status](#project-status) above for the
per-route feature list. A few implementation notes worth knowing about:

- **`route.tsx` files calling `notFound()` must not have a route-level
  `loading.tsx`.** Confirmed empirically while building `/dataset/[id]`: a
  `loading.tsx` anywhere from the route's own segment up to the root wraps
  that segment's `page.tsx` in a Suspense boundary, which makes Next.js
  (15.5.22, both `next dev` and the standalone production server) commit
  an HTTP 200 status and start streaming *before* an inner `notFound()`
  call resolves — the `not-found.tsx` body renders correctly, but the
  status code stays 200 instead of 404. Fixed two ways: (1) the home page
  moved into a route group (`src/app/(home)/`) so its `loading.tsx`
  doesn't cascade to sibling routes, and (2) `/dataset/[id]` has no
  route-level `loading.tsx` at all — it resolves the `notFound()` check
  synchronously (fast; cached queries), then wraps only the records table
  in an inline `<Suspense fallback={<RecordsTableSkeleton />}>` further
  down the tree, which streams safely because it's *after* the not-found
  decision is already made. `/categories/[theme]` keeps its route-level
  `loading.tsx` since that route never calls `notFound()` (an unknown/
  empty theme renders a plain-Arabic empty state instead — see below).
- **`metas.default.description` from data.gov.bh is simple HTML**
  (`<p>`, `<br>`, entity-escaped `&amp;` — confirmed across every sampled
  dataset), not plain text. Rendering it directly produced literal
  `<p>...&lt;/p&gt;`-style text on the dataset page. `src/lib/format.ts`
  now exports `stripHtml()` (turns `<br>`/`</p>` into line breaks, drops
  other tags, decodes the handful of entities actually observed) instead
  of pulling in an HTML-sanitizer dependency for what is just `<p>`/`<br>`
  tags from a single trusted source.
- Unknown/empty `/categories/[theme]` values and empty result sets render
  a plain-Arabic empty state rather than a 404 — a category page doesn't
  have the same "this specific resource must exist" semantics as a
  dataset page, so graceful degradation felt like the better default (and
  sidesteps the `loading.tsx`/`notFound()` interaction above entirely,
  since that route never needs to call `notFound()`).
- While building against real synced data, found that 12 of the (at the
  time) 32 synced datasets had `vizConfig`/`statsJson`/`summaryAr` stuck
  `null` — they were synced during Phase 2/3 development *before*
  `computeDerivedFields()` was implemented, and the sync engine's
  unchanged-since-last-sync skip (`lastSyncedAt >= sourceModified`)
  correctly left them alone on subsequent plain `pnpm sync` runs, since
  their source data genuinely hadn't changed. Not a code bug — the skip
  logic is working as designed — but it left stale Phase-2-era nulls on
  disk that the dataset page needs to render around anyway (handled via
  the `vizConfig === null` → "no chart" fallback), so backfilled all 12
  locally with `pnpm sync -- --dataset <id> --force` to get a realistic
  mix of chart types (`area`/`multi-line`/`bar-stacked`/`table` all now
  present locally) to actually verify the page against. A full sync run
  in a later phase will pick up everything else.

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
