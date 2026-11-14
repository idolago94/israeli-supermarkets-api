# Notes for coding agents

This repo holds the price-comparison catalog: a read API and sync endpoints
deployed on Vercel (`api/`, `lib/`), and a local sync service that runs on an
always-on machine (`sync-service/`).

## Setting up or running the local sync service

When asked to install, set up, start, run or fix the sync service, follow
**[`sync-service/SETUP.md`](sync-service/SETUP.md) step by step**, and check
each step before moving on. In short, from the repo root:

1. `npm ci`, then `cd sync-service && npm ci`. Both installs are needed.
2. `cp .env.example .env` in `sync-service/`, and set `SYNC_DATABASE_URL`.
   Ask the user for the connection string; never invent one or commit `.env`.
3. `npm run migrate`
4. `npm run doctor`. It must report "All required checks passed". It prints
   the fix for anything that fails.
5. `npm start` to run in the foreground, or `./deploy/install-macos.sh` /
   `./deploy/install-linux.sh` to install it as a background service.

The dashboard is at http://localhost:4100. Run `npm run doctor` any time to
see the state of the setup and whether the service is running.

How the service works: [`sync-service/README.md`](sync-service/README.md).

## Working on the code

- Root (Vercel API and shared `lib/`): `npm run build` (type check),
  `npm test`.
- `sync-service/`: `npm run build`, `npm test`. Set `SYNC_TEST_DATABASE_URL`
  to a scratch Postgres to include the database tests, which truncate the
  catalog tables.
- `sync-service/` imports from `lib/`. Keep `lib/` free of imports that need
  environment variables at load time, such as `lib/mongo.ts` and `lib/pg.ts`,
  in anything the service uses.
- `sync-service/` must stay out of the Vercel deployment: it has its own
  `package.json` and is listed in `.vercelignore`.
- Catalog v2 schema changes go in `supabase/migrations/` as re-runnable SQL
  (`if not exists`), since `npm run migrate` applies every file each time.
