import './mongoEnv';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as cerberus from '../lib/cerberus';
import * as mongo from '../lib/mongo';
import { planDeltaFiles, syncChainDeltas, syncChainFull, validDeltaCursors } from '../lib/sync';
import { FailureInput, tagStage } from '../lib/syncFailures';
import { PRICE_XML } from './helpers';

const RAMI = { id: 'rami_levy', nameHe: 'רמי לוי', username: 'RamiLevi' };
const LEGACY = 'price7290058140886-039-202607151000.gz';

// ─── Stubs: the Cerberus portal and the Mongo collections ─────────────────────

let listing: string[];
let badFiles: Map<string, Error>;
let emptyFiles: Set<string>;
let downloads: string[];
let state: any;
let cursorWrites: Record<string, string>[];
let stateWrites: any[];
let bulkWrites: number;

beforeEach(() => {
  listing = [];
  badFiles = new Map();
  emptyFiles = new Set();
  downloads = [];
  state = null;
  cursorWrites = [];
  stateWrites = [];
  bulkWrites = 0;

  const c = cerberus as any;
  c.cerberusLogin = async () => 'cookie';
  c.cerberusListFiles = async (_cookie: string, search: string) =>
    listing.filter((f) => f.toLowerCase().includes(search.toLowerCase()));
  c.headFileMeta = async () => ({ size: '1', modified: 'x' });
  c.downloadFile = async (_cookie: string, file: string) => {
    downloads.push(file);
    const err = badFiles.get(file);
    if (err) throw err;
    return emptyFiles.has(file) ? '<Root><Items></Items></Root>' : PRICE_XML;
  };

  const m = mongo as any;
  m.syncState = async () => ({
    findOne: async () => state,
    updateOne: async (_filter: unknown, update: any) => {
      const set = { ...update.$set };
      delete set.updatedAt;
      if (Object.keys(set).some((k) => k.startsWith('lastDeltaTimestamps.'))) cursorWrites.push(set);
      else stateWrites.push(set);
    },
  });
  m.products = async () => ({
    bulkWrite: async () => {
      bulkWrites++;
    },
  });
});

function collectFailures() {
  const failures: FailureInput[] = [];
  return { failures, onFailure: (f: FailureInput) => failures.push(f) };
}

// ─── Pure planning helpers ────────────────────────────────────────────────────

test('validDeltaCursors drops cursors written by the old chain-id parser', () => {
  assert.deepEqual(validDeltaCursors({ '001': '729005814088', '002': '20261011070012', '': '20261011070012' }), {
    '002': '20261011070012',
  });
  assert.deepEqual(validDeltaCursors(undefined), {});
});

test('planDeltaFiles: newer files oldest-first; a branch without a cursor gets only its newest file', () => {
  const files = [
    'Price7290058140886-001-001-20261011-090000.gz',
    'Price7290058140886-001-001-20261011-070000.gz',
    'Price7290058140886-001-001-20261011-050000.gz',
    'Price7290058140886-001-002-20261011-080000.gz',
    'Price7290058140886-001-002-20261011-090000.gz',
    'Price7290058140886-9999.gz',
  ];
  const { byStore, unrecognized } = planDeltaFiles(files, { '001': '20261011060000' });
  assert.deepEqual(byStore.get('001'), [
    'Price7290058140886-001-001-20261011-070000.gz',
    'Price7290058140886-001-001-20261011-090000.gz',
  ]);
  assert.deepEqual(byStore.get('002'), ['Price7290058140886-001-002-20261011-090000.gz']);
  assert.deepEqual(unrecognized, ['Price7290058140886-9999.gz']);
});

// ─── syncChainDeltas ──────────────────────────────────────────────────────────

test('deltas: the stale legacy ZIP file that broke every run is no longer touched', async () => {
  listing = [LEGACY, 'Price7290058140886-001-001-20261011-070012.gz'];
  state = { _id: 'rami_levy', lastDeltaTimestamps: { '001': '729005814088' } }; // legacy cursor
  badFiles.set(LEGACY, tagStage(new Error(`invalid gzip for ${LEGACY}`), 'decompress'));
  const { failures, onFailure } = collectFailures();

  const result: any = await syncChainDeltas(RAMI, { onFailure });

  assert.deepEqual(downloads, ['Price7290058140886-001-001-20261011-070012.gz']);
  assert.equal(result.filesProcessed, 1);
  assert.equal(failures.length, 0);
  assert.deepEqual(cursorWrites, [{ 'lastDeltaTimestamps.001': '20261011070012' }]);
});

test('deltas: a bad file fails only its branch, is reported, and keeps that branch’s cursor', async () => {
  listing = [
    'Price7290058140886-001-001-20261011-070000.gz',
    'Price7290058140886-001-001-20261011-080000.gz',
    'Price7290058140886-001-001-20261011-090000.gz',
    'Price7290058140886-001-002-20261011-080000.gz',
  ];
  state = { _id: 'rami_levy', lastDeltaTimestamps: { '001': '20261011060000', '002': '20261011060000' } };
  const bad = 'Price7290058140886-001-001-20261011-080000.gz';
  badFiles.set(bad, tagStage(new Error(`invalid gzip for ${bad} (10 bytes): incorrect header check`), 'decompress'));
  const { failures, onFailure } = collectFailures();

  const result: any = await syncChainDeltas(RAMI, { onFailure });

  assert.equal(result.filesProcessed, 2); // 001@07:00 and 002@08:00
  assert.deepEqual(result.storesFailed, ['001']);
  // 001 stops at the bad file: 09:00 is not applied over the gap.
  assert.ok(!downloads.includes('Price7290058140886-001-001-20261011-090000.gz'));
  assert.deepEqual(
    cursorWrites.sort((a, b) => Object.keys(a)[0].localeCompare(Object.keys(b)[0])),
    [{ 'lastDeltaTimestamps.001': '20261011070000' }, { 'lastDeltaTimestamps.002': '20261011080000' }],
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].level, 'file');
  assert.equal(failures[0].chain, 'rami_levy');
  assert.equal(failures[0].storeId, '001');
  assert.equal(failures[0].file, bad);
});

