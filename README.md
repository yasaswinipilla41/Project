# Prio

**Internal Project & Issue Management** for Symbiosys Technologies — projects,
issues, stories and first-class bug management, with boards, backlogs, search,
reports, an immutable activity trail and notifications.

Self-hosted. Single organisation. No public sign-up.

---

## Stack

| Layer          | Choice                                                       |
| -------------- | ------------------------------------------------------------ |
| Frontend       | Next.js 16 (App Router, RSC) + React 19 + TypeScript          |
| Styling        | Bootstrap 5 **grid/layout utilities only** + Prio custom CSS  |
| Backend        | Next.js server actions and route handlers (modular monolith)  |
| Database       | PostgreSQL 17 + Prisma 7 (node-postgres driver adapter)       |
| Auth           | better-auth (email + password, sessions, sign-up disabled)    |
| Jobs           | BullMQ on Redis                                               |
| Email          | Provider-independent SMTP (nodemailer)                        |
| Tests          | Vitest                                                        |

There is no Tailwind and no component library: every Prio surface is built from
the design tokens in [`src/styles/tokens.css`](src/styles/tokens.css) and the
primitives in [`src/components/ui/`](src/components/ui/).

---

## Quick start (Docker)

Prerequisites: Docker Desktop running.

```bash
cp .env.example .env
# edit .env: set AUTH_SECRET (openssl rand -base64 32) and the SMTP block

docker compose up -d --build
```

A one-shot `migrate` service applies pending migrations and exits; `app` does
not start until it has succeeded, so no request is ever served against an
unmigrated schema. Then seed the development data:

```bash
docker compose run --rm migrate npx tsx prisma/seed.ts
```

The Prisma CLI lives only in the `migrate` image, not in the image that serves
traffic — so migrations and seeding both run through that service.

| Service         | URL                            |
| --------------- | ------------------------------ |
| Prio            | http://localhost:3000          |
| Health check    | http://localhost:3000/api/health |
| Mailpit (SMTP)  | http://localhost:8025          |
| PostgreSQL      | localhost:5433                 |
| Redis           | localhost:6380                 |

Postgres and Redis are published on non-default host ports so they cannot
collide with anything already installed locally.

### Seeded accounts

| Email                          | Password     | Role   |
| ------------------------------ | ------------ | ------ |
| `admin@symbiosystech.com`      | `Prio@12345` | Admin  |
| `rahul.menon@symbiosystech.com`| `Prio@12345` | Admin  |
| `priya.nair@symbiosystech.com` | `Prio@12345` | Member |

Change `SEED_ADMIN_PASSWORD` / `SEED_DEFAULT_PASSWORD` in `.env` before seeding
anything you intend to keep.

---

## Local development (without the app container)

Run only the backing services in Docker and Next.js on the host:

```bash
docker compose up -d postgres redis mailpit
npm install
npx prisma migrate dev
npm run db:seed
npm run dev
```

### Scripts

| Command              | Purpose                                     |
| -------------------- | ------------------------------------------- |
| `npm run dev`        | Next.js dev server                          |
| `npm run build`      | Production build                            |
| `npm run typecheck`  | `tsc --noEmit`                              |
| `npm run lint`       | ESLint                                      |
| `npm test`           | Vitest unit + integration tests             |
| `npm run test:e2e`   | Playwright end-to-end tests                 |
| `npm run test:all`   | Both suites                                 |
| `npm run db:migrate` | Create and apply a migration (development)  |
| `npm run db:deploy`  | Apply migrations (production)               |
| `npm run db:seed`    | Seed development data                       |
| `npm run db:reset`   | Drop, re-migrate and re-seed                |

### Tests

`npm test` runs Vitest. The suites are **integration** tests: they sign in as a
seeded user through better-auth and call the real server actions against the
running PostgreSQL database, so Postgres must be up and seeded first:

```bash
docker compose up -d postgres redis
npx prisma migrate deploy
npm run db:seed
npm test
```

They create their own fixtures and delete them again, leaving the seed data
untouched. They run serially — one shared database.

### End-to-end tests

