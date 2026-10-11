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

/** A file this much older than the newest one in the same listing belongs to
 *  a branch that stopped publishing (closed, renumbered) or to a retired
 *  naming scheme — rami_levy still lists July 2026 legacy files months later. */
export const MAX_FILE_AGE_DAYS = 7;

function timestampToMs(ts: string): number {
  return Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12));
}

/**
 * Drops files published more than `maxAgeDays` before the newest file in the
 * listing (and files with no parsable timestamp). Measured against the listing
 * itself rather than the clock, so a chain that pauses publishing for a few
 * days keeps its latest files instead of syncing nothing. Without this a
 * stale branch's months-old prices would be merged into the chain's minimum.
 */
export function dropStaleFiles(files: string[], maxAgeDays = MAX_FILE_AGE_DAYS): string[] {
  const dated = files.map((f) => ({ f, ts: fileTimestamp(f) })).filter((x) => x.ts);
  if (!dated.length) return [];
  const newest = dated.reduce((max, x) => (x.ts > max ? x.ts : max), '');
  const cutoff = timestampToMs(newest) - maxAgeDays * 24 * 60 * 60 * 1000;
  return dated.filter((x) => timestampToMs(x.ts) >= cutoff).map((x) => x.f);
}

/**
 * Groups a chain's PriceFull (or Price) file listing by branch — each chain
 * publishes one file per store, named "...-<subChainId>-<storeId>-<ts>.gz" —
 * and keeps only the latest file per branch. `storeId` (ChainConfig) still
 * narrows to a single configured branch first, same as before this chain
 * published per-branch prices at all. Stale files are dropped first (see
 * dropStaleFiles), so a branch that stopped publishing drops out entirely.
 */
export function latestFilePerStore(
  files: string[],
  storeId?: string,
): { storeId: string; file: string }[] {
  const filtered = dropStaleFiles(filterByStore(files, storeId));
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
