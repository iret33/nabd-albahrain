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

**Phase 8 of 9 — production deployment artifacts, then a full real sync of
the entire live catalog.** This phase added the `Dockerfile` +
`docker-compose.yml` production setup, finalized `.env.example`, wrote the
production/cron/Cloudflare-Tunnel deployment instructions (see
[Production deployment](#production-deployment) below), ran a full
`pnpm sync -- --force` against the live data.gov.bh API into local Postgres,
and refined `src/config/featured.ts` with real entries picked from the
now-fully-synced catalog. See
[Full sync results](#full-sync-results-phase-8) below for the outcome and
what the long tail of real-world datasets broke (and how it was fixed).

Phase 1 set up the app shell, design system, database
connection, and tooling. Phase 2 added the real data models (`Dataset`,
`DatasetRecord`, `SyncLog`, `SyncLock`) and the sync engine that pulls the
full catalog + every dataset's records from data.gov.bh into local
Postgres (see [Sync engine](#sync-engine) below). Phase 3 implemented
`computeDerivedFields()` (`src/lib/sync/derived.ts`): per-field
`statsJson`, a rule-based `vizConfig`/`chartData` chart recommendation,
and a template-based Arabic `summaryAr` (see
[Visualization-inference engine](#visualization-inference-engine) below).
Phase 4 built the core public site — every page is a Server Component
reading Postgres directly via Prisma (no client-side fetch waterfalls):

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
  `dir="rtl"`), stat chips (publisher is now a link to `/publishers/[slug]`,
  added this phase), direct links to the official CSV/JSON exports and
  dataset page (never proxied), and a server-paginated (25/page),
  sortable-by-column-header records table — the one place raw
  `DatasetRecord` rows reach the client, 25 at a time. A `syncStatus:
  "partial"` badge shows when a dataset's size guard capped storage.

This phase (5) rounds out the public site:

- **`/publishers`** — every distinct publisher (42 raw values / 41 URLs —
  see the slug-collision note below) as the same colored-tile grid style as
  `/categories`, via the new `PublisherTile` component. Tile color reuses
  `themeColor()`'s deterministic hash fallback (no publisher name matches
  its keyword rules, so every publisher gets a stable hash-picked color).
- **`/publishers/[slug]`** — same visual + behavioral pattern as
  `/categories/[theme]`, including rendering a plain-Arabic empty state
  instead of `notFound()` for an unmatched slug (keeps a route-level
  `loading.tsx` safe — see the `notFound()`/`loading.tsx` interaction note
  in the existing bullet below).
- **`/search?q=`** — ILIKE across `titleClean`/`description` (accelerated by
  the pg_trgm GIN indexes from Phase 2's
  `20260803224500_trgm_search_indexes` migration — Postgres's trgm operator
  classes let the planner use a GIN index for `ILIKE '%term%'`, not just
  prefix search) plus `publisher`/`theme` (no index needed at 512 rows).
  Empty state uses the exact spec copy: "لا توجد نتائج لبحثك — جرّب كلمة
  أخرى". A shared `SearchForm` component (`src/components/search-form.tsx`)
  is used both here and as a compact search box in the site header.
- **`/about`** — عن المشروع: independent-project statement, data.gov.bh
  source attribution, daily refresh cadence, an authoritative-figures
  disclaimer, and a minimal contact line (links to hekkapp.com, matching
  the contact reference already used in the sync engine's User-Agent
  string — no email address was invented for this).
- **`sitemap.ts`** — home, `/categories`, one entry per theme, `/publishers`,
  one entry per publisher slug, one entry per dataset (592 URLs against the
  current local sync). `/search` is deliberately excluded (no canonical URL
  without a query); `/about` is included as a normal low-priority page.
- **`robots.ts`** — allows everything, points at `/sitemap.xml`.
- **`error.tsx`** — Arabic-voice global error boundary (Client Component,
  per the Next.js convention) with a retry button and a link home.
- **`not-found.tsx`** — extended (was already Arabic-voice from Phase 4)
  with an explicit `metadata` title and the new `SearchForm`, so a dead
  link is also a recovery path.
- **`src/lib/slugify.ts`** — the one slugify helper used by both
  `/publishers` and `/publishers/[slug]`, per spec. **Real synced data has
  a genuine slug collision**: `"Meteorological Directorate \ Ministry of
  Transportation and Telecommunications"` (7 datasets) and
  `"Meteorological Directorate\Ministry of Transportation and
  Telecommunications"` (1 dataset, no spaces around the `\`) both slugify
  to the same string. `getPublisherCounts()`/`getDatasetsByPublisherSlug()`
  in `src/lib/queries.ts` treat slug → publisher-name as one-to-many
  everywhere and merge such collisions into a single tile/page (8 datasets
  total under one URL) instead of silently making one variant
  unreachable — not a bug introduced this phase, just messy upstream data
  handled defensively.
- Root layout now sets `metadataBase` (`src/lib/site.ts`, reads
  `NEXT_PUBLIC_SITE_URL`, falls back to the documented production domain)
  so sitemap/OG URLs resolve to real absolute URLs even without that env
  var set.
- Site header (`src/components/site-header.tsx`) and footer
  (`src/components/site-footer.tsx`) both extended with nav links to the
  new routes; the footer's mandatory data.gov.bh attribution line is
  unchanged from Phase 4.

Theme → color mapping (`src/lib/theme-colors.ts`), Latin-tabular-digit
number/date formatting (`src/lib/format.ts`), and the cached Prisma query
layer (`src/lib/queries.ts`, `unstable_cache` tagged `"datasets"` /
`"dataset:{id}"`) are shared across all of the above. Loading skeletons
(`src/components/skeletons.tsx`) and plain-Arabic empty states
(`src/components/empty-state.tsx`) cover the pre-sync / partially-synced /
zero-result cases everywhere.

This phase (6) adds the sync API + `/admin` — see
[Sync API & admin dashboard](#sync-api--admin-dashboard) below for the full
writeup:

- **`POST /api/sync`** — kicks off a sync run (fire-and-forget, `SyncLock`
  guarantees only one real run at a time), then `revalidateTag()`s every
  public page that read stale data.
- **`GET /api/sync/status`** — current lock state + latest `SyncLog` row,
  polled by the admin dashboard every 3s.
- **`/admin/login`** + **`/admin`** — a plain shared-token gate (no user
  accounts) guarding a live dashboard: header stat cards, a "مزامنة الكل
  الآن" button, a failures table with per-row retry, the last 20 sync
  runs, and a full searchable dataset list with a per-dataset refresh
  button — all backed by real Postgres reads and real polling, not static
  render.

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
docker compose up -d db
```

`docker-compose.yml` now describes the full **production** stack (`app` +
`db` — see [Production deployment](#production-deployment) below), but for
day-to-day local dev you only want the database container, not `app` —
`pnpm dev` on your host gives you hot reload, a container running `next
start` doesn't. `docker compose up -d db` starts just the `db` service
(`postgres:16-alpine`) bound to `127.0.0.1:5432`, with a named volume
(`pgdata`) and a healthcheck.

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

Then point `DATABASE_URL` in `.env` at `localhost:5432` as usual (see step 3
below) — the app doesn't care whether Postgres is containerized.

### 3. Configure environment variables

```bash
cp .env.example .env
```

**`.env.example` now models production defaults** (it's meant to be copied
straight onto the VPS and mostly work as-is — see
[Production deployment](#production-deployment)), since inside
`docker-compose.yml`'s network the `app` container reaches Postgres at the
service name `db`, not `localhost`. For **local dev**, where `pnpm dev` runs
directly on your host (outside Docker) against the `db` container's
host-published port, edit the two values that differ:

```bash
DATABASE_URL=postgresql://nabd:nabd@localhost:5432/nabd
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

Everything else (`ADMIN_TOKEN`, `SYNC_TOKEN`, `SYNC_CONCURRENCY`) can stay
as copied for local dev, but fill in real random values for `ADMIN_TOKEN` /
`SYNC_TOKEN` before deploying anywhere non-local — generate with e.g.
`openssl rand -hex 32`.

### 4. Run database migrations

```bash
pnpm exec prisma migrate dev
```

### 5. Run the dev server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

### 6. Run a first test sync

Before syncing the entire ~512-dataset catalog (which, respecting the
politeness rules in [Data source](#data-source) below, takes a genuinely
long time), sanity-check the pipeline end-to-end against a small slice:

```bash
pnpm sync -- --limit 10
```

This fetches the full catalog (metadata only, cheap) then syncs records for
just the first 10 datasets (catalog order). Check the summary it prints, or
open `/admin` (see [Sync API & admin dashboard](#sync-api--admin-dashboard))
and confirm those 10 show `syncStatus: "ok"`. Once that looks right, run a
full sync:

```bash
pnpm sync -- --force
```

`--force` re-fetches every dataset's records even if `sourceModified` looks
unchanged since the last sync — worth doing for the first full run so
nothing is skipped based on stale `lastSyncedAt` state from earlier partial
runs. See [Full sync results](#full-sync-results-phase-8) below for what
this actually produced against the live catalog.

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

Phase 4 + 5's routes — see [Project status](#project-status) above for the
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
  Phase 5's `/publishers/[slug]` deliberately follows the same pattern as
  `/categories/[theme]` (empty state instead of `notFound()` for an
  unmatched slug) specifically so it could keep a route-level
  `loading.tsx` too, rather than reinventing the `/dataset/[id]` approach.
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

## Sync API & admin dashboard

Phase 6. `src/lib/sync/engine.ts`'s `runSync()` (Phase 2) is unchanged —
this phase only adds callers + a UI on top of it.

### `POST /api/sync`

Kicks off a sync run without blocking the response:

```
POST /api/sync
POST /api/sync?dataset=<dataset_id>   # refresh just one dataset
POST /api/sync?force=1                # re-fetch even if unchanged
```

- **Auth** (`src/lib/sync/auth.ts`, `isSyncRequestAuthorized()`) — either
  of two credentials, checked in this order:
  1. `Authorization: Bearer $SYNC_TOKEN` — the documented contract for
     external/scripted callers (cron, `curl`, CI).
  2. The `admin_token` httpOnly cookie set by `/admin/login`. This is what
     lets the `/admin` dashboard's buttons call this exact endpoint
     without `SYNC_TOKEN` ever reaching client-side JS — the cookie
     travels automatically on same-origin `fetch()` calls, and `/admin`
     is itself gated behind `ADMIN_TOKEN` (see below), so this doesn't
     grant anyone new capability, just a token-free path for a session
     that already has equivalent access.
  Neither check can pass if its env var is unset (fails closed).
- **Response** — `202 { started: true }` once a run has been kicked off,
  or `409 { started: false, error: "sync_already_running", since }` if
  `SyncLock` is already held and not stale (`src/lib/sync/lock.ts`'s new
  `getLockState()` — a read-only peek, used here as a fast-path so an
  obviously-redundant request gets an immediate 409 instead of silently
  queueing; `runSync()`'s own `acquireLock()` remains the real,
  authoritative mutex for the rare race between two near-simultaneous
  requests — the loser's `SyncAlreadyRunningError` is caught and logged,
  not surfaced, since its request already got a response).
- **Cache invalidation** — once the fire-and-forget `runSync()` promise
  resolves, the route calls `revalidateTag("datasets")` plus
  `revalidateTag("dataset:<id>")` for every affected dataset (just the one
  for a single-dataset sync; every dataset currently on file for a full
  sync — cheap, and correctly covers datasets the catalog fetch newly
  discovered that run), so Phase 4/5's `unstable_cache`d public pages
  reflect the new data immediately instead of waiting out their cache.

### `GET /api/sync/status`

Same combined auth. Returns `{ lock, latestLog }` — `lock` is
`getLockState()`'s `{ running, since, stale }`, `latestLog` is the most
recent `SyncLog` row. Polled by the admin dashboard every 3s while a sync
is (or might be) running.

### `/admin`

No user accounts — a single shared token compared server-side:

- **`/admin/login`** — a plain form; `loginAction` (`src/app/admin/login/actions.ts`,
  a Server Action) compares the submitted value to `process.env.ADMIN_TOKEN`
  and, on a match, sets the httpOnly `admin_token` cookie (7-day expiry,
  `secure` in production) and redirects to `/admin`. A mismatch redirects
  back with `?error=1`, rendered as an Arabic error message.
- **`src/middleware.ts`** — guards every `/admin/*` route except
  `/admin/login` itself, checking that cookie and redirecting to the login
  form otherwise.
- **`/admin` (`src/app/admin/page.tsx` + `src/components/admin/admin-dashboard.tsx`)**
  — a Server Component does the initial data fetch straight from Postgres
  (`src/lib/admin/queries.ts` — deliberately uncached, unlike
  `src/lib/queries.ts`'s public queries, since this page exists to show
  real, current state) feeding a Client Component for the interactive
  parts:
  - Header stat cards: total datasets, ok/partial/error/pending counts,
    last sync time + duration.
  - **"مزامنة الكل الآن"** — `POST`s `/api/sync` (cookie-authed, no
    `?dataset=`), shows a spinner, and polls `/api/sync/status` every 3s
    until the lock clears, then calls `router.refresh()` to pull fresh
    numbers from the server (the data props are read directly in JSX
    rather than copied into `useState`, specifically so `refresh()`
    actually shows new data instead of state frozen at first mount).
  - **Failures table** — every `syncStatus: "error"` dataset, its
    `syncError`, and a per-row "إعادة المحاولة" button
    (`POST /api/sync?dataset=<id>&force=1`, same polling/refresh flow).
  - **Last 20 `SyncLog` rows.**
  - **Full searchable dataset list** — all 512 rows fetched once,
    filtered client-side (id/title/theme/publisher substring match — no
    pagination needed at this size), status dot per row, and a
    per-dataset "مزامنة" button (same `?dataset=<id>&force=1` flow).
  - If a sync is already running when the page loads (started from the
    CLI, or another admin tab), the dashboard detects this via the
    server-fetched initial lock state and starts polling immediately
    instead of waiting for a button click.
  - **`تسجيل الخروج`** — a small form on the page itself,
    `logoutAction` clears the cookie and redirects to `/admin/login`.

### Verified locally against the live sync (not just rendered statically)

`pnpm dev`, logged into `/admin` with the real `ADMIN_TOKEN` from `.env`,
then exercised the real endpoints end-to-end: unauthenticated `GET
/api/sync/status` / `POST /api/sync` both 401; a bearer-authed
`POST /api/sync?dataset=<id>&force=1` for one dataset returned `202`
immediately, the lock flipped `running: true` then cleared, a new
`SyncLog` row appeared, and the dataset's `syncStatus` flipped to `ok`
with real `vizConfig`/`chartData` computed; two near-simultaneous
requests for the same dataset correctly produced one `202` + one `409`;
from inside the logged-in `/admin` page's own JS context, the
cookie-only-authed `fetch()` calls the dashboard's buttons actually make
(`/api/sync/status`, then `POST /api/sync?dataset=...&force=1`) were
run directly and confirmed to work with zero bearer header — proving the
dual-auth path — and after the run, reloading `/admin` showed the header
counts, sync log, and that dataset's row in the searchable list all
reflecting the new state; the freshly-synced dataset's own public
`/dataset/[id]` page and the home page's portal-wide stats were checked
straight after (no server restart) and both showed the new data,
confirming `revalidateTag()` is actually wired up. `SyncLock` was
confirmed `running: false` before the dev server was stopped.

## Phase 7 — polish pass

A read-through of every page built in Phases 1–6, fixing consistency/quality-floor
issues rather than adding features. Verified locally (`pnpm dev` against the real
synced DB, `docker compose` Postgres) at 360px/desktop widths, `pnpm lint` and
`pnpm build` clean throughout. What was actually wrong, found and fixed:

- **Stray Arabic-Indic digits**: `not-found.tsx`'s "404" heading was literally
  `٤٠٤` (Arabic-Indic digits), the one place in the whole app that violated the
  "Latin tabular digits everywhere" rule — a `grep -P '[\x{0660}-\x{0669}]'`
  across `src` confirmed it was the only offender. Now renders through
  `NumberLatin` like every other figure.
- **Unwrapped numbers inside pre-baked Arabic sentences**: `dataset.summaryAr`
  (Phase 3's template-generated lead sentence on `/dataset/[id]`, e.g. "آخر قيمة
  مسجلة: 42403 في 2026، بتغير ‑49.5% عن الفترة السابقة.") is a single flat
  string with its Latin-digit numbers embedded directly in Arabic prose — never
  wrapped in a `dir="ltr"`/tabular-nums span, unlike every other number in the
  app. Since it's opaque stored text rather than separate props, fixed with a
  new small component, `src/components/arabic-text-with-numbers.tsx`
  (`ArabicTextWithNumbers`), that regex-splits the string and wraps just the
  numeric tokens (including a trailing `%`/`٪`) — used on the one call site
  that renders `summaryAr`. Also fixed `buildSummaryAr()` in
  `src/lib/sync/derived.ts` to emit ASCII `%` instead of the Arabic percent
  sign `٪` going forward, matching `formatPercent()`'s existing convention
  (the wrapping component still handles `٪` too, since already-synced rows in
  the local DB have the old character baked in until they're re-synced).
- **A real chart-correctness bug in the Phase 3 visualization engine**, found
  by eyeballing `/dataset/housing-units-by-housing-type-and-occupancy-census-2020`
  (a `bar-stacked` chart): `buildBarStacked()` picked its category (x-axis) and
  series (stack) dimensions as "the two lowest-cardinality dimension fields",
  with no check for whether those two fields actually mean the same thing. This
  catalog is bilingual — many datasets carry an English field and an Arabic
  twin describing the exact same value (here: `Occupancy`/"Vacant,Occupied"
  and `الإشغال`/"شاغر,مشغول") — and when both happen to tie for lowest
  cardinality, the chart ends up plotting a field against its own translation:
  every x-axis category has exactly one non-zero stacked segment (since
  category and series are 1-to-1 correlated), which both looks wrong and
  completely hides the dataset's actually-interesting dimension (here,
  `Housing Type`, which never got picked at all). Fixed with a new
  `isRedundantDimensionPair()` check (data-driven — it tests whether one
  field's value fully determines the other's across the sampled records, no
  language-specific assumptions) that `buildBarStacked()` now uses to skip
  redundant candidate pairs and try the next-lowest-cardinality combination,
  falling back to `table` (existing, already-safe behavior) if every pair is
  redundant. Verified against real data: re-synced the affected dataset
  (`pnpm sync -- --dataset housing-units-by-housing-type-and-occupancy-census-2020
  --force`) and confirmed the chart now correctly plots Housing Type × Occupancy;
  re-synced the other 2 locally-present `bar-stacked` datasets plus a 40-dataset
  batch (`pnpm sync -- --limit 40 --force`) and confirmed no regressions (all
  still pick sensible, non-redundant pairs; nothing crashed).
- **A dangling divider hairline on wrap**: the home hero's `HeroStatBand` (4
  stats) drew its "separated by 1px hairlines" divider with a plain
  "every item but the first gets a `border-r`" rule, which only makes sense
  when all 4 items share one row. Below `sm`, the row wraps (confirmed at
  360px), and whichever stat wraps onto its own new line keeps its right
  border with no right-hand neighbor to sit next to — a hairline floating at
  the top of an otherwise-empty edge. Fixed by making the band a single
  stacked column with horizontal dividers below `sm` (where it's genuinely a
  list, not a row) and only switching to the row-with-vertical-dividers
  layout from `sm` up, where it doesn't wrap.
- **A right-vs-left RTL bug in the design system's own signature element**:
  `ThemeChip` (the category-rail chips on `/`) implemented the spec's "chip
  right-border (3px)" accent with `borderInlineEnd`, a *logical* CSS property
  — which resolves to the physical **left** edge under this app's
  `dir="rtl"`, not the right. `ThemeTile`/`PublisherTile`'s equivalent
  colored-stripe accent both correctly use a physical `right-0`, confirming
  the intended treatment is a fixed physical-right accent (like the card
  footer's dashed top border — a decorative constant, not something meant to
  mirror with reading direction). Fixed `ThemeChip` to use physical
  `borderRight` to match.
- **`robots.ts`** now `Disallow: /admin` in addition to the existing
  per-page `robots: { index: false, follow: false }` metadata on
  `/admin`/`/admin/login` — belt-and-braces so crawlers don't even request
  the login form.
- **Admin dashboard duration formatting inconsistency**: the same
  `formatDuration()` call was wrapped in a `dir="ltr"`/tabular-nums `<span>`
  in the sync-log table but not in the header "آخر مزامنة" stat card right
  above it. Made the header card match the table's existing treatment.

Everything else audited and found already correct: keyboard focus-visible
states (global CSS rule, spot-checked via Tab), `prefers-reduced-motion`
(global override plus Tailwind's `motion-reduce:` on the admin spinner),
empty/loading/error states (all plain, natural Arabic, consistent tone and
terminology — "مملكة البحرين" and "الجهات الحكومية" used consistently
throughout, no mixed-terminology found), SEO metadata on every route,
`sitemap.ts`/`robots.ts` route coverage, and chart RTL correctness on the
already-verified `area`/`multi-line` chart types (canvas `dir="ltr"`,
custom tooltip/legend forced `dir="rtl"`, digits never garbled — confirmed
via the rendered DOM text, not just visually).

## Production deployment

Phase 8. Everything below produces **local files only** — no remote server,
DNS, or tunnel config was touched by this phase. The steps that do touch
real infrastructure (marked below) are for a human to run directly on the
VPS.

### Overview

- `Dockerfile` — multi-stage build (`node:22-alpine`, pnpm, Next's
  `output: "standalone"`). See the comment block at the top of the file for
  why the final stage overlays the builder's complete `node_modules` on top
  of the standalone output (a deliberate workaround for Prisma's native
  query-engine binary not being reliably traced by Next, combined with
  pnpm's content-addressed `node_modules/.pnpm/...` store layout).
- `docker/entrypoint.sh` — runs `prisma migrate deploy` (safe/idempotent —
  applies only not-yet-applied migrations) before starting the server, so a
  container never serves traffic against a schema it hasn't migrated to.
- `docker-compose.yml` — now describes the **production** stack: `app`
  (built from the `Dockerfile`, bound to `127.0.0.1:3000` only, `restart:
  unless-stopped`, a healthcheck against `GET /api/health`) and `db`
  (`postgres:16-alpine`, named volume, healthcheck), with `app` waiting on
  `db`'s healthcheck via `depends_on: condition: service_healthy`. No port
  is published to the outside world — see
  [Cloudflare Tunnel](#cloudflare-tunnel-manual-vps-step) below for how
  `data.hekkapp.com` actually reaches port 3000.
- `src/app/api/health/route.ts` — the endpoint the `app` healthcheck hits.
  Deliberately doesn't touch Postgres (a DB hiccup should surface as a
  normal error on real pages, not flap the container's health status on top
  of a database problem) — it only proves the Next.js server itself is
  responding.
- `.env.example` — production defaults (`DATABASE_URL` pointed at the `db`
  service name, `NEXT_PUBLIC_SITE_URL=https://data.hekkapp.com`). Copy it to
  `.env` on the VPS and replace `ADMIN_TOKEN`/`SYNC_TOKEN` with real random
  values (e.g. `openssl rand -hex 32`) — never deploy with the placeholder
  `change-me-long-random` values.

### Bringing the stack up (on the VPS, once Docker + this repo are there)

```bash
git clone <this-repo> nabd-albahrain
cd nabd-albahrain
cp .env.example .env
# edit .env: real ADMIN_TOKEN / SYNC_TOKEN (openssl rand -hex 32 for each)
docker compose up -d --build
```

This builds the `app` image, starts `db` first, waits for its healthcheck,
then starts `app` — which runs `prisma migrate deploy` (applying the schema
to a fresh database) before starting the server. Check both containers are
healthy:

```bash
docker compose ps
```

Then run the first sync (see [Daily sync cron](#daily-sync-cron-job-manual-vps-step)
below for the same call, automated) to populate the database:

```bash
curl -fsS -X POST -H "Authorization: Bearer $SYNC_TOKEN" http://127.0.0.1:3000/api/sync
```

This kicks off a background full sync (fire-and-forget — see
[Sync API & admin dashboard](#sync-api--admin-dashboard) above); watch its
progress via `docker compose logs -f app` or by polling
`GET /api/sync/status`, or from `/admin` once DNS is live.

### Daily sync cron job (manual VPS step)

Add this line to the **host's** crontab (`crontab -e`; not inside the
container) — data.gov.bh publishes on its own schedule, so a nightly refresh
keeps the mirror current without hammering the source:

```cron
15 3 * * * curl -fsS -X POST -H "Authorization: Bearer $SYNC_TOKEN" http://127.0.0.1:3000/api/sync >> /var/log/nabd-sync.log 2>&1
```

Replace `$SYNC_TOKEN` with the literal value from the VPS's `.env` (cron
doesn't inherit your shell's environment — either paste the real token
inline, or `source`/export it from a file crontab reads first). `curl` talks
to `127.0.0.1:3000` because that's the only interface `app` is bound to —
this line only works run from the VPS itself, never from outside it.

### Cloudflare Tunnel (manual VPS step)

The VPS already runs `cloudflared` for other services on an existing
tunnel — this just adds one more ingress rule, it doesn't create a new
tunnel:

1. Edit the existing tunnel's config (typically
   `/etc/cloudflared/config.yml` or `~/.cloudflared/config.yml`) and add an
   ingress rule mapping the new hostname to this app's local port, **above**
   the catch-all `service: http_status:404` rule (Cloudflare Tunnel ingress
   rules are matched top-to-bottom, first match wins):

   ```yaml
   ingress:
     - hostname: data.hekkapp.com
       service: http://localhost:3000
     # ... existing rules for other hostnames on this tunnel ...
     - service: http_status:404
   ```

2. Route the DNS record to this tunnel:

   ```bash
   cloudflared tunnel route dns <tunnel-name> data.hekkapp.com
   ```

3. Restart `cloudflared` (e.g. `sudo systemctl restart cloudflared`, or
   however it's run on that host) to pick up the config change.

No port is opened on the VPS firewall for this — `app` is bound to
`127.0.0.1:3000` only (see `docker-compose.yml`), reachable exclusively via
the tunnel's outbound-only connection to Cloudflare. TLS terminates at
Cloudflare's edge; traffic from Cloudflare to `cloudflared` to `app` on the
VPS is plain HTTP over loopback, which is fine since it never leaves the
host.

## Full sync results (Phase 8)

`pnpm sync -- --force` was run against the live data.gov.bh API into local
Postgres (started from a catalog that already had metadata for all 512
datasets from earlier phases' partial syncs — `--force` re-fetched every
dataset's records regardless). Result:

```
processed: 512
succeeded: 512 (skipped/unchanged: 0)
failed:    0
```

- **507 `ok`, 5 `partial`, 0 `error`, 0 `pending`** — every dataset in the
  live catalog synced successfully; the 95%-`ok`/`partial` bar from the
  spec was cleared at 100%, so there was no failures table to iterate on
  in `/admin`. The 5 `partial` datasets (`05-import-2021`, `04-import-2022`,
  `import-1-2025`, `import-2024`,
  `01-import-non-oil-classified-by-commodity-and-country-for-2023` — all
  detailed trade-by-commodity-and-country tables) each had 310,000–325,000
  source rows, correctly hit the 300,000-row hard cap, and stored the first
  50,000 as designed.
- **1,212,280 `DatasetRecord` rows** stored across all datasets.
- **Wall-clock time: ~6 minutes 38 seconds** (`02:00:43`–`02:07:21`) for
  the full catalog — faster than the "genuinely long time" the task brief
  expected, since most of this catalog's datasets are small statistical
  tables rather than huge exports; the politeness rules (concurrency 3,
  ~250ms stagger, 2 retries with backoff) were never visibly a bottleneck.
- **No dataset schema surprises the sync engine didn't already handle** —
  0 null `theme`, 0 null `publisher`, 0 null `vizConfig`/`summaryAr`, 0
  empty exports. This isn't luck: Phases 2/3's Zod schemas, per-field
  classification, and the `try/catch` wrapping in
  `engine.ts`/`derived.ts` (see
  [Sync engine](#sync-engine)/[Visualization-inference engine](#visualization-inference-engine)
  above) were already written defensively enough that the long tail of
  the real catalog didn't need new special-casing.
- **`vizConfig` chart-type distribution** across all 512:
  multi-line 269, area 125, bar-stacked 96, table 18, histogram 4 (0
  `bar-h`, correctly superseded by earlier rules in the decision tree
  whenever they also matched). The 18 `table` fallbacks spot-checked as
  genuinely correct fallbacks, not a bug — mostly `geographical-locations-of-*`
  point-data datasets (no real temporal/measure axis) and inspection-result
  tables.

**Two real bugs were found and fixed while doing this real, whole-catalog
run** — not in the sync engine itself (which held up perfectly), but in
how the app *serves* real data in production and *summarizes* it on cards:

1. **The Docker build was broken by a static-rendering bug that only a
   real production build (not `pnpm dev`) would ever surface.** `/`,
   `/categories`, `/publishers`, `/search`, and `sitemap.xml` are all
   Server Components that read Postgres directly with no `dynamic` export,
   so `next build` tried to fully prerender them as static HTML at *build*
   time — which requires a live, reachable `DATABASE_URL`. `docker build`
   (correctly, by design — see [Production deployment](#production-deployment))
   never has a database reachable during the image build, so this failed
   outright with `PrismaClientInitializationError: Environment variable
   not found: DATABASE_URL` prerendering `/`. Fixed by adding
   `export const dynamic = "force-dynamic"` to each of those routes (see
   the comment on `src/app/(home)/page.tsx` for the full reasoning) —
   confirmed by a clean `docker build` afterward, plus running the built
   image end-to-end against a real `db` container (`prisma migrate
   deploy` applied, then `/`, `/categories`, `/sitemap.xml`,
   `/dataset/01-unemployment-monthly` all returned 200, an unknown dataset
   404'd, and an unauthenticated `POST /api/sync` 401'd).
2. **`extractFeaturedMetric()` (`src/lib/chart-data.ts`) silently produced
   wrong headline numbers for a common real-data pattern**, found while
   picking `src/config/featured.ts` entries: several multi-line datasets'
   series include an explicit "Total" value *alongside* its own
   sub-components (e.g. `01-caa-monthly-passenger-movement-at-bahrain-international-airport`'s
   `data_type` series is `["Passengers Total", "Passengers Disembark",
   "Passengers Transfers", "Passengers Embark", "Passengers Transit"]`).
   The old code summed every series value, double-counting the total
   against its own parts — real airport passengers ~1.5M was rendering as
   ~4.7M. Fixed with `pickTotalSeriesKey()`: when a multi-line series
   includes an already-labeled total, use that value directly instead of
   summing everything. This fix lives in the shared view-model helper used
   by every `DatasetCard` sparkline site-wide, not just the featured band,
   so it corrects this pattern everywhere it occurs in the catalog, not
   only for the 2 entries below that happened to trigger it
   (`01-caa-monthly-passenger-movement-at-bahrain-international-airport`,
   `01-container-statistics-at-khalifa-bin-salman-port`). Separately, a
   *third* class of the same underlying problem
   (`01-unemployment-monthly`'s multi-line series mixes a rate percentage
   with a headcount in the same sum, and
   `01-consumer-price-index-division-and-group-index-number`'s `area`
   chart — a pre-existing Phase 4 pick — sums CPI index *points* across
   categories into a meaningless ~42,000, per the known limitation already
   documented in
   [Visualization-inference engine](#visualization-inference-engine)
   above) has no reliable data-driven fix, so those datasets were simply
   **not** picked as featured entries rather than shipped with a
   misleading number — see the doc comment in `src/config/featured.ts` for
   the full reasoning behind every entry that was picked vs. rejected.

`src/config/featured.ts` was refined to 6 entries picked from the real,
fully-synced catalog and individually verified against real `chartData`
(not just "a chart exists"): population, live births, registered vehicles,
airport passengers, port container throughput, and governmental schools —
spanning Population, Births and Deaths, and Transportation/Education
themes. Spot-checked on `/` after a cold restart (`rm -rf .next && pnpm
dev`, needed because `unstable_cache`'s on-disk Data Cache persists across
dev-server restarts and this sync ran via the CLI, which — unlike
`POST /api/sync` — never calls `revalidateTag()`; a production container
never hits this, since each fresh container starts with an empty cache):
all 6 cards render with the exact expected numbers (population
1,603,260; live births 16,787; vehicles 794,677; airport passengers
1,497,470.61; port containers 107,010; schools 209), correct Arabic
labels, and working sparklines.

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
