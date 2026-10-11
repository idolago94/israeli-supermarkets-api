import type { VercelRequest, VercelResponse } from '@vercel/node';
import { CHAINS, findChain, syncChainDeltas } from '../../lib/sync';
import { runSyncEndpoint } from '../../lib/syncEndpoint';

// POST/GET /api/sync/deltas?chain=<id>
//
// Runs the intraday delta sync (small "Price" files with only changed items).
// With ?chain=<id> it processes a single chain; without it, all chains run
// sequentially. Protected by SYNC_SECRET. Failures — including single branch
// files skipped while the rest of the chain synced — are returned in
// `failures` and reported as GitHub issues (see lib/syncEndpoint.ts).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  await runSyncEndpoint(req, res, {
    flow: 'deltas',
    chains: CHAINS,
    findChain,
    run: (chain, onFailure) => syncChainDeltas(chain, { onFailure }),
  });
}
