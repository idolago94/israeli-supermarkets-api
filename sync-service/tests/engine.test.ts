import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJson } from '../src/repo';
import {
  CHAIN_A,
  CHAIN_B,
  NO_A,
  NO_B,
  deltaName,
  fullName,
  gz,
  harness,
  priceXml,
  publishChain,
} from './fakes';

const statusesByStore = (h: ReturnType<typeof harness>, runId: number) =>
  Object.fromEntries(h.repo.tasksForRun(runId).map((t) => [`${t.chain_id}/${t.store_code}`, t.status]));

test('full run: every branch of every chain is written, one transaction per branch', async () => {
  const h = harness();
  publishChain(h, CHAIN_A, NO_A, ['001', '002', '003']);
  publishChain(h, CHAIN_B, NO_B, ['010', '011']);

  const runId = h.engine.startRun({ type: 'full', trigger: 'manual' });
  await h.engine.idle();

  const run = h.repo.getRun(runId)!;
  assert.equal(run.status, 'succeeded');
  assert.equal(h.target.fullWrites.length, 5);
  assert.deepEqual(h.repo.taskCounts({ runId }).succeeded, 5);
  // Each branch went through the full step sequence.
  const task = h.repo.tasksForRun(runId)[0];
  assert.deepEqual(
    h.repo.stepsForTask(task.id).map((s) => `${s.name}:${s.status}`),
    ['head-check:succeeded', 'download:succeeded', 'decompress:succeeded', 'parse:succeeded', 'validate:succeeded', 'write-db:succeeded', 'finalize:succeeded'],
  );
  // Chain-level steps, and the names recomputed once per chain at the end.
  const chainA = h.repo.chainJobsForRun(runId).find((j) => j.chain_id === 'chain_a')!;
  assert.deepEqual(
    h.repo.chainSteps(chainA.id).map((s) => s.name),
    ['login', 'stores-file', 'list-files', 'recompute-names'],
  );
  assert.equal(h.target.recomputed.length, 2);
  assert.equal(h.repo.touchedProducts(chainA.id).length, 0, 'cleared after the recompute');
  // Raw files kept for replay.
  assert.equal(h.repo.rawFilesForTask(task.id).length, 1);
  assert.deepEqual(h.finished, [runId]);
});

test('a corrupt branch file fails only that branch; the run ends partial', async () => {
  const h = harness();
  const files = publishChain(h, CHAIN_A, NO_A, ['001', '002', '003']);
  publishChain(h, CHAIN_B, NO_B, ['010']);
  h.portal.addFile(CHAIN_A.username, files['002'], Buffer.from('<html>error page</html>'));

  const runId = h.engine.startRun({ type: 'full', trigger: 'manual' });
  await h.engine.idle();

  assert.equal(h.repo.getRun(runId)!.status, 'partial');
  assert.deepEqual(statusesByStore(h, runId), {
    'chain_a/001': 'succeeded',
    'chain_a/002': 'failed',
    'chain_a/003': 'succeeded',
    'chain_b/010': 'succeeded',
  });
  const failed = h.repo.tasksForRun(runId).find((t) => t.status === 'failed')!;
  assert.equal(failed.error_stage, 'decompress');
  assert.equal(failed.error_kind, 'permanent');
  assert.equal(failed.attempts, 1, 'a permanent error is not retried');
  const jobs = Object.fromEntries(h.repo.chainJobsForRun(runId).map((j) => [j.chain_id, j.status]));
  assert.deepEqual(jobs, { chain_a: 'partial', chain_b: 'succeeded' });
});

test('a transient download error is retried with backoff and succeeds', async () => {
  const h = harness();
  const files = publishChain(h, CHAIN_A, NO_A, ['001', '002']);
  h.portal.fault(files['001'], { kind: 'transient', times: 2 });

  const runId = h.engine.startRun({ type: 'full', trigger: 'manual', params: { chains: ['chain_a'] } });
  await h.engine.idle();

  assert.equal(h.repo.getRun(runId)!.status, 'succeeded');
  const task = h.repo.tasksForRun(runId).find((t) => t.store_code === '001')!;
  assert.equal(task.status, 'succeeded');
  assert.equal(task.attempts, 3);
  const downloads = h.repo.stepsForTask(task.id).filter((s) => s.name === 'download');
  assert.deepEqual(downloads.map((s) => s.status), ['failed', 'failed', 'succeeded']);
});

