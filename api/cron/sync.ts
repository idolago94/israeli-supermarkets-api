import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireCron } from '../../lib/auth';
import { CHAINS, syncChainFull, syncChainDeltas } from '../../lib/sync';

// GET /api/cron/sync?mode=full|deltas
//
// Vercel Cron target (see vercel.json). Runs the requested sync for every chain
// sequentially inside a single long-running invocation (maxDuration 300s).
// Each chain is isolated in its own try/catch so one failure doesn't abort the
// rest. Protected by CRON_SECRET (Vercel sends it as a Bearer token).
//
// If a chain's file ever grows large enough that four sequential runs risk the
// 300s ceiling, split into per-chain crons hitting /api/sync/{mode}?chain=<id>.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireCron(req, res)) return;

  const mode = (req.query.mode as string) === 'deltas' ? 'deltas' : 'full';
  const run = mode === 'deltas' ? syncChainDeltas : syncChainFull;

  const summary: Record<string, unknown> = {};
  for (const chain of CHAINS) {
    try {
      summary[chain.id] = await run(chain);
    } catch (err) {
      summary[chain.id] = `error: ${err}`;
    }
  }

  res.json({ ok: true, mode, summary });
}
