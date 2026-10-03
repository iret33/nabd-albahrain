# Changelog

What changed since the Phase 9 acceptance build (August 2026), in plain language and
grouped by what you care about as the owner. This describes the code at the "Integrate
stage 3 fixes" commit (2026-10-03). The build log of the first nine phases is in
[docs/HISTORY.md](docs/HISTORY.md); how everything works is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Read this before you upgrade an existing server

1. **Compare your `.env` with `.env.example` line by line.** An `.env` copied from the old
   template silently lacks `AUTO_SYNC_INTERVAL_MINUTES` (the new scheduler stays off) and
   `TRUST_PROXY=1` (every visitor then shares one rate-limit bucket). Add both.
2. **Weak or placeholder secrets now stop the app from starting.** `ADMIN_TOKEN` and
   `SYNC_TOKEN` must be at least 32 characters, not placeholder-like, and different from
   each other (`openssl rand -hex 32` each). `dev-*` values are rejected in production.
3. **Everyone is logged out once.** Admin sessions are a new signed cookie; the old
   `admin_token` cookie is no longer recognised.
4. **The database migrates itself** when the container starts (`prisma migrate deploy`).
   Existing rows are then in the "legacy" shape (no version token, no search text): run
   one catalog pass (`docker compose run --rm app sync`, or just let the scheduler do it
   about a minute after boot) and the site repairs itself. Details in the README's
   "Upgrading a pre-freshness database".
5. **Build with the revision stamp** so `/api/health/ready` can tell you what is running:
   `GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build`.
6. If you used the host crontab line from the old README, you can remove it once
   `AUTO_SYNC_INTERVAL_MINUTES` is set (the sync lock makes running both harmless).

## Freshness and refresh (new)

- **A "check for new data" button** on the header, the home hero, every dataset page,
  `/updates` and `/about`. It asks the portal's catalog whether anything changed and
  re-downloads only what did (at most 5 datasets of at most 100,000 rows per press; bigger
  ones wait for the scheduled run). No token is involved; abuse is bounded by database
  cooldowns (120 s for the whole catalog, 600 s per dataset, shared by all visitors) and
  per-client limits. `PUBLIC_REFRESH_ENABLED=0` removes the button and answers 503.
- **Built-in scheduler** (`AUTO_SYNC_INTERVAL_MINUTES`): the web process checks the
  catalog itself, repairs legacy rows, re-derives stale charts, and populates an empty
  database about a minute after boot. No host cron needed.
- **Change detection by version token, not by clock comparison.** A dataset is
  re-downloaded when the portal's `modified` / `data_processed` / `metadata_processed` /
  row count / field list differs from what we synced from. A single dataset refresh costs
  one catalog request when the portal supports the per-dataset endpoint.
- **Datasets the portal removes are flagged, not deleted.** Their page stays up with a
  banner; they leave lists, search, the sitemap and the feed.
- **Truthful run history.** The sync lock has a heartbeat (stale after 10 minutes, not 2
  hours), a run's `SyncLog` row exists from the moment it starts, crashed runs are marked
  "aborted", and a container stop mid-sync aborts cleanly (Docker sets
  `NEXT_MANUAL_SIG_HANDLE`).
- **Integrity guards**: an incomplete or implausibly small catalog never deletes anything,
  an empty or truncated export never replaces stored rows, and very large datasets are
  processed one at a time.
- **Caches drop when data changes**: every run (also the CLI and the scheduler) tells the
  web server which pages to invalidate; `CACHE_TTL_SECONDS` is only the safety net.
- **Monitoring endpoints**: `GET /api/freshness` (add `?strict=1` for an uptime monitor
  that should alert when data is stale) and `GET /api/health/ready`.
- **`/updates` page and `/feed.xml` Atom feed** of the 50 most recently modified datasets.
- **CLI**: `--dry-run` (what would change), `--recompute` (re-derive charts without
  network), `--dataset`, `--limit`, `--force`; plain `pnpm sync` is now incremental.
- **SyncLog retention**: no-op public presses are pruned after 7 days, other rows after
  90 days (failures of scheduled/admin/CLI runs after 365), so visitor clicks cannot
  bury real history.

## Performance

- Every cached query has a real TTL and a bounded key space (no attacker-chosen cache
  keys); one refreshed dataset invalidates its own pages instead of all 512.
- Search is a single trigram-indexed column (`searchText`) with in-memory ranking.
- Keyset pagination for records (page 500 costs the same as page 1); CSV exports stream
  in batches with flat memory.
- Expensive record views (sort/search on huge datasets) take a limited slot and degrade
  with a notice instead of queueing; a 3-second statement timeout bounds them.
