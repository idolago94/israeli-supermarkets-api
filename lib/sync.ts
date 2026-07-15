import type { AnyBulkWriteOperation } from 'mongodb';
import { products, syncState, ProductDoc, SyncStateDoc } from './mongo';
import { ParsedItem, parsePriceItemsXml, generateKeywords } from './parse';
import {
  ChainConfig,
  cerberusLogin,
  cerberusListFiles,
  pickLatestFile,
  filterByStore,
  fileTimestamp,
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

async function writeChainPrices(chain: ChainConfig, items: ParsedItem[]): Promise<void> {
  if (!items.length) return;
  const col = await products();
  const now = new Date();

  const ops: AnyBulkWriteOperation<ProductDoc>[] = items.map((item) => {
    const keywords = generateKeywords(item.name);
    const set: Record<string, unknown> = {
      name: item.name,
      nameLower: item.name.toLowerCase(),
      [`prices.${chain.id}`]: {
        chainName: chain.nameHe,
        price: item.price,
        ...(item.unitOfMeasurePrice != null ? { unitOfMeasurePrice: item.unitOfMeasurePrice } : {}),
        ...(item.allowDiscount != null ? { allowDiscount: item.allowDiscount } : {}),
        updatedAt: now,
      },
      updatedAt: now,
    };
    if (item.brand) set.brand = item.brand;
    if (item.unitQty) set.unitQty = item.unitQty;

    // Product-level measurement attributes. Written as one object so each chain
    // overwrites it wholesale (values are intrinsic to the barcode, so they
    // agree across chains — same merge behavior as brand/unitQty above).
    const measure: Record<string, unknown> = {};
    if (item.measureUnitQty) measure.unitQty = item.measureUnitQty;
    if (item.quantity != null) measure.quantity = item.quantity;
    if (item.unitOfMeasure) measure.unitOfMeasure = item.unitOfMeasure;
    if (item.qtyInPackage) measure.qtyInPackage = item.qtyInPackage;
    if (item.isWeighted != null) measure.isWeighted = item.isWeighted;
    if (Object.keys(measure).length) set.measure = measure;

    return {
      updateOne: {
        filter: { _id: item.code },
        update: {
          $set: set,
          ...(keywords.length ? { $addToSet: { keywords: { $each: keywords } } } : {}),
        },
        upsert: true,
      },
    };
  });

  // ordered:false so one malformed item can't abort the whole batch.
  await col.bulkWrite(ops, { ordered: false });
}

// ─── Full sync (nightly) ──────────────────────────────────────────────────────

export async function syncChainFull(chain: ChainConfig): Promise<unknown> {
  const cookie = await cerberusLogin(chain.username);
  const files = await cerberusListFiles(cookie, 'PriceFull');
  const file = pickLatestFile(files, chain.storeId);
  if (!file) return { chain: chain.id, note: 'no PriceFull file found' };

  const state = await getSyncState(chain.id);
  const meta = await headFileMeta(cookie, file);

  // Skip the (potentially tens-of-MB) download entirely when the chain hasn't
  // republished since the last successful run.
  const unchanged =
    !!state &&
    state.lastFullFile === file &&
    !!meta &&
    state.lastFullSize === meta.size &&
    state.lastFullModified === meta.modified;

  if (unchanged) {
    return { chain: chain.id, file, skipped: true, reason: 'unchanged (HEAD check)' };
  }

  const xml = await downloadFile(cookie, file);
  const items = parsePriceItemsXml(xml, MAX_ITEMS_PER_CHAIN);
  await writeChainPrices(chain, items);

  // A fresh full snapshot supersedes older delta files, so fast-forward the
  // delta cursor to at least this file's timestamp.
  const fullTimestamp = fileTimestamp(file);
  const lastDeltaTimestamp =
    state?.lastDeltaTimestamp && state.lastDeltaTimestamp > fullTimestamp
      ? state.lastDeltaTimestamp
      : fullTimestamp;

  await setSyncState(chain.id, {
    lastFullFile: file,
    lastFullSize: meta?.size ?? '',
    lastFullModified: meta?.modified ?? '',
    lastDeltaTimestamp,
  });

  return { chain: chain.id, file, items: items.length };
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
