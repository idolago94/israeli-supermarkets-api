import type { VercelRequest, VercelResponse } from '@vercel/node';
import { CHAINS, findChain, syncChainStores } from '../../lib/sync';
import { runSyncEndpoint } from '../../lib/syncEndpoint';

// GET/POST /api/sync/stores?chain=<id>
//
// Refreshes the `stores` collection (branch id/name/address/city per chain)
// from each chain's daily Stores file. One small file per chain — no
// per-branch fan-out like /api/sync/full. Protected by SYNC_SECRET. Failures
// are returned in `failures` and reported as GitHub issues (see
// lib/syncEndpoint.ts).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  await runSyncEndpoint(req, res, {
    flow: 'stores',
    chains: CHAINS,
    findChain,
    run: (chain) => syncChainStores(chain),
  });
}
