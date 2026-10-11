import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Attempt, collectFailures, readAttempts, workflowContext } from '../scripts/report-sync-failures';
import { buildFailure, tagStage } from '../lib/syncFailures';

function attempt(n: number, httpStatus: number, body: string, curlRc = 0): Attempt {
  return { n, curlRc, httpStatus, body, startedAt: `2026-10-07T06:5${n}:00Z`, vercelId: `sfo1::id${n}-1791355822855-b17fd693eeb3` };
}

test('a crashed function (non-JSON 500) on every retry becomes one flow-level problem', () => {
  const crash = 'A server error has occurred\n\nFUNCTION_INVOCATION_FAILED\n\nsfo1::vj9vb-1791355822855-b17fd693eeb3';
  const failures = collectFailures([attempt(1, 500, crash), attempt(2, 500, crash), attempt(3, 500, crash)], 'full', 'rami_levy');
  assert.equal(failures.length, 3);
  assert.equal(new Set(failures.map((f) => f.fingerprint)).size, 1);
  assert.equal(failures[0].stage, 'request');
  assert.equal(failures[0].level, 'flow');
  assert.match(failures[0].message, /HTTP 500 from the full sync endpoint: A server error has occurred FUNCTION_INVOCATION_FAILED/);
  assert.equal(failures[0].stack, undefined);
});

test('curl transport failures are described', () => {
  const [f] = collectFailures([attempt(1, 0, '', 28)], 'deltas', 'rami_levy');
  assert.match(f.message, /curl exit 28 \(timed out\)/);
});

test('failures the endpoint returned are reported, without synthesising a duplicate', () => {
  const flowFailure = buildFailure('deltas', { level: 'flow', error: tagStage(new Error('file listing failed (502)'), 'list-files'), chain: 'rami_levy' });
  const body = JSON.stringify({ error: 'Error: file listing failed (502)', failures: [flowFailure], issueReport: { status: 'delegated' } });
  const failures = collectFailures([attempt(1, 500, body)], 'deltas', 'rami_levy');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].stage, 'list-files');
  assert.equal(failures[0].fingerprint, flowFailure.fingerprint);
});

test('file-level failures on a successful response are reported', () => {
  const fileFailure = buildFailure('full', { level: 'file', error: new Error('download failed (503)'), chain: 'rami_levy', storeId: '002', file: 'f.gz' });
  const body = JSON.stringify({ ok: true, result: {}, failures: [fileFailure], issueReport: { status: 'delegated' } });
  assert.equal(collectFailures([attempt(1, 200, body)], 'full', 'rami_levy').length, 1);
});

test('failures the endpoint already filed are skipped', () => {
  const f = buildFailure('full', { level: 'file', error: new Error('x'), chain: 'rami_levy' });
  const body = JSON.stringify({ ok: true, failures: [f], issueReport: { status: 'reported' } });
  assert.equal(collectFailures([attempt(1, 200, body)], 'full', 'rami_levy').length, 0);
});

test('a transient failure that recovered on retry is still reported, marked as recovered', () => {
  const attempts = [attempt(1, 504, 'gateway timeout'), attempt(2, 200, JSON.stringify({ ok: true, result: {} }))];
  const failures = collectFailures(attempts, 'deltas', 'tiv_taam');
  assert.equal(failures.length, 1);
  const ctx = workflowContext(attempts, {
    MODE: 'deltas',
    CHAIN: 'tiv_taam',
    FORCE: 'false',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'schedule',
    SCHEDULE: '0 5,9,13,17 * * *',
  });
  assert.equal(ctx.details?.['Job outcome'], 'succeeded on attempt 2');
  assert.equal(ctx.details?.['Request attempts'], '#1: HTTP 504, #2: HTTP 200');
  assert.equal(ctx.logs?.[0].value, 'https://github.com/o/r/actions/runs/42/attempts/1');
  assert.deepEqual(ctx.params, { flow: 'deltas', chain: 'tiv_taam', force: false, trigger: 'schedule', schedule: '0 5,9,13,17 * * *' });
});

test('readAttempts parses the files the workflow writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-attempts-'));
  writeFileSync(join(dir, 'attempt-1.json'), '{"error":"x"}');
  writeFileSync(join(dir, 'attempt-1.meta'), 'curl_rc=0\nhttp_status=500\nvercel_id=fra1::a\nstarted_at=2026-10-11T11:17:58Z\n');
  writeFileSync(join(dir, 'attempt-2.meta'), 'curl_rc=28\nhttp_status=000\nvercel_id=\nstarted_at=2026-10-11T11:28:00Z\n');
  const attempts = readAttempts(dir);
  assert.deepEqual(attempts.map((a) => [a.n, a.curlRc, a.httpStatus, a.vercelId, a.body]), [
    [1, 0, 500, 'fra1::a', '{"error":"x"}'],
    [2, 28, 0, undefined, ''],
  ]);
});
