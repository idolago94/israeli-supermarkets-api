import { createReadStream, existsSync, readFileSync, statSync } from 'fs';
import { IncomingMessage, Server, ServerResponse, createServer } from 'http';
import { extname, join, normalize, resolve } from 'path';
import { SERVICE_ROOT, ServiceConfig } from './config';
import { BadRequestError, Engine, RunBusyError } from './engine';
import { errorMessage } from './errors';
import type { Logger } from './logger';
import { healthWarnings, readHeartbeat } from './maintenance';
import type { RawStore } from './rawStore';
import { ChangeEvent, LogLevel, RUN_TYPES, Repo, RunRow, RunType, TaskRow, parseJson } from './repo';
import { Scheduler, validateCron } from './scheduler';

// ─── Dashboard server ──────────────────────────────────────────────────────────
//
// A JSON API plus the static dashboard (public/), on node:http — no framework
// needed for a dozen routes. Live updates go out over SSE (/api/events).
//
// Bound to 127.0.0.1 by default and unauthenticated, so two guards stop a web
// page in the same browser from driving it: the Host header must name this
// machine (blocks DNS rebinding), and state-changing requests must carry the
// custom `x-sync-dashboard` header (a cross-site page can't add one without a
// CORS preflight, which is never answered).

const PUBLIC_DIR = join(SERVICE_ROOT, 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export interface ServerDeps {
  engine: Engine;
  repo: Repo;
  scheduler: Scheduler;
  raw: RawStore;
  config: ServiceConfig;
  log: Logger;
  now?: () => number;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type Handler = (req: IncomingMessage, params: Record<string, string>, query: URLSearchParams) => unknown;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    })}$`,
  );
  return { method, pattern, keys, handler };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

function int(value: string | null | undefined, name: string): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${name} must be a non-negative integer`);
  return n;
}

function runView(run: RunRow) {
  return { ...run, params: parseJson(run.params, {}), summary: parseJson(run.summary, {}) };
}

function taskView(t: TaskRow, full = false) {
  const base = {
    id: t.id,
    run_id: t.run_id,
    chain_job_id: t.chain_job_id,
    chain_id: t.chain_id,
    store_code: t.store_code,
    status: t.status,
    attempts: t.attempts,
    next_attempt_at: t.next_attempt_at,
    current_step: t.current_step,
    skip_reason: t.skip_reason,
    error: t.error && !full ? t.error.slice(0, 300) : t.error,
    error_stage: t.error_stage,
    error_kind: t.error_kind,
    item_count: t.item_count,
    files: parseJson<string[]>(t.files, []),
    metrics: parseJson(t.metrics, {}),
    force: !!t.force,
    dry_run: !!t.dry_run,
    recovered: !!t.recovered,
    replay_of: t.replay_of,
    started_at: t.started_at,
    finished_at: t.finished_at,
    duration_ms: t.duration_ms,
  };
  return full ? { ...base, stack: t.stack, head_size: t.head_size, head_modified: t.head_modified, created_at: t.created_at } : base;
}

