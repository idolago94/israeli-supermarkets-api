# Setting up the sync service on a new machine

Step by step, from a fresh clone to a service that starts on its own and keeps
running. Each step ends with a check: don't move on until it passes.

`npm run doctor` (in `sync-service/`) checks everything below at once and
prints the fix for anything that's wrong. When in doubt, run it.

What the service is and how it works: [README.md](README.md).

## What you need

- **macOS or Linux**, on a machine that stays on and online.
- **Node.js 20 or newer** (`node -v`). With nvm: `nvm install 20 && nvm use 20`.
- **git**.
- **The catalog v2 Postgres connection string** (Supabase, Neon or any
  Postgres 14+).
- Internet access to `url.publishedprices.co.il`. A corporate or VPN proxy that
  intercepts TLS breaks the portal's certificate check.
- Optional: a GitHub token with `issues: write` on this repo, for failure
  reports.

The SQLite driver ships prebuilt binaries for common platforms. If `npm ci`
tries to compile it and fails, install build tools: `xcode-select --install`
on macOS, or `sudo apt install build-essential python3` on Debian/Ubuntu.

## 1. Clone and install

```bash
git clone https://github.com/idolago94/israeli-supermarkets-api.git
```
```bash
cd israeli-supermarkets-api
```
```bash
npm ci
```
```bash
cd sync-service && npm ci
```

Both installs are needed. The service imports the shared code in `../lib`,
which resolves its own packages (`postgres`, `undici`) from the repo root.

**Check:** `npm run doctor` shows ✓ for "Node.js", "repo-root dependencies"
and "SQLite driver". The `.env` and database checks fail until steps 2 and 3.

All later commands run from `sync-service/`.

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env` and set at least:

```ini
SYNC_DATABASE_URL=postgres://user:password@host:5432/postgres
```

- **Supabase:** use the direct connection or the session pooler (port 5432).
  If you can only use the transaction pooler (port 6543), also set
  `SYNC_PG_PREPARE=false`.
- **Failure reports to GitHub (optional):** set `SYNC_ISSUES_GITHUB_TOKEN` and
  `SYNC_ISSUES_GITHUB_REPO=idolago94/israeli-supermarkets-api`.
- Everything else has a working default, listed in `.env.example`: port 4100,
  data in `sync-service/data/`, `Asia/Jerusalem` schedule, and all 4 chains.

`.env` is gitignored. Never commit it.

**Check:** `npm run doctor` shows ✓ for ".env exists", "configuration is
valid", "SYNC_DATABASE_URL is set" and "target database reachable".

## 3. Prepare the database

```bash
npm run migrate
```

This applies every file in `../supabase/migrations/` in order: the catalog v2
schema, and the per-branch delta-cursor columns the service needs. Each file
can be re-run safely, so this is fine on a database that already has the
schema.

**Check:** `npm run doctor` shows ✓ for "catalog v2 tables and the
delta-cursor columns exist".

## 4. First run, in the foreground

```bash
npm run doctor
```

Every required check should pass (✓). Items marked `!` are optional. Then:

```bash
npm start
```

1. Open http://localhost:4100.
2. Under **Start a run**, choose **Branch list only** and start it. In under a
   minute, each chain should show **Succeeded**.
3. Start a **Full** run. The first one downloads every branch of every chain,
   which takes a while. Later runs skip branches that haven't changed. Watch
   the grid: failed branches turn red, and clicking one shows the step, the
   error and the logs.
4. When the full run ends (`succeeded` or `partial`), the catalog has data.

Stop it with Ctrl+C. A run that was interrupted resumes on the next start.

**Check:** the first full run finished, and the dashboard's run page shows
branches written.

## 5. Install as a background service

This makes it start at boot or login and restart if it crashes.

**macOS (launchd):**

```bash
./deploy/install-macos.sh
```

**Linux (systemd user unit):**

```bash
./deploy/install-linux.sh
```

The scripts record the absolute path of the current `node`. If you later
switch Node versions (nvm), run the script again.

**Check:** `npm run doctor` reports "service status — running". The dashboard
opens at http://localhost:4100 without running `npm start`.

From now on the schedule runs by itself (`Asia/Jerusalem`): deltas every hour
except 03:00, the branch list at 02:30, and the full sync at 03:00.

## Day-to-day

| Task | macOS | Linux |
|---|---|---|
| Service logs | `tail -f data/service.log` | `journalctl --user -u catalog-sync -f` |
| Restart | `launchctl kickstart -k gui/$(id -u)/com.catalog.sync-service` | `systemctl --user restart catalog-sync` |
| Stop | `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.catalog.sync-service.plist` | `systemctl --user stop catalog-sync` |
| Uninstall | stop, then `rm ~/Library/LaunchAgents/com.catalog.sync-service.plist` | `systemctl --user disable --now catalog-sync && rm ~/.config/systemd/user/catalog-sync.service` |
| Health | `npm run doctor`, or `curl localhost:4100/api/health` | same |

Run history, logs and raw files are on the dashboard: Runs, Logs, Trends,
Schedule. The data itself is in `sync-service/data/`; back that folder up if
you want to keep the history.

## Updating

```bash
git pull
```
```bash
npm ci && (cd sync-service && npm ci)
```

Run that from the repo root. Then, in `sync-service/`:

```bash
npm run migrate
```

Then restart the service (see the table above) and run `npm run doctor`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module 'postgres'` or `'undici'` | Run `npm ci` in the **repo root**, not only in `sync-service/`. |
| `better-sqlite3` error mentioning `NODE_MODULE_VERSION` | Node version changed since install: `npm rebuild better-sqlite3`, then re-run the install script from step 5. |
| `SYNC_DATABASE_URL (or DATABASE_URL) is not set` | Step 2: set it in `sync-service/.env`. |
| `column "last_delta_ts" does not exist` | Step 3: `npm run migrate`. |
| `prepared statement … already exists` | You're on Supabase's transaction pooler: set `SYNC_PG_PREPARE=false`, or use port 5432. |
| Every chain fails at `login` with a certificate error | TLS to the portal is being intercepted (VPN or corporate proxy). Run the service on a network without one. |
| `another sync service (pid …) is already using …` | It's already running as a background service. Use that one, or stop it first. |
| Port 4100 in use | Set `SYNC_PORT` in `.env`, then restart. |
| A branch keeps failing | Open it in the dashboard: step, error, stack and logs are there. **Replay from file (dry run)** reproduces it from the saved file without downloading again. |
| Dashboard warns that no hourly sync completed | Check the service is running (`npm run doctor`) and look at the last runs' errors. |

## Commands (in `sync-service/`)

| Command | What it does |
|---|---|
| `npm run doctor` | Checks the whole setup and prints fixes |
| `npm run migrate` | Applies the catalog v2 migrations to `SYNC_DATABASE_URL` |
| `npm start` | Runs the service in the foreground (dashboard on `SYNC_PORT`) |
| `npm run demo` | The dashboard with simulated data, on port 4199. No database or network needed |
| `npm test` | Tests. Set `SYNC_TEST_DATABASE_URL` to a **scratch** database to include the Postgres ones, which truncate the catalog tables |
| `npm run build` | Type check |
