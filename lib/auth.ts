import type { VercelRequest, VercelResponse } from '@vercel/node';

// ─── Request authentication ───────────────────────────────────────────────────
//
// Two independent secrets:
//   • CATALOG_API_KEY — sent by the mobile app on every read, in `x-api-key`.
//   • SYNC_SECRET     — required to trigger a catalog sync (write path).
//   • CRON_SECRET     — Vercel Cron's bearer token on scheduled invocations.

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Guards the read endpoints. Returns false (and sends 401) when the key is bad. */
export function requireApiKey(req: VercelRequest, res: VercelResponse): boolean {
  const expected = process.env.CATALOG_API_KEY;
  const provided = (req.headers['x-api-key'] as string) || '';
  if (!expected || !provided || !timingSafeEqual(provided, expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

/** Guards the /api/sync/* endpoints. */
export function requireSyncSecret(req: VercelRequest, res: VercelResponse): boolean {
  const expected = process.env.SYNC_SECRET;
  const provided =
    (req.headers['x-sync-secret'] as string) ||
    (req.query.secret as string) ||
    '';
  if (!expected || !provided || !timingSafeEqual(provided, expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

/**
 * Guards the /api/cron/* endpoints. Vercel Cron sends
 * `Authorization: Bearer <CRON_SECRET>`. When CRON_SECRET is unset we allow the
 * call (Vercel only invokes cron paths internally), but setting it is strongly
 * recommended so the endpoint can't be triggered publicly.
 */
export function requireCron(req: VercelRequest, res: VercelResponse): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!timingSafeEqual(provided, expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}
