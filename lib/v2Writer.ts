import type postgres from 'postgres';
import { ChainConfig, fileTimestamp } from './cerberus';
import { ParsedItem, generateKeywords, pickCanonicalName } from './parse';
import { ParsedStore } from './stores';

// ─── Catalog v2 writes (Postgres) ───────────────────────────────────────────────
//
// Every write the v2 sync makes, as functions that take the connection (or an
// open transaction) as their first argument instead of importing lib/pg.ts.
// Two callers:
//   - lib/syncV2.ts, the Vercel /api/v2/sync/full endpoint, which passes the
//     shared pooled client;
//   - sync-service/, the local sync service, which opens its own client and
//     writes each branch in its own transaction (writeBranchFull /
//     writeBranchDelta), so a branch either lands completely or not at all.
// Not importing lib/pg.ts also means loading this module never requires
// DATABASE_URL, so it can be unit-tested and used by tooling.

/** A client or an open transaction — every helper works with either. */
export type Db = postgres.ISql<{}>;
/** Something that can open a transaction (a client, not a transaction). */
export type TxDb = Pick<postgres.Sql<{}>, 'begin'>;

// Row count per multi-row INSERT — comfortably under Postgres' 65535 bind
// parameter ceiling even at ~10 columns/row, without one insert per row.
export const UPSERT_CHUNK_SIZE = 2000;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ─── chains ───────────────────────────────────────────────────────────────────

export async function upsertChain(db: Db, chain: ChainConfig): Promise<void> {
  await db`
    insert into chains (id, name_he, username, store_id_override)
    values (${chain.id}, ${chain.nameHe}, ${chain.username}, ${chain.storeId ?? null})
    on conflict (id) do update set
      name_he = excluded.name_he,
      username = excluded.username,
      store_id_override = excluded.store_id_override,
      updated_at = now()
  `;
}

// ─── stores (branch directory) ─────────────────────────────────────────────────

export interface StoreRow {
  id: number;
  lastPriceFile: string | null;
  lastPriceSize: string | null;
  lastPriceModified: string | null;
  /** fileTimestamp() of the newest delta (or full) file applied to this branch. */
  lastDeltaTs: string | null;
}

export async function loadStoreRows(db: Db, chainId: string): Promise<Map<string, StoreRow>> {
  const rows = await db<
    {
      id: number;
      store_code: string;
      last_price_file: string | null;
      last_price_size: string | null;
      last_price_modified: string | null;
      last_delta_ts: string | null;
    }[]
  >`
    select id, store_code, last_price_file, last_price_size, last_price_modified, last_delta_ts
    from stores where chain_id = ${chainId}
  `;
  const map = new Map<string, StoreRow>();
  for (const r of rows) {
    map.set(r.store_code, {
      id: r.id,
      lastPriceFile: r.last_price_file,
      lastPriceSize: r.last_price_size,
      lastPriceModified: r.last_price_modified,
      lastDeltaTs: r.last_delta_ts,
    });
  }
  return map;
}

/** Upserts branch directory metadata (name/address/city) from a parsed Stores
 *  file. Doesn't touch the per-branch price-change columns. */
export async function writeStores(db: Db, chainId: string, list: ParsedStore[]): Promise<number> {
  for (const batch of chunk(list, UPSERT_CHUNK_SIZE)) {
    const rows = batch.map((s) => ({
      chain_id: chainId,
      store_code: s.storeId,
      sub_chain_id: s.subChainId ?? null,
      name: s.name,
      address: s.address ?? null,
      city: s.city ?? null,
      zip_code: s.zipCode ?? null,
      store_type: s.storeType ?? null,
    }));
    await db`
      insert into stores ${db(rows, 'chain_id', 'store_code', 'sub_chain_id', 'name', 'address', 'city', 'zip_code', 'store_type')}
      on conflict (chain_id, store_code) do update set
        sub_chain_id = excluded.sub_chain_id,
        name = excluded.name,
        address = excluded.address,
        city = excluded.city,
        zip_code = excluded.zip_code,
        store_type = excluded.store_type,
        updated_at = now()
    `;
  }
  return list.length;
}

/**
 * Creates a bare row for any branch that shows up in a price listing but
 * wasn't in the Stores file — defensive; every branch observed so far
 * publishes both, but a price row can't exist without a stores.id to point
 * at. Existing rows are left untouched.
 */
