# PROJECT_STATUS: نبض البحرين (Nabd Al-Bahrain)

Current, honest status of the code at the "Integrate stage 3 fixes" commit (2026-10-03). It replaces the
Phase 9 acceptance report (kept, as history, in [docs/HISTORY.md](docs/HISTORY.md): its "PASS" results describe
a codebase that has since been rebuilt and must not be read as describing this one). Facts here were either run
for this report (the commands are quoted with their real output) or are marked as unverified. For setup and
operations read the [README](README.md); for how it works, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); for what
changed, [CHANGELOG.md](CHANGELOG.md).

**In one paragraph.** The application is feature-complete for its brief: a mirror of the data.gov.bh catalog with
automatic charts, Arabic search, a public refresh button backed by a scheduler and a freshness system, a public
JSON API, an admin dashboard, hardened deployment files and CI. It has an automated test suite (2,566 tests) that
passes except for one stale integration test, and it was exercised end to end here in a production build against an
offline mock of the portal. It has **not** been run against the real portal, in a Docker container, or on GitHub
Actions since the rebuild; those are the first things to do on the VPS (see "Owner actions").

## What is built

- **Sync engine** (`src/lib/sync/`): verified-complete catalog passes, version-token change detection, integrity
  guards, atomic lock with heartbeat, `SyncLog` lifecycle and retention, no-network recompute, graceful abort,
  one-at-a-time lane for big datasets, cache invalidation after every run, built-in scheduler, CLI and a bundled
  CLI (`dist/sync-cli.cjs`).
- **Freshness**: public `POST /api/refresh` (database cooldowns, per-client limits, kill switch), `GET /api/freshness`,
  `GET /api/health/ready`, stale detection, deferral of large datasets, the visitor-facing refresh button.
- **Derived data** (`derived.ts`, `DERIVED_VERSION` 3): field statistics, chart choice (multi-line, area, bar,
  stacked bar, histogram, table), total/mean/partial-period/gap/provisional rules, withheld headlines, Arabic lead
  sentences.
- **Public site**: home, categories, publishers, Arabic-aware search, dataset pages (chart, captions, data table,
  field dictionary, records table, JSON-LD, print), `/updates`, `/feed.xml`, `/about`, `/developers`, sitemap, robots,
  manifest and icons; local fonts; no streaming boundaries.
- **Public API** `/api/v1` (catalog, dataset, records with keyset pagination, streaming CSV) with abuse limits.
- **Admin** (`/admin`): signed 12 h sessions, sync/force/recompute, failures, run history, dataset list.
- **Security and ops**: boot-time env validation, same-origin CSP and headers, rate limits, Docker image and compose
  stack (non-root, `cap_drop`), `docker/entrypoint.sh`, GitHub Actions workflow, Dependabot.

## How it was verified (evidence that exists)

All run on 2026-10-03 against a scratch Postgres 16, Node 22.22, pnpm 10.28.0.

| Evidence | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint` | both exit 0 |
| `pnpm test` (no database) | **77 test files passed, 11 skipped; 2,323 tests passed, 243 skipped** (88 files, 2,566 tests in all; about 9 s) |
| `RUN_INTEGRATION=1 pnpm test` against a throwaway migrated database | 88 files, 2,566 tests: **2,565 passed, 1 failed** (about 54 s). The failure is `tests/integration/sync-recompute.test.ts` "--force recomputes datasets that are already current": it expects 9 recomputed datasets, the code now recomputes 10 because zero-row `ok` datasets became eligible (`recompute.ts` says so). A stale test, reproduced when run alone; not a behavior regression. CI would fail on it |
| `prisma validate`; `pnpm db:deploy` on an empty database; `prisma migrate diff` (migrated DB vs `schema.prisma`); `pnpm db:migrate` on an empty database | valid; all 6 migrations apply; empty diff ("This is an empty migration"); applies and reports "in sync" with no prompt and no new migration |
| `pnpm build` (no env, no network) | succeeds; 34 entries in the route table; the build needs no secrets and no font host |
| Production build served with `node .next/standalone/server.js` against the offline mock portal (`pnpm mock:ods`) | exercised: first sync through `node dist/sync-cli.cjs`; incremental, `--dry-run`, `--recompute`; a simulated pre-freshness database repaired by one recompute and one sync; every documented route of the README API reference with the status codes, headers and bodies quoted there (400, 401, 403, 404, 409 cursor_expired, 429 rate limits with `Retry-After`, 202/200 refresh outcomes incl. `up_to_date`, `already_running` and a **deferred** large dataset, kill switch 503, CSV with BOM, HEAD, CORS preflight, `/_next/image` 404); admin cookie rules (a bare cookie POST is 401, `cross-site` 401, `same-origin` 202, the old `admin_token` cookie and a forged cookie are redirected to login) |
| Boot validation | a `dev-*` token, identical tokens, `TRUST_PROXY=true`, `SYNC_CONCURRENCY=0` and `PUBLIC_REFRESH_ENABLED=maybe` each print the problem list and **exit 1**; unset `TRUST_PROXY` and a pool of 3 print `[config] WARNING` lines and still boot; `PUBLIC_REFRESH_ENABLED=false` is accepted |
| Clean clone (`git clone --no-hardlinks`, no `node_modules`, no `.env`) following the README's local-development steps | worked after a manual `pnpm db:generate` (found here; a `postinstall: prisma generate` was added afterwards, so a plain `pnpm install` now generates the client); then `pnpm db:deploy`, mock + `pnpm sync`, `pnpm dev` (home, dataset page and API answered 200), `pnpm check` all pass |
| `docker compose config` (with `.env.example` copied to `.env`), with and without the dev override; YAML parse of the CI and Dependabot files | exit 0: production publishes only `app` on `127.0.0.1:3000`, `db` publishes nothing; with the override `db` publishes `127.0.0.1:5432`; `GIT_SHA` reaches the build args, `connection_limit=12` reaches `DATABASE_URL`. No Docker daemon was available |
| `pnpm audit --prod` | 1 high (`deepmerge-ts` via Prisma's config loader, unreachable, no fix on Prisma 6); `sharp` is 0.35.5 |
| The real portal, earlier (Phase 8/9, **before the rebuild**) | a real full sync of 512 datasets (507 ok, 5 partial, 1,212,280 stored rows, about 6 min 38 s) and a Docker image run were recorded then; those numbers are historical and cannot be re-verified from this repository |

## What could NOT be verified

- **The real portal.** Unreachable. The shapes of `title_ar`, `keyword`, `license`, `language`, `data_processed`,
  `metadata_processed`, and the existence of the per-dataset catalog endpoint, are assumptions; the heuristics for
  charts, totals and headlines were tuned without real data. After the first real sync check
  `SELECT count("titleAr") FROM "Dataset";`.
- **Docker image build and container run** for the current `Dockerfile`, entrypoint wiring of `dist/sync-cli.cjs`, the
  `wget --spider` healthcheck, `cap_drop: ALL` with `no-new-privileges`, and `docker compose run ... sync -- <flags>`.
- **GitHub Actions**: the workflow was never executed (YAML parses, steps were replayed by hand).
- **Browsers**: Safari's refusal of `Secure` cookies on `http://localhost`, iOS focus zoom, and Firefox and older
  Safari rendering were not tested; print was only checked in Chromium.
