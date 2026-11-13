import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

// ─── Local SQLite database ──────────────────────────────────────────────────────
//
// The service's own state: the run history (runs → chain_jobs → branch_tasks
// → steps), structured logs, the schedule, and the durable task queue (which
// is just branch_tasks.status + next_attempt_at). Timestamps are epoch
// milliseconds (INTEGER) so they compare and subtract without parsing.
//
// WAL mode lets the dashboard read while the engine writes. Migrations are
// applied in order and tracked with PRAGMA user_version.

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  // 1 — initial schema
  `
  create table runs (
    id integer primary key,
    type text not null check (type in ('full', 'deltas', 'stores')),
    trigger text not null check (trigger in ('schedule', 'manual', 'retry', 'replay')),
    status text not null,
    params text not null default '{}',
    parent_run_id integer references runs (id) on delete set null,
    schedule_name text,
    scheduled_for integer,
    reason text,
    error text,
    summary text not null default '{}',
    cancel_requested integer not null default 0,
    notified integer not null default 0,
    created_at integer not null,
    started_at integer,
    finished_at integer,
    duration_ms integer
  );
  create index runs_created_idx on runs (created_at desc);
  create index runs_status_idx on runs (status);
  create index runs_type_status_idx on runs (type, status, finished_at desc);

  create table chain_jobs (
    id integer primary key,
    run_id integer not null references runs (id) on delete cascade,
    chain_id text not null,
    status text not null,
    -- 'chain' = chain-level steps still to run; 'branches' = branch tasks are
    -- enqueued (a resumed job skips straight to processing them); 'done'.
    phase text not null default 'chain',
    current_step text,
    attempts integer not null default 0,
    error text,
    error_stage text,
    stack text,
    summary text not null default '{}',
    started_at integer,
    finished_at integer,
    duration_ms integer,
    unique (run_id, chain_id)
  );
  create index chain_jobs_run_idx on chain_jobs (run_id);

  create table branch_tasks (
    id integer primary key,
    run_id integer not null references runs (id) on delete cascade,
    chain_job_id integer not null references chain_jobs (id) on delete cascade,
    chain_id text not null,
    store_code text not null,
    status text not null,
    attempts integer not null default 0,
    next_attempt_at integer not null default 0,
    -- Ordered list of files this task processes (one PriceFull, or a
    -- branch's pending Price deltas oldest first), JSON array.
    files text not null default '[]',
    head_size text,
    head_modified text,
    item_count integer,
    metrics text not null default '{}',
    current_step text,
    skip_reason text,
    error text,
    error_stage text,
    error_kind text,
    stack text,
    force integer not null default 0,
    dry_run integer not null default 0,
    -- Set when the task was found 'running' after a crash: it then always
    -- reprocesses instead of trusting the change check.
    recovered integer not null default 0,
    replay_of integer references branch_tasks (id) on delete set null,
    created_at integer not null,
    started_at integer,
    finished_at integer,
    duration_ms integer,
    updated_at integer not null
  );
  create index branch_tasks_queue_idx on branch_tasks (chain_job_id, status, next_attempt_at);
  create index branch_tasks_run_idx on branch_tasks (run_id);
  create index branch_tasks_store_idx on branch_tasks (chain_id, store_code, status, finished_at desc);

  create table steps (
    id integer primary key,
    run_id integer not null references runs (id) on delete cascade,
    chain_job_id integer references chain_jobs (id) on delete cascade,
    branch_task_id integer references branch_tasks (id) on delete cascade,
    level text not null check (level in ('run', 'chain', 'branch')),
    name text not null,
    status text not null,
    attempt integer not null default 1,
    file text,
    started_at integer not null,
    finished_at integer,
    duration_ms integer,
    error text,
    stack text,
    metrics text not null default '{}'
  );
  create index steps_task_idx on steps (branch_task_id);
  create index steps_chain_idx on steps (chain_job_id, level);
  create index steps_run_idx on steps (run_id);

  create table logs (
    id integer primary key,
    ts integer not null,
    level text not null,
    msg text not null,
    context text not null default '{}',
    run_id integer references runs (id) on delete cascade,
    chain_job_id integer,
    branch_task_id integer,
    step_id integer,
    chain_id text,
    step_name text
  );
  create index logs_ts_idx on logs (ts desc);
  create index logs_run_idx on logs (run_id, id);
  create index logs_task_idx on logs (branch_task_id, id);

  create table raw_files (
    id integer primary key,
    run_id integer not null references runs (id) on delete cascade,
    branch_task_id integer references branch_tasks (id) on delete cascade,
    chain_id text not null,
    store_code text,
    file text not null,
    path text not null,
    size integer not null,
    created_at integer not null,
    deleted_at integer
  );
  create index raw_files_task_idx on raw_files (branch_task_id);
  create index raw_files_created_idx on raw_files (created_at);

  -- Products whose price rows changed in a chain job; their name/keywords are
  -- recomputed once when the chain job finishes. Durable, so a crash between
  -- branch writes and the recompute doesn't lose them.
  create table touched_products (
    chain_job_id integer not null references chain_jobs (id) on delete cascade,
    product_id integer not null,
    primary key (chain_job_id, product_id)
  ) without rowid;

  create table schedules (
    name text primary key,
    run_type text not null,
    cron text not null,
    paused integer not null default 0,
    priority integer not null default 0,
    last_fired_at integer,
    updated_at integer not null
  );

  create table service_state (
    key text primary key,
    value text not null,
    updated_at integer not null
  );
  `,
];

/** Default schedule (Asia/Jerusalem): branch list at 02:30, full at 03:00,
 *  deltas every other hour on the hour. Priority decides which one runs when
 *  several fall due at once (after the machine wakes up). */
export const DEFAULT_SCHEDULES = [
  { name: 'stores', runType: 'stores', cron: '30 2 * * *', priority: 1 },
  { name: 'full', runType: 'full', cron: '0 3 * * *', priority: 2 },
  { name: 'deltas', runType: 'deltas', cron: '0 0-2,4-23 * * *', priority: 0 },
] as const;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: DB, now: number = Date.now()): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  const insert = db.prepare(
    `insert into schedules (name, run_type, cron, priority, last_fired_at, updated_at)
     values (?, ?, ?, ?, ?, ?) on conflict (name) do nothing`,
  );
  for (const s of DEFAULT_SCHEDULES) insert.run(s.name, s.runType, s.cron, s.priority, now, now);
}
