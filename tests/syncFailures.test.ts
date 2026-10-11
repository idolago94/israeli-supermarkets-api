import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FailureCollector, buildFailure, normalizeMessage, stageOf, tagStage, withStage } from '../lib/syncFailures';

test('withStage tags the original error without replacing it', async () => {
  const original = new TypeError('boom');
  await assert.rejects(
    withStage('download', () => {
      throw original;
    }),
    (err) => {
      assert.equal(err, original);
      assert.equal(stageOf(err), 'download');
      return true;
    },
  );
});

test('the innermost stage wins', async () => {
  await assert.rejects(
    withStage('download', async () => {
      throw tagStage(new Error('bad gzip'), 'decompress');
    }),
    (err) => stageOf(err) === 'decompress',
  );
});

test('non-Error throws are wrapped so they can carry a stage', async () => {
  await assert.rejects(
    withStage('parse', () => {
      throw 'plain string';
    }),
    (err: Error) => err instanceof Error && err.message === 'plain string' && stageOf(err) === 'parse',
  );
});

test('buildFailure captures context, stage, stack and cause', () => {
  const err = tagStage(Object.assign(new Error('download failed (503) for x.gz'), { cause: new Error('socket hang up') }), 'download');
  const f = buildFailure('deltas', { level: 'file', error: err, chain: 'rami_levy', storeId: '039', file: 'x.gz' }, new Date('2026-10-11T11:17:58Z'));
  assert.equal(f.flow, 'deltas');
  assert.equal(f.level, 'file');
  assert.equal(f.stage, 'download');
  assert.equal(f.chain, 'rami_levy');
  assert.equal(f.storeId, '039');
  assert.equal(f.file, 'x.gz');
  assert.equal(f.occurredAt, '2026-10-11T11:17:58.000Z');
  assert.match(f.stack ?? '', /download failed/);
  assert.match(f.cause ?? '', /socket hang up/);
  assert.match(f.fingerprint, /^[0-9a-f]{16}$/);
});

test('buildFailure falls back to the stage hint, then unknown', () => {
  assert.equal(buildFailure('full', { level: 'flow', error: new Error('x'), stage: 'login' }).stage, 'login');
  assert.equal(buildFailure('full', { level: 'flow', error: new Error('x') }).stage, 'unknown');
});

test('binary body previews are stripped of control characters', () => {
  const f = buildFailure('deltas', { level: 'file', error: new Error('invalid gzip; body starts: PK\u0003\u0004\u0014\u0000') });
  assert.equal(f.message, 'invalid gzip; body starts: PK');
});

test('the same problem on different files, stores and requests shares a fingerprint', () => {
  const a = buildFailure('deltas', {
    level: 'file',
    error: tagStage(new Error('invalid gzip for price7290058140886-039-202607151000.gz (14207 bytes): incorrect header check; body starts: PK..'), 'decompress'),
    chain: 'rami_levy',
    storeId: '039',
  });
  const b = buildFailure('deltas', {
    level: 'file',
    error: tagStage(new Error('invalid gzip for price7290058140886-040-202607151100.gz (9000 bytes): incorrect header check; body starts: PK!!'), 'decompress'),
    chain: 'rami_levy',
    storeId: '040',
  });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(
    normalizeMessage('HTTP 500: FUNCTION_INVOCATION_FAILED sfo1::vj9vb-1791355822855-b17fd693eeb3'),
    normalizeMessage('HTTP 500: FUNCTION_INVOCATION_FAILED iad1::abcde-1791355934327-7dbc332cdfb3'),
  );
});

test('different chains, flows or stages get different fingerprints', () => {
  const base = { level: 'file' as const, error: tagStage(new Error('download failed (503)'), 'download') };
  const a = buildFailure('deltas', { ...base, chain: 'rami_levy' }).fingerprint;
  assert.notEqual(a, buildFailure('deltas', { ...base, chain: 'osher_ad' }).fingerprint);
  assert.notEqual(a, buildFailure('full', { ...base, chain: 'rami_levy' }).fingerprint);
  assert.notEqual(
    a,
    buildFailure('deltas', { level: 'file', chain: 'rami_levy', error: tagStage(new Error('download failed (503)'), 'parse') }).fingerprint,
  );
});

test('FailureCollector.record is usable as a detached sink', () => {
  const c = new FailureCollector('full');
  const sink = c.record;
  sink({ level: 'file', error: new Error('x'), chain: 'tiv_taam' });
  assert.equal(c.failures.length, 1);
  assert.equal(c.failures[0].flow, 'full');
});
