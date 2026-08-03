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

**Phase 1 of 9 — scaffold only.** This commit sets up the app shell,
design system, database connection, and tooling. The home page
(`src/app/page.tsx`) is a placeholder — the real sync engine, dataset
browsing/search pages, charts, and admin dashboard land in later phases.

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
instance at `https://data.gov.bh/api/explore/v2.1`. See the sync engine
(added in Phase 2) for the client, politeness rules (concurrency limit 3,
~250ms delay, retry/backoff, 120s export timeout, custom User-Agent), and
per-dataset error isolation.

## Scripts

```bash
pnpm dev             # start dev server
pnpm build            # production build
pnpm start            # run the standalone production build
pnpm lint             # eslint
pnpm exec prisma studio        # inspect the database
pnpm exec prisma migrate dev   # apply/create migrations
```
