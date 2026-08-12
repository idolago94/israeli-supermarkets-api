import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireSyncSecret } from '../../lib/auth';
import { CHAINS, findChain, syncChainStores } from '../../lib/sync';

// GET/POST /api/sync/stores?chain=<id>
//
// Refreshes the `stores` collection (branch id/name/address/city per chain)
// from each chain's daily Stores file. One small file per chain — no
// per-branch fan-out like /api/sync/full. Protected by SYNC_SECRET.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireSyncSecret(req, res)) return;

  const chainId = (req.query.chain as string) || '';
  try {
    if (chainId) {
      const chain = findChain(chainId);
      if (!chain) {
        res.status(400).json({ error: `unknown chain: ${chainId}` });
        return;
      }
      res.json({ ok: true, result: await syncChainStores(chain) });
      return;
    }

    const summary: Record<string, unknown> = {};
    for (const chain of CHAINS) {
      try {
        summary[chain.id] = await syncChainStores(chain);
      } catch (err) {
        summary[chain.id] = `error: ${err}`;
      }
    }
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ error: `${err}` });
  }
}
