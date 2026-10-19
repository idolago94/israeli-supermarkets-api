import type { AnyBulkWriteOperation } from 'mongodb';
import { products, stores, syncState, ProductDoc, StoreDoc, SyncStateDoc } from './mongo';
import { ParsedItem, parsePriceItemsXml, generateKeywords } from './parse';
import { ParsedStore, parseStoresXml } from './stores';
import { mapWithConcurrency, latestFilePerStore, dropStaleFiles } from './branches';
import {
  ChainConfig,
  cerberusLogin,
  cerberusListFiles,
  pickLatestFile,
  filterByStore,
  fileTimestamp,
  isFileTimestamp,
  storeIdFromFileName,
  headFileMeta,
  downloadFile,
} from './cerberus';
import { FailureSink, tagStage, withStage } from './syncFailures';

// Chain config lives in lib/chains.ts (Mongo-independent, so v2 routes can use
// it without requiring MONGODB_URI) — re-exported here so v1 call sites don't
// need to change their import path.
export { CHAINS, findChain } from './chains';

const MAX_ITEMS_PER_CHAIN = 25000;

// A full sync's branch downloads run with bounded concurrency instead of one
// giant Promise.all — chains like rami_levy publish ~100 branch files, and
// unbounded parallel fetches would both hammer the portal and risk the
// function's memory ceiling holding that many responses at once. Folding each
// branch's items into the running merge as it arrives (see foldItemIntoMerge)
// keeps only one entry per unique barcode resident instead of every branch's
// full item list at once, so this can afford to run wider than the old 6.
const FULL_SYNC_CONCURRENCY = 12;

// Branches whose delta files are applied in parallel. Each branch's own files
// still apply strictly oldest-first; only different branches overlap. rami_levy
// publishes ~100 delta files an hour, so a 4-hour gap between runs is ~400
// small files — too many to fetch one at a time inside the function's limit.
const DELTA_SYNC_CONCURRENCY = 8;

// No new delta file starts after this much of a run has elapsed. The function
// is killed at maxDuration (300s, vercel.json) and a single in-flight file can
// still take over a minute (download timeouts + retries in lib/cerberus.ts),
// so the budget leaves that headroom. A backlog that doesn't fit is reported
// as `filesPending` and picked up by the next request — every file's cursor is
// persisted as it's applied, so nothing is redone.
const DELTA_SYNC_BUDGET_MS = 200_000;

/** Options shared by the sync entry points. */
export interface SyncRunOptions {
  /** Receives every failure the flow handles internally (a branch file that
   *  failed while the rest of the chain carried on), so it can be reported
   *  even though the flow itself succeeds. */
  onFailure?: FailureSink;
  /** Epoch ms after which no new file is started (delta sync only); defaults
   *  to DELTA_SYNC_BUDGET_MS from the start of the run. */
  deadline?: number;
}

/** items extended with a flag noting cross-branch price disagreement. */
interface AggregatedItem extends ParsedItem {
  priceVaries?: boolean;
}

interface MergeEntry {
  best: ParsedItem;
  varies: boolean;
}

/**
 * Folds one branch's items into the chain-wide merge: `best` tracks the
 * cheapest item seen so far for the barcode, `varies` flags a barcode whose
 * branches don't all agree on price (order-independent — it's set the moment
 * two different prices are seen, regardless of which arrives first).
 *
 * Used instead of collecting every branch's full item array before merging —
 * for a ~100-branch chain like rami_levy, that would hold on the order of a
 * million ParsedItem objects (mostly duplicates of the same barcode across
 * branches) in memory at once. Folding incrementally keeps only one entry per
 * unique barcode resident.
 */
function foldItemIntoMerge(merge: Map<string, MergeEntry>, item: ParsedItem): void {
  const existing = merge.get(item.code);
  if (!existing) {
    merge.set(item.code, { best: item, varies: false });
    return;
  }
  if (item.price !== existing.best.price) existing.varies = true;
  if (item.price < existing.best.price) existing.best = item;
}

