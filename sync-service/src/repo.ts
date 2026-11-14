import { EventEmitter } from 'events';
import type { DB } from './db';

// ─── Data access ──────────────────────────────────────────────────────────────
//
// Every SQL statement against the local database lives here. Writes that the
// dashboard cares about also emit a 'change' event on `bus`, which the server
// forwards to browsers over SSE.

export type RunType = 'full' | 'deltas' | 'stores';
export type RunTrigger = 'schedule' | 'manual' | 'retry' | 'replay';
export type RunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'skipped';
export type ChainStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
export type TaskStatus = 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'skipped' | 'failed' | 'cancelled';
export type StepStatus = 'running' | 'succeeded' | 'failed' | 'skipped';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const RUN_TYPES: RunType[] = ['stores', 'full', 'deltas'];
export const TERMINAL_TASK: TaskStatus[] = ['succeeded', 'skipped', 'failed', 'cancelled'];

export interface RunParams {
  /** Only these chains (default: every configured chain). */
  chains?: string[];
  /** Only these branches, per chain. A chain absent here runs every branch. */
  stores?: Record<string, string[]>;
  /** Reprocess branches even if their file hasn't changed. */
  force?: boolean;
  /** Replay: the task whose raw files are reprocessed. */
  replayOf?: number;
  /** Replay without writing to the target DB. */
  dryRun?: boolean;
}

export interface RunRow {
  id: number;
  type: RunType;
  trigger: RunTrigger;
  status: RunStatus;
  params: string;
  parent_run_id: number | null;
  schedule_name: string | null;
  scheduled_for: number | null;
  reason: string | null;
  error: string | null;
  summary: string;
  cancel_requested: number;
  notified: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
}

export interface ChainJobRow {
  id: number;
  run_id: number;
  chain_id: string;
  status: ChainStatus;
  phase: 'chain' | 'branches' | 'done';
  current_step: string | null;
  attempts: number;
  error: string | null;
  error_stage: string | null;
  stack: string | null;
  summary: string;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
}

export interface TaskRow {
  id: number;
  run_id: number;
  chain_job_id: number;
  chain_id: string;
  store_code: string;
  status: TaskStatus;
  attempts: number;
  next_attempt_at: number;
  files: string;
  head_size: string | null;
  head_modified: string | null;
  item_count: number | null;
  metrics: string;
  current_step: string | null;
  skip_reason: string | null;
  error: string | null;
  error_stage: string | null;
  error_kind: string | null;
  stack: string | null;
  force: number;
  dry_run: number;
  recovered: number;
  replay_of: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  updated_at: number;
}

export interface StepRow {
  id: number;
  run_id: number;
  chain_job_id: number | null;
  branch_task_id: number | null;
  level: 'run' | 'chain' | 'branch';
  name: string;
  status: StepStatus;
  attempt: number;
  file: string | null;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  error: string | null;
  stack: string | null;
  metrics: string;
}

export interface LogRow {
  id: number;
  ts: number;
  level: LogLevel;
  msg: string;
  context: string;
  run_id: number | null;
  chain_job_id: number | null;
  branch_task_id: number | null;
  step_id: number | null;
  chain_id: string | null;
  step_name: string | null;
}

export interface RawFileRow {
  id: number;
  run_id: number;
  branch_task_id: number | null;
  chain_id: string;
  store_code: string | null;
  file: string;
  path: string;
  size: number;
  created_at: number;
  deleted_at: number | null;
}

export interface ScheduleRow {
  name: string;
  run_type: RunType;
  cron: string;
  paused: number;
  priority: number;
  last_fired_at: number | null;
  updated_at: number;
}

export interface ChangeEvent {
  kind: 'run' | 'chain' | 'task' | 'step' | 'log' | 'schedule';
  runId?: number;
  chainJobId?: number;
  taskId?: number;
}

export interface TaskCounts {
  total: number;
  queued: number;
  running: number;
  retry_wait: number;
  succeeded: number;
  skipped: number;
  failed: number;
  cancelled: number;
}

const EMPTY_COUNTS: TaskCounts = {
  total: 0,
  queued: 0,
  running: 0,
  retry_wait: 0,
  succeeded: 0,
  skipped: 0,
  failed: 0,
  cancelled: 0,
};

/** JSON columns are stored as text; parse them leniently. */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

type Patch = Record<string, unknown>;

function encode(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
}

export class Repo {
  readonly bus = new EventEmitter();

