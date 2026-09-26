import { fileTimestamp, filterByStore, storeIdFromFileName } from './cerberus';

// ─── Per-branch file selection ─────────────────────────────────────────────────
//
// Shared between the v1 (MongoDB) and v2 (Postgres) sync backends — picking
// which branch files to process is a Cerberus-portal concern, independent of
// where the parsed prices end up.

export async function mapWithConcurrency<T, R>(
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
export function latestFilePerStore(
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