test('deltas: past the deadline no new file starts; the rest is reported as pending', async () => {
  listing = [
    'Price7290058140886-001-001-20261011-070000.gz',
    'Price7290058140886-001-001-20261011-080000.gz',
    'Price7290058140886-001-002-20261011-080000.gz',
  ];
  state = { _id: 'rami_levy', lastDeltaTimestamps: { '001': '20261011060000', '002': '20261011060000' } };

  const result: any = await syncChainDeltas(RAMI, { deadline: Date.now() - 1 });

  assert.deepEqual(downloads, []);
  assert.deepEqual(cursorWrites, []);
  assert.equal(result.filesProcessed, 0);
  assert.equal(result.filesPending, 3);
});

test('deltas: the deadline stops a branch mid-backlog, keeping its cursor at the last applied file', async () => {
  listing = [
    'Price7290058140886-001-001-20261011-070000.gz',
    'Price7290058140886-001-001-20261011-080000.gz',
    'Price7290058140886-001-001-20261011-090000.gz',
  ];
  state = { _id: 'rami_levy', lastDeltaTimestamps: { '001': '20261011060000' } };
  // The first download uses up the budget.
  const realNow = Date.now;
  let clock = 1_000;
  Date.now = () => clock;
  const download = (cerberus as any).downloadFile;
  (cerberus as any).downloadFile = async (cookie: string, file: string) => {
    clock = 10_000;
    return download(cookie, file);
  };

  let result: any;
  try {
    result = await syncChainDeltas(RAMI, { deadline: 5_000 });
  } finally {
    Date.now = realNow;
  }

  assert.deepEqual(downloads, ['Price7290058140886-001-001-20261011-070000.gz']);
  assert.deepEqual(cursorWrites, [{ 'lastDeltaTimestamps.001': '20261011070000' }]);
  assert.equal(result.filesProcessed, 1);
  assert.equal(result.filesPending, 2);
});

test('deltas: flow-level failures still throw, tagged with their stage', async () => {
  (cerberus as any).cerberusListFiles = async () => {
    throw new Error('file listing failed (502)');
  };
  await assert.rejects(syncChainDeltas(RAMI), (err: any) => err.syncStage === 'list-files');
});

// ─── syncChainFull ────────────────────────────────────────────────────────────

test('full: a failing branch is reported and its cursor is left alone; legacy cursors are cleaned up', async () => {
  listing = [
    'PriceFull7290058140886-001-001-20261011-001008.gz',
    'PriceFull7290058140886-001-002-20261011-001010.gz',
    'pricefull7290058140886-039-202607150513.gz', // stale legacy: ignored
  ];
  state = { _id: 'rami_levy', lastDeltaTimestamps: { '001': '729005814088', '': '729005814088' } };
  badFiles.set('PriceFull7290058140886-001-002-20261011-001010.gz', tagStage(new Error('download failed (503)'), 'download'));
  const { failures, onFailure } = collectFailures();

  const result: any = await syncChainFull(RAMI, { onFailure });

  assert.equal(result.stores, 2);
  assert.deepEqual(result.storesFailed, ['002']);
  assert.ok(!downloads.includes('pricefull7290058140886-039-202607150513.gz'));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].storeId, '002');
  assert.equal(bulkWrites, 1);
  // Only the successful branch's cursor is set; junk cursors are gone, and
  // the "unchanged" signature isn't saved while a branch failed.
  assert.deepEqual(stateWrites, [{ lastDeltaTimestamps: { '001': '20261011001008' } }]);
});

test('full: a branch file that parses to zero items is reported, not silently dropped', async () => {
  listing = [
    'PriceFull7290058140886-001-001-20261011-001008.gz',
    'pricefull7290058140886-039-202610110515.gz',
  ];
  emptyFiles.add('pricefull7290058140886-039-202610110515.gz');
  const { failures, onFailure } = collectFailures();

  const result: any = await syncChainFull(RAMI, { onFailure });

  assert.deepEqual(result.storesFailed, ['039']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].storeId, '039');
  assert.equal((failures[0].error as any).syncStage, 'parse');
  assert.match(String(failures[0].error), /parsed to zero items/);
});

test('deltas: an empty delta file is fine (nothing changed at that branch)', async () => {
  listing = ['Price7290058140886-001-001-20261011-070000.gz'];
  state = { _id: 'rami_levy', lastDeltaTimestamps: { '001': '20261011060000' } };
  emptyFiles.add('Price7290058140886-001-001-20261011-070000.gz');
  const { failures, onFailure } = collectFailures();
  const result: any = await syncChainDeltas(RAMI, { onFailure });
  assert.equal(result.filesProcessed, 1);
  assert.equal(failures.length, 0);
});
