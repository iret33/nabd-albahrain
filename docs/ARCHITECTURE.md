# Architecture

How Nabd Al-Bahrain works, in enough depth to maintain it. The README is the front door
(setup, configuration, API reference, deployment); this file explains the machinery behind
it. Everything here was checked against the code at the "Integrate stage 3 fixes" commit;
file paths are relative to the repository root. Unverified assumptions are labelled as such.

Contents: [Overview](#overview) · [Data model](#data-model) · [Sync engine](#sync-engine-phases) ·
[Lock and SyncLog](#lock-heartbeat-and-the-synclog-lifecycle) · [Change detection](#change-detection) ·
[Integrity guards](#integrity-guards) · [Derived fields](#derived-fields-pipeline) ·
[Caching](#caching-and-invalidation) · [Search](#search) ·
[Freshness and public refresh](#freshness-and-the-public-refresh-protocol) · [Scheduler](#scheduler) ·
[Public API layer](#public-api-layer) · [Security model](#security-model) ·
[Front-end conventions](#front-end-conventions) · [Changing things safely](#changing-things-safely)

## Overview

One Node process serves the website, the JSON API and the admin dashboard, and also hosts
the sync engine and its scheduler. Postgres is the only datastore. The portal is only ever
contacted by the sync engine; no visitor request reaches data.gov.bh.

```
                        +-------------------------------------------+
   visitors ----------> |  Next.js 15 server (one Node process)     |
   (browsers, feed      |   - pages (RSC, force-dynamic)            |
   readers, API         |   - /api/v1/*   public read-only API      |
   clients)             |   - /api/freshness, /api/refresh (public) |
                        |   - /api/sync*, /api/revalidate (token)   |
   admin -------------> |   - /admin (signed session)               |
                        |   - middleware (Edge): session check,     |
                        |       %-encoding 404, ?constructor= strip |
                        |   - instrumentation: env validation,      |
                        |       scheduler, boot sweep               |
                        +-----------+-------------------+-----------+
                                    | Prisma            | runSync() in-process
                                    v                   v
                        +-----------------+     +------------------------+
   CLI / one-off        |   PostgreSQL 16 |<----|  Sync engine           |
   container ---------> |  Dataset        |     |  catalog -> plan ->    |----> data.gov.bh
   (same engine,        |  DatasetRecord  |     |  download -> derive -> |      (OpenDataSoft
   same lock)           |  SyncLog        |     |  transaction -> notify |       Explore API v2.1)
                        |  SyncState      |     +-----------+------------+
                        |  SyncLock       |                 |
                        +-----------------+                 | POST /api/revalidate
                                    ^                       v (Bearer SYNC_TOKEN)
                                    |            drops Next.js data-cache tags
                                    +----------- (datasets, dataset:<id>)
```

Who can start a run (all go through the same `runSync()` in `src/lib/sync/engine.ts`, all
serialized by the same database lock):

| Trigger value in `SyncLog` | Started by | Notes |
| --- | --- | --- |
| `auto` | the built-in scheduler | `AUTO_SYNC_INTERVAL_MINUTES` > 0 |
| `public` | a visitor pressing the refresh button | capped: 5 datasets, <= `PUBLIC_REFRESH_MAX_RECORDS` rows each, never forced |
| `api` | `POST /api/sync` (bearer token or admin session) | the admin dashboard buttons use this |
| `cli` | `pnpm sync` / `node dist/sync-cli.cjs` / `docker compose run --rm app sync` | prints a summary, exit code 1 on `failed`/`aborted` |

Heavy runs execute inside the web process when started by the scheduler, the API or a
public press (documented limitation, see README "Known limitations"). Running the CLI in a
separate container moves the work out of the web process; the lock keeps both safe.

Next.js specifics that shape the design: `output: "standalone"` (the Docker image runs
`node server.js`); every route is `force-dynamic` (a build must never need a database);
`unstable_cache` is the only server cache (the Data Cache); the middleware runs on the Edge
runtime and so may only import runtime-neutral modules (hence Web Crypto in
`src/lib/admin-session.ts`).

## Data model

`prisma/schema.prisma` (read its header comment first). Five models:

| Model | Rows | What it holds |
| --- | --- | --- |
| `Dataset` | one per portal dataset (`id` = the ODS `dataset_id`) | portal metadata (`title`, `titleClean`, `titleAr`, `description`, `theme` = first theme, `publisher`, `keywords`, `license`, `recordsCount`, `fieldsJson`, `sourceModified`), the normalized `searchText`, the derived columns (`statsJson`, `vizConfig`, `chartData`, `summaryAr`, `derivedVersion`), and per-dataset sync state (`syncStatus` `pending/ok/partial/error`, `syncError`, `sourceCount`, `lastSyncedAt`, `syncedVersion`, `lastCheckedAt`, `refreshRequestedAt`, `removedAt`) |
| `DatasetRecord` | the stored rows | `data` JSON per row, `id` autoincrement; indexed on `(datasetId, id)` for keyset paging; bulk-replaced on every re-sync of its dataset (new, higher ids each time) |
| `SyncLog` | one per run (sync or recompute) | `trigger`, `scope`, `status` (`running/success/partial/failed/aborted`), counters (`total/processed/succeeded/failed/skipped/updated`), `error`, `failuresJson`, `changedJson` (`updated/deferred/removed/added` id lists, each capped at 1,000), timestamps |
| `SyncState` | singleton (`id = 1`) | `lastCatalogCheckAt`, `lastSuccessAt`, `lastDataChangeAt`, `lastFullPassAt` (the scheduler's clock), `lastPublicRefreshAt` (catalog cooldown anchor) |
| `SyncLock` | singleton (`id = 1`) | `running`, `since`, `holder`, `heartbeatAt` |

Search uses three hand-written `pg_trgm` GIN indexes on `Dataset` (`titleClean`,
`description`, `searchText`). They are declared in `schema.prisma` with matching `map:`
names so `prisma migrate dev` sees no drift and does not propose to drop them (verified:
`prisma migrate diff` between a freshly migrated database and the schema prints an empty
migration). Never edit an applied migration: Prisma checks its checksum, and
`.gitattributes` forces LF so a CRLF checkout cannot change the bytes.

Timestamps in `SyncLock`, `SyncLog` and the cooldown columns are `timestamp(3)` without a
time zone. Everything that compares them (staleness, cooldowns, retention) does so inside
Postgres with `timezone('utc', now())`, never with JS dates, so the answer cannot depend on
the app server's clock or the database session time zone.

## Sync engine phases

`runSync(opts)` (`src/lib/sync/engine.ts`). `startSyncInBackground(opts)` is the same run
but takes the lock and writes the `SyncLog` row **before** returning, so an HTTP caller can
answer `202` or `409` truthfully; the work then continues detached and never throws.

Options: `datasetId` (one dataset), `limit` (first N of the catalog), `force`, `dryRun`,
`maxRecords` / `maxDatasets` (the public-refresh caps), `trigger`, `signal`. The `SyncLog`
`scope` is `dataset:<id>`, `all` (forced) or `changed`; recompute runs use `recompute`.

```
 beginRun        acquire lock (atomic, heartbeat), mark orphaned "running" rows aborted,
                 create the SyncLog row (status running), clear the freshness memo
 catalog phase   dataset scope : GET /catalog/datasets/{id}  (falls back to the full catalog)
                 otherwise     : GET /catalog/datasets?limit=100&offset=N&order_by=dataset_id,
                                 whole pass verified complete, up to 3 attempts
                 -> assert the catalog is plausible (>= 50% of known live datasets)
                 -> upsert metadata only where it changed; clear removedAt on reappearance
                 -> flag datasets a COMPLETE catalog no longer lists (removedAt)
                 -> stamp lastCheckedAt on every dataset seen
 plan            per dataset: changeReason() = forced | new | not-ok | version | inconsistent | null
                 maxRecords : over the cap -> deferred;  maxDatasets : cheapest first, rest deferred
 download        up to SYNC_CONCURRENCY datasets in parallel; datasets the portal advertises with
                 > 50,000 rows (or an unknown count) go one at a time through an abortable gate
 per dataset     GET /catalog/datasets/{id}/exports/json -> integrity check
                 -> computeDerivedFields() over the FULL export
                 -> one transaction: advisory lock, delete old rows, insert <= 1,000 per batch,
                    update the Dataset row (sourceCount, syncStatus, syncedVersion,
                    derivedVersion, derived columns, lastSyncedAt)
                 One dataset's failure is caught, recorded (syncStatus "error") and never stops
                 the loop.
 endRun          finalize SyncLog -> update SyncState -> POST /api/revalidate -> prune SyncLog
                 (hourly) -> release the lock (ONLY then, so a poller sees "done" after the
                 caches were told) -> clear the freshness memo
```

Details worth knowing:

- **Size guard.** More than 300,000 rows (`MAX_ROWS_HARD_CAP`, `src/lib/row-limits.ts`):
  only the first 50,000 are stored (`MAX_ROWS_STORED_WHEN_CAPPED`) and the dataset is
  `partial`; the derived fields are still computed over the full download. Up to 300,000
  rows are stored whole. Inserts are batches of 1,000 (`INSERT_BATCH_SIZE`).
- **Run status.** `success`; `partial` when some datasets failed but at least one other
  finished fine (unchanged datasets count as fine); `failed` when none did, or the run
  itself failed (portal down, incomplete catalog); `aborted` on a shutdown signal, a lost
  lock or an orphan sweep. A `partial` run still advances
  `lastSuccessAt` (monitors learn about failures through `lastRun.failed`,
  `dataset.failed` and `/api/health/ready`, not through the run status).
- **SyncState clocks.** `lastCatalogCheckAt`: any run that applied a complete catalog.
  `lastFullPassAt`: only an *unrestricted* catalog-wide run (no `datasetId`, `limit`,
  `maxRecords`, `maxDatasets`, not a dry run: `isUnrestrictedCatalogRun`), i.e. the
  scheduler, the admin button or the CLI, never a public press. `lastSuccessAt`: a
  success/partial run that is not dataset-scoped. `lastDataChangeAt`: a run that updated at
  least one dataset. Recompute runs touch none of them.
- **Dry run** (`--dry-run`): catalog pass and planning only; no lock, no `SyncLog` row, no
  metadata writes, no downloads.
- **Polite HTTP** (`src/lib/sync/http.ts`): at most `SYNC_CONCURRENCY` requests in flight,
  `SYNC_DELAY_MS` between request starts, 2 retries with exponential backoff on 429/5xx or
  network errors (honouring `Retry-After`, capped at 60 s), a per-attempt deadline that
  covers the body (`SYNC_REQUEST_TIMEOUT_MS` for the catalog, `SYNC_EXPORT_TIMEOUT_MS` for
  exports), and a `User-Agent` (`USER_AGENT`). The engine's dataset-level concurrency and
  the HTTP concurrency are the same `SYNC_CONCURRENCY` setting.
- **Validation** (`src/lib/sync/schemas.ts`): each catalog entry is validated on its own, so
  one malformed entry is skipped and reported (counted as a failure, never pruned) instead
  of aborting the pass. A `modified` before 1970 or more than a day in the future is ignored
  (with a warning) so it cannot pin a dataset to the top of `/updates` and the feed.
- **Recompute** (`src/lib/sync/recompute.ts`): re-derives the derived columns from the
  stored rows without any network access, for datasets whose `derivedVersion` is not the
  current one. Only `ok` datasets qualify (zero-row ones included); `partial` datasets
  cannot, because only a prefix of their rows is stored, and are listed in
  `skippedPartial`. If the stored row count does not match `sourceCount` the dataset is
  flagged `error` so the next sync re-downloads it.

## Lock, heartbeat and the SyncLog lifecycle

`src/lib/sync/lock.ts`, `src/lib/sync/log.ts`, `src/lib/sync/run.ts`.

- **Acquire** is one statement: `INSERT ... ON CONFLICT DO UPDATE ... WHERE <free or stale>
  RETURNING`. Postgres makes a second concurrent caller wait on the row lock and re-check
  the `WHERE`, so exactly one caller gets a row back. The winner receives a random
  `holder` token; release and heartbeat only touch the row while it still carries it, so a
  run that outlived a takeover can neither free nor keep alive someone else's lock.
- **Heartbeat** every 30 s from a timer inside the lock handle. A lock whose heartbeat (or
  `since` for legacy rows) is older than **10 minutes** is stale and can be taken over; a
  crash or redeploy therefore recovers in minutes, and a healthy long run is never
  mistaken for a dead one. If a heartbeat finds the lock owned by someone else, the run
  aborts (`SyncAbortedError`).
- **SyncLog row** exists from the moment the lock is held (`status = running`), is updated
  at most every 1.5 s with progress counters while the run goes on, and is finalized in a
  `finally` block with the status, counters, failures and `changedJson`. A run that dies
  without finalizing leaves a `running` row; the next run that holds the lock
  (`abortOrphanedRuns`) and the boot sweep (`sweepOrphanedRuns`) mark such rows `aborted`
  ("Process died or was killed before the run finished").
- **Shutdown.** `installShutdownHandlers` aborts in-flight runs on SIGTERM/SIGINT; the run
  finalizes its row as `aborted` and releases the lock itself. By default Next installs
  its own handler that exits immediately, so the release is best-effort and the
  heartbeat window is the real guarantee. The Docker image sets
  `NEXT_MANUAL_SIG_HANDLE=true`, which makes the app own the signal: a `docker stop`
  mid-sync then aborts cleanly and frees the lock at once (compose gives it
  `stop_grace_period: 30s`). Caveat: the process then exits without closing the HTTP
  server first.
- **Retention** (`pruneSyncLogs`, at most hourly per process, after every run and on every
  scheduler tick): keeps the newest 200 rows and the rows the freshness/health/admin
  banners read; deletes no-op public presses (success, nothing updated, nothing failed)
  after 7 days, other rows after 90 days, and failed/partial/aborted rows of non-public
  runs after 365 days. Deletion runs in batches of 500, at most 20 batches per call.

## Change detection

`src/lib/sync/version.ts`. "Did the portal publish something new?" is answered by plain
equality of an **opaque version token**, never by comparing our clock with the portal's:

```
v1 | metas.modified | metas.data_processed | metas.metadata_processed | records_count | fnv1a(sorted field names)
```

A missing input contributes an empty slot, so the token degrades to `modified` +
`records_count`. The token of the entry the run *started from* is stored with the rows
(`Dataset.syncedVersion`); if the portal changes while a download is in flight, the next
catalog pass sees a different token and syncs again. `changeReason()` also re-downloads
datasets that are not `ok`/`partial` (an `error` dataset is always retried, even if its
token matches), rows that predate the token (legacy: counted as changed exactly once), and
datasets that store zero rows although the catalog advertises some (`inconsistent`).
Changing `VERSION_PREFIX` makes every dataset re-sync once.

Unverified against the real portal: whether `data_processed` / `metadata_processed` move
exactly when the data does. If the portal moves them more often than the data changes,
scheduled syncs re-download more than necessary; that risk comes with this design.

## Integrity guards

`src/lib/sync/integrity.ts`, applied before anything is written (a thrown
`SyncIntegrityError` leaves stored data untouched and the dataset is retried next run):

- **Incomplete catalog**: a catalog pass must prove itself complete (every page reports
  the same `total_count`, distinct entries equal it); otherwise the pass is retried, then
  fails with `CatalogIncompleteError`. Only a complete catalog may flag removals.
- **Implausible catalog** (`assertPlausibleCatalog`): fewer than 50% of the known live
  datasets refuses to prune. There is no override flag; if the portal truly retires more
  than half its datasets an operator must intervene. The single-dataset path applies the
  same test against the whole database's live count.
- **Empty export**: 0 rows while the catalog reports some keeps the previous data.
- **Truncated export** (`SHRINK_GUARD`): fewer than half of both the catalog's row count
  and the previously stored count, for datasets of at least 10 rows, keeps the previous
  data unless forced. `partial` rows are exempt (their stored count is capped).
- **Shape**: an export that is not a JSON array of objects is rejected.

## Derived fields pipeline

`computeDerivedFields(datasetId, records, fields, options?)` in `src/lib/sync/derived.ts`
(about 2,500 lines), with the shared pure rules in `src/lib/series.ts`,
`src/lib/headline.ts`, `src/lib/temporal.ts` and `src/lib/numeric-tokens.ts`. It is
deterministic (no AI/LLM), never throws (an outer `try/catch` falls back to a plain
sentence), and is a small fixed number of linear passes over the rows. It produces
`statsJson`, `vizConfig`, `chartData` and `summaryAr` (Arabic).

**1. Statistics** (`statsJson`, per field): `nullRate`, `distinctCount` (capped, shown as
`"1000+"`), numeric `min/max/mean/median` (median exact up to 10,000 values per field, a
deterministic reservoir sample beyond that), temporal `min/max` as the raw values, top 10
values for text fields with at most 30 distinct values, `unit` (from
`annotations.unit` or a unit-like label suffix such as "(km2)" / "(%)"), and the hints
`numericLike`, `looksLikeYear`, `looksLikeIdentifier` (so the UI never prints "2,020" for a
year).

**2. Classification** (first match wins, per field):

| Class | Rule |
| --- | --- |
| temporal | type `date`/`datetime`, or a `text`/`int` field whose name or label looks temporal and at least 90% of sampled values parse (strict whitelist in `temporal.ts`) |
| month part | a bare "Month" column (1..12 or month names) is combined with a sibling year column, never treated as a date alone; a numeric 1..4 "Quarter" column is not a measure |
| measure | numeric (`int`/`double`) and not an id/code (`id`, `*_id`, `code`, `*_code`), not a row index (dense +1 sequence, or a field literally named `n`), not a longitude/latitude, not an identifier-like integer ("Phone", "Building", "Road No") |
| dimension | `text` with 2..30 distinct values (series-able at <= 8) |
| geo | `geo_point_2d` / `geo_shape` |

**3. Decision tree** (`buildVizConfig`, first match wins; a builder that cannot produce
real data falls through to the next rule, so no empty chart is ever persisted):

1. a temporal field, a measure and a series-able dimension: `multi-line` (at most 8 series;
   `seriesOverflow` flags a truncated list)
2. a temporal field and a measure: `area`
3. exactly one dimension and a measure: `bar-h` (top 15 categories, the rest in an
   "أخرى" bucket, which is always the last row)
4. two or more dimensions and a measure: `bar-stacked` (x: top 15, series: at most 8 with
   an "أخرى" series; rate/mean measures are drawn grouped, not stacked; two dimensions
   that are translations of each other, i.e. one determines the other, are never paired)
5. no dimension, no temporal field, a measure and at least 20 records: `histogram` (10 bins)
6. otherwise `table` (`reason: "geo"` when the dataset has geo fields, else `"no-viz"`)

`chartData` is always pre-aggregated and capped at 500 points (downsampling keeps the
headline period); it is never a raw record dump. When several measures tie on non-null
count, columns are compared like with like (grouped by inferred aggregate and unit): a
total-named column or else the largest-magnitude column wins among additive ones, the most
spread-out among rates, and an additive column that actually varies beats a flat one.

**4. Sum or mean** (`inferAggregate`): a measure is **averaged** when its name, label or
unit says it is a rate, percent, ratio, average, index, price, level, temperature, ... (token-aware, with Arabic
patterns, "Point"/"Level" labels, and `X per Y` / `km/h` ratios; "Number of ..." counts
stay sums), otherwise **summed**. `last` (stock/cumulative values) is never inferred, only
reachable through `src/config/viz-overrides.ts`.

**5. Totals.** Statistical tables often carry a "Total" value next to its parts; summing
both double-counts. Three tiers: *strict* labels (the whole label is "Total" /
"الإجمالي") are dropped on dimensions that are not plotted, by label alone; *loose* labels
with a word-boundary "total" ("Passengers Total") are used only on the plotted series
dimension and only when exactly one matches; *candidates* ("Total (all)", "All
nationalities", "Kingdom of Bahrain"), and any series that equals the sum of the others
in nearly every period, are accepted only when the numbers agree. A multi-line chart keeps
its one total as its own series (`vizConfig.totalKey`); bar charts leave it out. A mean over a hidden dimension uses the
published Total when the table carries one for every period (`usedTotals`), else an
unweighted mean flagged `unweightedMean`. Two or more loose matches are ambiguous: no
pick, no headline.

**6. Periods.** Temporal parsing is a strict whitelist (years 1900..2100, ISO dates,
`YYYY/MM`, day-first `DD/MM/YYYY`, month names in English and Arabic, fiscal years such as
`FY2024` and `2023/24`); "1".."12" or "Item 12" are never dates. A trailing provisional
marker (`2024*`, `2024 (p)`, `2024e`, `2024 مؤقت`) is stripped and recorded
(`provisionalPeriods`); rows with an unreadable period are counted (`droppedPeriodRows`),
never silently dropped. The grain is `month` if any temporal value carries a month, else
`year`. **Gaps** between the first and last period are filled with `null` rows at the
series' own cadence (the greatest common divisor of observed spacings, so quarterly data is
not broken into dots), and the chart does not connect across them.

**7. Partial last period** (`lastPeriodPartial`, sum aggregates only): the last period is
partial when its row count is below 75% of the median of the up-to-5 periods before it
(at least 3 prior periods), or, for daily/weekly data, when the calendar says the month was
cut short (month grain, at least 2 dated prior months with a regular cadence, and
visibly fewer rows). It is drawn dashed and never becomes the headline; the previous period
does. A table with exactly one row per year cannot be judged and is never flagged.
`viz-overrides.ts` can pin `lastPeriod: "complete" | "partial"`.

**8. Headline** (`src/lib/headline.ts`, the ONE implementation; persisted as
`vizConfig.headline` and re-used by the dataset page's lead sentence, the home band and the
cards): the most recent comparable value plus the % change against the previous period. A
labeled total series is used as-is; without one, series are summed only for periods where
every series is present, and the previous period is the latest earlier one with the same
series set. The headline is **withheld** (`null`, with `headlineWithheld` saying why:
`ambiguous-total`, `mean-series`, `mixed-series`, `overflow`, `unweighted-mean`) for two
or more "Total X" series, several mean series, series that are different indicators
(a rate next to a head count, magnitudes five orders apart), a truncated series list, or a
mean over parts without a usable published total. A withheld headline is skipped by the
home band instead of printing a made-up number.

**9. Sentences** (`summaryAr`, template-based): the headline sentence ("آخر قيمة مسجلة: ...")
or, for bar charts, the top category, or a generic row/field count sentence; counted nouns
agree with the number (`src/lib/arabic-count.ts`); one number convention
(`formatSummaryNumber`: up to 2 decimals below 100, 1 below 1,000, none above) and one
percent convention (`formatChangePercent`: one decimal, a change that rounds to 0.0% reads
"flat" with no sign).

**10. Overrides.** `src/config/viz-overrides.ts` pins `measureField`, `aggregate`,
`seriesField` or `lastPeriod` for a dataset id; an invalid pin logs a warning and falls
back to inference (an override never fails silently). The CPI dataset is pinned to `mean`.

### DERIVED_VERSION and recompute

`DERIVED_VERSION` (currently **3**) is a constant in `derived.ts` with its history in the
comment above it. **Bump it whenever a change alters the persisted output for the same
input.** Every dataset records the version that produced it (`derivedVersion`); the
scheduler (each tick) and `pnpm sync:recompute` / `POST /api/sync?recompute=1` re-derive
stale `ok` datasets from the stored rows, with no network. Two things recompute cannot
fix, both needing a **forced sync** of the dataset: `partial` datasets (only 50,000 rows
stored) and, for the same reason, anything whose stored rows do not match `sourceCount`.
Render-time helpers repair some old shapes on the fly (a numeric total for rows that
predate `totalKey`, grouping of old summary numbers), but the stored columns are the
source of truth.

Known limits of the heuristics (name- and arithmetic-based; tuned without the real
portal): multi-level hierarchies (governorates plus their cities next to a national row)
and partially published totals are not detected; a series literally named "Price ..." or a
total-less "indicator / data type" partition loses its headline; the last-period rule
cannot judge one-row-per-year tables, and a historical table whose last period legitimately
has far fewer rows can be flagged partial; irregular sparse series render as dots;
`Q1 2024`, `15 Mar 2024` and `March 15, 2024` periods are unreadable (counted in
`droppedPeriodRows`); series colors are index-based, not stable per name.

## Caching and invalidation

`src/lib/queries.ts` (header), `src/lib/cache-config.ts`, `src/lib/sync/notify.ts`,
`src/app/api/revalidate/route.ts`.

- **Server cache**: `unstable_cache` only, every entry with an explicit `revalidate`.
  `CACHE_TTL_SECONDS` (default 300, 5..86400) for lists and aggregates; **6x** that for
  per-dataset detail, record metadata and first-page records. Dataset *cards* are cached
  per dataset with the base TTL. The TTL is the safety net (CLI syncs, crashes, manual
  SQL), not how fresh data normally appears.
- **Tags**: list/aggregate entries carry `datasets`; per-dataset entries carry only
  `dataset:<id>`. After every run the engine POSTs `/api/revalidate` with the ids it
  updated, added, removed, or rewrote metadata for, so one refreshed dataset no longer
  flushes the other 511.
- **Why an HTTP call**: `revalidateTag` only works synchronously inside a request handler
  (it throws in the CLI, instrumentation or a timer, and is a silent no-op after the
  response). The engine therefore calls its own server (`APP_INTERNAL_URL`, default
  `http://127.0.0.1:$PORT` or `:3000`) with `Authorization: Bearer $SYNC_TOKEN`. Failures
  are logged, never thrown; a missing `SYNC_TOKEN` logs `[notify] SYNC_TOKEN is not set`
  once; pages then fall back to the TTL. `next start -p N` does not set `PORT`, so outside
  Docker set `APP_INTERNAL_URL` explicitly. At most 1,000 ids are sent per run; the
  `datasets` tag covers the rest.
- **Bounded key space**: no attacker-chosen string becomes a cache key. Searches are never
  cached; themes and publisher slugs are validated against the cached lists; dataset ids
  and sort columns are validated against the database and the dataset's own schema;
  lookups that find nothing (or degrade) are returned without being stored (`cachedWhen`).
  Rows come back JSON-serialized from the cache, so every public function revives `Date`
  columns.
- **Uncached by design**: the lists' membership/order/total queries (cheap, so a page past
  the end can be clamped and totals are always fresh), related datasets, the admin
  queries, `/api/freshness`, and `Dataset.lastCheckedAt` on the dataset page (it moves on
  every catalog pass for every dataset, so it is read fresh outside the long-TTL entry).
- **Facet counts** are computed in memory from the filtered row set, not by a cached
  `groupBy`.
- **HTML pages send `Cache-Control: private, no-cache, no-store, max-age=0,
  must-revalidate`** (Next's default for dynamic routes). There is deliberately no public
  `Cache-Control` on HTML, so a refresh shows up at once. The one exception is the JSON/CSV
  API: successful `GET /api/v1/*` answers carry `public, s-maxage=300,
  stale-while-revalidate=3600`; errors are `no-store`. `/admin/*`, `/api/sync*` and the
  other token routes are `no-store`.
- **`robots.txt`** allows `/` and disallows `/admin` and `/api/` only: sorted, filtered,
  paged and searched URLs stay crawlable on purpose (they carry `noindex, follow` plus a
  canonical, which a crawler can only honour if it may fetch them). **`sitemap.xml`** lists
  the home page, `/categories`, `/publishers`, `/updates`, `/about`, `/developers`, each
  theme, each publisher and every live dataset, with `lastModified` = the portal's own
  modified date (falling back to our sync time) and no `changefreq`/`priority`.
  `robots.txt` is generated at build time (static), so its `Sitemap:` line uses the
  *build-time* `NEXT_PUBLIC_SITE_URL`; the sitemap itself is dynamic.

## Search

`src/lib/search.ts`, `src/lib/ranking.ts`, `src/lib/list-query.ts`, `listDatasets()` in
`src/lib/queries.ts`. One engine behind `/search`, `/categories/[theme]`,
`/publishers/[slug]` and `GET /api/v1/datasets`.

- **Index**: `Dataset.searchText` = `normalizeSearch(title + titleClean + titleAr +
  publisher + theme + keywords + description)`, rebuilt by the catalog phase whenever any
  part changes. HTML in the description is stripped for indexing (tags become spaces,
  entities decoded, `<script>`/`<style>`/comments dropped) so "href" or "nbsp" never match.
- **Normalization** (`normalizeSearch`, applied identically to stored text and queries):
  NFKC, lowercase, أ/إ/آ/ٱ -> ا, ى/ی -> ي, ک -> ك, ة -> ه, ؤ -> و, ئ -> ي, diacritics and
  tatweel removed, Arabic-Indic and Persian digits -> ASCII, punctuation -> space,
  whitespace collapsed.
- **Tokens** (`tokenize`): the raw query is capped at 100 characters, at most 6 tokens;
  one-character non-digit tokens are dropped; a leading article/clitic (ال، وال، بال، كال،
  فال، لل) is stripped when at least 3 letters remain ("للمطار" -> "مطار"); duplicates are
  removed after stripping. A query with no usable token yields `query-too-short`.
- **Matching**: every token must occur in `searchText` (`LIKE '%token%'`, AND across
  tokens; accelerated by the trigram GIN index). Broken Arabic plurals are not matched, by
  design. Existing rows keep their old `searchText` until a catalog pass rewrites them
  (a legacy row is repaired by the next pass).
- **Ranking** (`scoreMatch`, in memory over the few hundred survivors): +10 if the whole
  phrase occurs in a title (as written or with prefixes stripped); per token +5 in a
  title, +2 in the publisher or theme, +1 elsewhere (description/keywords). Ties: newest
  `sourceModified` first (undated last), then id. `sort=updated|title|records` and the
  `chart`/`since` filters are applied by the same engine.
- **Filters** are zero-JS GET parameters: `q`, `theme`, `publisher` (slug), `sort`,
  `chart=1`, `since=30d|1y`, `page`; a changed filter resets the page to 1.
- **In-table search** on a dataset's records (`rq`, at most 60 characters) scans stored
  JSON; it takes one of `HEAVY_QUERY_LIMIT` slots (default 4, lowered to
  `connection_limit - 2` when `DATABASE_URL` pins the pool; one client may hold at most
  half of them, and is limited to 120 such queries per minute), is time-capped (3 s
  statement timeout) and degrades to the default order with a notice instead of queueing.
  Cell values that are nested objects expose their key names to this search.

## Freshness and the public refresh protocol

`src/lib/sync/freshness.ts` (read model for `GET /api/freshness`),
`src/app/api/refresh/route.ts`, `src/lib/sync/public-refresh.ts`,
`src/lib/sync/refresh-policy.ts`, `src/components/refresh-button.tsx`.

**Read model.** `getFreshness()` reads only primary-key / tiny-table rows. The
catalog-wide part (`SyncState`, lock, newest finished non-recompute run, running run's
progress) is shared between concurrent callers for 1 s (`FRESHNESS_MEMO_TTL_MS`), strictly
below the client's 2 s poll; runs that start or end inside this process clear it
(`clearFreshnessMemo`), runs in another process are covered by the TTL alone. The
per-dataset part is never memoized (its key is caller-controlled). `stale` means the last
`lastSuccessAt` is older than twice the scheduler interval (48 h when the scheduler is
off) or missing; the same rule feeds `/api/health/ready` and the "data may be old" notice.

**The press, in the order the checks run** (`POST /api/refresh`; every answer is JSON with
`Cache-Control: no-store`):

```
refresh disabled (PUBLIC_REFRESH_ENABLED off) -> 503 {status:"disabled"}
Origin present and not the Host / NEXT_PUBLIC_SITE_URL host
                           -> 403 {status:"bad_origin"}
body not strict JSON (size > 1 KiB, unknown key incl. "force", bad id)
                           -> 400 {status:"bad_request"}       (before any limit is touched)
attempts bucket (120/h per client) or runs bucket (20/h) exhausted
                           -> 429 {status:"rate_limited", retryAfterSeconds} + Retry-After
dataset scope and id unknown or removed
                           -> 404 {status:"unknown_dataset"}
cooldown running (read-only peek: catalog 120 s, dataset 600 s, shared by ALL visitors)
                           -> 429 {status:"cooldown", scope, retryAfterSeconds} + Retry-After
a run holds the lock (read-only peek)
                           -> 202 {status:"already_running", since, scope, runScope}
claim the cooldown atomically (row lock) -- lost the race -> 429 cooldown
catalog scope and the catalog was checked < 60 s ago
                           -> 200 {status:"up_to_date", checkedAt}   (cooldown stays consumed)
startSyncInBackground({trigger:"public", maxRecords, maxDatasets:5, never forced})
   started                 -> 202 {status:"started", runId, scope}
   lock taken in between   -> give the claim back (compare-and-set), 202 already_running
anything else              -> 500 {status:"error"}
```

- **Cooldown atomicity.** The anchor (`SyncState.lastPublicRefreshAt`,
  `Dataset.refreshRequestedAt`) is claimed with `SELECT ... FOR UPDATE` plus one conditional
  `UPDATE` in one short transaction, timestamps and the remaining wait computed by the
  database. Many simultaneous presses: exactly one wins, the rest get a 429. The cooldown
  is **consumed even if the portal then fails** (a down portal is not hammered by
  retries); the one thing given back is a claim that ended in "a run was already in
  progress" (`release()` restores the previous anchor only while it still holds OUR claim).
  `already_running` never touches the anchor in the first place (the peek precedes the
  claim).
- **Two per-client buckets** (in memory, `clientKey()`): *attempts* count every accepted
  POST (stops hammering the cooldown query); *runs* are charged only when a press actually
  started a run, so no-op presses cannot burn the 20/hour budget.
- **`already_running.runScope`** is the scope of the run in progress, which may be
  unrelated to what was asked; a client must not say "up to date" for it.
- **What a run does for the visitor**: `maxRecords` defers datasets over
  `PUBLIC_REFRESH_MAX_RECORDS`, `maxDatasets` is a hard-coded 5 (no env var), cheapest
  first; everything deferred waits for the next scheduled or admin run and is reported
  (`lastRun.deferred`, `dataset.deferred`; counts only, never ids). Deferral does not
  change the run status or `lastDataChangeAt`.
- **Reading the outcome** (`GET /api/freshness`): match `lastRun.id` against the `runId`
  of the 202 to be sure it describes YOUR run. `partial` with `lastRun.failed > 0` and
  `updated === 0` means the download failed, not "nothing new"; `deferred > 0` means a
  large dataset was left for the scheduled sync. The button states exactly these outcomes
  (`src/components/refresh-button.tsx`): it polls every 2 s (up to 150 s) and calls
  `router.refresh()` when the run ends.
- **Button implementation notes**: its state lives in a module-level store keyed by scope
  and dataset id, so the header, hero and inline copies share one run, one countdown and
  one poller; `RefreshControl` (server) renders nothing when the kill switch is on, and
  `SiteHeader` mounts the button twice (one copy `display:none` per breakpoint, so the DOM
  order equals the visual order). With `PUBLIC_REFRESH_ENABLED=off` the SSR HTML of `/`
  contained zero refresh status regions versus three with it on (observed).

## Scheduler

`src/lib/sync/scheduler.ts`, started from `src/instrumentation.ts` when the Node server
boots (never during `next build`).

- Always on boot: install the shutdown hook, sweep orphaned `running` rows.
- With `AUTO_SYNC_INTERVAL_MINUTES` > 0 a timer (unref'd, never keeps the process alive)
  wakes every `min(interval, 5)` minutes (+-10% jitter), first after
  `AUTO_SYNC_FIRST_DELAY_SECONDS` (default 60) plus up to 15 s of random jitter. The
  **database** decides whether a run is due, so restarts and multiple instances are safe.
- **One tick**: prune old `SyncLog` rows; if the `Dataset` table is empty, run a full first
  sync (a fresh deploy populates itself); if any `ok` dataset has a stale `derivedVersion`,
  recompute first (no network); then run an incremental sync when `lastFullPassAt` is older
  than 0.9 x the interval (or never). **Catch-up**: when a live `ok`/`partial` dataset still
  has the shape an old engine left (no `syncedVersion`, or empty `searchText`), a pass is
  pulled forward as soon as the last full pass is at least `min(15 min, interval/4)` old.
- After a failed run the next wake waits at least `min(interval, 15)` minutes.
- The due-clock is `lastFullPassAt`, not `lastCatalogCheckAt`: a visitor's press also
  checks the catalog but defers big datasets, so counting it would let a visitor pressing
  every few hours starve the only automatic path that downloads those datasets.
- A tick never throws: `SyncAlreadyRunningError` means "busy" (another instance, an admin
  or CLI run holds the lock), anything else is logged and retried at the next wake.
- With the interval at 0 (the code default) the scheduler is off and nothing but the
  boot sweep runs; use cron or the buttons.

## Public API layer

Reference with examples is in the README; the implementation notes:

- `src/lib/api-v1.ts`: strict parameter parsing (an API client that sends `limit=abc` hears
  about it, unlike the website, which falls back to page 1), response helpers, CORS
  (`Access-Control-Allow-Origin: *`, GET/HEAD/OPTIONS, exposed headers `Retry-After`,
  `Content-Disposition`, `X-Dataset-Partial`), CSV cell encoding.
- `src/lib/api-limits.ts`: every `/api/v1` GET counts against a per-client budget
  (120 requests per minute) *before* anything is parsed; CSV starts have a separate budget
  (30 per 10 minutes) counted once the request is valid; a CSV stream holds a slot until it
  ends, fails or is cancelled (1 per client, 2 per server, `src/lib/slot-limiter.ts`;
  sized from a measurement: twenty uncapped 300,000-row streams pushed `/about` from 17 ms
  to about 2 s). Without a distinguishable client key (no `TRUST_PROXY=1`) every caller
  shares the key `local`, whose budgets are multiplied by 10, and a one-time production
  warning is logged.
- Records use **keyset** pagination on `DatasetRecord.id`. A sync that changes a dataset
  replaces all its rows with new, higher ids, so a cursor is valid within one *generation*;
  a stale or foreign `after` is `409 cursor_expired` with a `restart` URL. A CSV that hits a
  stale cursor mid-stream, the 301,000-row runaway stop (`CSV_MAX_ROWS`), 30 s without a
  read, or 10 minutes total, **errors** the stream (a failed download), never a clean
  truncated file that looks complete.
- `HEAD` on the records route returns GET's headers and never opens a stream or takes a
  slot.

## Security model

What is protected and how (`src/middleware.ts`, `src/lib/admin-session.ts`,
`src/lib/sync/auth.ts`, `src/lib/admin/*`, `src/lib/env.ts`, `next.config.ts`).

- **Admin session.** `/admin/login`'s Server Action compares the submitted value with
  `ADMIN_TOKEN` in constant time (both sides hashed first, so lengths never leak), then
  mints a token `<exp>.<random32hex>.<hmac>` signed with a key derived from
  `SESSION_SECRET` if set, else from `ADMIN_TOKEN`. Cookie: `__Host-nabd_admin` in
  production (Secure, Path=/, no Domain: a sibling subdomain cannot shadow it),
  `nabd_admin` in development; `HttpOnly`, `SameSite=Strict`, 12 hours
  (`ADMIN_SESSION_MAX_AGE_SECONDS`). There is **no server-side session store**: logout
  expires the browser's copy only; a stolen cookie stays valid until it expires or the
  secret is rotated (rotating `ADMIN_TOKEN`, or `SESSION_SECRET` when set, logs everyone
  out). The old raw-token cookie `admin_token` is not recognised. The module uses only Web
  Crypto because the middleware runs on the Edge runtime.
- **Three layers on `/admin`**: the middleware (`/admin/:path*` except `/admin/login`)
  verifies the cookie and redirects to the login form, the page re-checks
  (`requireAdmin`), and the data the dashboard polls (`/api/sync/status`) re-checks again.
  The redirect target is relative on non-loopback binds (0.0.0.0, as in Docker) and rebuilt
  from `Host` (plus `X-Forwarded-*` only when `TRUST_PROXY=1`) when the server is bound to
  literal loopback.
- **Sync API auth** (`authorizeSyncRequest`, always `await`ed: an un-awaited call is an
  always-truthy Promise, which `tests/security/auth-callers.test.ts` guards against): a
  valid session cookie, or `Authorization: Bearer $SYNC_TOKEN`. A cookie-authenticated
  *non-safe* request must prove same-origin (`Sec-Fetch-Site: same-origin`, else
  `Origin` host equal to `Host`; `X-Forwarded-Host` only with `TRUST_PROXY=1`); a request
  with neither header (curl) must use the Bearer token. GET with a cookie needs no origin
  proof. A **correct** token or valid session is never throttled; wrong guesses are counted
  per client (10 per 15 minutes) and answered 401, then 429 with `Retry-After`.
- **Login throttle**: 5 failures per 15 minutes per client, then even the right token is
  refused (`?error=rate`); each failure costs a fixed 400 ms delay. Login over plain http
  in production is refused up front (`?error=insecure`) when the browser's own `Origin`
  header says `http` on a non-loopback host, because a `Secure` `__Host-` cookie would be
  dropped; `X-Forwarded-Proto` is deliberately not used (Next invents it).
- **Client identity** (`clientKey`): with `TRUST_PROXY=1` only `CF-Connecting-IP` is
  believed, and only if it is a clean IP literal (IPv4-mapped IPv6 is unmapped; other IPv6
  collapses to its /64). `X-Forwarded-For` is never used. Anything else is the single key
  `local`. The limiter is in memory, per process, fixed window, bounded to 10,000 keys with
  eviction that prefers expired and un-locked buckets, and **resets on restart**.
- **Boot validation** (`src/lib/env.ts`): in production `ADMIN_TOKEN` and `SYNC_TOKEN` must
  be at least 32 characters, not placeholder-like (prefixes `change-me`, `dev-`, `test-`,
  `your-`, `example` ..., fragments `password`, `placeholder`), have at least 8 distinct
  characters, and differ; `SESSION_SECRET` is held to the same standard when set;
  `DATABASE_URL` must be a postgres URL; `SYNC_CONCURRENCY` an integer 1..10; the other
  numeric tunables non-negative numbers; `PUBLIC_REFRESH_ENABLED` one of the accepted
  switch spellings; `TRUST_PROXY` `0` or `1`. `docker/entrypoint.sh` mirrors the secret
  rules in POSIX sh and runs before `prisma migrate deploy`
  (`tests/security/entrypoint.test.ts` keeps both in lockstep). A failure prints every
  problem and exits 1. Non-fatal findings (`TRUST_PROXY` unset; a pool smaller than
  `SYNC_CONCURRENCY + 6`) are printed as `[config] WARNING` lines.
- **Headers** (`next.config.ts`): `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Permissions-Policy`; in production also
  `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`) and a
  same-origin CSP (`default-src 'self'`, scripts and styles with `'unsafe-inline'` because
  of Next's hydration payload and Recharts, `img-src 'self' data: blob:`,
  `connect-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`). The image
  optimizer is disabled (`images.unoptimized`): `/_next/image` answers 404 before `sharp`
  is ever required. See the README for the audit status.
- **Request hardening**: bodies are read with a byte cap (`readTextCapped`: 1 KiB for
  `/api/refresh`, 256 KiB for `/api/revalidate`); dataset ids are rejected when over 200
  characters, containing control characters or a lone surrogate (a NUL byte would make
  Postgres reject the query); the middleware strips a `constructor` query key (it breaks
  Next 15's `searchParams` Promise, a 500 on several pages; a `TODO` marks it for removal
  once Next ships the upstream fix) and answers a path with malformed percent-encoding
  with the site's Arabic 404 instead of Next's bare English 400.
- **CSV export** neutralizes spreadsheet formulas (`=`, `+`, `-`, `@`, tab, CR at the start
  of a text cell get a leading `'`; real numbers and numeric text are exempt).
- **Container**: non-root user (uid 1001), root-owned application tree (only
  `.next/cache` is writable), `cap_drop: ALL`, `no-new-privileges`, port bound to
  `127.0.0.1`, the database not published, `.dockerignore` keeps every `.env*` file and
  credentials out of the build context.

What is **not** protected: everything public is public by design (all dataset data, the
freshness and health endpoints, which reveal sync times, failure counts, uptime and the
build revision). The CORS policy is `*` on `/api/v1`. There is one shared admin token (no
accounts, no 2FA, no per-user audit). A flat-out request flood is not stopped by the app
(refusals still cost about 1.3 ms of the single Node thread each; only a Cloudflare rule in
front helps), ordinary page views have no per-client limit (only the expensive sorted or
searched record views do), the limiter forgets on restart, and a
copied session cookie cannot be revoked individually. The in-process limits assume a single
container: running several replicas multiplies the CSV slot caps and splits the buckets.

## Front-end conventions

- **RTL and language.** `<html lang="ar" dir="rtl">`. UI chrome is Arabic; dataset titles,
  field labels and publisher/theme names stay in their source language and are never
  machine-translated (the portal's Arabic title, when it provides one, is preferred for
  display and search).
- **Latin digits.** Every figure uses Latin digits with `font-variant-numeric:
  tabular-nums` (`NumberLatin`, the `.tabular-figures` class). Numbers are grouped except
  years and identifiers (`grouped={false}`; `looksLikeYear` / `looksLikeIdentifier` in the
  stats).
- **Bidi.** Source-language text inside Arabic copy goes through `Bidi` /
  `MixedBidiText` (`src/components/bidi.tsx`, `src/lib/text.ts`): `<bdi dir="auto">`, and
  every adjacent run of Latin words and numbers inside Arabic text is ONE `dir="ltr"`
  isolate, because after an Arabic letter the bidi algorithm reverses ranges ("2025-2010")
  and orders two adjacent LTR items right-to-left. `lang="en"` is added for Latin-only
  text so screen readers switch voice. Plain-string places (`<option>`) use the
  U+2068/U+2069 `isolate()` helper. Chart canvases are `dir="ltr"` (time axes read left to
  right); legends and tooltips are forced `dir="rtl"`.
- **No loading boundaries, no streaming.** There are no `loading.tsx` files and no
  `<Suspense>` around data sections. Reasons: a `loading.tsx` (or a Suspense boundary
  around a section) makes Next commit HTTP 200 and start streaming before an inner
  `notFound()` resolves, so a missing dataset would answer 200; and streamed content sits
  in a hidden template until an inline script reveals it, so a browser without JavaScript
  would see a permanent skeleton. The dataset page awaits its records section and related
  datasets in place (each catches and logs its own failure, so one failed read costs that
  section only). Do not add `loading.tsx` above a route that calls `notFound()`.
- **Zero-JS where it matters.** Filters, search, sorting and paging are plain GET links and
  forms (`list-query.ts` builds every href so a filter is never dropped); the records
  table, its in-table search and its pager need no JavaScript; sparklines are server
  SVG. JavaScript is needed for the refresh button, the dataset chart (Recharts loads on
  demand, `ssr: false`; a legend, download buttons and a same-height placeholder render
  immediately, and a data table alternative exists) and the admin dashboard.
- **Fonts are local.** Tajawal (700/900) for display and IBM Plex Sans Arabic
  (400/500/600) for text, as woff2 files in `src/app/fonts` with their SIL OFL texts,
  loaded with `next/font/local` (no `next/font/google`: the build touches no font host).
  Each subset (arabic, latin, latin-ext) is its own family with a `unicode-range`;
  `globals.css` chains them into `--font-tajawal` / `--font-ibm-plex-sans-arabic`, with
  hand-declared metric-adjusted Arial fallback faces last. Cyrillic is not shipped.
- **Tailwind v4**, CSS-first: design tokens ("Bahraini sea & pearl": sea-navy surfaces,
  sand background, pearl accent, coral actions) are CSS variables in `src/app/globals.css`
  exposed through `@theme inline`. Interactive controls aim for a 44 px target (`min-h-11`); form controls are
  16 px on coarse pointers (`pointer-coarse:`) so iOS does not zoom on focus; focus rings
  are global (`:focus-visible`), `prefers-reduced-motion` is honoured site-wide.
- **Print stylesheet** (`@media print` and `@page` in `globals.css`): chrome and controls
  hidden, a print-only brand/URL line in the layout and a print-only URL/dates line on the
  dataset page; the records table prints its current page of 25 rows.
- **Server components by default.** `"use client"` only for interaction: the refresh
  button, charts, the admin dashboard, relative time, copy-link. `RelativeTime` renders
  the absolute Bahrain time on the server and swaps to relative text on the client.
- **CSP constraints for new UI**: the production CSP is same-origin only. New UI must not
  load external scripts, styles, fonts or images, or call an external API from the browser;
  go through the server instead. Inline `<script type="application/ld+json">` is fine, and
  downloads via `blob:` URLs are fine.
- **Counts in Arabic** (`src/lib/arabic-count.ts`, `CountNoun`): the noun agrees with the
  number (singular, dual, plural, oblique forms after prepositions); zero has its own
  wording; the digits are printed only when the noun does not carry the count.
- **Admin pages** are `no-store`, `noindex, nofollow`, and uncached reads
  (`src/lib/admin/queries.ts`); the run history hides no-op public presses by default
  (`?runs=all` shows them).

## Changing things safely

| If you change ... | Also do ... |
| --- | --- |
| anything in `derived.ts`, `series.ts`, `headline.ts`, `temporal.ts` that alters persisted output | bump `DERIVED_VERSION` (with a line in its comment); the scheduler or `pnpm sync:recompute` re-derives `ok` datasets, `partial` ones need a forced sync |
| the version token (`version.ts`) | bump `VERSION_PREFIX` only if every dataset should re-download once |
| a Prisma model | `pnpm db:migrate` (review the SQL; `--create-only` first if unsure), commit the migration, never edit applied ones; keep the trigram `@@index` lines |
| an environment variable | read it in one place (`src/lib/sync/config.ts` for tunables), validate in `src/lib/env.ts` if boot should reject bad values, add it to `.env.example`, `docker-compose.yml` (if it must reach the container) and the README table |
| a public route | decide its limits (`guardApi` for `/api/v1`), its `Cache-Control`, its CORS, and add it to the README reference; remember the CSP |
| UI that needs another origin | don't: proxy it through the server |
| the featured band | `src/config/featured.ts`; an entry whose headline is withheld is skipped automatically |
| a dataset that charts wrongly | prefer a pin in `src/config/viz-overrides.ts` over changing the heuristics |
| Next.js | check whether the `?constructor=` workaround in `src/middleware.ts` can go, and that the CSP still holds |