function mergeEntriesToItems(merge: Map<string, MergeEntry>): AggregatedItem[] {
  return [...merge.values()].map(({ best, varies }) => ({ ...best, priceVaries: varies }));
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

/** Advances one branch's delta cursor without touching the others' — delta
 *  branches run concurrently, so a whole-map write could lose a sibling's
 *  progress. */
async function setDeltaCursor(chainId: string, storeId: string, ts: string): Promise<void> {
  await (await syncState()).updateOne(
    { _id: chainId },
    { $set: { [`lastDeltaTimestamps.${storeId}`]: ts, updatedAt: new Date() } as any },
    { upsert: true },
  );
}

/**
 * The persisted delta cursors, minus any that fileTimestamp() can't have
 * produced. Before the timestamp parser was fixed, every cursor was the first
 * 12 digits of the chain id (e.g. "729005814088"), which sorts after every real
 * timestamp — kept as-is it would make every delta file look already applied.
 */
export function validDeltaCursors(cursors: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [storeId, ts] of Object.entries(cursors ?? {})) {
    if (storeId && isFileTimestamp(ts)) out[storeId] = ts;
  }
  return out;
}

/**
 * Decides which delta files to apply: per branch, every file newer than that
 * branch's cursor, oldest first. A branch with no cursor yet (new branch, or
 * one whose cursor was discarded by validDeltaCursors) gets only its newest
 * file — replaying days of backlog could not finish inside one run, and the
 * next full sync sets a proper cursor for it anyway. Files without a store id
 * are returned separately so the caller can report them.
 */
export function planDeltaFiles(
  files: string[],
  cursors: Record<string, string>,
): { byStore: Map<string, string[]>; unrecognized: string[] } {
  const byStore = new Map<string, string[]>();
  const unrecognized: string[] = [];
  for (const f of files) {
    const storeId = storeIdFromFileName(f);
    if (!storeId) {
      unrecognized.push(f);
      continue;
    }
    if (fileTimestamp(f) > (cursors[storeId] ?? '')) {
      byStore.set(storeId, [...(byStore.get(storeId) ?? []), f]);
    }
  }
  for (const [storeId, group] of byStore) {
    group.sort((a, b) => fileTimestamp(a).localeCompare(fileTimestamp(b)));
    if (!cursors[storeId]) byStore.set(storeId, group.slice(-1));
  }
  return { byStore, unrecognized };
}

// ─── Firestore-equivalent upsert into Mongo ──────────────────────────────────
//
// One updateOne(upsert) per item, batched through bulkWrite. Because Mongo has
// no per-write daily quota (unlike Firestore), a full ~25k-item snapshot writes
// without hitting a cap. `$addToSet` mirrors the old Firestore arrayUnion on
// keywords; per-chain price lives under prices.<chainId> so each chain only
// touches its own sub-field (merge semantics preserved).

/**
 * Builds the bulkWrite ops shared by the full sync (unconditional overwrite —
 * `items` already carries the true cross-branch minimum) and the delta sync
 * (conditional — only replace the price when the new one actually undercuts
 * what's stored, since a single branch's delta can't tell whether it's still
 * the cheapest). `overwrite: false` is what makes it conditional.
 */