  constructor(readonly db: DB) {
    this.bus.setMaxListeners(100);
  }

  private emit(event: ChangeEvent): void {
    this.bus.emit('change', event);
  }

  private update(table: string, id: number | string, patch: Patch, key = 'id'): void {
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (!keys.length) return;
    if (keys.some((k) => !/^[a-z_]+$/.test(k))) throw new Error(`bad column in patch: ${keys.join(',')}`);
    const sql = `update ${table} set ${keys.map((k) => `${k} = @${k}`).join(', ')} where ${key} = @__id`;
    const params: Record<string, unknown> = { __id: id };
    for (const k of keys) params[k] = encode(patch[k]);
    this.db.prepare(sql).run(params);
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ─── runs ───────────────────────────────────────────────────────────────────

  createRun(input: {
    type: RunType;
    trigger: RunTrigger;
    status: RunStatus;
    params?: RunParams;
    parentRunId?: number | null;
    scheduleName?: string | null;
    scheduledFor?: number | null;
    reason?: string | null;
    now: number;
  }): number {
    const finished = input.status === 'skipped';
    const id = Number(
      this.db
        .prepare(
          `insert into runs (type, trigger, status, params, parent_run_id, schedule_name, scheduled_for, reason,
             created_at, started_at, finished_at, duration_ms)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.type,
          input.trigger,
          input.status,
          JSON.stringify(input.params ?? {}),
          input.parentRunId ?? null,
          input.scheduleName ?? null,
          input.scheduledFor ?? null,
          input.reason ?? null,
          input.now,
          finished ? null : input.now,
          finished ? input.now : null,
          finished ? 0 : null,
        ).lastInsertRowid,
    );
    this.emit({ kind: 'run', runId: id });
    return id;
  }

  getRun(id: number): RunRow | undefined {
    return this.db.prepare('select * from runs where id = ?').get(id) as RunRow | undefined;
  }

  updateRun(id: number, patch: Partial<Record<keyof RunRow, unknown>>): void {
    this.update('runs', id, patch as Patch);
    this.emit({ kind: 'run', runId: id });
  }

  activeRun(): RunRow | undefined {
    return this.db.prepare(`select * from runs where status = 'running' order by id limit 1`).get() as RunRow | undefined;
  }

  listRuns(opts: { limit?: number; before?: number; type?: string; status?: string } = {}): RunRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.before) {
      where.push('id < ?');
      params.push(opts.before);
    }
    if (opts.type) {
      where.push('type = ?');
      params.push(opts.type);
    }
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    params.push(Math.min(opts.limit ?? 50, 500));
    return this.db
      .prepare(`select * from runs ${where.length ? `where ${where.join(' and ')}` : ''} order by id desc limit ?`)
      .all(...params) as RunRow[];
  }

  /** The newest finished run of `type` whose status is one of `statuses`. */
  lastRun(types: RunType[], statuses: RunStatus[]): RunRow | undefined {
    return this.db
      .prepare(
        `select * from runs where type in (${types.map(() => '?').join(',')})
           and status in (${statuses.map(() => '?').join(',')})
         order by finished_at desc limit 1`,
      )
      .get(...types, ...statuses) as RunRow | undefined;
  }

  // ─── chain jobs ─────────────────────────────────────────────────────────────

  createChainJob(runId: number, chainId: string, phase: ChainJobRow['phase'] = 'chain'): number {
    const id = Number(
      this.db
        .prepare(`insert into chain_jobs (run_id, chain_id, status, phase) values (?, ?, 'queued', ?)`)
        .run(runId, chainId, phase).lastInsertRowid,
    );
    this.emit({ kind: 'chain', runId, chainJobId: id });
    return id;
  }

  getChainJob(id: number): ChainJobRow | undefined {
    return this.db.prepare('select * from chain_jobs where id = ?').get(id) as ChainJobRow | undefined;
  }

  chainJobsForRun(runId: number): ChainJobRow[] {
    return this.db.prepare('select * from chain_jobs where run_id = ? order by chain_id').all(runId) as ChainJobRow[];
  }

  updateChainJob(id: number, patch: Partial<Record<keyof ChainJobRow, unknown>>): void {
    this.update('chain_jobs', id, patch as Patch);
    const row = this.getChainJob(id);
    this.emit({ kind: 'chain', runId: row?.run_id, chainJobId: id });
  }

  // ─── branch tasks (the durable queue) ───────────────────────────────────────

  createTask(input: {
    runId: number;
    chainJobId: number;
    chainId: string;
    storeCode: string;
    files: string[];
    status?: TaskStatus;
    skipReason?: string | null;
    force?: boolean;
    dryRun?: boolean;
    replayOf?: number | null;
    now: number;
  }): number {
    const status = input.status ?? 'queued';
    const terminal = TERMINAL_TASK.includes(status);
    const id = Number(
      this.db
        .prepare(
          `insert into branch_tasks (run_id, chain_job_id, chain_id, store_code, status, files, skip_reason,
             force, dry_run, replay_of, created_at, updated_at, finished_at, duration_ms)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.chainJobId,
          input.chainId,
          input.storeCode,
          status,
          JSON.stringify(input.files),
          input.skipReason ?? null,
          input.force ? 1 : 0,
          input.dryRun ? 1 : 0,
          input.replayOf ?? null,
          input.now,
          input.now,
          terminal ? input.now : null,
          terminal ? 0 : null,
        ).lastInsertRowid,
    );
    return id;
  }

  getTask(id: number): TaskRow | undefined {
    return this.db.prepare('select * from branch_tasks where id = ?').get(id) as TaskRow | undefined;
  }

  tasksForRun(runId: number): TaskRow[] {
    return this.db
      .prepare('select * from branch_tasks where run_id = ? order by chain_id, store_code')
      .all(runId) as TaskRow[];
  }

  tasksForChainJob(chainJobId: number): TaskRow[] {
    return this.db
      .prepare('select * from branch_tasks where chain_job_id = ? order by store_code')
      .all(chainJobId) as TaskRow[];
  }

  updateTask(id: number, patch: Partial<Record<keyof TaskRow, unknown>>, now: number): void {
    this.update('branch_tasks', id, { ...patch, updated_at: now } as Patch);
    const row = this.getTask(id);
    this.emit({ kind: 'task', runId: row?.run_id, chainJobId: row?.chain_job_id, taskId: id });
  }

  /**
   * Atomically takes the next due task of a chain job: the oldest queued or
   * retry_wait task whose next_attempt_at has passed becomes 'running' with
   * its attempt count bumped. Returns undefined when nothing is due.
   */
  claimTask(chainJobId: number, now: number): TaskRow | undefined {
    const row = this.db
      .prepare(
        `update branch_tasks
           set status = 'running', attempts = attempts + 1, started_at = coalesce(started_at, @now),
               updated_at = @now, error = null, error_stage = null, error_kind = null, stack = null
         where id = (
           select id from branch_tasks
           where chain_job_id = @chainJobId and status in ('queued', 'retry_wait') and next_attempt_at <= @now
           order by next_attempt_at, id limit 1
         )
         returning *`,
      )
      .get({ chainJobId, now }) as TaskRow | undefined;
    if (row) this.emit({ kind: 'task', runId: row.run_id, chainJobId, taskId: row.id });
    return row;
  }

  /** Earliest next_attempt_at among a chain job's pending tasks; undefined
   *  when none are pending. */
  nextDueAt(chainJobId: number): number | undefined {
    const row = this.db
      .prepare(
        `select min(next_attempt_at) as t from branch_tasks
         where chain_job_id = ? and status in ('queued', 'retry_wait')`,
      )
      .get(chainJobId) as { t: number | null };
    return row.t ?? undefined;
  }

  /** Marks a chain job's (or run's) unfinished tasks cancelled. */
  cancelPendingTasks(scope: { chainJobId?: number; runId?: number }, reason: string, now: number): number {
    const col = scope.chainJobId != null ? 'chain_job_id' : 'run_id';
    const id = scope.chainJobId ?? scope.runId;
    const res = this.db
      .prepare(
        `update branch_tasks set status = 'cancelled', skip_reason = ?, finished_at = ?, updated_at = ?,
           duration_ms = case when started_at is null then 0 else ? - started_at end
         where ${col} = ? and status in ('queued', 'retry_wait')`,
      )
      .run(reason, now, now, now, id);
    if (res.changes) this.emit({ kind: 'task', runId: scope.runId, chainJobId: scope.chainJobId });
    return res.changes;
  }

  /** After a crash: anything left 'running' goes back to the queue, flagged so
   *  it reprocesses instead of trusting the change check. Open steps close as
   *  failed. Returns how many tasks were requeued. */
  recoverInterrupted(now: number): { tasks: number; steps: number } {
    return this.tx(() => {
      const tasks = this.db
        .prepare(
          `update branch_tasks set status = 'queued', recovered = 1, next_attempt_at = 0, current_step = null,
             updated_at = ? where status = 'running'`,
        )
        .run(now).changes;
      const steps = this.db
        .prepare(
          `update steps set status = 'failed', finished_at = ?, duration_ms = ? - started_at,
             error = 'interrupted: the service stopped while this step was running'
           where status = 'running'`,
        )
        .run(now, now).changes;
      return { tasks, steps };
    });
  }

  taskCounts(scope: { runId?: number; chainJobId?: number }): TaskCounts {
    const col = scope.chainJobId != null ? 'chain_job_id' : 'run_id';
    const rows = this.db
      .prepare(`select status, count(*) as n from branch_tasks where ${col} = ? group by status`)
      .all(scope.chainJobId ?? scope.runId) as { status: TaskStatus; n: number }[];
    const counts = { ...EMPTY_COUNTS };
    for (const r of rows) {
      counts[r.status] = r.n;
      counts.total += r.n;
    }
    return counts;
  }

  /** Item count of the branch's newest successful full file before `runId`. */
  previousFullItemCount(chainId: string, storeCode: string, runId: number): number | undefined {
    const row = this.db
      .prepare(
        `select t.item_count from branch_tasks t join runs r on r.id = t.run_id
         where t.chain_id = ? and t.store_code = ? and t.status = 'succeeded' and r.type = 'full'
           and t.item_count is not null and t.run_id < ? and t.dry_run = 0
         order by t.finished_at desc limit 1`,
      )
      .get(chainId, storeCode, runId) as { item_count: number } | undefined;
    return row?.item_count;
  }

  // ─── steps ──────────────────────────────────────────────────────────────────

  startStep(input: {
    runId: number;
    chainJobId?: number | null;
    taskId?: number | null;
    level: StepRow['level'];
    name: string;
    attempt: number;
    file?: string | null;
    now: number;
  }): number {
    const id = Number(
      this.db
        .prepare(
          `insert into steps (run_id, chain_job_id, branch_task_id, level, name, status, attempt, file, started_at)
           values (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.chainJobId ?? null,
          input.taskId ?? null,
          input.level,
          input.name,
          input.attempt,
          input.file ?? null,
          input.now,
        ).lastInsertRowid,
    );
    this.emit({ kind: 'step', runId: input.runId, chainJobId: input.chainJobId ?? undefined, taskId: input.taskId ?? undefined });
    return id;
  }

  finishStep(
    id: number,
    patch: { status: StepStatus; error?: string | null; stack?: string | null; metrics?: Record<string, unknown> },
    now: number,
  ): void {
    const row = this.db.prepare('select run_id, chain_job_id, branch_task_id, started_at from steps where id = ?').get(id) as
      | { run_id: number; chain_job_id: number | null; branch_task_id: number | null; started_at: number }
      | undefined;
    if (!row) return;
    this.update('steps', id, {
      status: patch.status,
      error: patch.error ?? null,
      stack: patch.stack ?? null,
      metrics: patch.metrics ?? {},
      finished_at: now,
      duration_ms: now - row.started_at,
    });
    this.emit({
      kind: 'step',
      runId: row.run_id,
      chainJobId: row.chain_job_id ?? undefined,
      taskId: row.branch_task_id ?? undefined,
    });
  }

  /** Records a step that didn't run (e.g. download on a replay). */
  skippedStep(input: Parameters<Repo['startStep']>[0], reason: string): number {
    const id = this.startStep(input);
    this.finishStep(id, { status: 'skipped', metrics: { reason } }, input.now);
    return id;
  }

  stepsForTask(taskId: number): StepRow[] {
    return this.db.prepare('select * from steps where branch_task_id = ? order by id').all(taskId) as StepRow[];
  }

  chainSteps(chainJobId: number): StepRow[] {
    return this.db
      .prepare(`select * from steps where chain_job_id = ? and level = 'chain' order by id`)
      .all(chainJobId) as StepRow[];
  }

  // ─── logs ───────────────────────────────────────────────────────────────────

  insertLog(row: Omit<LogRow, 'id'>): void {
    this.db
      .prepare(
        `insert into logs (ts, level, msg, context, run_id, chain_job_id, branch_task_id, step_id, chain_id, step_name)
         values (@ts, @level, @msg, @context, @run_id, @chain_job_id, @branch_task_id, @step_id, @chain_id, @step_name)`,
      )
      .run(row);
    if (row.run_id != null) this.emit({ kind: 'log', runId: row.run_id, taskId: row.branch_task_id ?? undefined });
  }

  queryLogs(filter: {
    level?: LogLevel;
    runId?: number;
    chainId?: string;
    taskId?: number;
    step?: string;
    q?: string;
    before?: number;
    limit?: number;
  }): LogRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.level) {
      const levels = (['debug', 'info', 'warn', 'error'] as LogLevel[]).slice(
        ['debug', 'info', 'warn', 'error'].indexOf(filter.level),
      );
      where.push(`level in (${levels.map(() => '?').join(',')})`);
      params.push(...levels);
    }
    if (filter.runId != null) {
      where.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter.chainId) {
      where.push('chain_id = ?');
      params.push(filter.chainId);
    }
    if (filter.taskId != null) {
      where.push('branch_task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.step) {
      where.push('step_name = ?');
      params.push(filter.step);
    }
    if (filter.q) {
      where.push(`(msg like ? escape '\\' or context like ? escape '\\')`);
      const like = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    if (filter.before) {
      where.push('id < ?');
      params.push(filter.before);
    }
    params.push(Math.min(filter.limit ?? 200, 1000));
    return this.db
      .prepare(`select * from logs ${where.length ? `where ${where.join(' and ')}` : ''} order by id desc limit ?`)
      .all(...params) as LogRow[];
  }

  // ─── raw files ──────────────────────────────────────────────────────────────

  insertRawFile(input: Omit<RawFileRow, 'id' | 'deleted_at'>): number {
    return Number(
      this.db
        .prepare(
          `insert into raw_files (run_id, branch_task_id, chain_id, store_code, file, path, size, created_at)
           values (@run_id, @branch_task_id, @chain_id, @store_code, @file, @path, @size, @created_at)`,
        )
        .run(input).lastInsertRowid,
    );
  }

  rawFilesForTask(taskId: number): RawFileRow[] {
    return this.db.prepare('select * from raw_files where branch_task_id = ? order by id').all(taskId) as RawFileRow[];
  }

  /** The newest kept raw copy of `file` for a task. */
  rawFileFor(taskId: number, file: string): RawFileRow | undefined {
    return this.db
      .prepare('select * from raw_files where branch_task_id = ? and file = ? and deleted_at is null order by id desc limit 1')
      .get(taskId, file) as RawFileRow | undefined;
  }

  getRawFile(id: number): RawFileRow | undefined {
    return this.db.prepare('select * from raw_files where id = ?').get(id) as RawFileRow | undefined;
  }

  // ─── touched products ───────────────────────────────────────────────────────

  addTouchedProducts(chainJobId: number, productIds: number[]): void {
    const stmt = this.db.prepare('insert or ignore into touched_products (chain_job_id, product_id) values (?, ?)');
    this.tx(() => {
      for (const id of productIds) stmt.run(chainJobId, id);
    });
  }

  touchedProducts(chainJobId: number): number[] {
    return (
      this.db.prepare('select product_id from touched_products where chain_job_id = ?').all(chainJobId) as {
        product_id: number;
      }[]
    ).map((r) => r.product_id);
  }

  clearTouchedProducts(chainJobId: number): void {
    this.db.prepare('delete from touched_products where chain_job_id = ?').run(chainJobId);
  }

  // ─── schedules & service state ──────────────────────────────────────────────

  schedules(): ScheduleRow[] {
    return this.db.prepare('select * from schedules order by priority desc, name').all() as ScheduleRow[];
  }

  getSchedule(name: string): ScheduleRow | undefined {
    return this.db.prepare('select * from schedules where name = ?').get(name) as ScheduleRow | undefined;
  }

  updateSchedule(name: string, patch: Partial<Record<keyof ScheduleRow, unknown>>, now: number): void {
    this.update('schedules', name, { ...patch, updated_at: now } as Patch, 'name');
    this.emit({ kind: 'schedule' });
  }

  getState(key: string): string | undefined {
    return (this.db.prepare('select value from service_state where key = ?').get(key) as { value: string } | undefined)
      ?.value;
  }

  setState(key: string, value: string, now: number): void {
    this.db
      .prepare(
        `insert into service_state (key, value, updated_at) values (?, ?, ?)
         on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }
}
