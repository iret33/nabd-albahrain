# نبض البحرين (Nabd Al-Bahrain)

An independent, **unofficial**, Arabic-first (right-to-left) website that mirrors and
visualizes the datasets published on Bahrain's open data portal,
[data.gov.bh](https://data.gov.bh) (about 512 datasets from 35+ government entities when it
was last synced against the real portal, August 2026). It is **not** affiliated with the
Government of Bahrain or data.gov.bh. Every page credits the official source and links back to
it; the portal is only contacted by the sync engine, never at request time. It is **not** an official statistics
product: charts and headline numbers are derived heuristically (see
[Known limitations](#known-limitations-and-unverified-items)). The repository ships no `LICENSE` file (the owner has
not chosen one); the portal's own terms govern the data.

Stack: Next.js 15 (App Router, React Server Components, `output: "standalone"`), TypeScript,
Tailwind CSS v4, Prisma 6 + PostgreSQL 16, Recharts, Zod, pnpm. Docs:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how it works) · [PROJECT_STATUS.md](PROJECT_STATUS.md)
(what was verified, what was not) · [CHANGELOG.md](CHANGELOG.md) (what changed for the owner) ·
[docs/HISTORY.md](docs/HISTORY.md) (the original Phase 1-9 build log, historical).

## Features

- **Browse**: home with live portal stats and a curated "featured stats" band; every theme
  (`/categories`) and publisher (`/publishers`); **Arabic-aware search** (`/search`, spelling
  variants, diacritics, the definite article); `/updates` ("what's new") and an Atom feed at
  `/feed.xml`; `/about`; `/developers` documents the API for humans.
- **Dataset pages** (`/dataset/[id]`): an automatically chosen chart (multi-line, area,
  bar, stacked bar, histogram or table) with an Arabic lead sentence, caption and data table,
  field dictionary with statistics, a sortable, searchable, paged records table, links to the
  official portal page and its exports, JSON-LD, print stylesheet. Datasets the portal removes
  stay available with a banner.