- Charts load on demand (Recharts is not in the first paint), sparklines need no
  JavaScript, fonts are local files (no font host at build or run time).
- The derivation engine is faster on very large datasets and bounded in memory.
- Compose gives the app an explicit database pool (`DB_POOL_SIZE`, default 12) and an
  optional memory cap.

## Correctness

- **Numbers you can trust** (`DERIVED_VERSION` 3): "Total" rows are never summed with
  their parts; rates, percentages, indexes and prices are averaged, not summed (the CPI
  no longer charts ~42,000); a half-finished last period is drawn dashed and never becomes
  the headline; gaps are visible; provisional markers (`2024*`) and fiscal years are read;
  a headline that cannot be stated honestly is withheld instead of invented.
- One number convention and one percent convention everywhere (cards, sentences, charts),
  with Arabic count agreement ("فئتان", "12 فئةً").
- **Arabic search**: spelling variants, diacritics, Persian letter forms, Arabic-Indic
  digits and the definite article (المطار / بالمطار / للمطار) all match; HTML in
  descriptions is no longer indexed as words.
- Stored-row limits are consistent: datasets up to 300,000 rows are stored whole, larger
  ones keep 50,000 and are marked partial everywhere (page, API, CSV header).
- API cursors are tied to one generation of a dataset's rows: a stale cursor is a clear
  `409 cursor_expired`, never a silently duplicated first page.
- Unknown categories, publishers and datasets return real 404s; malformed percent-encoded
  URLs get the Arabic 404 page.

## Security

- **Signed admin sessions** (12 hours, `SameSite=Strict`, `__Host-` cookie in production);
  cookie-authenticated POSTs must be same-origin; wrong tokens are throttled (login 5 per
  15 minutes, sync API 10 per 15 minutes) and compared in constant time.
- **Boot-time validation** of secrets and tunables, in the container entrypoint and in the
  server; `SESSION_SECRET` can decouple session signing from `ADMIN_TOKEN`.
- **Security headers and a same-origin-only CSP** in production; the image optimizer
  (`/_next/image`) is off.
- Per-client rate keys come only from `CF-Connecting-IP` (and only with `TRUST_PROXY=1`);
  `X-Forwarded-For` is ignored.
- Public API abuse limits: 120 requests/minute and 30 CSV starts per 10 minutes per client,
  one CSV stream per client and two per server; CSV cells that a spreadsheet would execute
  are neutralised.
- Request bodies are size-capped; malformed dataset ids are 400/404, never a 500.
- Container: non-root user, an application tree the runtime user cannot modify (only `.next/cache` is writable),
  `cap_drop: ALL`, `no-new-privileges`.
- `?constructor=` (a Next.js 15 crash vector) is stripped by the middleware.

## UX and accessibility

- Arabic right-to-left throughout with a bidi helper: Latin words and numbers inside
  Arabic text stay in one left-to-right group; Latin digits everywhere.
- Filters, search, sorting and paging work without JavaScript; there are no streaming
  loading boundaries, so a browser without JavaScript sees the real content.
- Phone layout fixes: header tab order, 16 px form controls (no iOS focus zoom), two-column
  hero stats, long-token wrapping.
- Arabic month names and compact Arabic units on chart axes; contrast-checked, colour-vision
  safe series colours; chart data table, CSV and PNG download.
- A print stylesheet (attribution and URL printed, controls hidden).
- Skip link, visible focus rings, `prefers-reduced-motion` respected.
- Admin: shows failed and aborted runs, freshness, a recompute button, removed counts, and
  hides no-op public presses by default (`/admin?runs=all` shows everything).

## Operations and CI

- GitHub Actions workflow: typecheck, lint, the full test suite against Postgres (database
  `nabd_ci`), build, dependency audit, and a Docker image build.
- Dependabot for npm, GitHub Actions and the Docker base image.
- `docker compose run --rm app sync -- <flags>` runs the bundled CLI (`dist/sync-cli.cjs`)
  as a one-off container; the entrypoint passes any other command through.
- `docker-compose.override.example.yml` for local development (the production `db` no
  longer publishes a port).
- `.gitattributes` forces LF (a CRLF checkout would break the entrypoint and migrations).
- An offline mock of the portal (`pnpm mock:ods`) with modes that simulate publishing,
  removal, truncation, slow and failing exports.
- Test suite: 88 test files, 2,566 tests (2,323 run without a database).

## Documentation

- README, `docs/ARCHITECTURE.md`, `PROJECT_STATUS.md` and `.env.example` rewritten to
  match the code; the old phase logs moved to `docs/HISTORY.md`.
- Stale comments in `prisma/schema.prisma` and the sync routes (the removed `admin_token`
  cookie, Phase 1/2 scaffolding) corrected. No behavior change.
