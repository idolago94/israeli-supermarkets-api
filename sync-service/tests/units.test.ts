import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CerberusHttpError, CerberusSessionExpiredError } from '../../lib/cerberus';
import { tagStage } from '../../lib/syncFailures';
import { CircuitBreaker } from '../src/breaker';
import { loadConfig, loadEnvFile } from '../src/config';
import { openDb } from '../src/db';
import { PermanentError, StepTimeoutError, ValidationError, backoffMs, classifyError } from '../src/errors';
import { cleanup, healthWarnings } from '../src/maintenance';
import { buildRunFailures } from '../src/notify';
import { RawStore } from '../src/rawStore';
import { Repo } from '../src/repo';
import { latestOccurrence, nextOccurrence } from '../src/scheduler';
import { validateItems } from '../src/validate';
import { writeFileSync, mkdtempSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { testConfig } from './fakes';

const newRepo = () => new Repo(openDb(':memory:'));

// ─── queue ──────────────────────────────────────────────────────────────────

function seedQueue(repo: Repo, n: number) {
  const runId = repo.createRun({ type: 'full', trigger: 'manual', status: 'running', now: 1 });
  const jobId = repo.createChainJob(runId, 'c');
  const ids = Array.from({ length: n }, (_, i) =>
    repo.createTask({ runId, chainJobId: jobId, chainId: 'c', storeCode: String(i).padStart(3, '0'), files: [], now: 1 }),
  );
  return { runId, jobId, ids };
}

test('queue: claim hands out each due task once, oldest first, bumping attempts', () => {
  const repo = newRepo();
  const { jobId, ids } = seedQueue(repo, 3);
  const a = repo.claimTask(jobId, 100)!;
  const b = repo.claimTask(jobId, 100)!;
  assert.deepEqual([a.id, b.id], [ids[0], ids[1]]);
  assert.equal(a.status, 'running');
  assert.equal(a.attempts, 1);
  assert.equal(repo.claimTask(jobId, 100)!.id, ids[2]);
  assert.equal(repo.claimTask(jobId, 100), undefined);
});

test('queue: a task in retry_wait is not claimed before next_attempt_at', () => {
  const repo = newRepo();
  const { jobId, ids } = seedQueue(repo, 1);
  repo.claimTask(jobId, 100);
  repo.updateTask(ids[0], { status: 'retry_wait', next_attempt_at: 500 }, 100);
  assert.equal(repo.claimTask(jobId, 499), undefined);
  assert.equal(repo.nextDueAt(jobId), 500);
  const again = repo.claimTask(jobId, 500)!;
  assert.equal(again.attempts, 2);
});

test('queue: recovery requeues running tasks and closes open steps', () => {
  const repo = newRepo();
  const { runId, jobId, ids } = seedQueue(repo, 2);
  repo.claimTask(jobId, 100);
  const stepId = repo.startStep({ runId, chainJobId: jobId, taskId: ids[0], level: 'branch', name: 'download', attempt: 1, now: 100 });
  assert.deepEqual(repo.recoverInterrupted(200), { tasks: 1, steps: 1 });
  const t = repo.getTask(ids[0])!;
  assert.equal(t.status, 'queued');
  assert.equal(t.recovered, 1);
  assert.equal(repo.stepsForTask(ids[0]).find((s) => s.id === stepId)!.status, 'failed');
  assert.equal(repo.claimTask(jobId, 300)!.id, ids[0]);
});

test('queue: cancelling leaves finished tasks alone', () => {
  const repo = newRepo();
  const { jobId, ids } = seedQueue(repo, 3);
  repo.claimTask(jobId, 1);
  repo.updateTask(ids[0], { status: 'succeeded' }, 1);
  assert.equal(repo.cancelPendingTasks({ chainJobId: jobId }, 'stop', 2), 2);
  assert.equal(repo.getTask(ids[0])!.status, 'succeeded');
});

// ─── errors & retry policy ──────────────────────────────────────────────────

test('classifyError: transient vs permanent vs session', () => {
  const net: any = new TypeError('fetch failed');
  net.cause = Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  assert.equal(classifyError(net), 'transient');
  assert.equal(classifyError(new CerberusHttpError('x', 503)), 'transient');
  assert.equal(classifyError(new CerberusHttpError('x', 429)), 'transient');
  assert.equal(classifyError(new CerberusHttpError('x', 404)), 'permanent');
  assert.equal(classifyError(new StepTimeoutError('download', 1000)), 'transient');
  assert.equal(classifyError(Object.assign(new Error('deadlock'), { code: '40P01' })), 'transient');
  assert.equal(classifyError(Object.assign(new Error('conn'), { code: '08006' })), 'transient');
  assert.equal(classifyError(Object.assign(new Error('dup'), { code: '23505' })), 'permanent');
  assert.equal(classifyError(new CerberusSessionExpiredError('x')), 'session');
  assert.equal(classifyError(new ValidationError('x')), 'permanent');
  assert.equal(classifyError(new PermanentError('x')), 'permanent');
  assert.equal(classifyError(tagStage(new Error('invalid gzip'), 'decompress')), 'permanent');
  assert.equal(classifyError(tagStage(new Error('bad xml'), 'parse')), 'permanent');
  assert.equal(classifyError(new Error('socket hang up')), 'transient');
  assert.equal(classifyError(new Error('Cannot read properties of undefined')), 'permanent');
});

test('backoff grows exponentially, is capped, and is jittered', () => {
  assert.equal(backoffMs(1, 1000, 60_000, () => 0), 500);
  assert.equal(backoffMs(1, 1000, 60_000, () => 1), 1000);
  assert.equal(backoffMs(3, 1000, 60_000, () => 1), 4000);
  assert.equal(backoffMs(20, 1000, 60_000, () => 1), 60_000);
  const v = backoffMs(2, 1000, 60_000);
  assert.ok(v >= 1000 && v <= 2000);
});

test('circuit breaker opens only past the threshold with enough samples', () => {
  const b = new CircuitBreaker(0.5, 4);
  b.record('failed');
  b.record('failed');
  b.record('failed');
  assert.equal(b.open, false, 'not enough samples yet');
  b.record('ok');
  assert.equal(b.open, true, '3 of 4 failed');
  const c = new CircuitBreaker(0.5, 4);
  for (const o of ['ok', 'failed', 'ok', 'failed'] as const) c.record(o);
  assert.equal(c.open, false, 'exactly 50% is not over the limit');
});

// ─── validation ─────────────────────────────────────────────────────────────

const rules = { minItemsFull: 100, maxItemDropRatio: 0.5, maxPrice: 10_000, maxBadPriceRatio: 0.01 };
const items = (n: number, price = 5) => Array.from({ length: n }, (_, i) => ({ code: String(1000000 + i), name: 'x', price }));

test('validation: full files need a minimum item count and no big drop', () => {
  assert.equal(validateItems('full', items(150), rules).itemCount, 150);
  assert.throws(() => validateItems('full', items(20), rules), /only 20 items/);
  assert.throws(() => validateItems('full', items(400), rules, 1000), /fell 60%/);
  assert.equal(validateItems('full', items(600), rules, 1000).previousCount, 1000);
  // Deltas are small by nature.
  assert.equal(validateItems('delta', items(2), rules).itemCount, 2);
});

test('validation: too many absurd prices fails', () => {
  const bad = [...items(150), ...items(5, 99_999)];
  assert.throws(() => validateItems('full', bad, rules), /price above/);
  assert.throws(() => validateItems('delta', items(3, 50_000), rules), /price above/);
});

// ─── scheduler ──────────────────────────────────────────────────────────────

const TZ = 'Asia/Jerusalem';
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

test('schedule times are local Jerusalem time across daylight saving', () => {
  // Winter (IST, UTC+2): 03:00 local = 01:00Z. Summer (IDT, UTC+3): 00:00Z.
  assert.equal(iso(nextOccurrence('0 3 * * *', TZ, Date.parse('2026-01-15T12:00:00Z'))), '2026-01-16T01:00:00.000Z');
  assert.equal(iso(nextOccurrence('0 3 * * *', TZ, Date.parse('2026-07-15T12:00:00Z'))), '2026-07-16T00:00:00.000Z');
  // The hourly pattern skips 03:00 local.
  const after2 = nextOccurrence('0 0-2,4-23 * * *', TZ, Date.parse('2026-07-16T23:30:00Z')); // 02:30 local
  assert.equal(iso(after2), '2026-07-17T01:00:00.000Z'); // 04:00 local
});

test('missed occurrences collapse into the latest one (wake from sleep)', () => {
  const lastFired = Date.parse('2026-07-16T05:00:00Z'); // 08:00 local
  const now = Date.parse('2026-07-16T09:20:00Z'); // 12:20 local, after a sleep
  assert.equal(iso(latestOccurrence('0 0-2,4-23 * * *', TZ, lastFired, now)), '2026-07-16T09:00:00.000Z');
  assert.equal(latestOccurrence('0 0-2,4-23 * * *', TZ, now, now + 60_000), undefined);
});

// ─── config ─────────────────────────────────────────────────────────────────

test('config: env file values fill gaps, real env wins, defaults apply', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const file = join(dir, '.env');
  writeFileSync(file, '# comment\nSYNC_PORT=4200\nSYNC_CHAINS="osher_ad, rami_levy"\nSYNC_BRANCH_CONCURRENCY=5 # inline\n');
  const env: NodeJS.ProcessEnv = { SYNC_PORT: '4300', SYNC_DATA_DIR: dir };
  loadEnvFile(file, env);
  const c = loadConfig(env);
  assert.equal(c.port, 4300);
  assert.deepEqual(c.chains, ['osher_ad', 'rami_levy']);
  assert.equal(c.branchConcurrency, 5);
  assert.equal(c.timezone, 'Asia/Jerusalem');
  assert.equal(c.timeoutsMs.download, 300_000);
  assert.equal(loadConfig({ SYNC_TIMEOUT_WRITE_DB_MS: '42' } as any).timeoutsMs['write-db'], 42);
  assert.throws(() => loadConfig({ SYNC_PORT: 'abc' } as any), /SYNC_PORT must be a number/);
});