test('a transient error that never clears fails the branch after max attempts', async () => {
  const h = harness();
  const files = publishChain(h, CHAIN_A, NO_A, ['001', '002']);
  h.portal.fault(files['001'], { kind: 'http', status: 503, times: 99 });

  const runId = h.engine.startRun({ type: 'full', trigger: 'manual', params: { chains: ['chain_a'] } });
  await h.engine.idle();

  const task = h.repo.tasksForRun(runId).find((t) => t.store_code === '001')!;
  assert.equal(task.status, 'failed');
  assert.equal(task.attempts, h.config.maxAttempts);
  assert.equal(task.error_kind, 'transient');
  assert.equal(h.repo.getRun(runId)!.status, 'partial');
});

test('a failing login fails only that chain', async () => {
  const h = harness();
  publishChain(h, CHAIN_A, NO_A, ['001']);
  publishChain(h, CHAIN_B, NO_B, ['010']);
  h.portal.loginFailures.set(CHAIN_A.username, 99);

  const runId = h.engine.startRun({ type: 'full', trigger: 'manual' });
  await h.engine.idle();

  const jobs = Object.fromEntries(h.repo.chainJobsForRun(runId).map((j) => [j.chain_id, j]));
  assert.equal(jobs.chain_a.status, 'failed');
  assert.equal(jobs.chain_a.error_stage, 'login');
  assert.equal(jobs.chain_b.status, 'succeeded');
  assert.equal(h.repo.getRun(runId)!.status, 'partial');
});

test('every chain failing makes the run failed', async () => {
  const h = harness();
  h.portal.loginFailures.set(CHAIN_A.username, 99);
  h.portal.loginFailures.set(CHAIN_B.username, 99);
  const runId = h.engine.startRun({ type: 'full', trigger: 'manual' });
  await h.engine.idle();
  assert.equal(h.repo.getRun(runId)!.status, 'failed');
});

test('an unchanged branch (same HEAD signature) is skipped without a download', async () => {
  const h = harness();
  const files = publishChain(h, CHAIN_A, NO_A, ['001', '002']);
  h.engine.startRun({ type: 'full', trigger: 'manual', params: { chains: ['chain_a'] } });
  await h.engine.idle();

  // 002 republishes under the same name with a new signature.
  h.portal.meta.set(files['002'], { size: '1', modified: 'later' });
  const downloadsBefore = h.portal.calls.download;
  const runId = h.engine.startRun({ type: 'full', trigger: 'manual', params: { chains: ['chain_a'] } });
  await h.engine.idle();

  assert.deepEqual(statusesByStore(h, runId), { 'chain_a/001': 'skipped', 'chain_a/002': 'succeeded' });
  // One branch file + the Stores file.
  assert.equal(h.portal.calls.download - downloadsBefore, 2);
  assert.equal(h.repo.getRun(runId)!.status, 'succeeded');
});

test('an expired session mid-run logs in again and retries the step', async () => {
  const h = harness();
  const files = publishChain(h, CHAIN_A, NO_A, ['001']);
  h.portal.fault(files['001'], { kind: 'session', times: 1 });

  const runId = h.engine.startRun({ type: 'full', trigger: 'manual', params: { chains: ['chain_a'] } });
  await h.engine.idle();

  const task = h.repo.tasksForRun(runId)[0];
  assert.equal(task.status, 'succeeded');
  assert.equal(task.attempts, 1, 'a re-login does not cost an attempt');
  assert.equal(h.portal.calls.login, 2);
  const job = h.repo.chainJobsForRun(runId)[0];
  assert.equal(h.repo.chainSteps(job.id).filter((s) => s.name === 'login').length, 2);
});

test('a hung step times out, frees its slot, and the branch fails', async () => {
  const h = harness({ config: { maxAttempts: 1 } });
  h.config.timeoutsMs.download = 50;
  const files = publishChain(h, CHAIN_A, NO_A, ['001', '002']);
  h.portal.fault(files['001'], { kind: 'hang', times: 99 });

  const runId = h.engine.startRun({ type: 'full', trigger: 'manual', params: { chains: ['chain_a'] } });
  await h.engine.idle();

  const t = Object.fromEntries(h.repo.tasksForRun(runId).map((x) => [x.store_code, x]));
  assert.equal(t['001'].status, 'failed');
  assert.match(t['001'].error!, /timed out/);
  assert.equal(t['001'].error_stage, 'download');
  assert.equal(t['002'].status, 'succeeded');
});