- **Load**: the abuse-limit numbers come from measurements recorded in code comments (20 uncapped 300,000-row CSV
  streams took `/about` from about 17 ms to about 2 s; a flood of refused requests costs about 1.3 ms of the Node
  thread each), not re-measured here.

## Owner actions and open items

1. **Run the first real sync and read the result**: `docker compose run --rm app sync`, then check field coverage
   and `GET /api/health/ready`. Look at `/admin` for failures.
2. **Build and start the image on the VPS** and run the CI workflow once (push the branch): both have never run.
3. **Set `TRUST_PROXY=1`, real `ADMIN_TOKEN`/`SYNC_TOKEN`, `AUTO_SYNC_INTERVAL_MINUTES`** in the production `.env` (an `.env`
   from the old template lacks them), and add the Cloudflare WAF rate-limit rules from the README.
4. **Pin the GitHub Actions to commit SHAs** (Dependabot keeps them current afterwards); decide on a **`LICENSE`**.
5. **Monitor** `GET /api/freshness?strict=1` (stale) and `GET /api/health/ready` (`ok`, `reasons`).
6. Decide whether you want server-side session revocation or per-user admin accounts (today: one shared token, 12 h
   signed cookie, rotate the token to revoke).
7. After any `DERIVED_VERSION` bump, force-sync each `partial` dataset (the recompute log lists them).
8. Developer follow-ups found by the documentation pass and since fixed: the stale recompute test, the missing Prisma
   client after a fresh `pnpm install` (now a `postinstall`), and the sync CLI ignoring env files (it now loads
   `.env.local` then `.env`).

## Known issues and limitations

Bugs and sharp edges found while documenting:

- **Fixed after the documentation pass found them:** the recompute integration test (zero-row datasets are now
  recomputed on purpose), the Prisma client missing after a fresh `pnpm install` (a `postinstall: prisma generate` now
  runs; the `allowBuilds` key in `pnpm-workspace.yaml` is still not pnpm 10's documented setting
  (`onlyBuiltDependencies`), which is harmless today because nothing depends on dependency build scripts), and
  `pnpm sync` ignoring `.env` / `.env.local` (the CLI now loads them without overriding real environment variables).
- **A malformed `%`-sequence in an `/api/` path** (for example `/api/v1/datasets/%E0%A4%A`) is answered with Next.js's own
  bare English HTML 400 page, not JSON (the middleware matcher excludes `api/`); page paths get the Arabic 404.
- **`robots.txt` is static**: its `Sitemap:` line uses the *build-time* `NEXT_PUBLIC_SITE_URL` (observed here: it named
  `data.hekkapp.com` while dynamic routes used the runtime value).
- The login page title reads "دخول لوحة الإدارة | نبض البحرين | نبض البحرين" (duplicated suffix).
- `prisma/migrations/20261003000000_freshness_and_search` still carries a SQL comment saying Prisma wants to drop the
  trigram indexes; the schema now declares them, so it is obsolete. Applied migrations must not be edited (checksums).

Design limits (also in the README): heavy runs execute inside the web process; partial datasets need a forced sync after a
`DERIVED_VERSION` bump; no public `Cache-Control` on HTML, by decision; theme names are not translated; in-memory rate
limiting; no session revocation; the 50%-of-catalog removal guard has no override; SIGTERM semantics differ outside Docker;
records-table scroll shadows need scroll-driven animations; the admin dashboard has reported contrast and keyboard-scroll
issues (from the independent review, not re-checked); heuristics are name- and arithmetic-based.

## Documentation map

| File | Role |
| --- | --- |
| `README.md` | front door: setup, configuration, freshness, API, deployment, security, testing, limitations |
| `docs/ARCHITECTURE.md` | the machinery: sync phases, lock, derived pipeline, caching, search, refresh protocol, security, front-end conventions |
| `CHANGELOG.md` | what changed since Phase 9, for the owner |
| `docs/HISTORY.md` | the old Phase 1-9 build log and acceptance report, historical |
| `.env.example` | annotated configuration template |
