import postgres from 'postgres';
import type { ChainConfig } from '../../lib/cerberus';
import type { ParsedStore } from '../../lib/stores';
import {
  BranchWriteResult,
  DeltaBranchInput,
  FullBranchInput,
  ensureStoreRows,
  loadStoreRows,
  recomputeNamesAndKeywords,
  upsertChain,
  writeBranchDelta,
  writeBranchFull,
  writeStores,
} from '../../lib/v2Writer';

// ─── Target catalog (v2 Postgres) ──────────────────────────────────────────────
//
// The writes the engine makes, as an interface so tests can use an in-memory
// fake (tests/fakes.ts). The real implementation is lib/v2Writer.ts bound to
// a postgres.js client. Only v2 is written; v1 (Mongo) is out of scope.

export interface StoreState {
  lastPriceFile: string | null;
  lastPriceSize: string | null;
  lastPriceModified: string | null;
  lastDeltaTs: string | null;
}

export interface Target {
  upsertChain(chain: ChainConfig): Promise<void>;
  writeStores(chainId: string, stores: ParsedStore[]): Promise<number>;
  ensureStores(chainId: string, storeCodes: string[]): Promise<void>;
  loadStoreStates(chainId: string): Promise<Map<string, StoreState>>;
  /** One branch's PriceFull, in one transaction. */
  writeBranchFull(input: FullBranchInput): Promise<BranchWriteResult>;
  /** One branch's Price (delta) file, in one transaction. */
  writeBranchDelta(input: DeltaBranchInput): Promise<BranchWriteResult>;
  recomputeNames(productIds: number[]): Promise<number>;
  close(): Promise<void>;
}

export function postgresTarget(connectionString: string): Target {
  const sql = postgres(connectionString, {
    // Chains × branch concurrency transactions at once, plus headroom.
    max: Number(process.env.SYNC_PG_POOL_SIZE || 16),
    idle_timeout: 60,
    connect_timeout: 30,
    // Supabase's transaction pooler (port 6543) doesn't support prepared
    // statements; set SYNC_PG_PREPARE=false when pointing at it.
    prepare: process.env.SYNC_PG_PREPARE !== 'false',
    onnotice: () => {},
  });
  return {
    upsertChain: (chain) => upsertChain(sql, chain),
    writeStores: (chainId, stores) => writeStores(sql, chainId, stores),
    ensureStores: (chainId, codes) => ensureStoreRows(sql, chainId, codes),
    loadStoreStates: (chainId) => loadStoreRows(sql, chainId),
    writeBranchFull: (input) => writeBranchFull(sql, input),
    writeBranchDelta: (input) => writeBranchDelta(sql, input),
    recomputeNames: (ids) => recomputeNamesAndKeywords(sql, ids),
    close: () => sql.end({ timeout: 5 }),
  };
}
