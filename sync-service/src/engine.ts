import {
  ChainConfig,
  decodeXmlBuffer,
  decompressFileBody,
  filterByStore,
  pickLatestFile,
  storeIdFromFileName,
} from '../../lib/cerberus';
import { dropStaleFiles, latestFilePerStore, planDeltaFiles, validDeltaCursors } from '../../lib/branches';
import { ParsedItem, parsePriceItemsXml } from '../../lib/parse';
import { parseStoresXml } from '../../lib/stores';
import { SyncStage, stageOf, tagStage } from '../../lib/syncFailures';
import type { BranchWriteResult } from '../../lib/v2Writer';
import { CircuitBreaker } from './breaker';
import type { ServiceConfig, StepName } from './config';
import {
  CancelledError,
  PermanentError,
  StepTimeoutError,
  ValidationError,
  backoffMs,
  classifyError,
  errorMessage,
  errorStack,
} from './errors';
import type { Logger } from './logger';
import type { Portal } from './portal';
import type { RawStore } from './rawStore';
import {
  ChainJobRow,
  ChainStatus,
  Repo,
  RunParams,
  RunRow,
  RunStatus,
  RunTrigger,
  RunType,
  StepRow,
  TaskRow,
  parseJson,
} from './repo';
import type { StoreState, Target } from './target';
import { validateItems } from './validate';

// ─── Sync engine ───────────────────────────────────────────────────────────────
//
// A run has three levels: Run → Chain job → Branch task.
//
//   chain  login → stores-file → list-files → enqueue one task per branch
//   branch head-check → download → decompress → parse → validate → write-db → finalize
//
// Chains run in parallel (one worker each), so a slow or broken chain doesn't
// hold up the rest. Inside a chain, `branchConcurrency` branches run at once.
// Each step has its own timeout and is recorded in `steps`. Branch tasks live
// in SQLite (the durable queue): a crash leaves them 'running', and startup
// puts them back to 'queued' and resumes the run where it stopped.
//
// Failure isolation: a branch failure fails that branch; a chain-level
// failure (login, file list) fails that chain; the run ends 'succeeded',
// 'partial' or 'failed' from what its chains did.

export interface StartRunRequest {
  type: RunType;
  trigger: RunTrigger;
  params?: RunParams;
  parentRunId?: number | null;
  scheduleName?: string | null;
  scheduledFor?: number | null;
  reason?: string | null;
}

export interface EngineDeps {
  repo: Repo;
  config: ServiceConfig;
  portal: Portal;
  target: Target;
  raw: RawStore;
  log: Logger;
  /** Chains this service syncs. */
  chains: ChainConfig[];
  now?: () => number;
  /** Called after a run finishes (GitHub notifications). Never throws. */
  onRunFinished?: (run: RunRow) => Promise<void>;
}

/** Another run is in progress. */
export class RunBusyError extends Error {
  constructor(readonly activeRunId: number) {
    super(`run #${activeRunId} is still in progress`);
    this.name = 'RunBusyError';
  }
}

/** A request the engine can't act on (unknown chain, nothing to retry…). */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

type Level = StepRow['level'];

interface StepScope {
  runId: number;
  chainJobId: number;
  taskId?: number;
  level: Level;
  attempt: number;
  log: Logger;
  signal: AbortSignal;
}

interface TaskOutcome {
  status: 'succeeded' | 'skipped';
  skipReason?: string;
  itemCount?: number;
  headSize?: string;
  headModified?: string;
  metrics: TaskMetrics;
}

interface TaskMetrics {
  files: number;
  bytes: number;
  items: number;
  rowsWritten: number;
  rowsDeleted: number;
  priceChanges: number;
  alreadyApplied?: number;
}

/** Everything one chain job's workers share. */
class ChainContext {
  cookie?: string;
  private loginPromise?: Promise<string>;
  private storeStates?: Promise<Map<string, StoreState>>;
  readonly breaker: CircuitBreaker;

  constructor(
    readonly engine: Engine,
    readonly run: RunRow,
    readonly params: RunParams,
    readonly job: ChainJobRow,
    readonly chain: ChainConfig,
    readonly log: Logger,
    readonly signal: AbortSignal,
  ) {
    const { threshold, minSamples } = engine.config.breaker;
    this.breaker = new CircuitBreaker(threshold, minSamples);
  }

  async session(): Promise<string> {
    return this.cookie ?? this.login();
  }

  /** Logs in again unless someone already did since `stale` was handed out. */
  async relogin(stale: string | undefined): Promise<string> {
    if (this.cookie && this.cookie !== stale) return this.cookie;
    this.cookie = undefined;
    this.log.warn('session expired — logging in again');
    return this.login();
  }

  private login(): Promise<string> {
    if (!this.loginPromise) {
      this.loginPromise = this.engine
        .chainStep(this, 'login', (signal) => this.engine.portal.login(this.chain.username, signal), () => ({}))
        .then((cookie) => {
          this.cookie = cookie;
          return cookie;
        })
        .finally(() => {
          this.loginPromise = undefined;
        });
    }
    return this.loginPromise;
  }

  /** The branches' saved file signatures and delta cursors, loaded once. */
  states(): Promise<Map<string, StoreState>> {
    if (!this.storeStates) {
      this.storeStates = this.engine.target.loadStoreStates(this.chain.id).catch((err) => {
        this.storeStates = undefined;
        throw err;
      });
    }
    return this.storeStates;
  }

