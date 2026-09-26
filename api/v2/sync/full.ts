import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireSyncSecret } from '../../../lib/auth';
import { CHAINS, findChain } from '../../../lib/chains';
import { syncChainFullV2 } from '../../../lib/syncV2';

// GET/POST /api/v2/sync/full?chain=<id>&force=1
//
// v2 (Postgres/Supabase) full sync — same Cerberus fetching as v1's
// /api/sync/full, but each branch gets its own price rows instead of one
// aggregate per chain (see lib/syncV2.ts and README "Branches"). Delta sync
// isn't implemented yet for v2; this is full-sync only.
//
// Protected by SYNC_SECRET (x-sync-secret header or ?secret=), same as v1.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireSyncSecret(req, res)) return;

  const chainId = (req.query.chain as string) || '';
  const force = ['1', 'true'].includes(((req.query.force as string) || '').toLowerCase());
  try {
    if (chainId) {
      const chain = findChain(chainId);
      if (!chain) {
        res.status(400).json({ error: `unknown chain: ${chainId}` });
        return;
      }
      res.json({ ok: true, result: await syncChainFullV2(chain, { skipUnchangedCheck: force }) });
      return;
    }

    const summary: Record<string, unknown> = {};
    for (const chain of CHAINS) {
      try {
        summary[chain.id] = await syncChainFullV2(chain, { skipUnchangedCheck: force });
      } catch (err) {
        summary[chain.id] = `error: ${err}`;
      }
    }
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ error: `${err}` });
  }
}