export async function ensureStoreRows(db: Db, chainId: string, storeCodes: string[]): Promise<void> {
  if (!storeCodes.length) return;
  for (const batch of chunk(storeCodes, UPSERT_CHUNK_SIZE)) {
    const rows = batch.map((code) => ({ chain_id: chainId, store_code: code, name: code }));
    await db`
      insert into stores ${db(rows, 'chain_id', 'store_code', 'name')}
      on conflict (chain_id, store_code) do nothing
    `;
  }
}

// ─── products ─────────────────────────────────────────────────────────────────

/**
 * Upserts the product-intrinsic fields (brand/measure/unitQty) and returns a
 * barcode -> id map. `name`/`name_lower` are only used to satisfy the
 * not-null columns on a brand-new row — on conflict they're left alone, owned
 * instead by recomputeNamesAndKeywords, which derives them from every store's
 * item_name, not just whichever item happened to upsert last.
 *
 * Rows are written in barcode order. Several branch transactions upsert
 * overlapping products at the same time; taking the row locks in one global
 * order is what keeps them from deadlocking each other.
 */
export async function upsertProducts(db: Db, items: ParsedItem[]): Promise<Map<string, number>> {
  const barcodeToId = new Map<string, number>();
  if (!items.length) return barcodeToId;

  const byBarcode = new Map<string, ParsedItem>();
  for (const item of items) byBarcode.set(item.code, item);
  const sorted = [...byBarcode.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  for (const batch of chunk(sorted, UPSERT_CHUNK_SIZE)) {
    const rows = batch.map((item) => ({
      barcode: item.code,
      name: item.name,
      name_lower: item.name.toLowerCase(),
      brand: item.brand ?? null,
      unit_qty: item.unitQty ?? null,
      measure_unit_qty: item.measureUnitQty ?? null,
      measure_quantity: item.quantity ?? null,
      measure_unit_of_measure: item.unitOfMeasure ?? null,
      measure_qty_in_package: item.qtyInPackage ?? null,
      measure_is_weighted: item.isWeighted ?? null,
    }));

    const result = await db<{ id: number; barcode: string }[]>`
      insert into products ${db(
        rows as any,
        'barcode', 'name', 'name_lower', 'brand', 'unit_qty',
        'measure_unit_qty', 'measure_quantity', 'measure_unit_of_measure',
        'measure_qty_in_package', 'measure_is_weighted',
      )}
      on conflict (barcode) do update set
        brand = coalesce(excluded.brand, products.brand),
        unit_qty = coalesce(excluded.unit_qty, products.unit_qty),
        measure_unit_qty = coalesce(excluded.measure_unit_qty, products.measure_unit_qty),
        measure_quantity = coalesce(excluded.measure_quantity, products.measure_quantity),
        measure_unit_of_measure = coalesce(excluded.measure_unit_of_measure, products.measure_unit_of_measure),
        measure_qty_in_package = coalesce(excluded.measure_qty_in_package, products.measure_qty_in_package),
        measure_is_weighted = coalesce(excluded.measure_is_weighted, products.measure_is_weighted),
        updated_at = now()
      returning id, barcode
    `;
    for (const r of result) barcodeToId.set(r.barcode, r.id);
  }
  return barcodeToId;
}

/**
 * Recomputes `name`/`name_lower` (shortest item_name across every store that
 * carries the product — pickCanonicalName, same rule as v1) and `keywords`
 * (union of generateKeywords over every one of those names) for a batch of
 * products, from their current `prices` rows. Run once per unique product
 * touched in a sync, after all of that sync's price rows are written — not
 * per store — so a product carried by 90 branches gets recomputed once, not
 * 90 times.
 */
export async function recomputeNamesAndKeywords(db: Db, productIds: number[]): Promise<number> {
  if (!productIds.length) return 0;
  let updated = 0;

  const sorted = [...new Set(productIds)].sort((a, b) => a - b);
  for (const batch of chunk(sorted, UPSERT_CHUNK_SIZE)) {
    const rows = await db<{ product_id: number; item_name: string }[]>`
      select product_id, item_name from prices where product_id = any(${batch})
    `;
    const namesByProduct = new Map<number, string[]>();
    for (const r of rows) {
      const arr = namesByProduct.get(r.product_id);
      if (arr) arr.push(r.item_name);
      else namesByProduct.set(r.product_id, [r.item_name]);
    }

    const updates = [...namesByProduct.entries()].map(([id, names]) => {
      const name = pickCanonicalName(names);
      const keywords = [...new Set(names.flatMap((n) => generateKeywords(n)))];
      return { id, name, name_lower: name.toLowerCase(), keywords };
    });
    if (!updates.length) continue;

    await db`
      update products p set
        name = u.name,
        name_lower = u.name_lower,
        keywords = u.keywords,
        updated_at = now()
      from (
        select * from jsonb_to_recordset(${db.json(updates as any)})
          as u(id integer, name text, name_lower text, keywords text[])
      ) as u
      where p.id = u.id
    `;
    updated += updates.length;
  }
  return updated;
}

// ─── prices ───────────────────────────────────────────────────────────────────

export interface PriceRow {
  product_id: number;
  store_id: number;
  item_name: string;
  price: number;
  unit_of_measure_price: number | null;
  allow_discount: boolean | null;
}

export async function upsertPrices(db: Db, rows: PriceRow[]): Promise<void> {
  if (!rows.length) return;
  for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
    await db`
      insert into prices ${db(batch, 'product_id', 'store_id', 'item_name', 'price', 'unit_of_measure_price', 'allow_discount')}
      on conflict (product_id, store_id) do update set
        item_name = excluded.item_name,
        price = excluded.price,
        unit_of_measure_price = excluded.unit_of_measure_price,
        allow_discount = excluded.allow_discount,
        updated_at = now()
    `;
  }
}