test('the circuit breaker stops a chain whose branches keep failing, other chains continue', async () => {
  const h = harness({ config: { maxAttempts: 1, branchConcurrency: 1 } });
  const stores = ['001', '002', '003', '004', '005', '006', '007', '008'];
  const files = publishChain(h, CHAIN_A, NO_A, stores);
  for (const s of stores) h.portal.fault(files[s], { kind: 'http', status: 404, times: 99 });
  publishChain(h, CHAIN_B, NO_B, ['010']);

  const runId = h.engine.startRun({ type: 'full', trigger: 'manual' });
  await h.engine.idle();

  const jobs = Object.fromEntries(h.repo.chainJobsForRun(runId).map((j) => [j.chain_id, j]));
  assert.equal(jobs.chain_a.status, 'failed');
  assert.match(jobs.chain_a.error!, /circuit breaker/);
  const counts = h.repo.taskCounts({ chainJobId: jobs.chain_a.id });
  assert.equal(counts.failed, h.config.breaker.minSamples);
  assert.equal(counts.cancelled, stores.length - h.config.breaker.minSamples);
  assert.equal(jobs.chain_b.status, 'succeeded');
  assert.equal(h.repo.getRun(runId)!.status, 'partial');
});

test('validation keeps a suspicious file out of the target DB', async () => {
  const h = harness({ config: { maxAttempts: 1 } });
  const files = publishChain(h, CHAIN_A, NO_A, ['001'], 1000);
  h.engine.startRun({ type: 'full', trigger: 'manual', params: { chains: ['chain_a'] } });
  await h.engine.idle();
  assert.equal(h.target.fullWrites.length, 1);

  // Republished with a fifth of the items: a > 50% drop.
  h.portal.addFile(CHAIN_A.username, files['001'], gz(priceXml('001', 200)), { size: '9', modified: 'new' });
  const runId = h.engine.startRun({ type: 'full', trigger: 'manual', params: { chains: ['chain_a'] } });
  await h.engine.idle();

  const task = h.repo.tasksForRun(runId)[0];
  assert.equal(task.status, 'failed');
  assert.equal(task.error_stage, 'validate');
  assert.match(task.error!, /item count fell 80%/);
  assert.equal(h.target.fullWrites.length, 1, 'nothing written');
  assert.equal(h.target.stores.get('chain_a')!.get('001')!.prices.size, 1000, 'good data kept');
});

test('a write failure (deadlock) is retried', async () => {
  const h = harness();
  publishChain(h, CHAIN_A, NO_A, ['001']);
  h.target.writeFailures.set('chain_a/001', {
    times: 1,
    error: () => Object.assign(new Error('deadlock detected'), { code: '40P01' }),
  });
  const runId = h.engine.startRun({ type: 'full', trigger: 'manual', params: { chains: ['chain_a'] } });
  await h.engine.idle();
  const task = h.repo.tasksForRun(runId)[0];
  assert.equal(task.status, 'succeeded');
  assert.equal(task.attempts, 2);
  // The retry reused the file saved by the first attempt.
  assert.equal(h.portal.calls.download, 2, 'Stores + one branch download, not two');
});

test('after a crash, the run resumes: running tasks are requeued and nothing is redone', async () => {
  const h = harness({ config: { branchConcurrency: 1 } });
  publishChain(h, CHAIN_A, NO_A, ['001', '002', '003']);

  // Simulate a crash: the run is created and its chain planned, one branch
  // is finished and one was mid-flight when the process died.
  const runId = h.repo.createRun({ type: 'full', trigger: 'schedule', status: 'running', now: Date.now() });
  const jobId = h.repo.createChainJob(runId, 'chain_a', 'branches');
  h.repo.updateChainJob(jobId, { status: 'running' });
  const mk = (store: string) =>
    h.repo.createTask({ runId, chainJobId: jobId, chainId: 'chain_a', storeCode: store, files: [fullName(NO_A, store)], now: Date.now() });
  const done = mk('001');
  mk('002');
  mk('003');
  h.repo.claimTask(jobId, Date.now()); // 001
  h.repo.updateTask(done, { status: 'succeeded', finished_at: Date.now() }, Date.now());
  const midFlight = h.repo.claimTask(jobId, Date.now())!; // 002, left 'running'
  assert.equal(midFlight.store_code, '002');

  const engine = h.newEngine();
  assert.equal(engine.resumeInterrupted(), runId);
  await engine.idle();

  assert.equal(h.repo.getRun(runId)!.status, 'succeeded');
  assert.deepEqual(statusesByStore(h, runId), { 'chain_a/001': 'succeeded', 'chain_a/002': 'succeeded', 'chain_a/003': 'succeeded' });
  assert.deepEqual(h.target.fullWrites.map((w) => w.storeCode).sort(), ['002', '003'], '001 not redone');
  assert.equal(h.repo.getTask(midFlight.id)!.recovered, 1);
});

