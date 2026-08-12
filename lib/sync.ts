import type { AnyBulkWriteOperation } from 'mongodb';
import { products, stores, syncState, ProductDoc, StoreDoc, SyncStateDoc } from './mongo';
import { ParsedItem, parsePriceItemsXml, generateKeywords } from './parse';
import { ParsedStore, parseStoresXml } from './stores';
import {
  ChainConfig,
  cerberusLogin,
  cerberusListFiles,
  pickLatestFile,
  filterByStore,
  fileTimestamp,
  storeIdFromFileName,
  headFileMeta,
  downloadFile,
} from './cerberus';

// ─── Chains ───────────────────────────────────────────────────────────────────
// ids must match the keys written into products.prices and the INDEXED_CHAINS
// list in mongo.ts.

export const CHAINS: ChainConfig[] = [
  { id: 'osher_ad', nameHe: 'אושר עד', username: 'osherad' },
  { id: 'rami_levy', nameHe: 'רמי לוי', username: 'RamiLevi' },
  { id: 'yohananof', nameHe: 'יוחננוף', username: 'yohananof' },
  { id: 'tiv_taam', nameHe: 'טיב טעם', username: 'TivTaam' },
];

export function findChain(id: string): ChainConfig | undefined {
  return CHAINS.find((c) => c.id === id);
}

const MAX_ITEMS_PER_CHAIN = 25000;

// A full sync's branch downloads run with bounded concurrency instead of one
// giant Promise.all — chains like rami_levy publish ~100 branch files, and
// unbounded parallel fetches would both hammer the portal and risk the
// function's memory ceiling holding that many responses at once.
const FULL_SYNC_CONCURRENCY = 6;

