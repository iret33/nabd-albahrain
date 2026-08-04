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

**Phase 6 of 9 — the sync API routes and the `/admin` dashboard.** Phase 1 set up the app shell, design system, database
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