test('only one run at a time', async () => {
  const h = harness();
  publishChain(h, CHAIN_A, NO_A, ['001']);
  h.engine.startRun({ type: 'full', trigger: 'manual' });
  assert.throws(() => h.engine.startRun({ type: 'deltas', trigger: 'manual' }), /still in progress/);
  await h.engine.idle();
});

test('cancel stops a run; unfinished branches are cancelled', async () => {
  const h = harness({ config: { branchConcurrency: 1 } });
  const files = publishChain(h, CHAIN_A, NO_A, ['001', '002', '003']);
  h.portal.fault(files['001'], { kind: 'hang', times: 1 });
  const runId = h.engine.startRun({ type: 'full', trigger: 'manual', params: { chains: ['chain_a'] } });
  await new Promise((r) => setTimeout(r, 50));
  h.engine.cancel(runId);
  await h.engine.idle();
  assert.equal(h.repo.getRun(runId)!.status, 'cancelled');
  const counts = h.repo.taskCounts({ runId });
  assert.equal(counts.cancelled, 3);
});

test('retry of a single branch, and retry of what failed in a run', async () => {
  const h = harness({ config: { maxAttempts: 1 } });
  const files = publishChain(h, CHAIN_A, NO_A, ['001', '002']);
  publishChain(h, CHAIN_B, NO_B, ['010']);
  h.portal.fault(files['002'], { kind: 'http', status: 404, times: 1 });
  const first = h.engine.startRun({ type: 'full', trigger: 'manual' });
  await h.engine.idle();
  assert.equal(h.repo.getRun(first)!.status, 'partial');

  const retry = h.engine.retryFailed(first);
  await h.engine.idle();
  const run = h.repo.getRun(retry)!;
  assert.equal(run.trigger, 'retry');
  assert.equal(run.parent_run_id, first);
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(statusesByStore(h, retry), { 'chain_a/002': 'succeeded' });

  // Retrying one branch reprocesses it even though it's unchanged.
  const task = h.repo.tasksForRun(first).find((t) => t.store_code === '001')!;
  const single = h.engine.retryTask(task.id);
  await h.engine.idle();
  assert.deepEqual(statusesByStore(h, single), { 'chain_a/001': 'succeeded' });
  assert.throws(() => h.engine.retryFailed(single), /nothing that failed/);
});

test('replay from file reprocesses the saved bytes without the portal; dry run writes nothing', async () => {
  const h = harness({ config: { maxAttempts: 1 } });
  publishChain(h, CHAIN_A, NO_A, ['001']);
  const first = h.engine.startRun({ type: 'full', trigger: 'manual', params: { chains: ['chain_a'] } });
  await h.engine.idle();
  const task = h.repo.tasksForRun(first)[0];
  const writes = h.target.fullWrites.length;
  const calls = { ...h.portal.calls };

  const replay = h.engine.replayTask(task.id, true);
  await h.engine.idle();
  const run = h.repo.getRun(replay)!;
  assert.equal(run.trigger, 'replay');
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(h.portal.calls, calls, 'no portal traffic');
  assert.equal(h.target.fullWrites.length, writes, 'dry run wrote nothing');
  const replayTask = h.repo.tasksForRun(replay)[0];
  assert.equal(replayTask.replay_of, task.id);
  const steps = h.repo.stepsForTask(replayTask.id).map((s) => `${s.name}:${s.status}`);
  assert.deepEqual(steps, ['head-check:skipped', 'download:succeeded', 'decompress:succeeded', 'parse:succeeded', 'validate:succeeded', 'write-db:skipped', 'finalize:skipped']);

  h.engine.replayTask(task.id, false);
  await h.engine.idle();
  assert.equal(h.target.fullWrites.length, writes + 1);
});

