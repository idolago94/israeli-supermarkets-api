import type { VercelRequest, VercelResponse } from '@vercel/node';
import { CHAINS, findChain, syncChainFull } from '../../lib/sync';
import { runSyncEndpoint } from '../../lib/syncEndpoint';

// POST/GET /api/sync/full?chain=<id>&force=1
//
// Runs the full PriceFull sync. With ?chain=<id> it processes a single chain
// (recommended — one download + parse fits comfortably inside the function's
// time/memory budget). Without it, all chains run sequentially; use only for
// manual backfills where the total stays under maxDuration.
//
// ?force=1 (or force=true) skips the "unchanged since last sync" HEAD-check
// and re-downloads/re-parses even if the catalog file looks identical to the
// last successful run — useful after a parsing bug fix or to force a refresh.
//
// Protected by SYNC_SECRET (x-sync-secret header or ?secret=). Failures —
// including single branch files skipped while the rest of the chain synced —
// are returned in `failures` and reported as GitHub issues (see
// lib/syncEndpoint.ts).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const force = ['1', 'true'].includes(((req.query.force as string) || '').toLowerCase());
  await runSyncEndpoint(req, res, {
    flow: 'full',
    chains: CHAINS,
    findChain,
    params: { force },
    run: (chain, onFailure) => syncChainFull(chain, { skipUnchangedCheck: force, onFailure }),
  });
}
