import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireSyncSecret } from '../../lib/auth';
import { CHAINS, findChain, syncChainDeltas } from '../../lib/sync';

// POST/GET /api/sync/deltas?chain=<id>
//
// Runs the intraday delta sync (small "Price" files with only changed items).
// With ?chain=<id> it processes a single chain; without it, all chains run
// sequentially. Protected by SYNC_SECRET.
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
      res.json({ ok: true, result: await syncChainDeltas(chain) });
      return;
    }

    const summary: Record<string, unknown> = {};
    for (const chain of CHAINS) {
      try {
        summary[chain.id] = await syncChainDeltas(chain);
      } catch (err) {
        summary[chain.id] = `error: ${err}`;
      }
    }
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ error: `${err}` });
  }
}