  invalidateStates(): void {
    this.storeStates = undefined;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Rejects as soon as `signal` aborts, even if `work` never settles — a hung
 *  step frees its slot instead of holding it forever. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function emptyMetrics(): TaskMetrics {
  return { files: 0, bytes: 0, items: 0, rowsWritten: 0, rowsDeleted: 0, priceChanges: 0 };
}

export class Engine {
  readonly repo: Repo;
  readonly config: ServiceConfig;
  readonly portal: Portal;
  readonly target: Target;
  readonly raw: RawStore;
  readonly log: Logger;
  readonly chains: ChainConfig[];
  readonly now: () => number;
  private readonly onRunFinished?: (run: RunRow) => Promise<void>;
  private current?: { runId: number; promise: Promise<void>; abort: AbortController };

  constructor(deps: EngineDeps) {
    this.repo = deps.repo;
    this.config = deps.config;
    this.portal = deps.portal;
    this.target = deps.target;
    this.raw = deps.raw;
    this.log = deps.log;
    this.chains = deps.chains;
    this.now = deps.now ?? Date.now;
    this.onRunFinished = deps.onRunFinished;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  get activeRunId(): number | undefined {
    return this.current?.runId ?? this.repo.activeRun()?.id;
  }

  /** Resolves when the run in progress (if any) has finished. */
  async idle(): Promise<void> {
    while (this.current) await this.current.promise;
  }

  /** Starts a run. Throws RunBusyError if one is already going. */
  startRun(req: StartRunRequest): number {
    const params = req.params ?? {};
    const chains = this.resolveChains(params.chains);
    const runId = this.repo.tx(() => {
      const active = this.repo.activeRun();
      if (active || this.current) throw new RunBusyError(active?.id ?? this.current!.runId);
      const id = this.repo.createRun({
        type: req.type,
        trigger: req.trigger,
        status: 'running',
        params,
        parentRunId: req.parentRunId,
        scheduleName: req.scheduleName,
        scheduledFor: req.scheduledFor,
        reason: req.reason,
        now: this.now(),
      });
      for (const chain of chains) this.repo.createChainJob(id, chain.id);
      return id;
    });
    this.launch(runId);
    return runId;
  }

  /** Records a scheduled run that didn't start because another was running. */
  recordSkipped(req: StartRunRequest, reason: string): number {
    return this.repo.createRun({
      type: req.type,
      trigger: req.trigger,
      status: 'skipped',
      params: req.params,
      scheduleName: req.scheduleName,
      scheduledFor: req.scheduledFor,
      reason,
      now: this.now(),
    });
  }

  /** On startup: requeue tasks a crash left 'running' and resume the run. */
  resumeInterrupted(): number | undefined {
    const recovered = this.repo.recoverInterrupted(this.now());
    const run = this.repo.activeRun();
    if (!run) return undefined;
    this.log.warn('resuming a run interrupted by a restart', { runId: run.id, requeuedTasks: recovered.tasks });
    this.launch(run.id);
    return run.id;
  }

  /** Cancels a running run: no new tasks start, running steps are aborted. */
  cancel(runId: number): void {
    const run = this.repo.getRun(runId);
    if (!run) throw new BadRequestError(`run #${runId} not found`);
    if (run.status !== 'running') throw new BadRequestError(`run #${runId} is not running (${run.status})`);
    this.repo.updateRun(runId, { cancel_requested: 1 });
    if (this.current?.runId === runId) {
      this.current.abort.abort(new CancelledError());
    } else {
      // Not executing in this process (shouldn't happen) — close it out.
      this.repo.cancelPendingTasks({ runId }, 'run cancelled', this.now());
      this.finishRun(runId);
    }
  }

  /** Retries one branch in a new run (reprocessing even if unchanged). */
  retryTask(taskId: number): number {
    const task = this.mustTask(taskId);
    const run = this.mustRun(task.run_id);
    return this.startRun({
      type: run.type,
      trigger: 'retry',
      parentRunId: run.id,
      params: { chains: [task.chain_id], stores: { [task.chain_id]: [task.store_code] }, force: true },
      reason: `retry of branch ${task.chain_id}/${task.store_code} (task #${task.id})`,
    });
  }

  /** Retries a whole chain in a new run. */
  retryChainJob(chainJobId: number): number {
    const job = this.repo.getChainJob(chainJobId);
    if (!job) throw new BadRequestError(`chain job #${chainJobId} not found`);
    const run = this.mustRun(job.run_id);
    return this.startRun({
      type: run.type,
      trigger: 'retry',
      parentRunId: run.id,
      params: { chains: [job.chain_id] },
      reason: `retry of chain ${job.chain_id} from run #${run.id}`,
    });
  }

  /** Retries everything that failed in a run: failed chains whole, failed
   *  branches individually. */
  retryFailed(runId: number): number {
    const run = this.mustRun(runId);
    const jobs = this.repo.chainJobsForRun(runId);
    const chains = new Set<string>();
    const stores: Record<string, string[]> = {};
    const wholeChain = new Set<string>();
    for (const job of jobs) {
      if (job.status === 'failed' || job.status === 'cancelled') {
        chains.add(job.chain_id);
        wholeChain.add(job.chain_id);
      }
    }
    for (const task of this.repo.tasksForRun(runId)) {
      if (task.status !== 'failed' || wholeChain.has(task.chain_id)) continue;
      chains.add(task.chain_id);
      (stores[task.chain_id] ??= []).push(task.store_code);
    }
    if (!chains.size) throw new BadRequestError(`run #${runId} has nothing that failed`);
    return this.startRun({
      type: run.type,
      trigger: 'retry',
      parentRunId: run.id,
      params: { chains: [...chains], ...(Object.keys(stores).length ? { stores } : {}), force: true },
      reason: `retry of what failed in run #${run.id}`,
    });
  }

  /** Reprocesses a branch task from its saved raw files, without contacting
   *  the portal. `dryRun` stops before writing to the target DB. */
  replayTask(taskId: number, dryRun: boolean): number {
    const task = this.mustTask(taskId);
    const run = this.mustRun(task.run_id);
    if (run.type === 'stores') throw new BadRequestError('stores runs have no branch files to replay');
    const files = parseJson<string[]>(task.files, []);
    const missing = files.filter((f) => !this.rawFor(task.id, f));
    if (!files.length || missing.length === files.length) {
      throw new BadRequestError(`task #${taskId} has no saved raw file to replay (expired or never downloaded)`);
    }
    const replayFiles = files.filter((f) => !missing.includes(f));

    const runId = this.repo.tx(() => {
      const active = this.repo.activeRun();
      if (active || this.current) throw new RunBusyError(active?.id ?? this.current!.runId);
      const id = this.repo.createRun({
        type: run.type,
        trigger: 'replay',
        status: 'running',
        parentRunId: run.id,
        params: { chains: [task.chain_id], stores: { [task.chain_id]: [task.store_code] }, replayOf: task.id, dryRun },
        reason: `${dryRun ? 'dry-run ' : ''}replay of task #${task.id} (${task.chain_id}/${task.store_code})`,
        now: this.now(),
      });
      const jobId = this.repo.createChainJob(id, task.chain_id, 'branches');
      this.repo.createTask({
        runId: id,
        chainJobId: jobId,
        chainId: task.chain_id,
        storeCode: task.store_code,
        files: replayFiles,
        force: true,
        dryRun,
        replayOf: task.id,
        now: this.now(),
      });
      return id;
    });
    this.launch(runId);
    return runId;
  }

  // ─── Run ────────────────────────────────────────────────────────────────────

  private launch(runId: number): void {
    const abort = new AbortController();
    const promise = this.executeRun(runId, abort.signal)
      .catch((err) => {
        this.log.error('run crashed', { runId, error: errorMessage(err), stack: errorStack(err) });
        try {
          this.repo.updateRun(runId, { error: errorMessage(err) });
          this.finishRun(runId, 'failed');
        } catch {
          /* already logged */
        }
      })
      .finally(() => {
        if (this.current?.runId === runId) this.current = undefined;
      });
    this.current = { runId, promise, abort };
  }

  private async executeRun(runId: number, signal: AbortSignal): Promise<void> {
    const run = this.mustRun(runId);
    const params = parseJson<RunParams>(run.params, {});
    const log = this.log.child({ runId });
    log.info(`run #${runId} started`, { type: run.type, trigger: run.trigger, params });

    const jobs = this.repo.chainJobsForRun(runId).filter((j) => ['queued', 'running'].includes(j.status));
    await Promise.all(jobs.map((job) => this.executeChain(run, params, job, signal)));

    const finished = this.finishRun(runId);
    log.info(`run #${runId} finished: ${finished.status}`, { durationMs: finished.duration_ms, summary: parseJson(finished.summary, {}) });
    if (this.onRunFinished) await this.onRunFinished(finished).catch(() => {});
  }

  /** Works out the run's final status and summary from its chains. */
  private finishRun(runId: number, forced?: RunStatus): RunRow {
    const run = this.mustRun(runId);
    const jobs = this.repo.chainJobsForRun(runId);
    const counts = this.repo.taskCounts({ runId });
    const byStatus: Record<string, number> = {};
    for (const j of jobs) byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;

    const totals = emptyMetrics();
    for (const j of jobs) {
      const s = parseJson<Partial<TaskMetrics>>(j.summary, {});
      for (const k of Object.keys(totals) as (keyof TaskMetrics)[]) totals[k] = (totals[k] ?? 0) + (s[k] ?? 0);
    }

    let status: RunStatus;
    if (forced) status = forced;
    else if (run.cancel_requested) status = 'cancelled';
    else if (jobs.every((j) => j.status === 'succeeded')) status = 'succeeded';
    else if (jobs.some((j) => j.status === 'succeeded' || j.status === 'partial')) status = 'partial';
    else status = 'failed';

    const now = this.now();
    this.repo.updateRun(runId, {
      status,
      finished_at: now,
      duration_ms: now - (run.started_at ?? run.created_at),
      summary: { chains: byStatus, branches: counts, ...totals },
    });
    return this.mustRun(runId);
  }

  // ─── Chain ──────────────────────────────────────────────────────────────────

  private async executeChain(run: RunRow, params: RunParams, job: ChainJobRow, runSignal: AbortSignal): Promise<void> {
    const log = this.log.child({ runId: run.id, chainJobId: job.id, chainId: job.chain_id });
    const chain = this.chains.find((c) => c.id === job.chain_id);
    const now = this.now();
    this.repo.updateChainJob(job.id, { status: 'running', started_at: job.started_at ?? now });

    if (!chain) {
      this.finishChain(job.id, 'failed', { error: `chain "${job.chain_id}" is not configured`, stage: 'unknown' });
      return;
    }
    const ctx = new ChainContext(this, run, params, job, chain, log, runSignal);

    try {
      if (job.phase === 'chain') {
        await this.chainSteps(ctx);
        if (run.type === 'stores') {
          this.finishChain(job.id, 'succeeded');
          return;
        }
      }

      this.repo.updateChainJob(job.id, { current_step: 'branches' });
      const breakerOpened = await this.processBranches(ctx);
      if (runSignal.aborted) {
        this.finishChain(job.id, 'cancelled');
        return;
      }
      if (breakerOpened) {
        const { failureRatio, samples } = ctx.breaker;
        const message =
          `circuit breaker opened: ${Math.round(failureRatio * samples)} of ${samples} finished branches failed ` +
          `(limit ${Math.round(this.config.breaker.threshold * 100)}%) — the rest of the chain was cancelled`;
        log.error(message);
        await this.recomputeNames(ctx);
        this.finishChain(job.id, 'failed', { error: message, stage: 'unknown' });
        return;
      }

      const recomputeError = await this.recomputeNames(ctx);
      const counts = this.repo.taskCounts({ chainJobId: job.id });
      let status: ChainStatus;
      if (counts.failed === 0 && !recomputeError) status = 'succeeded';
      else if (counts.succeeded + counts.skipped > 0) status = 'partial';
      else status = 'failed';
      this.finishChain(job.id, status, recomputeError ? { error: errorMessage(recomputeError), stage: 'recompute-names', stack: errorStack(recomputeError) } : undefined);
    } catch (err) {
      if (runSignal.aborted) {
        this.repo.cancelPendingTasks({ chainJobId: job.id }, 'run cancelled', this.now());
        this.finishChain(job.id, 'cancelled');
        return;
      }
      log.error(`chain ${job.chain_id} failed`, { error: errorMessage(err), stage: stageOf(err) });
      this.repo.cancelPendingTasks({ chainJobId: job.id }, 'chain failed', this.now());
      this.finishChain(job.id, 'failed', { error: errorMessage(err), stage: stageOf(err) ?? 'unknown', stack: errorStack(err) });
    }
  }

  private finishChain(
    chainJobId: number,
    status: ChainStatus,
    failure?: { error: string; stage: SyncStage | string; stack?: string },
  ): void {
    const job = this.repo.getChainJob(chainJobId)!;
    const tasks = this.repo.tasksForChainJob(chainJobId);
    const totals = emptyMetrics();
    for (const t of tasks) {
      const m = parseJson<Partial<TaskMetrics>>(t.metrics, {});
      for (const k of Object.keys(totals) as (keyof TaskMetrics)[]) totals[k] = (totals[k] ?? 0) + (m[k] ?? 0);
    }
    const now = this.now();
    this.repo.updateChainJob(chainJobId, {
      status,
      phase: 'done',
      current_step: null,
      finished_at: now,
      duration_ms: now - (job.started_at ?? now),
      summary: { ...totals, branches: this.repo.taskCounts({ chainJobId }) },
      ...(failure ? { error: failure.error, error_stage: failure.stage, stack: failure.stack ?? null } : {}),
    });
  }

  /** Runs a chain-level step with retries (transient errors) and re-login
   *  (expired session). */
  async chainStep<T>(
    ctx: ChainContext,
    name: StepName,
    fn: (signal: AbortSignal, log: Logger) => Promise<T> | T,
    metrics: (result: T) => Record<string, unknown>,
  ): Promise<T> {
    let relogins = 0;
    // A re-login while branches are running shouldn't leave the chain stuck
    // on "login" in the dashboard.
    const previousStep = this.repo.getChainJob(ctx.job.id)?.current_step;
    const restore = () => {
      if (previousStep === 'branches') this.repo.updateChainJob(ctx.job.id, { current_step: previousStep });
    };
    for (let attempt = 1; ; attempt++) {
      this.repo.updateChainJob(ctx.job.id, { current_step: name });
      try {
        return await this.step(
          { runId: ctx.run.id, chainJobId: ctx.job.id, level: 'chain', attempt, log: ctx.log, signal: ctx.signal },
          name,
          fn,
          metrics,
        ).finally(restore);
      } catch (err) {
        const kind = classifyError(err);
        if (ctx.signal.aborted) throw err;
        if (kind === 'session' && name !== 'login' && relogins < this.config.maxRelogins) {
          relogins++;
          await ctx.relogin(ctx.cookie);
          continue;
        }
        if (kind === 'permanent' || attempt >= this.config.maxAttempts) throw err;
        const wait = backoffMs(attempt, this.config.backoffBaseMs, this.config.backoffMaxMs);
        ctx.log.warn(`${name} failed (attempt ${attempt}/${this.config.maxAttempts}), retrying in ${Math.round(wait / 1000)}s`, {
          error: errorMessage(err),
        });
        await sleep(wait, ctx.signal);
      }
    }
  }

  /** Calls the portal with the chain's session, logging in again (once per
   *  expiry, shared by every worker) when it has expired. */
  private async withSession<T>(ctx: ChainContext, fn: (cookie: string) => Promise<T>): Promise<T> {
    let relogins = 0;
    for (;;) {
      const cookie = await ctx.session();
      try {
        return await fn(cookie);
      } catch (err) {
        if (classifyError(err) !== 'session' || relogins >= this.config.maxRelogins) throw err;
        relogins++;
        await ctx.relogin(cookie);
      }
    }
  }

  private async chainSteps(ctx: ChainContext): Promise<void> {
    const { run, chain, job, params } = ctx;
    await this.target.upsertChain(chain);
    await ctx.session();

    if (run.type === 'stores' || run.type === 'full') {
      try {
        await this.chainStep(
          ctx,
          'stores-file',
          (signal, log) => this.refreshStores(ctx, signal, log),
          (r) => r,
        );
      } catch (err) {
        // A full run carries on with the branch list it already has.
        if (run.type === 'stores') throw err;
        ctx.log.warn('branch list refresh failed — continuing with the existing branch list', {
          error: errorMessage(err),
        });
      }
      if (run.type === 'stores') return;
    }

    const plan = await this.chainStep(
      ctx,
      'list-files',
      (signal, log) => (run.type === 'full' ? this.planFull(ctx, signal) : this.planDeltas(ctx, signal, log)),
      (p) => ({
        files: p.listed,
        branches: p.tasks.length,
        queued: p.tasks.filter((t) => !t.skipReason).length,
        skipped: p.tasks.filter((t) => t.skipReason).length,
      }),
    );

    const only = params.stores?.[chain.id];
    const tasks = only ? plan.tasks.filter((t) => only.includes(t.storeCode)) : plan.tasks;
    const now = this.now();
    this.repo.tx(() => {
      for (const t of tasks) {
        this.repo.createTask({
          runId: run.id,
          chainJobId: job.id,
          chainId: chain.id,
          storeCode: t.storeCode,
          files: t.files,
          status: t.skipReason ? 'skipped' : 'queued',
          skipReason: t.skipReason,
          force: params.force,
          now,
        });
      }
      this.repo.updateChainJob(job.id, { phase: 'branches' });
    });
    ctx.log.info(`enqueued ${tasks.filter((t) => !t.skipReason).length} of ${tasks.length} branches`);
  }

  private async refreshStores(ctx: ChainContext, signal: AbortSignal, log: Logger): Promise<Record<string, unknown>> {
    const files = await this.withSession(ctx, (cookie) => this.portal.listFiles(cookie, 'Stores', signal));
    const file = pickLatestFile(files);
    if (!file) throw new PermanentError('no Stores file in the listing');
    const body = await this.withSession(ctx, (cookie) => this.portal.download(cookie, file, signal));
    const path = this.raw.save(ctx.run.id, ctx.chain.id, file, body, this.now());
    this.repo.insertRawFile({
      run_id: ctx.run.id,
      branch_task_id: null,
      chain_id: ctx.chain.id,
      store_code: null,
      file,
      path,
      size: body.length,
      created_at: this.now(),
    });
    const list = parseStoresXml(decodeXmlBuffer(decompressFileBody(body, file)));
    if (!list.length) throw new ValidationError(`Stores file ${file} parsed to zero branches`);
    await this.target.writeStores(ctx.chain.id, list);
    log.info(`branch list refreshed: ${list.length} branches`, { file });
    ctx.invalidateStates();
    return { file, bytes: body.length, stores: list.length };
  }

  private async planFull(
    ctx: ChainContext,
    signal: AbortSignal,
  ): Promise<{ listed: number; tasks: { storeCode: string; files: string[]; skipReason?: string }[] }> {
    const files = await this.withSession(ctx, (cookie) => this.portal.listFiles(cookie, 'PriceFull', signal));
    const perStore = latestFilePerStore(files, ctx.chain.storeId).filter((s) => s.storeId);
    if (!perStore.length) throw new PermanentError('no PriceFull files in the listing');
    await this.target.ensureStores(ctx.chain.id, perStore.map((s) => s.storeId));
    ctx.invalidateStates();
    return { listed: files.length, tasks: perStore.map((s) => ({ storeCode: s.storeId, files: [s.file] })) };
  }

  private async planDeltas(
    ctx: ChainContext,
    signal: AbortSignal,
    log: Logger,
  ): Promise<{ listed: number; tasks: { storeCode: string; files: string[]; skipReason?: string }[] }> {
    const all = await this.withSession(ctx, (cookie) => this.portal.listFiles(cookie, 'Price', signal));
    // The search is a substring match, so "Price" also lists PriceFull files.
    const deltas = dropStaleFiles(filterByStore(all.filter((f) => !/pricefull/i.test(f)), ctx.chain.storeId));
    const states = await ctx.states();
    const cursors: Record<string, string> = {};
    for (const [code, s] of states) if (s.lastDeltaTs) cursors[code] = s.lastDeltaTs;
    const { byStore, unrecognized } = planDeltaFiles(deltas, validDeltaCursors(cursors));
    for (const f of unrecognized) log.warn('delta file has no store id in its name — ignored', { file: f });

    const listedStores = new Set(deltas.map((f) => storeIdFromFileName(f)).filter((s): s is string => !!s));
    const tasks = [...listedStores].sort().map((code) =>
      byStore.has(code)
        ? { storeCode: code, files: byStore.get(code)! }
        : { storeCode: code, files: [], skipReason: 'no new delta file' },
    );
    if (byStore.size) await this.target.ensureStores(ctx.chain.id, [...byStore.keys()]);
    return { listed: deltas.length, tasks };
  }

  /** Recomputes name/keywords for the products this chain job touched.
   *  Returns the error instead of throwing: the prices are already written. */
  private async recomputeNames(ctx: ChainContext): Promise<unknown | undefined> {
    const ids = this.repo.touchedProducts(ctx.job.id);
    if (!ids.length) return undefined;
    try {
      await this.chainStep(ctx, 'recompute-names', () => this.target.recomputeNames(ids), (n) => ({
        products: ids.length,
        updated: n,
      }));
      this.repo.clearTouchedProducts(ctx.job.id);
      return undefined;
    } catch (err) {
      ctx.log.error('recomputing product names failed — prices are written, names may be stale until the next run', {
        error: errorMessage(err),
      });
      return err;
    }
  }

  // ─── Branches (the queue) ───────────────────────────────────────────────────

  /** Works through the chain job's queue. Returns true if the circuit
   *  breaker stopped it. */
  private async processBranches(ctx: ChainContext): Promise<boolean> {
    const { job, signal } = ctx;
    const limit = this.config.branchConcurrency;
    const active = new Map<number, Promise<void>>();
    let breakerOpened = false;

    for (;;) {
      if (signal.aborted) break;
      if (ctx.breaker.open) {
        breakerOpened = true;
        break;
      }
      while (active.size < limit) {
        const task = this.repo.claimTask(job.id, this.now());
        if (!task) break;
        active.set(
          task.id,
          this.runTask(ctx, task).finally(() => active.delete(task.id)),
        );
      }
      const due = this.repo.nextDueAt(job.id);
      if (!active.size && due === undefined) break;
      const waits: Promise<unknown>[] = [...active.values()];
      if (due !== undefined && active.size < limit) waits.push(sleep(Math.max(10, due - this.now()), signal));
      await Promise.race(waits);
    }

    await Promise.allSettled(active.values());
    if (signal.aborted) this.repo.cancelPendingTasks({ chainJobId: job.id }, 'run cancelled', this.now());
    else if (breakerOpened) this.repo.cancelPendingTasks({ chainJobId: job.id }, 'circuit breaker open', this.now());
    return breakerOpened;
  }

  /** Runs one claimed task to an outcome. Never throws. */
  private async runTask(ctx: ChainContext, task: TaskRow): Promise<void> {
    const log = ctx.log.child({ taskId: task.id, storeCode: task.store_code });
    const scope: StepScope = {
      runId: ctx.run.id,
      chainJobId: ctx.job.id,
      taskId: task.id,
      level: 'branch',
      attempt: task.attempts,
      log,
      signal: ctx.signal,
    };
    const started = task.started_at ?? this.now();
    try {
      if (task.attempts > 1) log.info(`attempt ${task.attempts}/${this.config.maxAttempts}`);
      const outcome =
        ctx.run.type === 'full' ? await this.fullPipeline(ctx, task, scope) : await this.deltaPipeline(ctx, task, scope);
      const now = this.now();
      this.repo.updateTask(
        task.id,
        {
          status: outcome.status,
          skip_reason: outcome.skipReason ?? null,
          item_count: outcome.itemCount ?? null,
          head_size: outcome.headSize ?? null,
          head_modified: outcome.headModified ?? null,
          metrics: outcome.metrics,
          current_step: null,
          finished_at: now,
          duration_ms: now - started,
        },
        now,
      );
      ctx.breaker.record('ok');
      if (outcome.status === 'skipped') log.debug(`skipped: ${outcome.skipReason}`);
      else log.info('branch done', { ...outcome.metrics });
    } catch (err) {
      this.taskFailed(ctx, task, err, log, started);
    }
  }

  private taskFailed(ctx: ChainContext, task: TaskRow, err: unknown, log: Logger, started: number): void {
    try {
      const now = this.now();
      if (ctx.signal.aborted || err instanceof CancelledError) {
        this.repo.updateTask(
          task.id,
          { status: 'cancelled', skip_reason: 'run cancelled', current_step: null, finished_at: now, duration_ms: now - started },
          now,
        );
        return;
      }
      const kind = classifyError(err);
      const failure = {
        error: errorMessage(err),
        error_stage: stageOf(err) ?? 'unknown',
        error_kind: kind,
        stack: errorStack(err) ?? null,
      };
      if (kind !== 'permanent' && task.attempts < this.config.maxAttempts) {
        const wait = backoffMs(task.attempts, this.config.backoffBaseMs, this.config.backoffMaxMs);
        this.repo.updateTask(task.id, { ...failure, status: 'retry_wait', next_attempt_at: now + wait, current_step: null }, now);
        log.warn(`${failure.error_stage} failed (${kind}), retrying in ${Math.round(wait / 1000)}s`, { error: failure.error });
        return;
      }
      this.repo.updateTask(
        task.id,
        { ...failure, status: 'failed', current_step: null, finished_at: now, duration_ms: now - started },
        now,
      );
      ctx.breaker.record('failed');
      log.error(`branch failed at ${failure.error_stage}: ${failure.error}`, { kind, attempts: task.attempts });
    } catch (inner) {
      log.error('could not record a task failure', { error: errorMessage(inner), original: errorMessage(err) });
    }
  }

  /** The body of `file` for this task: the replay source's saved copy, a copy
   *  saved by an earlier attempt of this task, or a fresh download. */
  private async fetchBody(ctx: ChainContext, task: TaskRow, scope: StepScope, file: string): Promise<Buffer> {
    const sourceTask = task.replay_of ?? task.id;
    const saved = this.rawFor(sourceTask, file);
    if (saved) {
      const why = task.replay_of ? `replay of task #${task.replay_of}` : 'reused the copy saved by an earlier attempt';
      const body = await this.step(scope, 'download', async () => this.raw.read(saved.path), (b) => ({
        bytes: b.length,
        source: why,
      }), file);
      if (task.replay_of) {
        // Link the same bytes to the replay task too, so it can be replayed
        // again and its page shows the file.
        this.repo.insertRawFile({
          run_id: task.run_id,
          branch_task_id: task.id,
          chain_id: saved.chain_id,
          store_code: saved.store_code,
          file: saved.file,
          path: saved.path,
          size: saved.size,
          created_at: this.now(),
        });
      }
      return body;
    }
    if (task.replay_of) throw new PermanentError(`the saved copy of ${file} is gone (retention)`);

    return this.step(
      scope,
      'download',
      async (signal) => {
        const body = await this.withSession(ctx, (cookie) => this.portal.download(cookie, file, signal));
        const path = this.raw.save(ctx.run.id, ctx.chain.id, file, body, this.now());
        this.repo.insertRawFile({
          run_id: ctx.run.id,
          branch_task_id: task.id,
          chain_id: ctx.chain.id,
          store_code: task.store_code,
          file,
          path,
          size: body.length,
          created_at: this.now(),
        });
        return body;
      },
      (b) => ({ bytes: b.length }),
      file,
    );
  }

  private async readItems(
    scope: StepScope,
    file: string,
    body: Buffer,
  ): Promise<ParsedItem[]> {
    const xml = await this.step(scope, 'decompress', async () => decodeXmlBuffer(decompressFileBody(body, file)), (x) => ({
      chars: x.length,
    }), file);
    return this.step(scope, 'parse', async () => parsePriceItemsXml(xml, this.config.maxItemsPerFile), (items) => ({
      items: items.length,
    }), file);
  }

  private async fullPipeline(ctx: ChainContext, task: TaskRow, scope: StepScope): Promise<TaskOutcome> {
    const [file] = parseJson<string[]>(task.files, []);
    if (!file) throw new PermanentError('task has no file');
    const metrics = emptyMetrics();
    const stepBase = { runId: ctx.run.id, chainJobId: ctx.job.id, taskId: task.id, level: 'branch' as const, attempt: task.attempts, file };

    // head-check — skip branches whose file hasn't changed since it was written.
    let meta = { size: '', modified: '' };
    if (task.replay_of) {
      this.repo.skippedStep({ ...stepBase, name: 'head-check', now: this.now() }, 'replay');
    } else {
      const states = await ctx.states();
      meta = await this.step(scope, 'head-check', (signal) => this.withSession(ctx, (c) => this.portal.head(c, file, signal)), (m) => ({ ...m }), file);
      const saved = states.get(task.store_code);
      const unchanged =
        !!saved &&
        saved.lastPriceFile === file &&
        saved.lastPriceSize === meta.size &&
        saved.lastPriceModified === meta.modified;
      if (unchanged && !task.force && !task.recovered) {
        return { status: 'skipped', skipReason: 'unchanged (same HEAD signature)', headSize: meta.size, headModified: meta.modified, metrics };
      }
    }

    const body = await this.fetchBody(ctx, task, scope, file);
    metrics.files = 1;
    metrics.bytes = body.length;
    const items = await this.readItems(scope, file, body);

    const previous = this.repo.previousFullItemCount(ctx.chain.id, task.store_code, ctx.run.id);
    await this.step(scope, 'validate', async () => validateItems('full', items, this.config.validation, previous), (v) => ({ ...v }), file);
    metrics.items = items.length;

    if (task.dry_run) {
      this.repo.skippedStep({ ...stepBase, name: 'write-db', now: this.now() }, 'dry run');
      this.repo.skippedStep({ ...stepBase, name: 'finalize', now: this.now() }, 'dry run');
      return { status: 'succeeded', itemCount: items.length, metrics };
    }

    const result = await this.step(
      scope,
      'write-db',
      async () => {
        const r = await this.target.writeBranchFull({
          chainId: ctx.chain.id,
          storeCode: task.store_code,
          file,
          size: meta.size,
          modified: meta.modified,
          items,
        });
        // Recorded right after the commit: a crash before finalize still
        // gets these names recomputed.
        this.repo.addTouchedProducts(ctx.job.id, r.productIds);
        return r;
      },
      writeMetrics,
      file,
    );
    addWrite(metrics, result);

    await this.step(scope, 'finalize', async () => metrics, (m) => ({ ...m }), file);
    return { status: 'succeeded', itemCount: items.length, headSize: meta.size, headModified: meta.modified, metrics };
  }

  private async deltaPipeline(ctx: ChainContext, task: TaskRow, scope: StepScope): Promise<TaskOutcome> {
    const files = parseJson<string[]>(task.files, []);
    const metrics = emptyMetrics();
    const stepBase = { runId: ctx.run.id, chainJobId: ctx.job.id, taskId: task.id, level: 'branch' as const, attempt: task.attempts };
    this.repo.skippedStep({ ...stepBase, name: 'head-check', now: this.now() }, 'delta files are chosen by the branch cursor');

    // Strictly oldest first: each file applies on top of the previous one.
    for (const file of files) {
      const body = await this.fetchBody(ctx, task, scope, file);
      metrics.files++;
      metrics.bytes += body.length;
      const items = await this.readItems(scope, file, body);
      await this.step(scope, 'validate', async () => validateItems('delta', items, this.config.validation), (v) => ({ ...v }), file);
      metrics.items += items.length;

      if (task.dry_run) {
        this.repo.skippedStep({ ...stepBase, name: 'write-db', file, now: this.now() }, 'dry run');
        continue;
      }
      const result = await this.step(
        scope,
        'write-db',
        async () => {
          const r = await this.target.writeBranchDelta({
            chainId: ctx.chain.id,
            storeCode: task.store_code,
            file,
            items,
            force: !!task.replay_of,
          });
          this.repo.addTouchedProducts(ctx.job.id, r.productIds);
          return r;
        },
        writeMetrics,
        file,
      );
      addWrite(metrics, result);
      if (result.alreadyApplied) metrics.alreadyApplied = (metrics.alreadyApplied ?? 0) + 1;
    }

    if (task.dry_run) this.repo.skippedStep({ ...stepBase, name: 'finalize', now: this.now() }, 'dry run');
    else await this.step(scope, 'finalize', async () => metrics, (m) => ({ ...m }));
    return { status: 'succeeded', itemCount: metrics.items, metrics };
  }

  // ─── Steps ──────────────────────────────────────────────────────────────────

  /**
   * Runs one step: records it in `steps`, applies its timeout (aborting the
   * signal handed to `fn`), and tags any error with the step name so the
   * failure says where it happened.
   */
  async step<T>(
    scope: StepScope,
    name: StepName,
    fn: (signal: AbortSignal, log: Logger) => Promise<T> | T,
    metrics: (result: T) => Record<string, unknown>,
    file?: string,
  ): Promise<T> {
    const started = this.now();
    const stepId = this.repo.startStep({
      runId: scope.runId,
      chainJobId: scope.chainJobId,
      taskId: scope.taskId,
      level: scope.level,
      name,
      attempt: scope.attempt,
      file,
      now: started,
    });
    if (scope.taskId != null) this.repo.updateTask(scope.taskId, { current_step: name }, started);
    const log = scope.log.child({ stepId, step: name });

    const timeoutMs = this.config.timeoutsMs[name];
    const ctrl = new AbortController();
    const onRunAbort = () => ctrl.abort(scope.signal.reason ?? new CancelledError());
    if (scope.signal.aborted) onRunAbort();
    else scope.signal.addEventListener('abort', onRunAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(new StepTimeoutError(name, timeoutMs)), timeoutMs);

    try {
      const result = await raceAbort(Promise.resolve().then(() => fn(ctrl.signal, log)), ctrl.signal);
      const m = metrics(result);
      this.repo.finishStep(stepId, { status: 'succeeded', metrics: m }, this.now());
      log.debug(`${name} ok`, { durationMs: this.now() - started, ...m });
      return result;
    } catch (raw) {
      // An aborted fetch rejects with a generic AbortError; report the reason.
      const err = ctrl.signal.aborted && ctrl.signal.reason instanceof Error ? ctrl.signal.reason : raw;
      const details = err instanceof ValidationError ? err.details : {};
      this.repo.finishStep(
        stepId,
        { status: 'failed', error: errorMessage(err), stack: errorStack(err) ?? null, metrics: details },
        this.now(),
      );
      if (!(err instanceof CancelledError)) {
        log.warn(`${name} failed: ${errorMessage(err)}`, { kind: classifyError(err), ...details });
      }
      throw tagStage(err, name as SyncStage);
    } finally {
      clearTimeout(timer);
      scope.signal.removeEventListener('abort', onRunAbort);
    }
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  private rawFor(taskId: number, file: string) {
    const row = this.repo.rawFileFor(taskId, file);
    return row && this.raw.exists(row.path) ? row : undefined;
  }

  private resolveChains(ids: string[] | undefined): ChainConfig[] {
    if (!ids || !ids.length) return this.chains;
    const unknown = ids.filter((id) => !this.chains.some((c) => c.id === id));
    if (unknown.length) throw new BadRequestError(`unknown or disabled chain(s): ${unknown.join(', ')}`);
    return this.chains.filter((c) => ids.includes(c.id));
  }

  private mustRun(id: number): RunRow {
    const run = this.repo.getRun(id);
    if (!run) throw new BadRequestError(`run #${id} not found`);
    return run;
  }

  private mustTask(id: number): TaskRow {
    const task = this.repo.getTask(id);
    if (!task) throw new BadRequestError(`task #${id} not found`);
    return task;
  }
}

function writeMetrics(r: BranchWriteResult): Record<string, unknown> {
  return {
    rowsWritten: r.rowsWritten,
    rowsDeleted: r.rowsDeleted,
    priceChanges: r.priceChanges,
    products: r.productIds.length,
    ...(r.alreadyApplied ? { alreadyApplied: true } : {}),
  };
}

function addWrite(m: TaskMetrics, r: BranchWriteResult): void {
  m.rowsWritten += r.rowsWritten;
  m.rowsDeleted += r.rowsDeleted;
  m.priceChanges += r.priceChanges;
}