/** Removes this store's price rows for products that weren't in its latest
 *  file — a discontinued item, unlike v1 (Mongo), doesn't linger forever. One
 *  statement with an array-bound parameter, so it scales to a store's full
 *  item count (~7k) without hitting Postgres' per-statement param ceiling.
 *  An empty `keepProductIds` deletes nothing rather than everything — `<> all
 *  ([])` is vacuously true for every row, and callers already treat "zero
 *  items for a store" as a suspected parse failure, not a real empty store. */
export async function deleteStalePrices(db: Db, storeId: number, keepProductIds: number[]): Promise<number> {
  if (!keepProductIds.length) return 0;
  const result = await db`
    delete from prices
    where store_id = ${storeId} and product_id <> all(${keepProductIds})
  `;
  return result.count;
}

/** Turns parsed items into this store's price rows. */
export function priceRowsFor(items: ParsedItem[], storeId: number, barcodeToId: Map<string, number>): PriceRow[] {
  const rows = new Map<number, PriceRow>();
  for (const item of items) {
    const productId = barcodeToId.get(item.code);
    if (productId == null) continue;
    // A file listing the same barcode twice keeps the last occurrence — one
    // multi-row upsert can't touch the same (product, store) row twice.
    rows.set(productId, {
      product_id: productId,
      store_id: storeId,
      item_name: item.name,
      price: item.price,
      unit_of_measure_price: item.unitOfMeasurePrice ?? null,
      allow_discount: item.allowDiscount ?? null,
    });
  }
  return [...rows.values()];
}

/** How many of `rows` add a price or change one, versus what's stored now. */
async function countPriceChanges(db: Db, storeId: number, rows: PriceRow[]): Promise<number> {
  if (!rows.length) return 0;
  const existing = await db<{ product_id: number; price: string }[]>`
    select product_id, price from prices
    where store_id = ${storeId} and product_id = any(${rows.map((r) => r.product_id)})
  `;
  const before = new Map(existing.map((r) => [r.product_id, Number(r.price)]));
  return rows.filter((r) => before.get(r.product_id) !== r.price).length;
}

// ─── Per-branch atomic writes (local sync service) ────────────────────────────

export interface BranchWriteResult {
  storeId: number;
  productIds: number[];
  rowsWritten: number;
  rowsDeleted: number;
  /** Rows whose price is new or different from what was stored. */
  priceChanges: number;
  /** True when a delta file was already applied (cursor at or past it). */
  alreadyApplied?: boolean;
}

/** Locks the branch's stores row for the rest of the transaction (creating a
 *  bare one if needed), so two writers to the same branch serialise. */
