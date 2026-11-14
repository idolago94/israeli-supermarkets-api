import { sql } from './pg';
import {
  ChainConfig,
  cerberusLogin,
  cerberusListFiles,
  pickLatestFile,
  headFileMeta,
  downloadFile,
} from './cerberus';
import { ParsedItem, parsePriceItemsXml } from './parse';
import { parseStoresXml } from './stores';
import { mapWithConcurrency, latestFilePerStore } from './branches';
import {
  PriceRow,
  upsertChain as upsertChainRow,
  writeStores,
  ensureStoreRows as ensureStoreRowsIn,
  upsertProducts as upsertProductsIn,
  upsertPrices as upsertPricesIn,
  deleteStalePrices as deleteStalePricesIn,
  recomputeNamesAndKeywords as recomputeNamesAndKeywordsIn,
} from './v2Writer';

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

// The writes themselves live in lib/v2Writer.ts (shared with the local sync
// service in sync-service/); these bind them to the shared pooled client.
const upsertChain = (chain: ChainConfig) => upsertChainRow(sql, chain);
const ensureStoreRows = (chainId: string, codes: string[]) => ensureStoreRowsIn(sql, chainId, codes);
const upsertProducts = (items: ParsedItem[]) => upsertProductsIn(sql, items);
const upsertPrices = (rows: PriceRow[]) => upsertPricesIn(sql, rows);
const deleteStalePrices = (storeId: number, keep: number[]) => deleteStalePricesIn(sql, storeId, keep);
const recomputeNamesAndKeywords = (ids: number[]) => recomputeNamesAndKeywordsIn(sql, ids);

// ─── stores (branch directory) ─────────────────────────────────────────────────

interface StoreRow {
  id: number;
  lastPriceFile: string | null;
  lastPriceSize: string | null;
  lastPriceModified: string | null;
}

// Selects only the original columns (not the local service's delta cursor),
// so this endpoint keeps working whether or not that migration has run.
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

  await writeStores(sql, chain.id, list);
  return { chain: chain.id, file, stores: list.length };
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
