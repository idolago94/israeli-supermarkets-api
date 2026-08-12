import { MongoClient, Db, Collection } from 'mongodb';

// ─── Cached MongoDB connection ────────────────────────────────────────────────
//
// Serverless functions are invoked concurrently and reused across requests, so
// a fresh MongoClient per invocation would quickly exhaust the Atlas connection
// limit (especially on the free M0 tier). The client is cached on the global
// object so warm invocations reuse a single pooled connection.

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'catalog';

if (!uri) {
  // Surfaced at cold start rather than on first query, so a misconfiguration
  // fails loudly in the function logs.
  throw new Error('MONGODB_URI is not set');
}

interface CatalogGlobal {
  _catalogMongo?: {
    client: MongoClient;
    promise: Promise<MongoClient> | null;
    indexed: boolean;
  };
}

const g = globalThis as unknown as CatalogGlobal;
if (!g._catalogMongo) {
  g._catalogMongo = {
    client: new MongoClient(uri, { maxPoolSize: 10 }),
    promise: null,
    indexed: false,
  };
}
const cache = g._catalogMongo;

async function connect(): Promise<MongoClient> {
  if (!cache.promise) {
    cache.promise = cache.client.connect();
  }
  return cache.promise;
}

// ─── Document shapes ──────────────────────────────────────────────────────────

export interface ChainPrice {
  chainName: string;
  /** The product name as this chain writes it. Kept per-chain so the top-level
   *  `name` can be chosen canonically instead of "last chain to sync wins". */
  name?: string;
  price: number;
  /** Source UnitOfMeasurePrice — price per unit of measure (₪/ליטר). */
  unitOfMeasurePrice?: number;
  /** Source AllowDiscount — whether the chain allows discounts on this item. */
  allowDiscount?: boolean;
  /** True when this chain's branches don't all sell the item at `price` — it's
   *  the cheapest of the per-branch prices, not a chain-wide flat price. */
  priceVaries?: boolean;
  updatedAt: Date;
}

/** Physical measurement attributes, intrinsic to the product (barcode). */
export interface ProductMeasure {
  /** Source UnitQty — the unit the item is priced by. */
  unitQty?: string;
  /** Source Quantity — the numeric size. */
  quantity?: number;
  /** Source UnitOfMeasure — unit of `quantity`. */
  unitOfMeasure?: string;
  /** Source QtyInPackage — units per package. */
  qtyInPackage?: string;
  /** Source bIsWeighted — true when sold by weight. */
  isWeighted?: boolean;
}

export interface ProductDoc {
  /** Normalized barcode (ItemCode) — also the document _id. */
  _id: string;
  /** Canonical display name, chosen deterministically from the per-chain names
   *  in `prices.<chain>.name` (the shortest one) rather than "last chain wins".
   *  Recomputed on every sync write; stable regardless of chain sync order. */
  name: string;
  nameLower: string;
  brand?: string;
  /** Human-readable size label ("1.32 ליטר"), derived at parse time. */
  unitQty?: string;
  /**
   * Manually-assigned departments/categories. Not present in the source files,
   * so the sync never writes them — they're set only via the admin endpoint and
   * thus survive every re-sync (the sync's $set doesn't include this field). An
   * item may belong to several departments at once.
   */
  departments?: string[];
  /**
   * Legacy single-department field. Superseded by `departments` (which supports
   * multiple values); still read for backward compatibility until every product
   * has been re-saved through the admin screen, at which point it's unset.
   */
  department?: string;
  measure?: ProductMeasure;
  keywords?: string[];
  prices: Record<string, ChainPrice>;
  updatedAt: Date;
}

export interface SyncStateDoc {
  /** chainId — also the document _id. */
  _id: string;
  /** Combined `storeId:file:size:modified` signature (one segment per branch,
   *  sorted) from the last full sync's HEAD checks. Lets a full sync skip
   *  downloading every branch's file again when nothing has changed anywhere. */
  lastFullSignature?: string;
  lastDeltaFile?: string;
  lastDeltaTimestamp?: string;
  updatedAt?: Date;
}

/** A chain's physical branch, as published in its daily Stores file. */
export interface StoreDoc {
  /** `${chainId}:${storeId}` — unique across chains. */
  _id: string;
  chainId: string;
  chainName: string;
  storeId: string;
  subChainId?: string;
  name: string;
  address?: string;
  city?: string;
  zipCode?: string;
  storeType?: string;
  updatedAt: Date;
}

export async function getDb(): Promise<Db> {
  await connect();
  const db = cache.client.db(dbName);
  await ensureIndexes(db);
  return db;
}

export async function products(): Promise<Collection<ProductDoc>> {
  return (await getDb()).collection<ProductDoc>('products');
}

export async function syncState(): Promise<Collection<SyncStateDoc>> {
  return (await getDb()).collection<SyncStateDoc>('syncState');
}

export async function stores(): Promise<Collection<StoreDoc>> {
  return (await getDb()).collection<StoreDoc>('stores');
}

// Chains whose prices we index on for the catalog's per-chain sort. Kept in
// sync with the CHAINS list in lib/sync.ts.
const INDEXED_CHAINS = ['osher_ad', 'rami_levy', 'yohananof', 'tiv_taam'];

/**
 * Create the indexes the read endpoints rely on. Runs once per warm instance
 * (guarded by `cache.indexed`); createIndex is idempotent so repeat calls after
 * a cold start are cheap no-ops.
 */
async function ensureIndexes(db: Db): Promise<void> {
  if (cache.indexed) return;
  const col = db.collection<ProductDoc>('products');
  const storesCol = db.collection<StoreDoc>('stores');
  await Promise.all([
    storesCol.createIndex({ chainId: 1 }),
    // Prefix search + default catalog ordering.
    col.createIndex({ nameLower: 1 }),
    // Word-prefix autocomplete (array-contains equivalent).
    col.createIndex({ keywords: 1 }),
    // Department filtering (admin screen + app grouping). Multikey over the
    // departments array; sparse so the many un-categorized products are skipped.
    col.createIndex({ departments: 1 }, { sparse: true }),
    // Per-chain catalog sort (cheapest first), one index per chain. The
    // partial filter also excludes products the chain doesn't carry.
    ...INDEXED_CHAINS.map((id) =>
      col.createIndex(
        { [`prices.${id}.price`]: 1 },
        { partialFilterExpression: { [`prices.${id}`]: { $exists: true } } },
      ),
    ),
  ]);
  cache.indexed = true;
}