export function createDashboardServer(deps: ServerDeps): Server {
  const { engine, repo, scheduler, raw, config, log } = deps;
  const now = deps.now ?? Date.now;
  const db = repo.db;

  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', config.host]);
  try {
    allowedHosts.add(new URL(config.publicUrl).hostname);
  } catch {
    /* ignore */
  }

  const routes: Route[] = [
    route('GET', '/api/overview', () => {
      const active = repo.activeRun();
      const t = now();
      return {
        now: t,
        timezone: config.timezone,
        chains: engine.chains.map((c) => ({ id: c.id, name: c.nameHe })),
        active: active
          ? {
              run: runView(active),
              counts: repo.taskCounts({ runId: active.id }),
              chains: repo.chainJobsForRun(active.id).map((j) => ({
                id: j.id,
                chain_id: j.chain_id,
                status: j.status,
                phase: j.phase,
                current_step: j.current_step,
                counts: repo.taskCounts({ chainJobId: j.id }),
              })),
              elapsed_ms: t - (active.started_at ?? active.created_at),
              long_running: t - (active.started_at ?? active.created_at) > config.longRunWarnMinutes * 60_000,
            }
          : null,
        schedules: scheduler.upcoming(),
        recent: repo.listRuns({ limit: 25 }).map(runView),
        health: { warnings: healthWarnings(repo, config, t), heartbeat: readHeartbeat(repo) ?? null },
        long_run_warn_minutes: config.longRunWarnMinutes,
      };
    }),

    route('GET', '/api/runs', (_req, _p, q) =>
      repo
        .listRuns({
          limit: int(q.get('limit'), 'limit') ?? 50,
          before: int(q.get('before'), 'before'),
          type: q.get('type') || undefined,
          status: q.get('status') || undefined,
        })
        .map(runView),
    ),

    route('GET', '/api/runs/:id', (_req, p) => {
      const id = int(p.id, 'id')!;
      const run = repo.getRun(id);
      if (!run) throw new HttpError(404, `run #${id} not found`);
      const children = db.prepare('select * from runs where parent_run_id = ? order by id').all(id) as RunRow[];
      return {
        run: runView(run),
        parent: run.parent_run_id ? runView(repo.getRun(run.parent_run_id) ?? run) : null,
        children: children.map(runView),
        counts: repo.taskCounts({ runId: id }),
        chains: repo.chainJobsForRun(id).map((j) => ({
          ...j,
          summary: parseJson(j.summary, {}),
          counts: repo.taskCounts({ chainJobId: j.id }),
          steps: repo.chainSteps(j.id).map((s) => ({ ...s, metrics: parseJson(s.metrics, {}) })),
        })),
        tasks: repo.tasksForRun(id).map((t) => taskView(t)),
      };
    }),

    route('GET', '/api/tasks/:id', (_req, p) => {
      const id = int(p.id, 'id')!;
      const task = repo.getTask(id);
      if (!task) throw new HttpError(404, `task #${id} not found`);
      const run = repo.getRun(task.run_id)!;
      const history = db
        .prepare(
          `select t.*, r.type as run_type from branch_tasks t join runs r on r.id = t.run_id
           where t.chain_id = ? and t.store_code = ? order by t.id desc limit 30`,
        )
        .all(task.chain_id, task.store_code) as (TaskRow & { run_type: RunType })[];
      return {
        task: taskView(task, true),
        run: runView(run),
        chain_job: repo.getChainJob(task.chain_job_id),
        steps: repo.stepsForTask(id).map((s) => ({ ...s, metrics: parseJson(s.metrics, {}) })),
        logs: repo.queryLogs({ taskId: id, limit: 1000 }).reverse(),
        raw_files: repo.rawFilesForTask(id).map((f) => ({ ...f, available: !f.deleted_at && raw.exists(f.path) })),
        replays: (db.prepare('select * from branch_tasks where replay_of = ? order by id desc').all(id) as TaskRow[]).map((t) =>
          taskView(t),
        ),
        history: history.map((h) => ({ ...taskView(h), run_type: h.run_type })),
      };
    }),

    route('GET', '/api/logs', (_req, _p, q) => {
      const level = q.get('level') as LogLevel | null;
      if (level && !['debug', 'info', 'warn', 'error'].includes(level)) throw new HttpError(400, 'bad level');
      return repo.queryLogs({
        level: level || undefined,
        runId: int(q.get('run'), 'run'),
        chainId: q.get('chain') || undefined,
        taskId: int(q.get('task'), 'task'),
        step: q.get('step') || undefined,
        q: q.get('q') || undefined,
        before: int(q.get('before'), 'before'),
        limit: int(q.get('limit'), 'limit') ?? 200,
      });
    }),

    route('GET', '/api/trends', (_req, _p, q) => {
      const days = Math.min(int(q.get('days'), 'days') ?? 30, 365);
      const since = now() - days * 24 * 60 * 60 * 1000;
      const runs = db
        .prepare(
          `select id, type, trigger, status, created_at, duration_ms, summary from runs
           where created_at >= ? and status <> 'skipped' order by id`,
        )
        .all(since) as RunRow[];
      const chains = db
        .prepare(
          `select chain_id, date(created_at / 1000, 'unixepoch', 'localtime') as day,
             count(*) as total,
             sum(case when status = 'failed' then 1 else 0 end) as failed,
             sum(case when status = 'succeeded' then 1 else 0 end) as succeeded,
             sum(case when status = 'skipped' then 1 else 0 end) as skipped
           from branch_tasks where created_at >= ? group by chain_id, day order by day`,
        )
        .all(since);
      const chainJobs = db
        .prepare(
          `select chain_id, count(*) as total, sum(case when status = 'failed' then 1 else 0 end) as failed,
             avg(duration_ms) as avg_duration_ms
           from chain_jobs where started_at >= ? group by chain_id order by chain_id`,
        )
        .all(since);
      const topFailures = db
        .prepare(
          `select chain_id, store_code, count(*) as failures, max(finished_at) as last_failed_at,
             (select error from branch_tasks t2 where t2.chain_id = t.chain_id and t2.store_code = t.store_code
                and t2.status = 'failed' order by t2.id desc limit 1) as last_error
           from branch_tasks t where status = 'failed' and created_at >= ?
           group by chain_id, store_code order by failures desc limit 15`,
        )
        .all(since);
      return { days, runs: runs.map(runView), chains, chain_jobs: chainJobs, top_failures: topFailures };
    }),

    route('GET', '/api/schedules', () => scheduler.upcoming()),

    route('PUT', '/api/schedules/:name', async (req, p) => {
      const schedule = repo.getSchedule(p.name);
      if (!schedule) throw new HttpError(404, `schedule "${p.name}" not found`);
      const body = await readBody(req);
      const patch: Record<string, unknown> = {};
      if (typeof body.cron === 'string') {
        const cron = body.cron.trim();
        try {
          validateCron(cron, config.timezone);
        } catch (err) {
          throw new HttpError(400, `invalid cron pattern: ${errorMessage(err)}`);
        }
        patch.cron = cron;
        // Count from now, so changing the pattern doesn't fire a backlog.
        patch.last_fired_at = now();
      }
      if (typeof body.paused === 'boolean') {
        patch.paused = body.paused ? 1 : 0;
        // Resuming doesn't replay what was missed while paused.
        if (!body.paused) patch.last_fired_at = now();
      }
      repo.updateSchedule(p.name, patch, now());
      log.info(`schedule "${p.name}" updated`, patch);
      return scheduler.upcoming().find((s) => s.name === p.name);
    }),

    route('POST', '/api/runs', async (req) => {
      const body = await readBody(req);
      const type = body.type as RunType;
      if (!RUN_TYPES.includes(type)) throw new HttpError(400, `type must be one of ${RUN_TYPES.join(', ')}`);
      const chains = Array.isArray(body.chains) ? body.chains.map(String) : undefined;
      const id = engine.startRun({
        type,
        trigger: 'manual',
        params: { ...(chains?.length ? { chains } : {}), ...(body.force ? { force: true } : {}) },
        reason: 'started from the dashboard',
      });
      return { runId: id };
    }),

    route('POST', '/api/runs/:id/cancel', (_req, p) => {
      engine.cancel(int(p.id, 'id')!);
      return { ok: true };
    }),
    route('POST', '/api/runs/:id/retry-failed', (_req, p) => ({ runId: engine.retryFailed(int(p.id, 'id')!) })),
    route('POST', '/api/chain-jobs/:id/retry', (_req, p) => ({ runId: engine.retryChainJob(int(p.id, 'id')!) })),
    route('POST', '/api/tasks/:id/retry', (_req, p) => ({ runId: engine.retryTask(int(p.id, 'id')!) })),
    route('POST', '/api/tasks/:id/replay', async (req, p) => {
      const body = await readBody(req);
      return { runId: engine.replayTask(int(p.id, 'id')!, body.dryRun !== false) };
    }),
  ];

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  }

  function serveRaw(res: ServerResponse, id: number): void {
    const row = repo.getRawFile(id);
    if (!row || row.deleted_at || !raw.exists(row.path)) return sendJson(res, 404, { error: 'raw file not available' });
    const abs = raw.resolve(row.path);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': statSync(abs).size,
      'content-disposition': `attachment; filename="${row.file.replace(/[^\w.\-]/g, '_')}"`,
    });
    createReadStream(abs).pipe(res);
  }

  function serveStatic(res: ServerResponse, pathname: string): void {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const abs = resolve(PUBLIC_DIR, normalize(rel));
    if (!abs.startsWith(PUBLIC_DIR) || !existsSync(abs) || !statSync(abs).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(abs)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(readFileSync(abs));
  }

  function serveEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    // Coalesce bursts (a busy run writes many rows a second) into one message
    // every 400ms listing what changed.
    let pending: { kinds: Set<string>; runs: Set<number>; tasks: Set<number> } | null = null;
    const flush = () => {
      if (!pending) return;
      res.write(
        `event: change\ndata: ${JSON.stringify({ kinds: [...pending.kinds], runs: [...pending.runs], tasks: [...pending.tasks] })}\n\n`,
      );
      pending = null;
    };
    const onChange = (e: ChangeEvent) => {
      pending ??= { kinds: new Set(), runs: new Set(), tasks: new Set() };
      pending.kinds.add(e.kind);
      if (e.runId != null) pending.runs.add(e.runId);
      if (e.taskId != null) pending.tasks.add(e.taskId);
    };
    repo.bus.on('change', onChange);
    const flusher = setInterval(flush, 400);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      repo.bus.off('change', onChange);
      clearInterval(flusher);
      clearInterval(keepAlive);
    });
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!allowedHosts.has(hostname)) return sendJson(res, 403, { error: 'host not allowed' });

      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
        return serveStatic(res, url.pathname);
      }
      if (req.method !== 'GET' && req.headers['x-sync-dashboard'] !== '1') {
        return sendJson(res, 403, { error: 'missing x-sync-dashboard header' });
      }
      if (url.pathname === '/api/events' && req.method === 'GET') return serveEvents(req, res);
      if (url.pathname === '/api/health' && req.method === 'GET') {
        const warnings = healthWarnings(repo, config, now());
        return sendJson(res, 200, { ok: !warnings.some((w) => w.level === 'error'), warnings, heartbeat: readHeartbeat(repo) });
      }
      const rawMatch = /^\/api\/raw\/(\d+)$/.exec(url.pathname);
      if (rawMatch && req.method === 'GET') return serveRaw(res, Number(rawMatch[1]));

      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const result = await r.handler(req, params, url.searchParams);
        return sendJson(res, 200, result);
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      if (err instanceof RunBusyError) return sendJson(res, 409, { error: err.message, activeRunId: err.activeRunId });
      if (err instanceof BadRequestError) return sendJson(res, 400, { error: err.message });
      log.error('request failed', { url: req.url, error: errorMessage(err) });
      if (!res.headersSent) sendJson(res, 500, { error: errorMessage(err) });
    }
  });
}
