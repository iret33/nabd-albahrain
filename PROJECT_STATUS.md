# PROJECT_STATUS.md — نبض البحرين (Nabd Al-Bahrain)

**Phase 9 of 9 — final acceptance verification.** Written 2026-08-04, after
independently re-verifying (not assuming) every item in the Phase 9 brief:
querying Postgres directly, running a clean `pnpm build`, driving the admin
dashboard through a real browser session, curling ~60 pages, running the
production Docker image end-to-end against real data, and reading the
relevant source files. No source code needed to change — everything below
that could be checked, passed on first verification.

## What's built

A complete Next.js 15 (App Router, RSC, TypeScript) app that mirrors and
visualizes all ~512 datasets on data.gov.bh:

- **Sync engine** (`src/lib/sync/`): catalog + per-dataset export fetch
  against the live OpenDataSoft API, politeness-limited (concurrency 3,
  ~250ms stagger, retry/backoff), a deterministic visualization-inference
  engine (`derived.ts`) that classifies fields and picks one of
  area/multi-line/bar-h/bar-stacked/histogram/table per dataset with no
  LLM calls, a `SyncLock` mutex, and a `SyncLog` audit trail. Callable via
  `pnpm sync -- [--limit N] [--dataset <id>] [--force]` or `POST /api/sync`.
- **Public pages**: Arabic RTL home (hero stat band + featured metrics +
  category tiles), `/categories` + `/categories/[theme]`, `/publishers` +
  `/publishers/[slug]`, `/dataset/[id]` (chart, stats, paginated/sortable
  records table, CSV/JSON/official-page links), `/search`, `/about`, plus
  `robots.ts`, `sitemap.ts`, global `error.tsx`/`not-found.tsx`.
- **Admin** (`/admin`, token-gated via `ADMIN_TOKEN` + httpOnly cookie):
  live sync stats, per-dataset failure table, sync history, a manual
  "sync all now" button with live status polling.
- **Design system**: Bahraini sea & pearl — Tajawal/IBM Plex Sans Arabic
  fonts, dark hero band with hairline dividers, pearl-lattice divider,
  dataset cards with hover lift, Latin tabular-digit numerals throughout,
  full RTL with LTR-wrapped chart canvases.
- **Deployment artifacts**: multi-stage `Dockerfile` (standalone output +
  full node_modules overlay for Prisma-on-Alpine), production
  `docker-compose.yml` (app + db, both loopback-only), `docker/entrypoint.sh`
  (`prisma migrate deploy` before serving), `.env.example`, and a detailed
  README covering local dev (with a documented Postgres-without-Docker
  fallback), the sync/admin API, production bring-up, the cron line, and
  Cloudflare Tunnel ingress steps.

## Acceptance checklist — honest results