// ─── retention & health ─────────────────────────────────────────────────────

test('retention deletes old runs (cascading) and old raw files', () => {
  const config = testConfig();
  const repo = newRepo();
  const raw = new RawStore(config.rawDir);
  const DAY = 86_400_000;
  const now = Date.parse('2026-11-13T12:00:00Z');
  const old = repo.createRun({ type: 'full', trigger: 'manual', status: 'running', now: now - 100 * DAY });
  repo.updateRun(old, { status: 'succeeded' });
  repo.createChainJob(old, 'c');
  const fresh = repo.createRun({ type: 'full', trigger: 'manual', status: 'running', now: now - DAY });
  repo.updateRun(fresh, { status: 'succeeded' });
  const oldPath = raw.save(fresh, 'c', 'a.gz', Buffer.from('x'), now - 20 * DAY);
  const newPath = raw.save(fresh, 'c', 'b.gz', Buffer.from('x'), now - DAY);

  const r = cleanup(repo, raw, config, now);
  assert.equal(r.runs, 1);
  assert.equal(repo.getRun(old), undefined);
  assert.equal(repo.chainJobsForRun(old).length, 0);
  assert.ok(repo.getRun(fresh));
  assert.equal(raw.exists(oldPath), false);
  assert.equal(raw.exists(newPath), true);
});