/** items extended with a flag noting cross-branch price disagreement. */
interface AggregatedItem extends ParsedItem {
  priceVaries?: boolean;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Groups a chain's PriceFull (or Price) file listing by branch — each chain
 * publishes one file per store, named "...-<subChainId>-<storeId>-<ts>.gz" —
 * and keeps only the latest file per branch. `storeId` (ChainConfig) still
 * narrows to a single configured branch first, same as before this chain
 * published per-branch prices at all.
 */
function latestFilePerStore(
  files: string[],
  storeId?: string,
): { storeId: string; file: string }[] {
  const filtered = filterByStore(files, storeId);
  const byStore = new Map<string, string[]>();
  for (const f of filtered) {
    const id = storeIdFromFileName(f) ?? '';
    byStore.set(id, [...(byStore.get(id) ?? []), f]);
  }
  return [...byStore.entries()].map(([id, group]) => ({
    storeId: id,
    file: [...group].sort((a, b) => fileTimestamp(b).localeCompare(fileTimestamp(a)))[0],
  }));
}

/**
 * Merges each branch's parsed items into one row per barcode: `price` is the
 * cheapest of the branches that carry the item, and `priceVaries` flags items
 * whose branches don't all agree on that price.
 */
function mergeItemsAcrossStores(perStoreItems: ParsedItem[][]): AggregatedItem[] {
  const byCode = new Map<string, ParsedItem[]>();
  for (const items of perStoreItems) {
    for (const item of items) {
      const arr = byCode.get(item.code);
      if (arr) arr.push(item);
      else byCode.set(item.code, [item]);
    }
  }

  const merged: AggregatedItem[] = [];
  for (const items of byCode.values()) {
    const cheapest = items.reduce((best, cur) => (cur.price < best.price ? cur : best));
    const priceVaries = items.some((it) => it.price !== cheapest.price);
    merged.push({ ...cheapest, priceVaries });
  }
  return merged;
}

// ─── syncState (per chain) ────────────────────────────────────────────────────

async function getSyncState(chainId: string): Promise<SyncStateDoc | null> {
  return (await syncState()).findOne({ _id: chainId });
}

async function setSyncState(
  chainId: string,
  patch: Partial<SyncStateDoc>,
): Promise<void> {
  await (await syncState()).updateOne(
    { _id: chainId },
    { $set: { ...patch, updatedAt: new Date() } },
    { upsert: true },
  );
}

// ─── Firestore-equivalent upsert into Mongo ──────────────────────────────────
//
// One updateOne(upsert) per item, batched through bulkWrite. Because Mongo has
// no per-write daily quota (unlike Firestore), a full ~25k-item snapshot writes
// without hitting a cap. `$addToSet` mirrors the old Firestore arrayUnion on
// keywords; per-chain price lives under prices.<chainId> so each chain only
// touches its own sub-field (merge semantics preserved).

async function writeChainPrices(chain: ChainConfig, items: AggregatedItem[]): Promise<void> {
  if (!items.length) return;
  const col = await products();
  const now = new Date();

  const ops: AnyBulkWriteOperation<ProductDoc>[] = items.map((item) => {
    const keywords = generateKeywords(item.name);

    // This chain's price entry. It now carries `name` — the product name as this
    // chain writes it — so the top-level canonical name can be recomputed below
    // from every chain's name instead of "last chain to sync wins".
    const priceEntry: Record<string, unknown> = {
      chainName: chain.nameHe,
      name: item.name,
      price: item.price,
      ...(item.unitOfMeasurePrice != null ? { unitOfMeasurePrice: item.unitOfMeasurePrice } : {}),
      ...(item.allowDiscount != null ? { allowDiscount: item.allowDiscount } : {}),
      ...(item.priceVaries != null ? { priceVaries: item.priceVaries } : {}),
      updatedAt: now,
    };

    // Product-level measurement attributes. Written as one object so each chain
    // overwrites it wholesale (values are intrinsic to the barcode, so they
    // agree across chains — same merge behavior as brand/unitQty).
    const measure: Record<string, unknown> = {};
    if (item.measureUnitQty) measure.unitQty = item.measureUnitQty;
    if (item.quantity != null) measure.quantity = item.quantity;
    if (item.unitOfMeasure) measure.unitOfMeasure = item.unitOfMeasure;
    if (item.qtyInPackage) measure.qtyInPackage = item.qtyInPackage;
    if (item.isWeighted != null) measure.isWeighted = item.isWeighted;

    // First pipeline stage: this chain's fields. Source-derived constants are
    // wrapped in $literal so a value starting with '$' is never parsed as a
    // field path. keywords accumulate across chains ($setUnion mirrors the old
    // $addToSet, preserving cross-chain search recall).
    const setStage: Record<string, unknown> = {
      [`prices.${chain.id}`]: { $literal: priceEntry },
      updatedAt: { $literal: now },
    };
    if (item.brand) setStage.brand = { $literal: item.brand };
    if (item.unitQty) setStage.unitQty = { $literal: item.unitQty };
    if (Object.keys(measure).length) setStage.measure = { $literal: measure };
    if (keywords.length) {
      setStage.keywords = { $setUnion: [{ $ifNull: ['$keywords', []] }, { $literal: keywords }] };
    }

    // Aggregation-pipeline update (not an operator doc) so the canonical name is
    // derived from every chain's name in the same atomic write, keeping name /
    // nameLower stable regardless of chain sync order. See pickCanonicalName()
    // in parse.ts for the JS reference of the selection rule.
    const pipeline = [
      { $set: setStage },
      {
        // name = shortest non-empty per-chain name (tiebreak: codepoint order).
        // Empty names are filtered out first — otherwise a chain without a name
        // (length 0) would always "win" and blank the field. Falls back to the
        // existing name when no chain has a per-chain name yet (migration).
        $set: {
          name: {
            $let: {
              vars: {
                names: {
                  $filter: {
                    input: {
                      $map: {
                        input: { $objectToArray: '$prices' },
                        as: 'p',
                        in: { $ifNull: ['$$p.v.name', ''] },
                      },
                    },
                    as: 'n',
                    cond: { $gt: [{ $strLenCP: '$$n' }, 0] },
                  },
                },
              },
              in: {
                $cond: [
                  { $eq: [{ $size: '$$names' }, 0] },
                  { $ifNull: ['$name', ''] },
                  {
                    $reduce: {
                      input: '$$names',
                      initialValue: { $arrayElemAt: ['$$names', 0] },
                      in: {
                        $cond: [
                          {
                            $or: [
                              { $lt: [{ $strLenCP: '$$this' }, { $strLenCP: '$$value' }] },
                              {
                                $and: [
                                  { $eq: [{ $strLenCP: '$$this' }, { $strLenCP: '$$value' }] },
                                  { $lt: ['$$this', '$$value'] },
                                ],
                              },
                            ],
                          },
                          '$$this',
                          '$$value',
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
      { $set: { nameLower: { $toLower: '$name' } } },
    ];

    return {
      updateOne: {
        filter: { _id: item.code },
        update: pipeline,
        upsert: true,
      },
    };
  });

  // ordered:false so one malformed item can't abort the whole batch.
  await col.bulkWrite(ops, { ordered: false });
}

// ─── Full sync (nightly) ──────────────────────────────────────────────────────

export async function syncChainFull(
  chain: ChainConfig,
  opts: { skipUnchangedCheck?: boolean } = {},
): Promise<unknown> {
  const cookie = await cerberusLogin(chain.username);
  const files = await cerberusListFiles(cookie, 'PriceFull');
  const perStore = latestFilePerStore(files, chain.storeId);
  if (!perStore.length) return { chain: chain.id, note: 'no PriceFull file found' };

  const state = await getSyncState(chain.id);

  // HEAD every selected branch file — cheap relative to downloading them —
  // and build one signature for the whole chain. Skip the (potentially
  // tens-of-MB, times ~dozens of branches) download entirely when nothing has
  // changed since the last successful run. Callers can force a re-download
  // (e.g. to backfill after a parsing bug fix) via opts.skipUnchangedCheck.
  const metas = await mapWithConcurrency(perStore, FULL_SYNC_CONCURRENCY, async ({ storeId, file }) => {
    const meta = await headFileMeta(cookie, file);
    return { storeId, file, size: meta?.size ?? '', modified: meta?.modified ?? '' };
  });
  const signature = metas
    .slice()
    .sort((a, b) => a.storeId.localeCompare(b.storeId))
    .map((m) => `${m.storeId}:${m.file}:${m.size}:${m.modified}`)
    .join('|');

  const unchanged = !opts.skipUnchangedCheck && !!state && state.lastFullSignature === signature;
  if (unchanged) {
    return { chain: chain.id, stores: perStore.length, skipped: true, reason: 'unchanged (HEAD check)' };
  }

  const perStoreItems = await mapWithConcurrency(perStore, FULL_SYNC_CONCURRENCY, async ({ file }) => {
    const xml = await downloadFile(cookie, file);
    return parsePriceItemsXml(xml, MAX_ITEMS_PER_CHAIN);
  });
  const items = mergeItemsAcrossStores(perStoreItems);
  await writeChainPrices(chain, items);

  // A fresh full snapshot supersedes older delta files, so fast-forward the
  // delta cursor to at least the newest branch file's timestamp.
  const fullTimestamp = perStore.reduce(
    (max, { file }) => (fileTimestamp(file) > max ? fileTimestamp(file) : max),
    '',
  );
  const lastDeltaTimestamp =
    state?.lastDeltaTimestamp && state.lastDeltaTimestamp > fullTimestamp
      ? state.lastDeltaTimestamp
      : fullTimestamp;

  await setSyncState(chain.id, { lastFullSignature: signature, lastDeltaTimestamp });

  return { chain: chain.id, stores: perStore.length, items: items.length };
}

// ─── Delta sync (intraday) ─────────────────────────────────────────────────────

export async function syncChainDeltas(chain: ChainConfig): Promise<unknown> {
  const cookie = await cerberusLogin(chain.username);

  // The portal's search matches substrings, so "Price" also returns
  // "PriceFull" entries — excluded here (handled by the full sync).
  const allFiles = await cerberusListFiles(cookie, 'Price');
  const deltaFiles = filterByStore(
    allFiles.filter((f) => !/pricefull/i.test(f)),
    chain.storeId,
  );

  const state = await getSyncState(chain.id);
  const lastTimestamp = state?.lastDeltaTimestamp ?? '';

  const newFiles = deltaFiles
    .filter((f) => fileTimestamp(f) > lastTimestamp)
    .sort((a, b) => fileTimestamp(a).localeCompare(fileTimestamp(b)));

  if (!newFiles.length) {
    return { chain: chain.id, filesProcessed: 0, reason: 'no new delta files' };
  }

  let itemsTotal = 0;
  for (const file of newFiles) {
    const xml = await downloadFile(cookie, file);
    const items = parsePriceItemsXml(xml, MAX_ITEMS_PER_CHAIN);
    await writeChainPrices(chain, items);
    itemsTotal += items.length;

    // Persisted after each file so a mid-batch crash resumes from the last
    // applied delta instead of redoing it.
    await setSyncState(chain.id, {
      lastDeltaFile: file,
      lastDeltaTimestamp: fileTimestamp(file),
    });
  }

  return { chain: chain.id, filesProcessed: newFiles.length, items: itemsTotal };
}

// ─── Stores (branches) sync ────────────────────────────────────────────────────

async function writeChainStores(chain: ChainConfig, list: ParsedStore[]): Promise<void> {
  if (!list.length) return;
  const col = await stores();
  const now = new Date();

  const ops: AnyBulkWriteOperation<StoreDoc>[] = list.map((s) => ({
    updateOne: {
      filter: { _id: `${chain.id}:${s.storeId}` },
      update: {
        $set: {
          chainId: chain.id,
          chainName: chain.nameHe,
          storeId: s.storeId,
          ...(s.subChainId ? { subChainId: s.subChainId } : {}),
          name: s.name,
          ...(s.address ? { address: s.address } : {}),
          ...(s.city ? { city: s.city } : {}),
          ...(s.zipCode ? { zipCode: s.zipCode } : {}),
          ...(s.storeType ? { storeType: s.storeType } : {}),
          updatedAt: now,
        },
      },
      upsert: true,
    },
  }));

  await col.bulkWrite(ops, { ordered: false });
}

/** Refreshes the `stores` collection from the chain's daily Stores file — one
 *  small file listing every branch, unlike the per-branch PriceFull fan-out. */
export async function syncChainStores(chain: ChainConfig): Promise<unknown> {
  const cookie = await cerberusLogin(chain.username);
  const files = await cerberusListFiles(cookie, 'Stores');
  const file = pickLatestFile(files);
  if (!file) return { chain: chain.id, note: 'no Stores file found' };

  const xml = await downloadFile(cookie, file);
  const list = parseStoresXml(xml);
  await writeChainStores(chain, list);

  return { chain: chain.id, file, stores: list.length };
}