- **Freshness you can see and trigger**: every page shows when the portal was last checked
  and when its data last changed; a **"check for new data" button** (header, home, dataset
  pages, `/updates`, `/about`) asks the portal and re-downloads only what changed; a built-in
  scheduler does the same on a timer. See [How fresh data reaches visitors](#how-fresh-data-reaches-visitors).
- **Public read-only JSON API** (`/api/v1`): catalog, dataset detail, records with keyset
  pagination, streaming CSV export. See the [API reference](#api-reference).
- **Admin dashboard** (`/admin`, one shared token): sync everything or one dataset, recompute
  charts without network, failures with per-row retry, run history, searchable dataset list.
- **Operations**: `GET /api/freshness?strict=1` and `GET /api/health/ready` for monitors, an
  offline mock of the portal, a bundled sync CLI, CI, Docker Compose production stack.

## Quick start (production, Docker Compose)

Requires Docker with Compose v2. The stack is `app` (Next.js standalone, published on
`127.0.0.1:3000` only) and `db` (`postgres:16-alpine`, publishes nothing).

```bash
git clone <repo-url> nabd-albahrain && cd nabd-albahrain
cp .env.example .env
#   edit .env:  ADMIN_TOKEN and SYNC_TOKEN  (openssl rand -hex 32, a different value each),
#               NEXT_PUBLIC_SITE_URL        (your public https origin),
#               POSTGRES_PASSWORD           (NEW database only: openssl rand -hex 16, before the first up)
GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build
docker compose ps                              # app and db should become healthy
docker compose run --rm app sync               # first sync as a one-off container (optional, see below)
curl -fsS http://127.0.0.1:3000/api/health/ready
```

The first `up` builds the image, applies the migrations (`prisma migrate deploy`, in the entrypoint) and starts
the server. With the template's `AUTO_SYNC_INTERVAL_MINUTES=360` the scheduler also populates an empty database
about a minute after boot, so the explicit first sync is optional; as a one-off container it keeps the heavy work
out of the web process. Then expose it with the [Cloudflare Tunnel](#cloudflare-tunnel) and read
[Production deployment](#production-deployment). The container refuses to start with missing, short, placeholder
or identical tokens.

The Docker CLI was present but no daemon where this was written: both compose files were checked with
`docker compose config` (production: only `app` publishes a port; with the dev override `db` publishes
`127.0.0.1:5432`), the image build and container run were **not** exercised
([Known limitations](#known-limitations-and-unverified-items)).

## Local development

Prerequisites: **Node.js >= 22** and **pnpm** (`corepack enable` is enough: the version is
pinned by `packageManager` in `package.json`; without corepack use `npm install -g pnpm` and pick
the version that field names). Postgres 16 with the `pg_trgm` extension (any role that may create
it, and a database for Prisma's shadow database if you use `db:migrate`).

```bash
pnpm install --frozen-lockfile
pnpm db:generate      # generate the Prisma client: with pnpm 10 `pnpm install` does not (typecheck, tests, dev, sync fail without it)
cp .env.example .env
```

Edit `.env` for local use (it is **not** the production file; never reuse it on a server). A blank `ADMIN_TOKEN`
disables the admin login, a blank `SYNC_TOKEN` disables the bearer-token API and the cache invalidation after a
CLI sync, and `AUTO_SYNC_INTERVAL_MINUTES` must be `0` or `pnpm dev` starts syncing about a minute after boot:

```bash
DATABASE_URL=postgresql://nabd:nabd@localhost:5432/nabd
NEXT_PUBLIC_SITE_URL=http://localhost:3000
ADMIN_TOKEN=anything
SYNC_TOKEN=anything-else
TRUST_PROXY=0
AUTO_SYNC_INTERVAL_MINUTES=0
```

**Postgres with Docker** (the production compose file publishes no database port; the override
file is development-only and must never be copied to a server):

```bash
cp docker-compose.override.example.yml docker-compose.override.yml   # git-ignored
docker compose up -d db                                              # 127.0.0.1:5432
```

**Postgres without Docker** (macOS shown; on Debian/Ubuntu install `postgresql-16` and
`postgresql-contrib`): `brew install postgresql@16 && brew services start postgresql@16`, then
`createuser -s nabd; createdb -O nabd nabd; psql -d nabd -c "ALTER USER nabd WITH PASSWORD 'nabd';"`.

```bash
pnpm db:deploy     # apply the committed migrations (what the container does at start)
pnpm dev           # http://localhost:3000   (Next.js reads .env and .env.local)
```

`pnpm db:migrate` (`prisma migrate dev`) is for *creating* a migration after you change
`prisma/schema.prisma`; on a fresh database it applies everything and reports "in sync" (the trigram search
indexes are declared in the schema, so it no longer proposes to drop them). Under `pnpm dev` the admin works over
plain http (the session cookie is not `Secure` outside production).

**Getting data in, even offline.** The real portal may be unreachable from your network. An
offline mock of its API (10 small datasets, plus control endpoints to simulate publishing,
removal, truncation, slow and failing exports; see the header of `scripts/mock-ods.mjs`) is
included:

```bash
pnpm mock:ods                                                       # terminal 1, port 4010 (MOCK_ODS_PORT)
set -a; . ./.env; set +a                                            # terminal 2: export the variables
export ODS_BASE_URL=http://127.0.0.1:4010/api/explore/v2.1          # (or put it in .env first)
pnpm sync                                                           # incremental sync; also: pnpm sync -- --limit 10
```

Against the real portal leave `ODS_BASE_URL` unset and run `pnpm sync -- --limit 10` first, then
`pnpm sync`. **The sync CLI does not read `.env` or `.env.local`** (tsx and Prisma's client load no env file;
only the Prisma *CLI* reads `.env`, never `.env.local`), so export the variables as above or use
`pnpm exec tsx --env-file=.env src/lib/sync/cli.ts <flags>`. Quality gate: `pnpm check` (typecheck, lint, tests).

## Configuration

All configuration is environment variables; `.env.example` is the annotated template.
"Boot" means the check that makes the production server (or container) exit with a list of
problems; elsewhere an invalid number falls back to its default (garbage) or is clamped
(out of range), with a warning in the log. Production means `NODE_ENV=production`
(the Docker image sets it).

| Variable | Default | Meaning and validation |
| --- | --- | --- |
| `DATABASE_URL` | none (required) | Postgres URL. Boot: must be `postgres://` or `postgresql://`. Add `?connection_limit=N`; compose does it for you |
| `ADMIN_TOKEN` | none (required in prod) | `/admin` login password. Boot: >= 32 chars, not placeholder-like, >= 8 distinct chars, different from `SYNC_TOKEN`. Blank disables admin login |
| `SYNC_TOKEN` | none (required in prod) | Bearer token for `POST /api/sync`, `/api/revalidate`; used by the engine to invalidate caches. Same boot rules |
| `SESSION_SECRET` | unset (uses `ADMIN_TOKEN`) | Separate admin-session signing key; same boot rules when set. Rotate it (or `ADMIN_TOKEN`) to log everyone out |
| `NEXT_PUBLIC_SITE_URL` | `https://data.hekkapp.com` | Public origin (canonical links, sitemap, feed, API links, refresh Origin check). Docker build arg **and** runtime variable (the static `robots.txt` bakes it at build time); a change needs `docker compose up -d --build` |
| `TRUST_PROXY` | unset (= 0) | `1` behind the Cloudflare Tunnel: per-client limits use `CF-Connecting-IP`. Boot: must be `0` or `1`; unset only warns |
| `AUTO_SYNC_INTERVAL_MINUTES` | `0` (off; the template sets 360) | Scheduler interval, 0..10080. Also defines "stale" (2x; 48 h when 0). Boot: number >= 0 |
| `AUTO_SYNC_FIRST_DELAY_SECONDS` | `60` | Delay before the scheduler's first check (+0-15 s jitter), 0..3600 |
| `PUBLIC_REFRESH_ENABLED` | on | Kill switch: `0/false/no/off` disables (503, buttons removed), `1/true/yes/on` or blank enables, anything else is rejected at boot (and reads as off elsewhere) |
| `PUBLIC_REFRESH_CATALOG_COOLDOWN_SECONDS` | `120` | Whole-catalog press cooldown, shared by all visitors, 0..86400 |
| `PUBLIC_REFRESH_DATASET_COOLDOWN_SECONDS` | `600` | Per-dataset press cooldown, 0..86400 |
| `PUBLIC_REFRESH_MAX_RECORDS` | `100000` | A public press never downloads a dataset advertised above this, 1..10000000 (a press also downloads at most 5 datasets: hard-coded) |
| `CACHE_TTL_SECONDS` | `300` | Safety-net TTL of cached queries, digits only, 5..86400; per-dataset entries use 6x |
| `HEAVY_QUERY_LIMIT` | `4` | Concurrent sorted/searched record queries, 1..16; lowered to `connection_limit - 2` if the URL pins one |
| `APP_INTERNAL_URL` | `http://127.0.0.1:$PORT` (3000); compose: `http://app:3000` | Where the engine POSTs cache invalidations. Set it for `next start -p N` or a remote CLI |
| `SYNC_CONCURRENCY` | `3` | Datasets in parallel and portal requests in flight, 1..10 (boot: integer 1..10). Keep the pool >= this + 6 |
| `SYNC_DELAY_MS` / `SYNC_REQUEST_TIMEOUT_MS` / `SYNC_EXPORT_TIMEOUT_MS` / `SYNC_RETRY_BASE_MS` | `250` / `30000` / `120000` / `1000` | Gap between request starts (0..10000), catalog deadline (100..600000), export deadline (100..1800000), backoff base (0..60000) |
| `USER_AGENT` | `nabd-albahrain/1.0 (independent open-data dashboard; contact via hekkapp.com)` | Sent to the portal |
| `ODS_BASE_URL` | `https://data.gov.bh/api/explore/v2.1` | Another OpenDataSoft API, e.g. the mock |
| `GIT_SHA` | empty | Docker **build** arg shown as `version` by `/api/health/ready`: `GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build` |
| `NEXT_MANUAL_SIG_HANDLE` | set by the Dockerfile | Any non-empty value (even `0`) makes the app own SIGTERM so a stop mid-sync frees the lock at once. Outside Docker: `1` or unset |
| `PORT`, `HOSTNAME` | image: `3000`, `0.0.0.0` | Standalone server bind. Do not put them in `.env` under compose |
| compose only: `POSTGRES_PASSWORD` | `nabd` | Bundled Postgres password; compose derives the app's `DATABASE_URL` from it (a `DATABASE_URL` in `.env` is ignored). Use hex; baked into the volume at first start |
| compose only: `DB_POOL_SIZE` | `12` | Prisma `connection_limit` for the app; keep >= `SYNC_CONCURRENCY + 6` (a boot warning says so) |
| compose only: `APP_MEM_LIMIT`, `APP_NODE_OPTIONS` | no cap, no flags | Optional container memory limit (e.g. `1536m`) and Node flags (e.g. `--max-old-space-size=1024`); do not go below ~1.2 GB with `SYNC_CONCURRENCY >= 3` |
| dev/test: `MOCK_ODS_PORT`, `MOCK_ODS_BIG`, `MOCK_ODS_BIG_ROWS` | `4010`, off, `120000` | Mock portal port; `MOCK_ODS_BIG=1` adds a large dataset |
| dev/test: `RUN_INTEGRATION`, `INTEGRATION_ALLOW_WIPE`, `DEBUG_INTEGRATION` | off | See [Testing](#testing) |

## How fresh data reaches visitors

1. **Scheduler** (`AUTO_SYNC_INTERVAL_MINUTES` > 0): the web process wakes every
   min(interval, 5) minutes and lets the *database* decide whether a pass is due (the last
   unrestricted pass is older than 0.9 x the interval), so restarts and extra instances are
   safe. On an empty database it runs the first full sync; it re-derives stale charts first
   (no network); it repairs legacy rows early; after a failed run it waits at least 15 minutes.
2. **Public refresh button** (`POST /api/refresh`, no token): checks the portal's catalog and
   re-downloads what changed, at most 5 datasets of at most `PUBLIC_REFRESH_MAX_RECORDS` rows,
   cheapest first, never forced. Cooldowns live in the database (120 s catalog, 600 s dataset,
   shared by all visitors), plus per-client limits (120 presses/hour counted, 20 that actually
   started a run). Big datasets and the rest are **deferred** to the scheduled or admin run and
   reported as such. `PUBLIC_REFRESH_ENABLED=0` is the kill switch.
3. **Admin dashboard** and `POST /api/sync`: sync everything (incremental), force one dataset,
   or recompute. 4. **CLI** (below). 5. Host cron, only if the scheduler is off: the lock makes
   running both harmless.

**Change detection** compares an opaque version token (portal `modified`, `data_processed`,
`metadata_processed`, `records_count`, a hash of the field names) with the token the stored rows
were synced from: no clocks involved. A dataset in `error` is always retried; datasets the portal
stops listing are flagged removed (never deleted), but only from a complete, plausible catalog.
**Cache invalidation**: when a run ends, the engine POSTs the changed dataset ids to the web
server's `/api/revalidate` (CLI and scheduler included), which drops exactly those pages;
`CACHE_TTL_SECONDS` is the safety net if that call fails (`APP_INTERNAL_URL` or `SYNC_TOKEN`
wrong or missing), never the normal path.

**Monitoring.** `GET /api/freshness?strict=1` answers 503 while data is *stale* (last
successful run older than twice the scheduler interval, 48 h when it is off, or never): point an
uptime monitor at it to learn that "the nightly sync silently stopped". `GET /api/health/ready`
(200 even when degraded; read `ok`/`reasons`) reports `last_sync_failed`, `no_data_synced`,
`sync_stale` and `datasets_failing` (at least 3 datasets and 10% of live ones in error; 1-2
failing datasets only appear in `warnings`), and 503 only when the database does not answer in
2 s. `/api/health` is a Postgres-free liveness probe (the Docker healthcheck). A `partial` run
means some datasets failed: look at `lastRun.failed`, never read "partial" as "nothing new".

## Command-line sync

```bash
pnpm sync                            # incremental: only datasets whose version token changed
pnpm sync -- --dataset <id>          # one dataset (add --force to re-download it regardless)
pnpm sync -- --limit 10              # only the first 10 datasets of the catalog (catalog order)
pnpm sync:force                      # == pnpm sync -- --force: re-download everything
pnpm sync -- --dry-run               # catalog check only: prints what WOULD change, writes nothing
pnpm sync:recompute                  # no network: re-derive charts from stored rows (stale ones; --force: all)
pnpm build:cli && node dist/sync-cli.cjs <flags>      # the same, bundled (what the image contains)
docker compose run --rm app sync -- --dataset <id> --force    # in production (the `--` is optional)
```

It takes the same database lock as every other run (exit code 1 if another run holds it, or the
run failed/aborted; a `partial` run exits 0). The variables must be in the environment (see
[Local development](#local-development)); without `SYNC_TOKEN`/`APP_INTERNAL_URL` the run works
but cannot invalidate the web server's caches (log line `[notify] ...`).

## API reference

Responses below are real, from a production build against the mock portal (trimmed). Base URL
in the examples is `http://127.0.0.1:3501`; per-client limits key on `CF-Connecting-IP` when
`TRUST_PROXY=1` (examples send `-H 'cf-connecting-ip: 203.0.113.7'`, omitted below).

### Pages (HTML)

| URL | Query parameters and notes |
| --- | --- |
| `/`, `/about`, `/developers` | home, about, API documentation for humans |
| `/search`, `/categories/{theme}`, `/publishers/{slug}` | listing parameters `q`, `sort` (`relevance`/`updated`/`title`/`records`), `chart=1`, `since` (`30d`/`1y`), `page`, plus `theme`/`publisher` on `/search`; an unknown theme or slug is a real 404; a publisher slug is lowercase ASCII (`p-<hash>` for Arabic-only names) |
| `/categories`, `/publishers` | the tile indexes |
| `/dataset/{id}` | records table state `page`, `sort` (a field name), `dir` (`asc`/`desc`), `rq` (in-table search, <= 60 chars); any non-default view is `noindex`; an unknown id is a 404, a removed one renders with a banner |
| `/updates` | `days` (`7`/`30`/`90`; default all time) and `page` |
| `/admin`, `/admin/login` | session required; `/admin?runs=all` also lists the no-op public presses hidden by default; `/admin/login?error=` is `rate`, `insecure` or `session` |

### Public read-only API: `/api/v1` (GET, HEAD, OPTIONS)

| Route | Parameters | Notes |
| --- | --- | --- |
| `GET /api/v1` | | pointer document with the endpoint URLs |
| `GET /api/v1/datasets` | `q` (<= 100 chars, Arabic or English), `theme` (exact name), `publisher` (slug), `sort` = `relevance` (default with `q`) / `updated` / `title` (default) / `records`, `updated_since` (ISO date or date-time), `page` (1..10000), `limit` (1..100, default 30) | same engine as the website's search; `facets` lists valid themes and publishers |
| `GET /api/v1/datasets/{id}` | | metadata, field list, per-field statistics, links. A removed dataset answers 200 with `removed: true` |
| `GET /api/v1/datasets/{id}/records` | `after` (a `nextAfter` from the previous response), `limit` (1..1000, default 100), `format` = `json` / `csv` | keyset pagination, `ORDER BY id`; `csv` ignores `limit` and **streams every remaining row** (UTF-8 BOM, CRLF, spreadsheet-formula cells neutralized) |

```text
$ curl "/api/v1/datasets?q=المواليد&limit=1"        # total, page, limit, totalPages, results[], facets
{"total":1,"page":1,"limit":1,"totalPages":1,"results":[{"id":"live-births-by-governorate",
 "title":"Live Births by Governorate","titleAr":"المواليد الأحياء حسب المحافظة","theme":"Health",
 "publisher":"Ministry of Health","recordsCount":44,"sourceModified":"2026-01-15T08:00:00.000Z",
 "lastSyncedAt":"2026-10-03T16:28:37.740Z","url":"http://localhost:3501/dataset/live-births-by-governorate",
 "officialUrl":"https://www.data.gov.bh/explore/dataset/live-births-by-governorate/"}], "facets":{...}}

$ curl "/api/v1/datasets/seaports/records?limit=2"
{"id":"seaports","partial":false,"storedRecordsCount":12,"recordsCount":12,"removed":false,"limit":2,
 "count":2,"nextAfter":"40","next":".../api/v1/datasets/seaports/records?after=40&limit=2",
 "records":[{"id":"39","data":{"year":"2014","value":1000000}},{"id":"40","data":{"year":"2015","value":1052000}}]}

$ curl -i "/api/v1/datasets/seaports/records?format=csv"     # 200, then:
content-type: text/csv; charset=utf-8   x-dataset-partial: false
content-disposition: attachment; filename="seaports.csv"; filename*=UTF-8''seaports.csv
<BOM>year,value / 2014,1000000 / 2015,1052000 / ...
```

Behavior contract (all verified live unless marked):

- **Success** carries `Cache-Control: public, s-maxage=300, stale-while-revalidate=3600`; **every error is
  `no-store`**; CORS is `Access-Control-Allow-Origin: *`, methods `GET, HEAD, OPTIONS`, exposing
  `Retry-After, Content-Disposition, X-Dataset-Partial`; `OPTIONS` answers 204 (cacheable 1 day).
- **Errors are JSON** `{error, message[, parameter]}`: `400 invalid_parameter` (`limit=abc`,
  `sort=bogus`, `after=abc`, `format=xml`, `page=0`, `q=a`, `updated_since=2026-02-31`), `404 unknown_theme` /
  `unknown_publisher` / `not_found`, `500 internal_error` (never echoes details).
- **`409 cursor_expired`** `{error, message, parameter:"after", restart:<url without after>}`: a sync
  that changes a dataset replaces all its rows (new, higher ids), so cursors are bound to one
  generation; a stale or foreign `after` is refused instead of silently restarting. A CSV that meets
  a stale cursor mid-stream, the 301,000-row runaway stop, 30 s without a read, or 10 minutes total
  *errors* the connection (never a clean, truncated file). `X-Dataset-Partial: true` means the dataset
  is partial (only its first 50,000 rows are stored).
- **Limits** per client: 120 requests/minute on any route, 30 CSV starts per 10 minutes, 1 concurrent CSV
  stream per client and 2 per server. Over budget: `429 {"error":"rate_limited","message":...,
  "retryAfterSeconds":59}` with `Retry-After` (observed: 120 x 200 then 429 with `retry-after: 59`; 30 CSV
  starts then `429` with `retry-after: 600`); every server slot taken: `503 server_busy` with
  `Retry-After` (from code). Without `TRUST_PROXY=1` all callers share one bucket with 10x budgets.
- `HEAD` on `/records` returns GET's headers and never opens a stream or takes a slot.
  A malformed `%`-sequence in an `/api/` path is answered by Next.js's own bare HTML 400, not JSON.

### Operational routes (public)

| Route | Purpose |
| --- | --- |
| `GET /api/health` | `{"ok":true}`; liveness only, never touches Postgres |
| `GET /api/health/ready` | readiness for monitors, `no-store`; 503 only if the database does not answer in 2 s |
| `GET /api/freshness[?dataset=<id>][&strict=1]` | freshness read model, `no-store`; `strict=1` answers 503 while stale; a malformed id gives `dataset: null`, never 500 |
| `POST /api/refresh` | the public button; body `{"scope":"catalog"}` or `{"scope":"dataset","id":"<dataset_id>"}` |
| `GET /feed.xml`, `/sitemap.xml`, `/robots.txt`, `/manifest.webmanifest` | Atom feed (50 newest by portal date), sitemap, robots (`/admin` and `/api/` disallowed), web manifest |

```text
$ curl /api/health/ready           # healthy
{"ok":true,"status":"ok","reasons":[],"warnings":[],"db":"up","sync":{"running":false,"since":null,"stale":false,
 "lastStatus":"success","lastFinishedAt":"...","lastSuccessAt":"...","lastDataChangeAt":"...","lastSyncedAt":"...",
 "ageHours":0,"failingDatasets":0},"uptimeSec":22,"version":null}        # version = GIT_SHA, null when unset
# before the first sync: ok:false, status:"degraded", reasons:["no_data_synced"]  (still HTTP 200)

$ curl /api/freshness
{"now":"...","lastCheckedAt":"...","lastSuccessAt":"...","lastDataChangeAt":"...","lastRunStatus":"success",
 "lastRun":{"id":1,"scope":"changed","trigger":"cli","status":"success","finishedAt":"...","updated":10,"failed":0,
 "deferred":0},"running":false,"runStartedAt":null,"runScope":null,"progress":null,
 "cooldown":{"catalogUntil":null},"stale":false,"refreshEnabled":true}
# ?dataset=seaports adds  "dataset":{"id","lastCheckedAt","lastSyncedAt","sourceModified","refreshAvailableAt",
#   "removed","syncStatus":"ok","failed":false,"deferred":false,"lastRunId":1}
# a run in flight: "running":true,"runScope":"changed","progress":{"done":9,"total":10}
```

`POST /api/refresh`, every body is JSON `{status, ...}` with `Cache-Control: no-store`:

| Status | Body | Meaning |
| --- | --- | --- |
| 503 | `{"status":"disabled"}` | kill switch (`PUBLIC_REFRESH_ENABLED`) |
| 403 | `{"status":"bad_origin"}` | an `Origin` header whose host is neither the request's `Host` nor `NEXT_PUBLIC_SITE_URL`'s; no `Origin` (curl) is allowed |
| 400 | `{"status":"bad_request"}` | not strict JSON, over 1 KiB, an unknown key (**`force` is rejected**), or a malformed id (before any limit is touched) |
| 429 | `{"status":"rate_limited","retryAfterSeconds":3599}` + `Retry-After` | per-client attempts (120/hour) or runs (20/hour) exhausted |
| 404 | `{"status":"unknown_dataset"}` | no such live dataset |
| 429 | `{"status":"cooldown","scope":"dataset","retryAfterSeconds":598}` + `Retry-After` | cooldown running (shared by everyone) |
| 202 | `{"status":"already_running","since":"...","scope":"dataset","runScope":"changed"}` | a run holds the lock (not necessarily yours: `runScope` says which); costs no cooldown |
| 200 | `{"status":"up_to_date","checkedAt":"..."}` | catalog press, but the catalog was checked < 60 s ago (the cooldown stays consumed) |
| 202 | `{"status":"started","runId":2,"scope":"catalog"}` | poll `/api/freshness` and match `lastRun.id` with `runId` |
| 500 | `{"status":"error"}` | |

### Token-gated routes (`Authorization: Bearer $SYNC_TOKEN`, or the admin session)

| Route | Result |
| --- | --- |
| `POST /api/sync[?dataset=<id>][&force=1][&recompute=1]` | `202 {"started":true,"runId":4}`; `409 {"started":false,"error":"sync_already_running","since":"..."}` (lock and `SyncLog` row exist before the answer); `400 {"error":"invalid_dataset"}` (over 200 chars, control characters, lone surrogate); `401 {"error":"unauthorized"}`; `429 {"error":"rate_limited","retryAfterSeconds":900}` + `Retry-After` after 10 wrong guesses from one client in 15 minutes (a correct token is never throttled). `recompute=1` re-derives without network (`force=1`: all) |
| `GET /api/sync/status` | `{"lock":{"running","since","heartbeatAt","stale"},"latestLog":{<newest SyncLog row incl. an in-flight run: id, trigger, scope, status, total, processed, skipped, updated, failed, error, failuresJson, changedJson{added,removed,updated,deferred}>}}` |
| `POST /api/revalidate` | body `{"datasetIds":["seaports"],"tags":[...]}` (all optional; tags default to `["datasets"]`) -> `{"revalidated":["datasets","dataset:seaports"]}`; `400 {"error":"invalid_body"}` |

The admin session cookie also authorizes these routes (the dashboard uses it), but a cookie-authenticated
**POST** must prove it is same-origin (`Sec-Fetch-Site: same-origin`, else `Origin` = `Host`): verified with a valid
cookie, a bare POST gives 401, `Sec-Fetch-Site: cross-site` 401, `same-origin` 202. Scripts use the Bearer token.

## Production deployment

**Compose.** `docker-compose.yml` runs `app` (built from the `Dockerfile`: multi-stage
`node:22-alpine`, standalone output plus the full `node_modules` overlay Prisma needs, non-root
uid 1001, root-owned application tree, `HEALTHCHECK` on `/api/health`) and `db`. `app` waits for the
db healthcheck; `docker/entrypoint.sh` checks the secrets, runs `prisma migrate deploy`, then
`node server.js`. Any other command passes through the entrypoint unchecked (`docker compose run
--rm app sh` works even with a broken `.env`). Hardening: `cap_drop: ALL`, `no-new-privileges`,
the port bound to `127.0.0.1`, the database not published. `stop_grace_period: 30s`.

**Build and run.** `GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build` (do not keep
`GIT_SHA` in `.env`). `DB_POOL_SIZE` (default 12), `APP_MEM_LIMIT` and `APP_NODE_OPTIONS` are optional
resource knobs (table above). The build needs no secrets and no network access to font hosts.

**First sync as a one-off container**, before the tunnel is live, so the heavy work gets its own
pool and memory: `docker compose run --rm app sync`. Later forced or single-dataset runs the same way:
`docker compose run --rm app sync -- --dataset <id> --force`. Heavy runs started by the scheduler, the API
or a public press execute inside the web process (see limitations).

### Cloudflare Tunnel

The VPS already runs `cloudflared`; add one ingress rule **above** the catch-all `http_status:404`
and route the DNS record (no firewall port is opened: the app listens on `127.0.0.1:3000`; TLS
terminates at Cloudflare):

```yaml
ingress:
  - hostname: data.hekkapp.com
    service: http://localhost:3000
  - service: http_status:404
```
```bash
cloudflared tunnel route dns <tunnel-name> data.hekkapp.com && sudo systemctl restart cloudflared
```

**`TRUST_PROXY=1` is required behind the tunnel**, otherwise every visitor shares one rate-limit
bucket (and a few bad logins lock everyone out). Only `CF-Connecting-IP` is used. If the proxy ever
fails to send it, everyone falls back to the shared bucket (a safe, but disruptive, failure with no
warning for that case). **Add Cloudflare WAF rate-limit rules**, because the app's own limiter cannot
stop a flat-out flood (each refused request still costs ~1.3 ms of the single Node thread, enough to
push `/` to ~2 s p50 at ~560 req/s; measured during the build, not re-measured here): `/admin/login` and `/api/sync*` (e.g. 10 requests/minute/IP),
`starts_with(http.request.uri.path, "/api/v1/")` (and a lower threshold where `format=csv`), and
`/api/refresh`. Optionally a Cache Rule "eligible for cache, respect origin" scoped to `/api/v1/*`
only (HTML must stay uncached).

### Operating it

- **Admin needs HTTPS or loopback.** In production the cookie is `Secure` + `__Host-`, which browsers
  refuse to store over plain http; the login says so instead of half-logging in. Use the tunnel's https
  hostname, or `http://127.0.0.1` through an SSH tunnel. Safari reportedly refuses on `http://localhost` too (untested).
- **Upgrading a pre-freshness database.** The container applies the new migrations itself; existing rows
  are then "legacy" (no version token, no search text, no `derivedVersion`). One catalog pass repairs
  them: `docker compose run --rm app sync` (or the scheduler, which pulls a pass forward by itself on its
  first tick when `AUTO_SYNC_INTERVAL_MINUTES` > 0, and also re-derives stale charts without network; with
  the scheduler off use `docker compose run --rm app sync -- --recompute`). Diff your old `.env` against
  `.env.example`: the scheduler is **off** and `TRUST_PROXY` is unset in an `.env` copied from the old
  template. Never "fix" `POSTGRES_PASSWORD` by editing `.env` on an existing volume (it needs `ALTER USER`).
- **After a `DERIVED_VERSION` bump** (a release note says so): non-partial datasets re-derive by
  themselves; the datasets with `syncStatus` `partial` (above 300,000 rows) need a forced sync each:
  `docker compose run --rm app sync -- --dataset <id> --force` (the recompute log lists them).
- **Windows checkouts**: `.gitattributes` forces LF; an already-CRLF tree needs `git add --renormalize .`
  or a fresh clone (a CRLF `entrypoint.sh` cannot start).

## Security

Details and reasoning: [docs/ARCHITECTURE.md#security-model](docs/ARCHITECTURE.md#security-model).

- **Admin**: one shared token (`ADMIN_TOKEN`) exchanged for a signed session cookie (HMAC, **12 h**, `HttpOnly`,
  `SameSite=Strict`, `__Host-nabd_admin` in production / `nabd_admin` in development); the old `admin_token`
  cookie is not recognised. **No server-side revocation**: logout only expires the browser's copy; rotate
  `ADMIN_TOKEN` (or `SESSION_SECRET` when set) to log everyone out. Login: 5 failures per 15 minutes per client
  and 400 ms per failure; sync API: 10 wrong guesses per 15 minutes, then 429.
- **Secrets are validated at boot** (container entrypoint and server): length, placeholders, entropy, distinctness.
  `dev-*` tokens cannot run with `NODE_ENV=production`.
- **Headers/CSP** (production): `X-Frame-Options: DENY`, HSTS (1 year, no subdomains) and a **same-origin-only CSP**
  (inline scripts/styles allowed for Next and Recharts): new UI must not load external assets or call external
  APIs from the browser. `/_next/image` is disabled (404, observed).
- **Rate limits** are in memory, per process, reset on restart, and key on the real client only with `TRUST_PROXY=1`.
  They are not DDoS protection (see the WAF rules above).
- **Not protected**: all dataset data is public by design; `/api/freshness` and `/api/health/ready` are public and
  reveal sync times, failure counts, uptime and the build revision; one shared admin token (no accounts, 2FA or
  audit trail); a copied session cookie cannot be revoked individually; replicas would split the buckets.
- **Supply chain**: `pnpm audit --prod --audit-level=critical` blocks CI, high advisories print as a warning. Last run
  here: 1 high, `deepmerge-ts` via Prisma's config loader (unreachable: no `prisma.config.ts`; no fixed release on
  Prisma 6); `sharp` is locked at 0.35.5. CI actions are on major tags; pinning them to commit SHAs (Dependabot then
  maintains them) is left to the owner.

## Testing

`pnpm test` runs Vitest. Most of the suite (the exact, dated counts are in [PROJECT_STATUS.md](PROJECT_STATUS.md))
needs no database; the integration tests (11 files: `tests/integration/*` and two `*.integration.test.ts` under
`tests/security`) are skipped unless `RUN_INTEGRATION=1`. Unit tests cover parsing, ranking, derivation (including fuzzing and
number-correctness oracles), auth/CSRF/throttles, env validation, the entrypoint shell script, deploy-config
static guards and component render tests; integration tests run the real engine, lock, scheduler, recompute
and queries against Postgres and an in-process mock portal.

```bash
export DATABASE_URL=postgresql://nabd:nabd@localhost:5432/nabd_test    # a THROWAWAY, migrated database
RUN_INTEGRATION=1 pnpm test
```

**These tests TRUNCATE `Dataset`, `SyncLog`, `SyncLock` and `SyncState` (and so `DatasetRecord`) in
`DATABASE_URL`.** They refuse a database named exactly `nabd` unless `INTEGRATION_ALLOW_WIPE=1`: never set
that against data you care about. `DEBUG_INTEGRATION=1` shows the engine's log output. Vitest does not read
`.env`, so export `DATABASE_URL` yourself (and migrate that database first: `pnpm db:deploy`). **One integration
test is currently stale and fails** (`sync-recompute`, "--force recomputes datasets that are already current"), so
`RUN_INTEGRATION=1 pnpm test` and CI's `check` job are red until it is updated: see PROJECT_STATUS.md.

**CI** (`.github/workflows/ci.yml`; on push to `main`, pull requests and weekly): job `check`, with a
Postgres 16 service **database `nabd_ci`** (the harness refuses `nabd`): `prisma migrate deploy`, typecheck,
lint, `pnpm test` with `RUN_INTEGRATION=1`, `pnpm build` (no secrets needed), the critical-advisory audit
plus the non-blocking high report; job `docker`: builds the image (no push) with `GIT_SHA`. Dependabot
(`.github/dependabot.yml`) tracks npm, Actions and the Docker base image. **The workflow has never run**
(no GitHub Actions in the build sandbox); the first push is the real validation.

## Repo map

```text
src/app/          routes: (home), about, admin (+login), api/* (v1, sync, refresh, freshness, health, revalidate),
                  categories, dataset/[id], developers, publishers, search, updates, feed.xml, sitemap/robots, fonts/
src/components/   UI (header, cards, filters, pager, records table, refresh button, bidi, charts/, admin/)
src/config/       featured.ts (home band), viz-overrides.ts (per-dataset chart pins)
src/lib/sync/     engine, lock, log, run, scheduler, freshness, public-refresh, recompute, derived, version, integrity, cli
src/lib/          queries (cached data layer), search/ranking, api-v1/api-limits/csv-export, env, rate-limit, admin*, format
src/middleware.ts, src/instrumentation.ts   admin session check and URL hygiene (Edge); boot validation and scheduler
prisma/ scripts/ docker/ Dockerfile docker-compose*.yml .github/ tests/ docs/    schema+migrations, mock portal and CLI bundle
```

Scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:watch`, `check`, `sync`, `sync:force`,
`sync:recompute`, `build:cli`, `mock:ods`, `db:generate`, `db:migrate`, `db:deploy`, `db:studio`. `pnpm start` is
`next start`, which prints that it "does not work with output: standalone" (it still serves): the production
path is Docker, or `node .next/standalone/server.js` after copying `.next/static` next to it. Flags go without
`--` (`pnpm start -p 3001`; `pnpm start -- -p 3001` fails on pnpm 10), and `-p N` needs `APP_INTERNAL_URL`
because it does not set `PORT`.

## Known limitations and unverified items

**Not verified against reality** (the real portal and Docker/GitHub were unreachable from the build sandbox):

- Real-portal field shapes: `metas.default` `title_ar`, `keyword`, `license`, `language`, `data_processed`,
  `metadata_processed` are assumptions (the code degrades to `modified` + `records_count` when absent). After the
  first real sync check coverage: `SELECT count("titleAr") FROM "Dataset";`.
- The per-dataset catalog endpoint `GET {base}/catalog/datasets/{id}` may not exist or lack fields; the fallback to
  the full catalog works but then a single-dataset refresh costs 6 requests instead of 1.
- If the portal moves `data_processed`/`modified` more often than the data changes, scheduled syncs re-download
  more than needed.
- The current `Dockerfile`, compose runtime behavior (`cap_drop`, `wget --spider` healthcheck, `docker compose run ...
  sync -- <flags>`), the image's `build:cli` step and the GitHub Actions workflow have **never been run** (the phase 8/9
  build ran an earlier Dockerfile; historical). The CLI bundle and the standalone server were run directly.
- Safari's refusal of `Secure` cookies on `http://localhost` is a documented claim, not tested here.
- Chart and headline heuristics were tuned without the real portal: no multi-level total detection, a series named
  "Price ..." loses its headline, one-row-per-year tables cannot be judged for a partial last year, unusual period
  formats (`Q1 2024`, `15 Mar 2024`) are unreadable (counted, not plotted).

**Known behavior and design limits:**

- **Heavy sync runs inside the web process** when started by the scheduler, the API or a public press; big
  datasets run one at a time but a very large export parse can still stall the event loop for seconds.
- **Partial datasets** (above 300,000 rows: 50,000 stored) are never re-derived locally; after a `DERIVED_VERSION` bump
  each needs a forced sync. The 50%-of-catalog removal guard has no override flag.
- **SIGTERM**: outside Docker, Next's own handler wins unless `NEXT_MANUAL_SIG_HANDLE` is set, so the lock and a
  `running` row survive a restart for up to 10 minutes. With it, the process exits without closing the HTTP server first.
- **No public `Cache-Control` on HTML, by decision** (a refresh must show at once); every page view reaches the app.
- Theme (category) names are shown in the portal's language and are **not translated**.
- Rate limiting is per process and in memory; sessions cannot be revoked individually; no `LICENSE`; the app does not
  stop a request flood.
- `pnpm sync` and `pnpm test` do not read `.env` (export it); the Prisma CLI reads `.env` only.
- The records CSV header comes from cached field metadata, so right after a field-set change columns can lag until the
  cache expires (up to 30 minutes for per-dataset entries). `?page=` of 100,000 or more falls back to page 1. A cursor
  that is not a real record id now answers 409 (it used to return an empty page).
- Search does not match broken Arabic plurals; searching a dataset's records matches key names of nested objects.
- UI: records-table edge shadows need scroll-driven animations (Chromium/Edge, recent Safari; none in Firefox); print
  shows the current page of 25 rows (only Chromium print was checked); iOS focus zoom was not tested on a device; the
  hero search box is hidden below the `sm` breakpoint (the header search remains); bar-chart value labels are not
  implemented; the independent review reported contrast failures in the admin dashboard (`text-ink/40-50`) and a history
  table scroll region that is not keyboard-focusable at 360 px (not re-checked); the login page title reads
  "... | نبض البحرين | نبض البحرين" (observed).
- Behind a proxy that drops `CF-Connecting-IP` with `TRUST_PROXY=1`, everyone shares the `local` bucket (no specific
  warning). The `?constructor=` middleware workaround stays until Next ships the upstream fix.
