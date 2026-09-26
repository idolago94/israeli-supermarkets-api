import { ChainConfig } from './cerberus';

// ─── Chain config ───────────────────────────────────────────────────────────
// Shared between v1 (lib/sync.ts, Mongo) and v2 (lib/syncV2.ts, Postgres) —
// deliberately dependency-free (no lib/mongo import) so loading a v2 route
// never requires MONGODB_URI to be set.
//
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
