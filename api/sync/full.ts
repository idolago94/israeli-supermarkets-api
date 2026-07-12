import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireSyncSecret } from '../../lib/auth';
import { CHAINS, findChain, syncChainFull } from '../../lib/sync';

// POST/GET /api/sync/full?chain=<id>
//
// Runs the full PriceFull sync. With ?chain=<id> it processes a single chain
// (recommended — one download + parse fits comfortably inside the function's
// time/memory budget). Without it, all chains run sequentially; use only for
// manual backfills where the total stays under maxDuration.
//
// Protected by SYNC_SECRET (x-sync-secret header or ?secret=).
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
      res.json({ ok: true, result: await syncChainFull(chain) });
      return;
    }

    const summary: Record<string, unknown> = {};
    for (const chain of CHAINS) {
      try {
        summary[chain.id] = await syncChainFull(chain);
      } catch (err) {
        summary[chain.id] = `error: ${err}`;
      }
    }
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ error: `${err}` });
  }
}