function buildPriceUpdateOps(
  chain: ChainConfig,
  items: (AggregatedItem | ParsedItem)[],
  overwrite: boolean,
): AnyBulkWriteOperation<ProductDoc>[] {
  const now = new Date();

  return items.map((item) => {
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
      ...('priceVaries' in item && item.priceVaries != null ? { priceVaries: item.priceVaries } : {}),
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

    // Full sync already computed the true cross-branch minimum, so it always
    // wins outright. A delta only knows this one branch's new price, so it
    // replaces the stored entry only when strictly cheaper — it can lower the
    // chain's displayed price but never raise it (that needs the next full
    // sync, which sees every branch at once and can tell the previously
    // cheapest branch actually got more expensive).
    const priceValue = overwrite
      ? { $literal: priceEntry }
      : {
          $cond: [
            { $lt: [{ $literal: item.price }, { $ifNull: [`$prices.${chain.id}.price`, Infinity] }] },
            { $literal: priceEntry },
            `$prices.${chain.id}`,
          ],
        };

    // First pipeline stage: this chain's fields. Source-derived constants are
    // wrapped in $literal so a value starting with '$' is never parsed as a
    // field path. keywords accumulate across chains ($setUnion mirrors the old
    // $addToSet, preserving cross-chain search recall).
    const setStage: Record<string, unknown> = {
      [`prices.${chain.id}`]: priceValue,
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
}

async function writeChainPrices(chain: ChainConfig, items: AggregatedItem[]): Promise<void> {
  if (!items.length) return;
  const col = await products();
  // ordered:false so one malformed item can't abort the whole batch.
  await col.bulkWrite(buildPriceUpdateOps(chain, items, true), { ordered: false });
}

async function writeChainPricesIfCheaper(chain: ChainConfig, items: ParsedItem[]): Promise<void> {
  if (!items.length) return;
  const col = await products();
  await col.bulkWrite(buildPriceUpdateOps(chain, items, false), { ordered: false });
}

// ─── Full sync (nightly) ──────────────────────────────────────────────────────

export async function syncChainFull(
  chain: ChainConfig,
  opts: { skipUnchangedCheck?: boolean } & SyncRunOptions = {},
): Promise<unknown> {
  const cookie = await withStage('login', () => cerberusLogin(chain.username));
  const files = await withStage('list-files', () => cerberusListFiles(cookie, 'PriceFull'));
  const perStore = latestFilePerStore(files, chain.storeId);
  if (!perStore.length) return { chain: chain.id, note: 'no PriceFull file found' };

  const state = await withStage('sync-state', () => getSyncState(chain.id));

  // HEAD every selected branch file — cheap relative to downloading them —
  // and build one signature for the whole chain. Skip the (potentially
  // tens-of-MB, times ~dozens of branches) download entirely when nothing has
  // changed since the last successful run. Callers can force a re-download
  // (e.g. to backfill after a parsing bug fix) via opts.skipUnchangedCheck.
  const metas = await withStage('head-check', () =>
    mapWithConcurrency(perStore, FULL_SYNC_CONCURRENCY, async ({ storeId, file }) => {
      const meta = await headFileMeta(cookie, file);
      return { storeId, file, size: meta?.size ?? '', modified: meta?.modified ?? '' };
    }),
  );
  const signature = metas
    .slice()
    .sort((a, b) => a.storeId.localeCompare(b.storeId))
    .map((m) => `${m.storeId}:${m.file}:${m.size}:${m.modified}`)
    .join('|');

  const unchanged = !opts.skipUnchangedCheck && !!state && state.lastFullSignature === signature;
  if (unchanged) {
    return { chain: chain.id, stores: perStore.length, skipped: true, reason: 'unchanged (HEAD check)' };
  }

  // One bad branch file (portal hiccup, an error page served as a 200, a
  // truncated transfer) must not sink the other ~99 — collect failures
  // instead of letting Promise.all reject the whole chain on the first one.
  const merge = new Map<string, MergeEntry>();
  const failedStores = new Set<string>();
  await mapWithConcurrency(perStore, FULL_SYNC_CONCURRENCY, async ({ storeId, file }) => {
    try {
      const xml = await withStage('download', () => downloadFile(cookie, file));
      const items = await withStage('parse', () => parsePriceItemsXml(xml, MAX_ITEMS_PER_CHAIN));
      // Every real branch carries thousands of items; none means the format
      // wasn't understood, which must surface instead of silently dropping
      // the branch's prices (same rule as the v2 sync).
      if (!items.length) throw tagStage(new Error(`${file} parsed to zero items`), 'parse');
      for (const item of items) foldItemIntoMerge(merge, item);
    } catch (err) {
      failedStores.add(storeId);
      console.error(`syncChainFull: ${chain.id} branch ${storeId} (${file}) failed: ${err}`);
      opts.onFailure?.({ level: 'file', error: err, chain: chain.id, storeId, file });
    }
  });
  const items = mergeEntriesToItems(merge);
  await withStage('write-db', () => writeChainPrices(chain, items));

  // A fresh full snapshot supersedes older delta files for the branches it
  // covered, so fast-forward each of those branches' delta cursor to at least
  // its own file's timestamp (branches not in this sync, e.g. a configured
  // chain.storeId override, or that failed to download above, keep whatever
  // cursor they already had — deltas keep covering them until a full sync
  // actually lands their data).
  const lastDeltaTimestamps = validDeltaCursors(state?.lastDeltaTimestamps);
  for (const { storeId, file } of perStore) {
    if (failedStores.has(storeId) || !storeId) continue;
    const ts = fileTimestamp(file);
    if (isFileTimestamp(ts) && (!lastDeltaTimestamps[storeId] || ts > lastDeltaTimestamps[storeId])) {
      lastDeltaTimestamps[storeId] = ts;
    }
  }

  // Only record this run's signature as the "nothing changed, skip next time"
  // baseline when every branch actually downloaded — otherwise a future
  // HEAD-check could see unchanged metadata for the branches that failed here
  // and skip retrying them indefinitely.
  await withStage('sync-state', () =>
    setSyncState(chain.id, {
      ...(failedStores.size === 0 ? { lastFullSignature: signature } : {}),
      lastDeltaTimestamps,
    }),
  );

  return {
    chain: chain.id,
    stores: perStore.length,
    items: items.length,
    storesFailed: failedStores.size ? [...failedStores] : undefined,
  };
}

// ─── Delta sync (intraday) ─────────────────────────────────────────────────────
//
// Delta files are published per branch, same as PriceFull, so this checks
// each branch's cursor separately and only downloads branches that actually
// republished. A branch's new price only overwrites the catalog when it
// undercuts what's stored (writeChainPricesIfCheaper) — a delta can lower a
// chain's displayed price but can't detect the previously-cheapest branch
// raising its price, since it never sees the other branches. That's a known
// gap, corrected by the next full sync (see README "Branches").

export async function syncChainDeltas(chain: ChainConfig, opts: SyncRunOptions = {}): Promise<unknown> {
  const deadline = opts.deadline ?? Date.now() + DELTA_SYNC_BUDGET_MS;
  const cookie = await withStage('login', () => cerberusLogin(chain.username));

  // The portal's search matches substrings, so "Price" also returns
  // "PriceFull" entries — excluded here (handled by the full sync).
  const allFiles = await withStage('list-files', () => cerberusListFiles(cookie, 'Price'));
  const deltaFiles = dropStaleFiles(
    filterByStore(
      allFiles.filter((f) => !/pricefull/i.test(f)),
      chain.storeId,
    ),
  );

  const state = await withStage('sync-state', () => getSyncState(chain.id));
  const { byStore: newByStore, unrecognized } = planDeltaFiles(
    deltaFiles,
    validDeltaCursors(state?.lastDeltaTimestamps),
  );

  for (const file of unrecognized) {
    console.error(`syncChainDeltas: ${chain.id} skipped ${file}: no store id in file name`);
    opts.onFailure?.({
      level: 'file',
      stage: 'list-files',
      error: new Error(`unrecognised delta file name (no store id): ${file}`),
      chain: chain.id,
      file,
    });
  }

  if (!newByStore.size) {
    return { chain: chain.id, branchesChanged: 0, filesProcessed: 0, filesPending: 0, reason: 'no new delta files' };
  }

  let filesProcessed = 0;
  let filesPending = 0;
  let itemsTotal = 0;
  const failedStores: string[] = [];

  // One bad file (e.g. a body that isn't the archive its name says) must not
  // sink every other branch — same isolation as the full sync. A branch stops
  // at its first failed file without advancing its cursor: later deltas can't
  // be applied over the gap, the next run retries from that file, and the
  // nightly full sync fast-forwards the cursor past a permanently bad one.
  await mapWithConcurrency([...newByStore], DELTA_SYNC_CONCURRENCY, async ([storeId, ordered]) => {
    for (const [i, file] of ordered.entries()) {
      // Out of time: leave the rest of this branch for the next request rather
      // than letting the platform kill the function mid-run (a 504 with no
      // response, which a retry of the same request would only repeat).
      if (Date.now() >= deadline) {
        filesPending += ordered.length - i;
        return;
      }
      try {
        const xml = await withStage('download', () => downloadFile(cookie, file));
        const items = await withStage('parse', () => parsePriceItemsXml(xml, MAX_ITEMS_PER_CHAIN));
        await withStage('write-db', () => writeChainPricesIfCheaper(chain, items));
        itemsTotal += items.length;
        filesProcessed++;

        // Persisted after each file so a mid-batch crash resumes from the last
        // applied delta for that branch instead of redoing it.
        await withStage('sync-state', () => setDeltaCursor(chain.id, storeId, fileTimestamp(file)));
      } catch (err) {
        failedStores.push(storeId);
        console.error(`syncChainDeltas: ${chain.id} branch ${storeId} (${file}) failed: ${err}`);
        opts.onFailure?.({ level: 'file', error: err, chain: chain.id, storeId, file });
        return;
      }
    }
  });

  return {
    chain: chain.id,
    branchesChanged: newByStore.size,
    filesProcessed,
    filesPending,
    items: itemsTotal,
    storesFailed: failedStores.length ? failedStores : undefined,
  };
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
  const cookie = await withStage('login', () => cerberusLogin(chain.username));
  const files = await withStage('list-files', () => cerberusListFiles(cookie, 'Stores'));
  const file = pickLatestFile(files);
  if (!file) return { chain: chain.id, note: 'no Stores file found' };

  const xml = await withStage('download', () => downloadFile(cookie, file));
  const list = await withStage('parse', () => parseStoresXml(xml));
  await withStage('write-db', () => writeChainStores(chain, list));

  return { chain: chain.id, file, stores: list.length };
}
