import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import postgres from 'postgres';
import { postgresTarget, Target } from '../src/target';

// Exercises lib/v2Writer.ts against a real Postgres with the catalog v2
// migrations applied (supabase/migrations/*.sql). Skipped unless
// SYNC_TEST_DATABASE_URL is set — it truncates the catalog tables.

const url = process.env.SYNC_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'SYNC_TEST_DATABASE_URL not set' };

let sql: postgres.Sql;
let target: Target;
const chain = { id: 'test_chain', nameHe: 'בדיקה', username: 'test' };
const item = (code: string, price: number, name = `מוצר ${code}`) => ({ code, name, price });

before(async () => {
  if (!url) return;
  sql = postgres(url, { onnotice: () => {} });
  target = postgresTarget(url);
  await sql`truncate prices, products, stores, chains restart identity cascade`;
  await target.upsertChain(chain);
});
after(async () => {
  if (!url) return;
  await target.close();
  await sql.end();
});

test('writeBranchFull writes a branch atomically and removes items no longer listed', opts, async () => {
  const file = 'PriceFull1-001-001-20261113-030000.gz';
  let r = await target.writeBranchFull({
    chainId: chain.id, storeCode: '001', file, size: '10', modified: 'm1',
    items: [item('1000001', 5), item('1000002', 7), item('1000003', 9)],
  });
  assert.equal(r.rowsWritten, 3);
  assert.equal(r.priceChanges, 3);

  r = await target.writeBranchFull({
    chainId: chain.id, storeCode: '001', file, size: '11', modified: 'm2',
    items: [item('1000001', 5), item('1000002', 8)],
  });
  assert.equal(r.rowsDeleted, 1);
  assert.equal(r.priceChanges, 1);
  const states = await target.loadStoreStates(chain.id);
  assert.deepEqual(states.get('001'), {
    id: states.get('001')!['id' as never],
    lastPriceFile: file, lastPriceSize: '11', lastPriceModified: 'm2', lastDeltaTs: '20261113030000',
  });
});

test('a failing branch write leaves nothing behind', opts, async () => {
  const before = await sql`select count(*)::int as n from prices`;
  await assert.rejects(
    target.writeBranchFull({
      chainId: chain.id, storeCode: '002', file: 'PriceFull1-001-002-20261113-030000.gz', size: '1', modified: 'm',
      // A non-numeric price fails the prices insert — after the products were
      // already upserted in the same transaction.
      items: [item('2000001', 5), item('2000002', 'not-a-price' as unknown as number)],
    }),
  );
  const after = await sql`select count(*)::int as n from prices`;
  assert.equal(after[0].n, before[0].n);
  const products = await sql`select count(*)::int as n from products where barcode like '200000%'`;
  assert.equal(products[0].n, 0, 'products rolled back too');
});

test('writeBranchDelta upserts only listed rows, advances the cursor, never applies twice', opts, async () => {
  const d1 = 'Price1-001-001-20261113-090000.gz';
  let r = await target.writeBranchDelta({ chainId: chain.id, storeCode: '001', file: d1, items: [item('1000002', 6.5), item('1000009', 3)] });
  assert.equal(r.rowsWritten, 2);
  const rows = await sql`select p.barcode, pr.price::float as price from prices pr join products p on p.id = pr.product_id
    join stores s on s.id = pr.store_id where s.store_code = '001' order by p.barcode`;
  assert.deepEqual(rows.map((x) => [x.barcode, x.price]), [['1000001', 5], ['1000002', 6.5], ['1000009', 3]]);

  r = await target.writeBranchDelta({ chainId: chain.id, storeCode: '001', file: d1, items: [item('1000002', 1)] });
  assert.equal(r.alreadyApplied, true);
  const older = await target.writeBranchDelta({ chainId: chain.id, storeCode: '001', file: 'Price1-001-001-20261113-020000.gz', items: [item('1000002', 1)] });
  assert.equal(older.alreadyApplied, true, 'a file older than the full snapshot is ignored');
  assert.equal((await target.loadStoreStates(chain.id)).get('001')!.lastDeltaTs, '20261113090000');
});

test('recomputeNames picks the shortest name across stores', opts, async () => {
  await target.writeBranchFull({
    chainId: chain.id, storeCode: '003', file: 'PriceFull1-001-003-20261113-030000.gz', size: '1', modified: 'm',
    items: [item('1000001', 4, 'חלב')],
  });
  const [{ id }] = await sql`select id from products where barcode = '1000001'`;
  await target.recomputeNames([id]);
  const [p] = await sql`select name, keywords from products where id = ${id}`;
  assert.equal(p.name, 'חלב');
  assert.ok(p.keywords.includes('מו'));
});

test('concurrent branch writes over overlapping products do not deadlock', opts, async () => {
  const many = (offset: number) => Array.from({ length: 3000 }, (_, i) => item(String(5000000 + ((i * 7 + offset) % 3000)), 1 + (i % 9)));
  const writes = Array.from({ length: 6 }, (_, b) =>
    target.writeBranchFull({
      chainId: chain.id, storeCode: `1${b}0`, file: `PriceFull1-001-1${b}0-20261113-030000.gz`, size: '1', modified: 'm',
      items: many(b * 13),
    }),
  );
  const results = await Promise.all(writes);
  assert.ok(results.every((r) => r.rowsWritten === 3000));
});
