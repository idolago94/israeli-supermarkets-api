import { sql } from './pg';
import {
  ChainConfig,
  cerberusLogin,
  cerberusListFiles,
  pickLatestFile,
  headFileMeta,
  downloadFile,
} from './cerberus';
import { ParsedItem, parsePriceItemsXml, generateKeywords, pickCanonicalName } from './parse';
import { parseStoresXml } from './stores';
import { mapWithConcurrency, latestFilePerStore } from './branches';

// ─── Catalog v2 full sync (Postgres/Supabase) ──────────────────────────────────
//
// Same Cerberus fetching/parsing as v1 (lib/sync.ts) — login, list files, group
// by branch, HEAD-based change detection, download+parse — reused as-is via
// lib/branches.ts and lib/parse.ts. What changes is storage: v1 has to flatten
// every branch's price into one aggregate field per chain (a write-time
// computation prone to staleness — see README "Branches"); v2 gives each
// (product, store) price its own row, so "cheapest" is just MIN(price) at read
// time, and a branch that hasn't changed never needs to be touched to keep
// that correct. See supabase/migrations/20260817000000_catalog_v2_schema.sql.

const MAX_ITEMS_PER_CHAIN = 25000;
const FULL_SYNC_CONCURRENCY = 6;
// Row count per multi-row INSERT — comfortably under Postgres' 65535 bind
// parameter ceiling even at ~10 columns/row, without one insert per row.
const UPSERT_CHUNK_SIZE = 2000;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ─── chains ───────────────────────────────────────────────────────────────────

async function upsertChain(chain: ChainConfig): Promise<void> {
  await sql`
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

interface StoreRow {
  id: number;
  lastPriceFile: string | null;
  lastPriceSize: string | null;
  lastPriceModified: string | null;
}

async function loadStoreRows(chainId: string): Promise<Map<string, StoreRow>> {
  const rows = await sql<
    { id: number; store_code: string; last_price_file: string | null; last_price_size: string | null; last_price_modified: string | null }[]
  >`
    select id, store_code, last_price_file, last_price_size, last_price_modified
    from stores where chain_id = ${chainId}
  `;
  const map = new Map<string, StoreRow>();
  for (const r of rows) {
    map.set(r.store_code, {
      id: r.id,
      lastPriceFile: r.last_price_file,
      lastPriceSize: r.last_price_size,
      lastPriceModified: r.last_price_modified,
    });
  }
  return map;
}

/** Refreshes branch directory metadata (name/address/city) from the chain's
 *  daily Stores file. Doesn't touch the per-branch price-change columns. */
export async function syncChainStoresV2(chain: ChainConfig): Promise<unknown> {
  await upsertChain(chain);

  const cookie = await cerberusLogin(chain.username);
  const files = await cerberusListFiles(cookie, 'Stores');
  const file = pickLatestFile(files);
  if (!file) return { chain: chain.id, note: 'no Stores file found' };

  const xml = await downloadFile(cookie, file);
  const list = parseStoresXml(xml);
  if (!list.length) return { chain: chain.id, file, note: 'Stores file parsed to zero rows — skipped' };

  for (const batch of chunk(list, UPSERT_CHUNK_SIZE)) {
    const rows = batch.map((s) => ({
      chain_id: chain.id,
      store_code: s.storeId,
      sub_chain_id: s.subChainId ?? null,
      name: s.name,
      address: s.address ?? null,
      city: s.city ?? null,
      zip_code: s.zipCode ?? null,
      store_type: s.storeType ?? null,
    }));
    await sql`
      insert into stores ${sql(rows, 'chain_id', 'store_code', 'sub_chain_id', 'name', 'address', 'city', 'zip_code', 'store_type')}
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

  return { chain: chain.id, file, stores: list.length };
}

/**
 * Creates a bare row for any branch that shows up in a PriceFull listing but
 * wasn't in the Stores file — defensive; every branch observed so far
 * publishes both, but a price row can't exist without a stores.id to point
 * at. Existing rows are left untouched.
 */
async function ensureStoreRows(chainId: string, storeCodes: string[]): Promise<void> {
  if (!storeCodes.length) return;
  const rows = storeCodes.map((code) => ({ chain_id: chainId, store_code: code, name: code }));
  await sql`
    insert into stores ${sql(rows, 'chain_id', 'store_code', 'name')}
    on conflict (chain_id, store_code) do nothing
  `;
}

// ─── products ─────────────────────────────────────────────────────────────────

/**
 * Upserts the product-intrinsic fields (brand/measure/unitQty) and returns a
 * barcode -> id map. `name`/`name_lower` are only used to satisfy the
 * not-null columns on a brand-new row — on conflict they're left alone, owned
 * instead by recomputeNamesAndKeywords, which derives them from every store's
 * item_name, not just whichever item happened to upsert last.
 */
async function upsertProducts(items: ParsedItem[]): Promise<Map<string, number>> {
  const barcodeToId = new Map<string, number>();
  if (!items.length) return barcodeToId;

  for (const batch of chunk(items, UPSERT_CHUNK_SIZE)) {
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

    const result = await sql<{ id: number; barcode: string }[]>`
      insert into products ${sql(
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
async function recomputeNamesAndKeywords(productIds: number[]): Promise<void> {
  if (!productIds.length) return;

  for (const batch of chunk(productIds, UPSERT_CHUNK_SIZE)) {
    const rows = await sql<{ product_id: number; item_name: string }[]>`
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

    await sql`
      update products p set
        name = u.name,
        name_lower = u.name_lower,
        keywords = u.keywords,
        updated_at = now()
      from (
        select * from jsonb_to_recordset(${sql.json(updates as any)})
          as u(id integer, name text, name_lower text, keywords text[])
      ) as u
      where p.id = u.id
    `;
  }
}

