import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'zlib';
import {
  decompressFileBody,
  fileTimestamp,
  isFileTimestamp,
  pickLatestFile,
  storeIdFromFileName,
  unzipFirstEntry,
} from '../lib/cerberus';
import { stageOf } from '../lib/syncFailures';
import { makeZip } from './helpers';

// Real names from the portal listing (2026-10-11).
const CURRENT = 'Price7290058140886-001-039-20261011-070012.gz';
const CURRENT_FULL = 'PriceFull7290103152017-001-010-20261011-080003.gz';
const LEGACY = 'price7290058140886-039-202607151000.gz';
const STORES = 'Stores7290058140886-000-20261009-050500.xml';

test('fileTimestamp reads the dashed date-time, never the chain id', () => {
  assert.equal(fileTimestamp(CURRENT), '20261011070012');
  assert.equal(fileTimestamp(CURRENT_FULL), '20261011080003');
  assert.equal(fileTimestamp(STORES), '20261009050500');
});

test('fileTimestamp reads the legacy 12-digit timestamp, padding seconds', () => {
  assert.equal(fileTimestamp(LEGACY), '20260715100000');
});

test('fileTimestamp returns empty for a name without a timestamp', () => {
  assert.equal(fileTimestamp('Price7290058140886.gz'), '');
});

test('files of one chain now order by publish time', () => {
  const files = [
    'Price7290058140886-001-039-20261011-090000.gz',
    'Price7290058140886-001-039-20261011-070012.gz',
    'Price7290058140886-001-039-20261010-230000.gz',
  ];
  assert.equal(pickLatestFile(files), 'Price7290058140886-001-039-20261011-090000.gz');
});

test('isFileTimestamp rejects cursors produced by the old chain-id parser', () => {
  assert.equal(isFileTimestamp('20261011070012'), true);
  assert.equal(isFileTimestamp('729005814088'), false);
  assert.equal(isFileTimestamp(''), false);
  assert.equal(isFileTimestamp(undefined), false);
});

test('storeIdFromFileName handles both layouts', () => {
  assert.equal(storeIdFromFileName(CURRENT), '039');
  assert.equal(storeIdFromFileName(CURRENT_FULL), '010');
  assert.equal(storeIdFromFileName(LEGACY), '039');
  assert.equal(storeIdFromFileName('pricefull7290058140886-039-202607150513.gz'), '039');
  assert.equal(storeIdFromFileName('Price7290803800003-000-001-20261011-164000.gz'), '001');
  assert.equal(storeIdFromFileName('PriceFull7290803800003-7999-202405211349.gz'), null);
});

test('decompressFileBody gunzips a gzip body', () => {
  const out = decompressFileBody(gzipSync(Buffer.from('<Root/>')), CURRENT);
  assert.equal(out.toString(), '<Root/>');
});

test('decompressFileBody extracts a ZIP served under a .gz name (the rami_levy failure)', () => {
  const xml = Buffer.from('<Root><Items/></Root>');
  const zipped = makeZip('Price7290058140886-039-202607151000.xml', xml);
  assert.equal(zipped.subarray(0, 2).toString(), 'PK');
  assert.equal(decompressFileBody(zipped, LEGACY).toString(), xml.toString());
});

test('unzipFirstEntry handles stored entries and data descriptors', () => {
  const xml = Buffer.from('<Root>stored</Root>');
  assert.equal(unzipFirstEntry(makeZip('a.xml', xml, { method: 0 })).toString(), xml.toString());
  assert.equal(unzipFirstEntry(makeZip('a.xml', xml, { dataDescriptor: true })).toString(), xml.toString());
});

test('decompressFileBody passes a plain .xml body through', () => {
  assert.equal(decompressFileBody(Buffer.from('<Root/>'), STORES).toString(), '<Root/>');
});

test('a non-archive body under .gz fails with a decompress-stage error naming the file', () => {
  const html = Buffer.from('<html>rate limited</html>');
  assert.throws(
    () => decompressFileBody(html, CURRENT),
    (err: Error) => {
      assert.match(err.message, /invalid gzip for Price7290058140886-001-039-20261011-070012\.gz/);
      assert.match(err.message, /body starts: <html>rate limited/);
      assert.equal(stageOf(err), 'decompress');
      return true;
    },
  );
});

test('a corrupt ZIP fails as a decompress-stage error', () => {
  const broken = makeZip('a.xml', Buffer.from('x')).subarray(0, 20);
  assert.throws(() => decompressFileBody(broken, LEGACY), (err: Error) => {
    assert.match(err.message, /invalid zip for/);
    assert.equal(stageOf(err), 'decompress');
    return true;
  });
});