test('deltas: each branch applies only its new Price files, oldest first, and a second run skips', async () => {
  const h = harness();
  publishChain(h, CHAIN_A, NO_A, ['001', '002']); // PriceFull at 2026-11-13 03:00
  h.engine.startRun({ type: 'full', trigger: 'manual', params: { chains: ['chain_a'] } });
  await h.engine.idle();

  const older = deltaName(NO_A, '001', '20261113-020000'); // before the full file: already included
  const d1 = deltaName(NO_A, '001', '20261113-090000');
  const d2 = deltaName(NO_A, '001', '20261113-100000');
  h.portal.addFile(CHAIN_A.username, older, gz(priceXml('001', 3, () => 1)));
  h.portal.addFile(CHAIN_A.username, d2, gz(priceXml('001', 2, () => 99)));
  h.portal.addFile(CHAIN_A.username, d1, gz(priceXml('001', 2, () => 50)));

  const runId = h.engine.startRun({ type: 'deltas', trigger: 'manual', params: { chains: ['chain_a'] } });
  await h.engine.idle();
  assert.equal(h.repo.getRun(runId)!.status, 'succeeded');
  assert.deepEqual(statusesByStore(h, runId), { 'chain_a/001': 'succeeded' });
  assert.deepEqual(h.target.deltaWrites.map((w) => w.file), [d1, d2]);
  const prices = h.target.stores.get('chain_a')!.get('001')!.prices;
  assert.equal(prices.get('7290000000000'), 99, 'newest delta wins');
  assert.equal(prices.size, 150, 'a delta never deletes rows');

  const second = h.engine.startRun({ type: 'deltas', trigger: 'manual', params: { chains: ['chain_a'] } });
  await h.engine.idle();
  assert.deepEqual(statusesByStore(h, second), { 'chain_a/001': 'skipped' });
  assert.equal(h.repo.tasksForRun(second)[0].skip_reason, 'no new delta file');
  assert.equal(h.target.deltaWrites.length, 2);
});

test('deltas: a delta already applied before a crash is not applied twice', async () => {
  const h = harness();
  publishChain(h, CHAIN_A, NO_A, ['001']);
  h.engine.startRun({ type: 'full', trigger: 'manual', params: { chains: ['chain_a'] } });
  await h.engine.idle();
  const d1 = deltaName(NO_A, '001', '20261113-090000');
  h.portal.addFile(CHAIN_A.username, d1, gz(priceXml('001', 2, () => 50)));

  // The cursor already moved past d1 (committed), but the task is replanned.
  const runId = h.repo.createRun({ type: 'deltas', trigger: 'schedule', status: 'running', now: Date.now() });
  const jobId = h.repo.createChainJob(runId, 'chain_a', 'branches');
  h.repo.createTask({ runId, chainJobId: jobId, chainId: 'chain_a', storeCode: '001', files: [d1], now: Date.now() });
  await h.target.writeBranchDelta({ chainId: 'chain_a', storeCode: '001', file: d1, items: [] });
  const writes = h.target.deltaWrites.length;

  const engine = h.newEngine();
  engine.resumeInterrupted();
  await engine.idle();
  const task = h.repo.tasksForRun(runId)[0];
  assert.equal(task.status, 'succeeded');
  assert.equal(parseJson<any>(task.metrics, {}).alreadyApplied, 1);
  assert.equal(h.target.deltaWrites.length, writes);
});

test('stores run refreshes the branch list of every chain', async () => {
  const h = harness();
  publishChain(h, CHAIN_A, NO_A, ['001', '002']);
  publishChain(h, CHAIN_B, NO_B, ['010']);
  const runId = h.engine.startRun({ type: 'stores', trigger: 'schedule' });
  await h.engine.idle();
  assert.equal(h.repo.getRun(runId)!.status, 'succeeded');
  assert.equal(h.repo.tasksForRun(runId).length, 0);
  assert.deepEqual([...h.target.stores.get('chain_a')!.keys()].sort(), ['001', '002']);
  assert.equal(h.target.stores.get('chain_a')!.get('001')!.name, 'סניף 001');
});

test('logs are linked to the run, chain, branch and step', async () => {
  const h = harness({ config: { maxAttempts: 1 } });
  const files = publishChain(h, CHAIN_A, NO_A, ['001']);
  h.portal.addFile(CHAIN_A.username, files['001'], Buffer.from('garbage'));
  const runId = h.engine.startRun({ type: 'full', trigger: 'manual', params: { chains: ['chain_a'] } });
  await h.engine.idle();
  const task = h.repo.tasksForRun(runId)[0];
  const logs = h.repo.queryLogs({ taskId: task.id, level: 'warn' });
  assert.ok(logs.some((l) => l.step_name === 'decompress' && l.chain_id === 'chain_a' && l.run_id === runId));
  assert.ok(h.repo.queryLogs({ runId, q: 'branch failed' }).length >= 1);
});
