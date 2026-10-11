import type { VercelRequest, VercelResponse } from '@vercel/node';
import { CHAINS, findChain } from '../../../lib/chains';
import { syncChainFullV2 } from '../../../lib/syncV2';
import { runSyncEndpoint } from '../../../lib/syncEndpoint';

// GET/POST /api/v2/sync/full?chain=<id>&force=1
//
// v2 (Postgres/Supabase) full sync — same Cerberus fetching as v1's
// /api/sync/full, but each branch gets its own price rows instead of one
// aggregate per chain (see lib/syncV2.ts and README "Branches"). Delta sync
// isn't implemented yet for v2; this is full-sync only.
//
// Protected by SYNC_SECRET (x-sync-secret header or ?secret=), same as v1, and
// reports failures as GitHub issues the same way (flow "full-v2").
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const force = ['1', 'true'].includes(((req.query.force as string) || '').toLowerCase());
  await runSyncEndpoint(req, res, {
    flow: 'full-v2',
    chains: CHAINS,
    findChain,
    params: { force },
    run: (chain) => syncChainFullV2(chain, { skipUnchangedCheck: force }),
  });
}
