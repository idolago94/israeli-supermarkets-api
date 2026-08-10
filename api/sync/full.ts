import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireSyncSecret } from '../../lib/auth';
import { CHAINS, findChain, syncChainFull } from '../../lib/sync';

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
// Protected by SYNC_SECRET (x-sync-secret header or ?secret=).
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
      res.json({ ok: true, result: await syncChainFull(chain, { skipUnchangedCheck: force }) });
      return;
    }

    const summary: Record<string, unknown> = {};
    for (const chain of CHAINS) {
      try {
        summary[chain.id] = await syncChainFull(chain, { skipUnchangedCheck: force });
      } catch (err) {
        summary[chain.id] = `error: ${err}${(err as any)?.cause ? ` (cause: ${(err as any).cause})` : ''}`;
      }
    }
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ error: `${err}${(err as any)?.cause ? ` (cause: ${(err as any).cause})` : ''}` });
  }
}
