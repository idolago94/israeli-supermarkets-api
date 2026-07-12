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
  price: number;
  updatedAt: Date;
}

export interface ProductDoc {
  /** Normalized barcode (ItemCode) — also the document _id. */
  _id: string;
  name: string;
  nameLower: string;
  brand?: string;
  unitQty?: string;
  keywords?: string[];
  prices: Record<string, ChainPrice>;
  updatedAt: Date;
}

export interface SyncStateDoc {
  /** chainId — also the document _id. */
  _id: string;
  lastFullFile?: string;
  lastFullSize?: string;
  lastFullModified?: string;
  lastDeltaFile?: string;
  lastDeltaTimestamp?: string;
  updatedAt?: Date;
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
  await Promise.all([
    // Prefix search + default catalog ordering.
    col.createIndex({ nameLower: 1 }),
    // Word-prefix autocomplete (array-contains equivalent).
    col.createIndex({ keywords: 1 }),
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
