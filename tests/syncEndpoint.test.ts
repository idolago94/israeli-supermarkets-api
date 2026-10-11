import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runSyncEndpoint, SyncEndpointSpec } from '../lib/syncEndpoint';
import { IssueReportResult, ReportContext, reportSyncFailuresSafely } from '../lib/githubIssues';
import { SyncFailure, tagStage } from '../lib/syncFailures';
import { ChainConfig } from '../lib/cerberus';
import { FakeGitHub, fakeReqRes } from './helpers';

const CHAINS: ChainConfig[] = [
  { id: 'rami_levy', nameHe: 'רמי לוי', username: 'RamiLevi' },
  { id: 'osher_ad', nameHe: 'אושר עד', username: 'osherad' },
];

beforeEach(() => {
  process.env.SYNC_SECRET = 'secret';
});

function spec(run: SyncEndpointSpec['run'], report?: SyncEndpointSpec['report']): SyncEndpointSpec {
  return { flow: 'deltas', chains: CHAINS, findChain: (id) => CHAINS.find((c) => c.id === id), run, report };
}

function recordingReporter() {
  const calls: { failures: SyncFailure[]; ctx: ReportContext }[] = [];
  const report = async (failures: SyncFailure[], ctx: ReportContext): Promise<IssueReportResult> => {
    calls.push({ failures, ctx });
    return { status: 'reported', issues: [], errors: [] };
  };
  return { calls, report };
}

test('a flow failure keeps the original 500 and error message, and is reported with its stage', async () => {
  const { calls, report } = recordingReporter();
  const { req, res } = fakeReqRes({ chain: 'rami_levy' }, { 'x-vercel-id': 'fra1::abc' });
  await runSyncEndpoint(req, res, spec(async () => {
    throw tagStage(new Error('file listing failed (502)'), 'list-files');
  }, report));

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Error: file listing failed (502)');
  assert.equal(calls.length, 1);
  const [f] = calls[0].failures;
  assert.equal(f.level, 'flow');
  assert.equal(f.stage, 'list-files');
  assert.equal(f.chain, 'rami_levy');
  assert.deepEqual(calls[0].ctx.params, { flow: 'deltas', chain: 'rami_levy' });
  assert.deepEqual(calls[0].ctx.logs?.[0].value, 'fra1::abc');
  assert.equal(res.body.issueReport.status, 'reported');
});

test('file-level failures handled inside a successful flow are still reported', async () => {
  const { calls, report } = recordingReporter();
  const { req, res } = fakeReqRes({ chain: 'rami_levy' });
  await runSyncEndpoint(req, res, spec(async (chain, onFailure) => {
    onFailure({ level: 'file', error: tagStage(new Error('invalid gzip for a.gz'), 'decompress'), chain: chain.id, storeId: '039', file: 'a.gz' });
    return { chain: chain.id, filesProcessed: 10, storesFailed: ['039'] };
  }, report));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.result.filesProcessed, 10);
  assert.equal(res.body.failures.length, 1);
  assert.equal(res.body.failures[0].file, 'a.gz');
  assert.equal(calls[0].failures[0].stage, 'decompress');
});

test('a clean run reports nothing and keeps the original response shape', async () => {
  const { calls, report } = recordingReporter();
  const { req, res } = fakeReqRes({ chain: 'osher_ad' });
  await runSyncEndpoint(req, res, spec(async (chain) => ({ chain: chain.id }), report));
  assert.deepEqual(res.body, { ok: true, result: { chain: 'osher_ad' } });
  assert.equal(calls.length, 0);
});

test('all-chains mode reports each failing chain and keeps going', async () => {
  const { calls, report } = recordingReporter();
  const { req, res } = fakeReqRes({});
  await runSyncEndpoint(req, res, spec(async (chain) => {
    if (chain.id === 'rami_levy') throw Object.assign(new Error('boom'), { cause: new Error('ECONNRESET') });
    return { chain: chain.id };
  }, report));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.summary.rami_levy, 'error: Error: boom (cause: Error: ECONNRESET)');
  assert.deepEqual(res.body.summary.osher_ad, { chain: 'osher_ad' });
  assert.equal(calls[0].failures.length, 1);
  assert.equal(calls[0].ctx.params.chain, 'all');
});

test('GitHub being down never masks the sync error or changes the status', async () => {
  const gh = new FakeGitHub();
  gh.throwOn = /.*/;
  const report = (failures: SyncFailure[], ctx: ReportContext) =>
    reportSyncFailuresSafely(failures, ctx, { token: 't', repo: 'o/r', fetchImpl: gh.fetch });
  const { req, res } = fakeReqRes({ chain: 'rami_levy' });
  await runSyncEndpoint(req, res, spec(async () => {
    throw new Error('original sync error');
  }, report));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Error: original sync error');
  assert.equal(res.body.issueReport.status, 'failed');
});

test('even a reporter that throws cannot change the outcome', async () => {
  const { req, res } = fakeReqRes({ chain: 'rami_levy' });
  await runSyncEndpoint(req, res, spec(async (chain, onFailure) => {
    onFailure({ level: 'file', error: new Error('x'), chain: chain.id });
    return { ok: 1 };
  }, async () => {
    throw new Error('reporter exploded');
  }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.result, { ok: 1 });
  assert.equal(res.body.issueReport.status, 'failed');
});

test('x-sync-issue-reporting: caller delegates reporting but still returns failures', async () => {
  const { calls, report } = recordingReporter();
  const { req, res } = fakeReqRes({ chain: 'rami_levy' }, { 'x-sync-issue-reporting': 'caller' });
  await runSyncEndpoint(req, res, spec(async () => {
    throw new Error('boom');
  }, report));
  assert.equal(calls.length, 0);
  assert.equal(res.body.issueReport.status, 'delegated');
  assert.equal(res.body.failures[0].message, 'boom');
});

test('auth and unknown-chain rejections are not sync failures', async () => {
  const { calls, report } = recordingReporter();
  const bad = fakeReqRes({ chain: 'rami_levy' }, { 'x-sync-secret': 'wrong' });
  await runSyncEndpoint(bad.req, bad.res, spec(async () => ({}), report));
  assert.equal(bad.res.statusCode, 401);
  const unknown = fakeReqRes({ chain: 'nope' });
  await runSyncEndpoint(unknown.req, unknown.res, spec(async () => ({}), report));
  assert.equal(unknown.res.statusCode, 400);
  assert.equal(calls.length, 0);
});