test('health warns when no hourly/full run completed recently, and on a long run', () => {
  const config = testConfig();
  const repo = newRepo();
  const now = Date.parse('2026-11-13T12:00:00Z');
  assert.equal(healthWarnings(repo, config, now).length, 2);

  const full = repo.createRun({ type: 'full', trigger: 'schedule', status: 'running', now: now - 9 * 3600_000 });
  repo.updateRun(full, { status: 'succeeded', finished_at: now - 9 * 3600_000 });
  const delta = repo.createRun({ type: 'deltas', trigger: 'schedule', status: 'running', now: now - 3600_000 });
  repo.updateRun(delta, { status: 'partial', finished_at: now - 3600_000 });
  assert.deepEqual(healthWarnings(repo, config, now), []);

  assert.match(healthWarnings(repo, config, now + 2 * 3600_000)[0].message, /No hourly sync has completed in 3 hours/);
  repo.createRun({ type: 'deltas', trigger: 'schedule', status: 'running', now: now - 50 * 60_000 });
  assert.match(healthWarnings(repo, config, now).map((w) => w.message).join(), /running for 50 minutes/);
});

// ─── notifications ──────────────────────────────────────────────────────────

test('failure report: one failure per failed chain and branch, fingerprinted', () => {
  const repo = newRepo();
  const runId = repo.createRun({ type: 'deltas', trigger: 'schedule', status: 'running', now: 1 });
  const jobA = repo.createChainJob(runId, 'a');
  repo.updateChainJob(jobA, { status: 'failed', error: 'login failed (403)', error_stage: 'login' });
  const jobB = repo.createChainJob(runId, 'b');
  const t1 = repo.createTask({ runId, chainJobId: jobB, chainId: 'b', storeCode: '001', files: ['Price1-001-001-20261113-010000.gz'], now: 1 });
  const t2 = repo.createTask({ runId, chainJobId: jobB, chainId: 'b', storeCode: '002', files: ['Price1-001-002-20261113-010000.gz'], now: 1 });
  repo.updateTask(t1, { status: 'failed', error: 'invalid gzip for Price1-001-001-20261113-010000.gz (12 bytes)', error_stage: 'decompress' }, 1);
  repo.updateTask(t2, { status: 'failed', error: 'invalid gzip for Price1-001-002-20261113-010000.gz (40 bytes)', error_stage: 'decompress' }, 1);

  const failures = buildRunFailures(repo, repo.getRun(runId)!);
  assert.equal(failures.length, 3);
  assert.deepEqual(failures.map((f) => [f.flow, f.level, f.stage, f.chain]), [
    ['local-deltas', 'flow', 'login', 'a'],
    ['local-deltas', 'file', 'decompress', 'b'],
    ['local-deltas', 'file', 'decompress', 'b'],
  ]);
  assert.equal(failures[1].fingerprint, failures[2].fingerprint, 'same problem → same issue');
});

test('raw store refuses paths outside its folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'raw-'));
  mkdirSync(join(dir, 'raw'));
  const raw = new RawStore(join(dir, 'raw'));
  assert.throws(() => raw.resolve('../secret'), /escapes/);
  assert.equal(existsSync(raw.resolve(raw.save(1, 'c', 'x/../../y.gz', Buffer.from('1'), Date.now()))), true);
});

test('error messages include the network cause', async () => {
  const { errorMessage } = await import('../src/errors');
  const err: any = new TypeError('fetch failed');
  err.cause = Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
  assert.equal(errorMessage(err), 'fetch failed (SELF_SIGNED_CERT_IN_CHAIN: self-signed certificate in certificate chain)');
  assert.equal(errorMessage(new Error('plain')), 'plain');
});
