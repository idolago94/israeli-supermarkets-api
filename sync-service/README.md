# Catalog sync service

A long-running service that syncs the catalog from the Cerberus portal into the
v2 Postgres catalog. It runs on a machine you own instead of on Vercel, so
there's no 300-second limit, and every run, step, and log line is kept in a
local SQLite database with a dashboard on top.

It lives in this repo and imports the existing portal client and parsers from
`../lib`. It has its own `package.json`, so its dependencies (SQLite, the
scheduler) never reach the Vercel deployment (`.vercelignore` excludes this
folder).

## Run it

**Setting it up on a new machine:** follow [SETUP.md](SETUP.md). It goes step
by step, with a check after each step. `npm run doctor` verifies the whole
setup and prints a fix for anything missing. The short version:

```bash
npm ci                      # in the repo root: lib/ needs postgres and undici
cd sync-service && npm ci
cp .env.example .env        # set SYNC_DATABASE_URL at least
npm start                   # dashboard at http://localhost:4100
```

Before the first run, run `npm run migrate`. It applies the catalog v2
migrations to `SYNC_DATABASE_URL`, including the per-branch delta cursor the
service needs.

To keep it running across reboots and crashes:

```bash
./deploy/install-macos.sh   # launchd agent (macOS)
./deploy/install-linux.sh   # systemd user unit (Linux)
```

To look around the dashboard without a database or network access, run
`npm run demo`. It runs the real engine against a simulated portal and an
in-memory catalog on http://localhost:4199.

## How a run works

A run has three levels: **run → chain → branch**. The branch is the unit of
work: each branch of each chain is its own task with its own status, retries,
and logs.

| Level | Steps |
|---|---|
| Chain | `login` → `stores-file` (refresh the branch list) → `list-files` → one task per branch |
| Branch | `head-check` → `download` → `decompress` → `parse` → `validate` → `write-db` → `finalize` |
| Chain, at the end | `recompute-names`: name and keywords, once, for the products this chain touched |

- **Chains run in parallel.** Inside a chain, `SYNC_BRANCH_CONCURRENCY`
  branches run at once (default 3).
- **Each step has a timeout.** A hung request is aborted and frees its slot.
- **Each branch is written in one transaction** (`lib/v2Writer.ts`), so either
  the whole branch lands or none of it does.
- **Isolation.** A failing branch fails only that branch. A failing login or
  file list fails only that chain. A run ends `succeeded`, `partial` (some
  branches or chains failed), or `failed` (no chain succeeded).
- **Retries.** Transient errors (network, 5xx, 429, timeouts, a dropped or
  deadlocked DB connection) are retried with exponential backoff and jitter,
  up to `SYNC_MAX_ATTEMPTS`. Permanent errors (a corrupt file, a parse or
  validation failure, a 4xx) fail the branch at once. An expired session logs
  in again and retries the step, which doesn't count as an attempt.
- **Circuit breaker.** When more than `SYNC_BREAKER_THRESHOLD` of a chain's
  finished branches have failed, that chain stops and its remaining branches
  are cancelled. Other chains carry on.
- **Validation before writing.** A full file needs at least
  `SYNC_MIN_ITEMS_FULL` items and may not drop more than
  `SYNC_MAX_ITEM_DROP_RATIO` against the branch's previous good file. In any
  file, absurd prices may make up only a small share. A file that fails is not
  written, so the good data stays.
- **No wasted downloads.** In a full run, a branch whose file has the same HEAD
  signature as the one already written is `skipped`. In a deltas run, each
  branch gets only the `Price` files newer than its cursor, applied oldest
  first. A delta upserts the rows in the file and deletes nothing.

### Run types and schedule

All times are `Asia/Jerusalem`, so daylight saving is handled by the cron
library, not by shifting UTC by hand.

| Run | Default pattern | What it does |
|---|---|---|
| `stores` | `30 2 * * *` | Refreshes every chain's branch list |
| `full` | `0 3 * * *` | Every branch's `PriceFull`; unchanged branches are skipped |
| `deltas` | `0 0-2,4-23 * * *` | The intraday `Price` files, hourly except at 03:00 |