`npm run test:e2e` drives a real Chromium against the **running stack** (Docker
Compose by default; override with `E2E_BASE_URL`). It signs in with the seeded
accounts, so bring the stack up and seed it first.

```bash
docker compose up -d
docker compose run --rm migrate npx tsx prisma/seed.ts
npx playwright install chromium   # first run only
npm run test:e2e
```

Note that better-auth rate-limits sign-in to 3 attempts per 10 seconds in
production. The suite signs in once per role and reuses the session; tests that
deliberately exercise the sign-in form space their attempts out rather than
disabling the protection.

### Load testing

To check the §39 target of roughly 2,000 issues per project:

```bash
npm run loadtest:seed    # creates a LOAD project with 2,000 issues
npm run loadtest:clean   # removes it again
```

---

## Configuration

Every setting comes from the environment; nothing is hard-coded. See
[`.env.example`](.env.example).

| Variable                        | Purpose                                        |
| ------------------------------- | ---------------------------------------------- |
| `DATABASE_URL`                  | PostgreSQL connection string                    |
| `REDIS_URL`                     | Redis connection for BullMQ                     |
| `AUTH_SECRET`                   | Session signing secret (≥32 bytes of entropy)   |
| `BASE_URL`                      | Public origin, used in links and cookies        |
| `SMTP_HOST` / `_PORT`           | Mail relay                                      |
| `SMTP_USERNAME` / `_PASSWORD`   | Relay credentials (omit for an open local sink) |
| `SMTP_FROM`                     | From header on outgoing mail                    |

`SMTP_HOST` unset disables email delivery: jobs log what they would have sent
and in-app notifications continue to work.

---

## Operations

### Startup / shutdown

```bash
docker compose up -d            # start
docker compose ps               # state and health
docker compose stop             # stop, keep data
docker compose down             # stop and remove containers, keep volumes
docker compose down -v          # …and DELETE the database volume
```

### Logs

```bash
docker compose logs -f app
docker compose logs -f postgres
docker compose logs --since 15m app
```

### Health checks

The `app` container is healthy only when `/api/health` returns 200, which
requires a successful database round-trip:

```bash
curl -s http://localhost:3000/api/health
# {"status":"ok","service":"prio","database":"up","latencyMs":3,...}
```

### Migrations

```bash
# development — creates a migration from schema.prisma changes
npx prisma migrate dev --name add_something

# production — applies pending migrations, never generates one
docker compose run --rm migrate

docker compose run --rm migrate npx prisma migrate status
```

Migrations always run before the app serves traffic: `app` declares
`depends_on: migrate: condition: service_completed_successfully`.

### Backups

Nightly `pg_dump` in custom format, retained 14 days, via
[`scripts/backup/backup.sh`](scripts/backup/backup.sh):

```bash
# run now
docker compose exec postgres sh /scripts/backup.sh

# restore (stop the app first)
docker compose stop app
docker compose exec postgres sh /scripts/restore.sh /var/lib/postgresql/backups/prio-YYYYMMDD-HHMMSS.dump
docker compose start app
```

Schedule it nightly with cron (Linux) or Task Scheduler (Windows) — both
invocations are documented at the top of `backup.sh`. Copy the dumps off the
host; a backup on the same disk as the database is not a backup.

---

## Brand assets

The Prio logo is **not** drawn in code. It lives in
[`public/brand/`](public/brand/README.md) and is referenced through one
component, [`PrioLogo`](src/components/brand/PrioLogo.tsx) — replacing the file
updates the sidebar, sign-in, splash, invitations and emails at once.

The files currently in `public/brand/` are placeholders and are marked as such.

---

## Project layout

```
prisma/
  schema.prisma        single Issue model; a Bug is type = BUG
  seed.ts              Symbiosys Technologies development data
src/
  app/
    (auth)/            sign-in and invitation screens
    (app)/             authenticated application
    api/               health check and better-auth handler
  components/
    brand/             PrioLogo — the only place the mark is referenced
    shell/             sidebar, top bar, application frame
    ui/                icons, indicators, primitives, menus
  lib/                 auth, session, authorization, domain vocabulary
  server/              server actions and background jobs
  styles/              design tokens and component CSS
scripts/backup/        pg_dump backup and restore
```