async function lockStoreRow(db: Db, chainId: string, storeCode: string): Promise<StoreRow> {
  await ensureStoreRows(db, chainId, [storeCode]);
  const [row] = await db<
    {
      id: number;
      last_price_file: string | null;
      last_price_size: string | null;
      last_price_modified: string | null;
      last_delta_ts: string | null;
    }[]
  >`
    select id, last_price_file, last_price_size, last_price_modified, last_delta_ts
    from stores where chain_id = ${chainId} and store_code = ${storeCode}
    for update
  `;
  return {
    id: row.id,
    lastPriceFile: row.last_price_file,
    lastPriceSize: row.last_price_size,
    lastPriceModified: row.last_price_modified,
    lastDeltaTs: row.last_delta_ts,
  };
}

export interface FullBranchInput {
  chainId: string;
  storeCode: string;
  file: string;
  /** The HEAD signature the file was fetched under. */
  size: string;
  modified: string;
  items: ParsedItem[];
}

/**
 * Writes one branch's PriceFull snapshot in a single transaction: its products,
 * its price rows, removal of rows for items no longer in the file, and the
 * branch's file signature — all of it or none of it. Also moves the branch's
 * delta cursor up to the snapshot's timestamp, since the snapshot already
 * contains every earlier delta. Idempotent: writing the same file twice leaves
 * the same rows.
 */
export async function writeBranchFull(db: TxDb, input: FullBranchInput): Promise<BranchWriteResult> {
  if (!input.items.length) throw new Error(`refusing to write an empty PriceFull for store ${input.storeCode}`);
  const ts = fileTimestamp(input.file) || null;

  return (await db.begin(async (tx) => {
    const store = await lockStoreRow(tx, input.chainId, input.storeCode);
    const barcodeToId = await upsertProducts(tx, input.items);
    const rows = priceRowsFor(input.items, store.id, barcodeToId);
    const priceChanges = await countPriceChanges(tx, store.id, rows);
    await upsertPrices(tx, rows);
    const rowsDeleted = await deleteStalePrices(tx, store.id, rows.map((r) => r.product_id));
    await tx`
      update stores set
        last_price_file = ${input.file},
        last_price_size = ${input.size},
        last_price_modified = ${input.modified},
        last_delta_ts = case
          when ${ts}::text is null then last_delta_ts
          when last_delta_ts is null or last_delta_ts < ${ts}::text then ${ts}::text
          else last_delta_ts
        end,
        updated_at = now()
      where id = ${store.id}
    `;
    return {
      storeId: store.id,
      productIds: rows.map((r) => r.product_id),
      rowsWritten: rows.length,
      rowsDeleted,
      priceChanges,
    };
  })) as BranchWriteResult;
}

export interface DeltaBranchInput {
  chainId: string;
  storeCode: string;
  file: string;
  items: ParsedItem[];
  /** Apply even if the branch's cursor is already at or past this file
   *  (replaying a file on purpose). The cursor never moves backwards. */
  force?: boolean;
}

/**
 * Applies one intraday Price file to one branch in a single transaction: an
 * upsert of only the rows in the file (unlike a full snapshot, a barcode
 * missing from a delta is not deleted) and the branch's delta cursor. The
 * cursor is re-checked under the row lock, so a file that was committed just
 * before a crash is not applied twice when the task is retried.
 */
export async function writeBranchDelta(db: TxDb, input: DeltaBranchInput): Promise<BranchWriteResult> {
  const ts = fileTimestamp(input.file);
  if (!ts) throw new Error(`delta file name has no timestamp: ${input.file}`);

  return (await db.begin(async (tx) => {
    const store = await lockStoreRow(tx, input.chainId, input.storeCode);
    if (!input.force && store.lastDeltaTs && store.lastDeltaTs >= ts) {
      return { storeId: store.id, productIds: [], rowsWritten: 0, rowsDeleted: 0, priceChanges: 0, alreadyApplied: true };
    }
    const barcodeToId = await upsertProducts(tx, input.items);
    const rows = priceRowsFor(input.items, store.id, barcodeToId);
    const priceChanges = await countPriceChanges(tx, store.id, rows);
    await upsertPrices(tx, rows);
    await tx`
      update stores set
        last_delta_file = case when last_delta_ts is null or last_delta_ts < ${ts} then ${input.file} else last_delta_file end,
        last_delta_ts = case when last_delta_ts is null or last_delta_ts < ${ts} then ${ts} else last_delta_ts end,
        updated_at = now()
      where id = ${store.id}
    `;
    return {
      storeId: store.id,
      productIds: rows.map((r) => r.product_id),
      rowsWritten: rows.length,
      rowsDeleted: 0,
      priceChanges,
    };
  })) as BranchWriteResult;
}