Patterns can be edited and schedules paused from the dashboard (the
`schedules` table). Only one run happens at a time. A run that falls due while
another is going is recorded as `skipped` with an overlap reason. If the
machine was asleep, the missed occurrences start one run when it wakes. When
several fall due at once, `full` takes precedence over `stores`, which takes
precedence over `deltas`.

### Durability

The task queue is the `branch_tasks` table, not memory. If the process dies,
the next start puts any task left `running` back in the queue and resumes the
run. A recovered task reprocesses instead of trusting the change check. A
delta that was committed just before the crash is not applied twice, because
the branch cursor is re-checked inside the write transaction. A second
instance using the same data directory refuses to start.

## Dashboard

- **Runs:** the run in progress with progress per chain, the next scheduled
  run, recent runs, and a form to start one (type, chains, reprocess
  unchanged).
- **Run:** a grid of chains × branches colored by status, the chain-level steps
  with durations, and the failed branches with their errors. You can cancel
  the run, retry what failed, or retry a single chain.
- **Branch:** a timeline of steps per attempt, the error and stack, its logs,
  the saved raw files, and the branch's history. You can retry the branch, or
  replay it from the saved file, either as a dry run that stops after
  validation or as a real write.
- **Logs:** filter by level, run, chain, task, and step, and search the text.
- **Trends:** duration per run, failed branches per chain per day, and the
  branches that fail most.
- **Schedule:** edit patterns, pause, and resume.

Updates arrive live over SSE. The dashboard warns when no hourly sync has
completed in 2 hours, when no full sync has completed in 26, or when a run has
been going for more than 45 minutes. "Completed" means succeeded or partial.

The server binds to `127.0.0.1` and has no login. It rejects requests whose
`Host` isn't this machine, and state-changing requests without the
`x-sync-dashboard` header, so other web pages open in your browser can't drive
it. Don't expose it on a network without putting authentication in front.

## Data kept

`data/sync.db` (SQLite, WAL mode):

| Table | Holds |
|---|---|
| `runs` | Type, trigger (schedule/manual/retry/replay), status, timing, summary |
| `chain_jobs` | One per chain in a run: status, phase, error |
| `branch_tasks` | One per branch: status, attempts, files, HEAD signature, metrics, error (the queue) |
| `steps` | Every step: level, name, status, timing, attempt, error, stack, metrics |
| `logs` | Structured log lines linked to run, chain, branch, and step |
| `raw_files` | Where each downloaded file was saved |
| `touched_products` | Products to recompute when a chain finishes |
| `schedules`, `service_state` | Schedule, heartbeat |

`data/raw/<day>/run-<id>/<chain>/` holds every downloaded file exactly as
served (compressed). Runs and logs are kept for 90 days, raw files for 14
(`SYNC_RETENTION_DAYS`, `SYNC_RAW_RETENTION_DAYS`). Cleanup runs every 6 hours.

## Failure notifications

When a run ends `partial` or `failed`, the service opens or updates GitHub
issues through `lib/githubIssues.ts`. That is one issue per distinct problem,
deduplicated by fingerprint, with flow `local-<type>` and a link to the run in
the dashboard. Set `SYNC_ISSUES_GITHUB_TOKEN` and `SYNC_ISSUES_GITHUB_REPO` to
turn it on.

## Tests

```bash
npm test
SYNC_TEST_DATABASE_URL=postgres://… npm test   # also runs lib/v2Writer.ts against Postgres
```

The Postgres tests truncate the catalog tables, so point them at a scratch
database with the migrations applied. The engine tests use an in-memory portal
and catalog (`tests/fakes.ts`) with injectable failures: corrupt files,
transient and HTTP errors, expired sessions, hung requests, and write
deadlocks.

## Cutover

Run the service alongside the current setup for a week. Then turn off the
GitHub Actions workflow (`.github/workflows/catalog-sync.yml`) and the
`/api/sync/*` and `/api/v2/sync/*` endpoints, leaving Vercel with only the read
API.