| # | Item | Result |
|---|------|--------|
| 1 | ≥95% of datasets `syncStatus` ok/partial; failures visible in `/admin` | **PASS** — 512/512 datasets are `ok` (507) or `partial` (5) = **100%**. 0 `error`, 0 `pending`. Queried Postgres directly (`SELECT "syncStatus", count(*) FROM "Dataset" GROUP BY 1`) to confirm, not just read the README's Phase 8 claim. The `/admin` failures table correctly shows its empty state ("لا توجد أخطاء حالياً") since there are none to list — verified by logging into `/admin` in a real browser session, not just reading the code. |
| 2 | Every dataset page renders without crashing for ≥15 datasets spanning temporal/categorical/geo/table-fallback | **PASS** — curled **41** dataset pages against the running production build: a stratified sample of 21 (4× multi-line, 3× area, 3× bar-stacked, 2× bar-h-eligible/histogram, 2× geo-reason table, 2× no-viz-reason table, plus all 5 `partial` datasets) + 20 fully random ones. All 41 returned HTTP 200 with no `Application error`/`Internal Server Error`/`__next_error__` markers, and the server log had zero errors during the run. Also spot-checked visually in a real browser (a table-fallback page correctly shows "لا يتوفر رسم بياني مناسب لهذه المجموعة" instead of crashing; a multi-line chart renders correctly LTR with a legible legend and correct Latin-digit y-axis). |
| 3 | Manual sync button works; `SyncLock` prevents overlapping syncs; status polling reflects reality | **PASS** — tested for real, not just read the code: (a) via `curl`, fired a single-dataset sync then immediately fired a second — got `202` then `409 sync_already_running`, and `GET /api/sync/status` correctly showed `running:false` with the first run's completed `SyncLog` once it finished. (b) via a live browser session: logged into `/admin` with the real `ADMIN_TOKEN`, clicked "مزامنة الكل الآن" — button correctly switched to a disabled "جارٍ التنفيذ…" spinner state, a second click while disabled produced no second network request (client-side guard confirmed via the network log), and the 3s status-poll requests were visible firing and the dashboard's stat tiles updated correctly once the run completed. |
| 4 | `pnpm sync -- --dataset <id> --force` refreshes one dataset only | **PASS** — ran it against `cemeteries`; its `lastSyncedAt` advanced and `SyncLog` recorded `processed: 1, succeeded: 1`. Confirmed via SQL that exactly **one** row (`cemeteries`) had a `lastSyncedAt` newer than the run's start time — every other dataset's `lastSyncedAt` (checked `seaports` specifically) was untouched. |
| 5 | RTL correct everywhere; charts readable; all numbers use Latin tabular digits | **PASS** — `<html lang="ar" dir="rtl">` confirmed on every page checked. `font-variant-numeric: tabular-nums` is applied globally in `globals.css`, and the two number-rendering components (`NumberLatin`, `ArabicTextWithNumbers`) both wrap digits in `dir="ltr"` spans. Chart canvases render inside `dir="ltr"` wrappers so time axes flow left-to-right (verified visually — 2019→2026 left-to-right on a multi-line chart) while the page around them stays RTL. Verified responsive down to 360px width in a live browser (hero band, stat tiles, and dataset cards all reflow correctly with no horizontal overflow). `prefers-reduced-motion` and `:focus-visible` rules are both present in `globals.css`. The Arabic empty-state copy from the spec ("لا توجد نتائج لبحثك — جرّب كلمة أخرى") is present verbatim on `/search` and in the admin dashboard. |
| 6 | `pnpm build` succeeds cleanly | **PASS** — ran it fresh: `✓ Compiled successfully`, typecheck clean, all 16 routes generated, zero errors/warnings. `pnpm lint` also passes with zero output. Additionally built and ran the actual **Docker** production image (`docker run` on the `nabd-albahrain_default` network against the real `db` container) end-to-end: `prisma migrate deploy` ran cleanly (no pending migrations — schema already current), the server started, and `/`, `/dataset/seaports`, `/categories`, `/api/health` all returned 200 with an unknown dataset correctly 404ing. This is real evidence the Dockerfile/compose setup works today, not just a rerun of Phase 8's notes. |
| 7 | README lets a stranger deploy from zero, incl. cron line and Cloudflare Tunnel steps | **PASS** — read the full 900+ line README. It has prerequisites, local dev (with Docker and a documented non-Docker Postgres fallback), env var setup, migrations, a first test sync, the full design system, the sync engine and viz-inference engine internals, all public routes, the sync API + admin dashboard contract, a Phase-7 polish log, and a dedicated **Production deployment** section: `git clone` → `.env` setup → `docker compose up -d --build`, a first-sync curl command, the exact crontab line for a nightly sync (`15 3 * * * curl ... >> /var/log/nabd-sync.log 2>&1`, with a note that cron doesn't inherit shell env), and step-by-step Cloudflare Tunnel ingress-rule + DNS-route + restart instructions for adding this app to an *existing* tunnel. Nothing in it references infrastructure this workflow actually touched. |
| 8 | Home page TTFB feels fast locally | **PASS (rough local gut check only, as instructed)** — 5 consecutive local requests to `/` averaged ~24ms TTFB (`curl -w "%{time_starttransfer}"`), dataset pages ~17ms. This is `next start` on a dev laptop against local Postgres, not the real VPS — real production TTFB genuinely cannot be measured from here, per the brief. |
| 9 | `robots.txt` and `sitemap.ts` exist and look correct; dataset pages have sane `generateMetadata` | **PASS** — `robots.txt` allows `/`, disallows `/admin`, and points at `/sitemap.xml`. `sitemap.xml` served 592 `<url>` entries (static pages + all categories/publishers/datasets) with correct `changefreq`/`priority`. `/dataset/[id]`, `/categories/[theme]`, `/publishers/[slug]`, and `/search` all have dynamic `generateMetadata` (title + description from real dataset/category data); `/`, `/categories`, `/publishers`, `/about` have static `export const metadata`. Spot-checked rendered `<title>`/`<meta name="description">` on a real dataset page — both correct and dataset-specific. |

**Every checklist item passed.** No gaps needed a same-phase fix, and
nothing was silently marked done without being actually checked — see the
verification method noted in each row.

## Dataset sync success rate

**512 / 512 datasets = 100% ok/partial** (507 `ok`, 5 `partial`, 0 `error`,
0 `pending`) — well above the 95% bar. **1,212,280** `DatasetRecord` rows
stored. `vizConfig` distribution across all 512: multi-line 269, area 125,
bar-stacked 96, table 18 (9 `reason:"geo"`, 9 `reason:"no-viz"`),
histogram 4, bar-h 0 (structurally correct — bar-h's decision-tree slot is
only reached when no multi-line/area/bar-stacked rule already matched, and
in this catalog something earlier in the tree always did for
single-dimension-eligible datasets).

## Known issues / permanently-limited datasets

- **5 datasets are `partial`, not `ok`, by design, not by failure**:
  `05-import-2021`, `04-import-2022`, `import-1-2025`, `import-2024`,
  `01-import-non-oil-classified-by-commodity-and-country-for-2023` — each
  has 300,000+ source rows (detailed trade-by-commodity-by-country tables),
  correctly hit the 300,000-row hard cap, and store only the first 50,000
  rows as `DatasetRecord`s. `statsJson`/`vizConfig`/`chartData`/`summaryAr`
  are still computed over the **full** fetched export, so the chart and
  summary sentence on those 5 pages are accurate — only the raw records
  table is capped. This is intentional (`MAX_ROWS_HARD_CAP` /
  `MAX_ROWS_STORED_WHEN_CAPPED` in `src/lib/sync/engine.ts`), not a bug.
- **0 hard sync failures** in the current run. Nothing is silently broken
  or unaddressed in `/admin`'s failure table because there is nothing in it.
- Two real bugs *were* found and fixed during Phase 8's full-catalog run
  (a static-rendering/Docker-build bug, and a featured-metric
  double-counting bug) — both already fixed and documented in the README's
  "Full sync results (Phase 8)" section; re-verified as fixed in this
  phase (the Docker image builds and serves correctly; see item 6 above).
- `next start` (used only for this phase's local smoke-testing, not the
  real deploy path) prints a harmless warning that `output: "standalone"`
  wants `node .next/standalone/server.js` instead — it still serves pages
  correctly for local testing. The Dockerfile/entrypoint already do it the
  right way (`exec node server.js` against the standalone build) for
  production, which is what was actually verified end-to-end.
- `/categories/[theme]` and `/publishers/[slug]` return `200` with a
  graceful Arabic "unknown"/empty-results state for a slug that doesn't
  match any live category/publisher, rather than a hard `404` (unlike
  `/dataset/[id]`, which does correctly `404` for an unknown id). This is
  a reasonable design choice given categories/publishers are derived from
  live data rather than a fixed enum, not a defect — noted here for
  transparency, not fixed, since it wasn't a checklist item.
- No automated test suite exists (never specced — the locked stack has no
  test runner). Verification in this phase was black-box: live DB queries,
  a real browser session, and direct HTTP checks against a running build.

## What a human needs to do next

This workflow **deliberately never touched any remote infrastructure** —
everything above was produced and verified against local Docker/Postgres
only. To actually ship this:

1. **Review the site locally** — `pnpm dev` (or `docker compose up -d --build`
   for the full containerized stack) against the local Postgres this phase
   already populated with a live, 100%-synced catalog, and click around.
2. **Supervise the actual VPS deployment** — `git clone` this repo onto
   `data.hekkapp.com`'s Ubuntu VPS, follow the README's **Production
   deployment** section exactly (`.env` with real random
   `ADMIN_TOKEN`/`SYNC_TOKEN`, `docker compose up -d --build`, the cron
   line, and the Cloudflare Tunnel ingress-rule edit + DNS route + restart)
   — all of which requires direct access to that VPS and its existing
   tunnel config that no phase of this workflow had or touched.
3. Optional/nice-to-have, not blocking: decide whether `/categories/[theme]`
   and `/publishers/[slug]` should 404 on an unknown slug instead of
   showing an empty state (see "Known issues" above) — this is a design
   call, not a bug fix.

Every phase's git history is intact and clean (`git log --oneline`, 8
prior commits + this phase's). Working tree was clean before this phase
started and required no source changes — only this file is new.
