import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropStaleFiles, latestFilePerStore } from '../lib/branches';

test('dropStaleFiles drops files older than the window relative to the newest one', () => {
  const files = [
    'PriceFull7290058140886-001-001-20261011-001008.gz',
    'PriceFull7290058140886-001-001-20261005-001008.gz', // 6 days older: kept
    'pricefull7290058140886-039-202607150513.gz', // July legacy: dropped
    'PriceFull7290058140886.gz', // no timestamp: dropped
  ];
  assert.deepEqual(dropStaleFiles(files), files.slice(0, 2));
});

test('dropStaleFiles keeps the latest files when a chain paused publishing', () => {
  const files = ['PriceFull7290058140886-001-001-20260101-001008.gz'];
  assert.deepEqual(dropStaleFiles(files), files);
});

test('latestFilePerStore picks the newest file per branch and ignores stale legacy branches', () => {
  const files = [
    'PriceFull7290058140886-001-001-20261010-001008.gz',
    'PriceFull7290058140886-001-001-20261011-001008.gz',
    'PriceFull7290058140886-001-002-20261011-001500.gz',
    'pricefull7290058140886-039-202607150513.gz',
  ];
  assert.deepEqual(latestFilePerStore(files), [
    { storeId: '001', file: 'PriceFull7290058140886-001-001-20261011-001008.gz' },
    { storeId: '002', file: 'PriceFull7290058140886-001-002-20261011-001500.gz' },
  ]);
});