// ─── prices ───────────────────────────────────────────────────────────────────

interface PriceRow {
  product_id: number;
  store_id: number;
  item_name: string;
  price: number;
  unit_of_measure_price: number | null;
  allow_discount: boolean | null;
}

async function upsertPrices(rows: PriceRow[]): Promise<void> {
  if (!rows.length) return;
  for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
    await sql`
      insert into prices ${sql(batch, 'product_id', 'store_id', 'item_name', 'price', 'unit_of_measure_price', 'allow_discount')}
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
async function deleteStalePrices(storeId: number, keepProductIds: number[]): Promise<number> {
  if (!keepProductIds.length) return 0;
  const result = await sql`
    delete from prices
    where store_id = ${storeId} and product_id <> all(${keepProductIds})
  `;
  return result.count;
}

// ─── Full sync (nightly) ────────────────────────────────────────────────────────

export async function syncChainFullV2(
  chain: ChainConfig,
  opts: { skipUnchangedCheck?: boolean } = {},
): Promise<unknown> {
  await upsertChain(chain);

  // Branch directory first — a price row can't be written without a stores.id
  // to point at, and this also refreshes name/address/city for the admin UI.
  await syncChainStoresV2(chain);

  const cookie = await cerberusLogin(chain.username);
  const files = await cerberusListFiles(cookie, 'PriceFull');
  const perStore = latestFilePerStore(files, chain.storeId);
  if (!perStore.length) return { chain: chain.id, note: 'no PriceFull file found' };

  await ensureStoreRows(chain.id, perStore.map((s) => s.storeId));
  const storeRows = await loadStoreRows(chain.id);

  // HEAD every selected branch file (bounded concurrency) and compare against
  // that branch's own saved signature — unlike v1, an unrelated branch
  // changing doesn't force this one to be re-downloaded, because its prices
  // are already correctly sitting in their own rows.
  const metas = await mapWithConcurrency(perStore, FULL_SYNC_CONCURRENCY, async ({ storeId, file }) => {
    const meta = await headFileMeta(cookie, file);
    return { storeId, file, size: meta?.size ?? '', modified: meta?.modified ?? '' };
  });

  const changed = metas.filter((m) => {
    if (opts.skipUnchangedCheck) return true;
    const row = storeRows.get(m.storeId);
    if (!row) return true;
    return row.lastPriceFile !== m.file || row.lastPriceSize !== m.size || row.lastPriceModified !== m.modified;
  });

  if (!changed.length) {
    return { chain: chain.id, storesTotal: perStore.length, storesChanged: 0, skipped: true };
  }

  const downloaded = await mapWithConcurrency(changed, FULL_SYNC_CONCURRENCY, async (m) => {
    const xml = await downloadFile(cookie, m.file);
    return { ...m, items: parsePriceItemsXml(xml, MAX_ITEMS_PER_CHAIN) };
  });

  // A store's file parsing to zero items is treated as a failure for that
  // store (every real branch carries thousands of items), not "sells
  // nothing" — otherwise a parse hiccup would wipe that store's prices via
  // deleteStalePrices below. Skipped stores keep their old signature, so
  // they're retried on the next full sync instead of silently going stale.
  const usable = downloaded.filter((d) => d.items.length > 0);
  const failedStores = downloaded.filter((d) => d.items.length === 0).map((d) => d.storeId);

  // Upsert every touched product once (union across all changed stores in
  // this run — a product doesn't need N separate upserts for N branches).
  const byBarcode = new Map<string, ParsedItem>();
  for (const { items } of usable) {
    for (const item of items) byBarcode.set(item.code, item);
  }
  const barcodeToProductId = await upsertProducts([...byBarcode.values()]);

  let priceRowsWritten = 0;
  let priceRowsDeleted = 0;
  const touchedProductIds = new Set<number>();

  for (const { storeId, file, size, modified, items } of usable) {
    const storeRow = storeRows.get(storeId);
    if (!storeRow) continue; // covered by ensureStoreRows above; defensive only

    const rows: PriceRow[] = [];
    for (const item of items) {
      const productId = barcodeToProductId.get(item.code);
      if (productId == null) continue;
      touchedProductIds.add(productId);
      rows.push({
        product_id: productId,
        store_id: storeRow.id,
        item_name: item.name,
        price: item.price,
        unit_of_measure_price: item.unitOfMeasurePrice ?? null,
        allow_discount: item.allowDiscount ?? null,
      });
    }

    await upsertPrices(rows);
    priceRowsWritten += rows.length;
    priceRowsDeleted += await deleteStalePrices(storeRow.id, rows.map((r) => r.product_id));

    await sql`
      update stores set last_price_file = ${file}, last_price_size = ${size}, last_price_modified = ${modified}, updated_at = now()
      where id = ${storeRow.id}
    `;
  }

  await recomputeNamesAndKeywords([...touchedProductIds]);

  return {
    chain: chain.id,
    storesTotal: perStore.length,
    storesChanged: changed.length,
    storesFailed: failedStores.length ? failedStores : undefined,
    products: touchedProductIds.size,
    priceRowsWritten,
    priceRowsDeleted,
  };
}
