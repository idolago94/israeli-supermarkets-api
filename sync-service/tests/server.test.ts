import assert from 'node:assert/strict';
import { request } from 'node:http';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Logger } from '../src/logger';
import { Scheduler } from '../src/scheduler';
import { createDashboardServer } from '../src/server';
import { CHAIN_A, NO_A, harness, publishChain } from './fakes';

async function withServer(fn: (base: string, h: ReturnType<typeof harness>) => Promise<void>) {
  const h = harness();
  publishChain(h, CHAIN_A, NO_A, ['001', '002']);
  const log = new Logger(h.repo, {}, { stdoutLevel: 'silent' });
  const scheduler = new Scheduler(h.engine, h.repo, h.config.timezone, log);
  const server = createDashboardServer({ engine: h.engine, repo: h.repo, scheduler, raw: h.raw, config: h.config, log });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base, h);
  } finally {
    await h.engine.idle();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const post = (url: string, body: unknown, headers: Record<string, string> = { 'x-sync-dashboard': '1' }) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('API: start a run, read it back, and get 409 while it is running', async () => {
  await withServer(async (base, h) => {
    const download = h.portal.download.bind(h.portal);
    h.portal.download = async (s, f, sig) => {
      await new Promise((r) => setTimeout(r, 150));
      return download(s, f, sig);
    };
    const res = await post(`${base}/api/runs`, { type: 'full', chains: ['chain_a'] });
    assert.equal(res.status, 200);
    const { runId } = (await res.json()) as any;
    const busy = await post(`${base}/api/runs`, { type: 'deltas' });
    assert.equal(busy.status, 409);
    await h.engine.idle();

    const run = (await (await fetch(`${base}/api/runs/${runId}`)).json()) as any;
    assert.equal(run.run.status, 'succeeded');
    assert.equal(run.tasks.length, 2);
    assert.equal(run.chains[0].steps[0].name, 'login');

    const task = (await (await fetch(`${base}/api/tasks/${run.tasks[0].id}`)).json()) as any;
    assert.equal(task.steps.length, 7);
    assert.equal(task.raw_files[0].available, true);
    const raw = await fetch(`${base}/api/raw/${task.raw_files[0].id}`);
    assert.equal(raw.status, 200);
    assert.ok((await raw.arrayBuffer()).byteLength > 0);

    const overview = (await (await fetch(`${base}/api/overview`)).json()) as any;
    assert.equal(overview.recent[0].id, runId);
    assert.equal(overview.schedules.length, 3);
    const logs = (await (await fetch(`${base}/api/logs?run=${runId}&level=info`)).json()) as any[];
    assert.ok(logs.length > 0);
  });
});

test('API: rejects requests that could come from another site', async () => {
  await withServer(async (base) => {
    const noHeader = await post(`${base}/api/runs`, { type: 'full' }, {});
    assert.equal(noHeader.status, 403);
    // fetch() won't send a forged Host header; a raw request can.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/api/overview`, { headers: { host: 'evil.example.com' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

test('API: validates input', async () => {
  await withServer(async (base) => {
    assert.equal((await post(`${base}/api/runs`, { type: 'nope' })).status, 400);
    assert.equal((await post(`${base}/api/runs`, { type: 'full', chains: ['ghost'] })).status, 400);
    assert.equal((await fetch(`${base}/api/runs/999`)).status, 404);
    const badCron = await fetch(`${base}/api/schedules/deltas`, {
      method: 'PUT',
      headers: { 'x-sync-dashboard': '1' },
      body: JSON.stringify({ cron: 'every hour' }),
    });
    assert.equal(badCron.status, 400);
    const pause = await fetch(`${base}/api/schedules/deltas`, {
      method: 'PUT',
      headers: { 'x-sync-dashboard': '1' },
      body: JSON.stringify({ paused: true }),
    });
    assert.equal(((await pause.json()) as any).paused, 1);
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  });
});

test('dashboard page is served', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>Catalog sync<\/title>/);
  });
});

// ─── scheduler firing ───────────────────────────────────────────────────────

test('scheduler: fires a due schedule once, records overlap as skipped', async () => {
  const h = harness();
  publishChain(h, CHAIN_A, NO_A, ['001']);
  let now = Date.parse('2026-07-16T06:10:00Z'); // 09:10 Jerusalem
  for (const s of h.repo.schedules()) h.repo.updateSchedule(s.name, { last_fired_at: now }, now);
  const sched = new Scheduler(h.engine, h.repo, 'Asia/Jerusalem', new Logger(h.repo, {}, { stdoutLevel: 'silent' }), () => now);

  sched.tick();
  assert.equal(h.repo.listRuns().length, 0, 'nothing due yet');

  now = Date.parse('2026-07-16T07:00:30Z'); // 10:00:30
  sched.tick();
  let runs = h.repo.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].type, 'deltas');
  assert.equal(runs[0].scheduled_for, Date.parse('2026-07-16T07:00:00Z'));
  sched.tick();
  assert.equal(h.repo.listRuns().length, 1, 'not fired twice');

  // The next hour falls due while the run is still going.
  now = Date.parse('2026-07-16T08:00:10Z');
  sched.tick();
  runs = h.repo.listRuns();
  assert.equal(runs[0].status, 'skipped');
  assert.match(runs[0].reason!, /overlap: run #\d+ was still in progress/);
  await h.engine.idle();
});

test('scheduler: after a long sleep, one run starts and the rest are recorded as skipped', async () => {
  const h = harness();
  publishChain(h, CHAIN_A, NO_A, ['001']);
  const slept = Date.parse('2026-07-15T21:30:00Z'); // 00:30 Jerusalem
  for (const s of h.repo.schedules()) h.repo.updateSchedule(s.name, { last_fired_at: slept }, slept);
  const now = Date.parse('2026-07-16T04:20:00Z'); // 07:20 — stores, full and deltas all missed
  const sched = new Scheduler(h.engine, h.repo, 'Asia/Jerusalem', new Logger(h.repo, {}, { stdoutLevel: 'silent' }), () => now);
  sched.tick();
  const runs = h.repo.listRuns();
  const started = runs.filter((r) => r.status !== 'skipped');
  assert.equal(started.length, 1);
  assert.equal(started[0].type, 'full', 'the highest-priority schedule runs');
  assert.match(started[0].reason!, /late/);
  assert.deepEqual(runs.filter((r) => r.status === 'skipped').map((r) => r.type).sort(), ['deltas', 'stores']);
  await h.engine.idle();
});

test('scheduler: a paused schedule does not fire', () => {
  const h = harness();
  const t0 = Date.parse('2026-07-16T06:10:00Z');
  for (const s of h.repo.schedules()) h.repo.updateSchedule(s.name, { last_fired_at: t0, paused: 1 }, t0);
  const sched = new Scheduler(h.engine, h.repo, 'Asia/Jerusalem', new Logger(h.repo, {}, { stdoutLevel: 'silent' }), () => t0 + 5 * 3600_000);
  sched.tick();
  assert.equal(h.repo.listRuns().length, 0);
});
