import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireApiKey } from '../../lib/auth';
import { products } from '../../lib/mongo';
import { searchTokens } from '../../lib/parse';
import { toApiProduct, qp } from '../../lib/serialize';

// GET /api/products/search?q=<term>&max=<n>
//
// Splits the term into word tokens and requires ALL of them to appear in the
// product's `keywords` array ($all). Because keywords hold word *prefixes*, this
// matches partial words, ignores word order, and tolerates extra words in the
// name — so "חלב דל לקטוז" finds "חלב טרי דל לקטוז" (which the old nameLower
// prefix match missed). Results are ranked with exact name-prefix hits first.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireApiKey(req, res)) return;

  const term = qp(req.query.q).trim();
  const max = Math.min(Math.max(parseInt(qp(req.query.max) || '8', 10) || 8, 1), 25);
  const tokens = searchTokens(term);
  if (!tokens.length) {
    res.json({ products: [] });
    return;
  }

  try {
    const col = await products();
    // Fetch a few extra candidates so the "starts-with" ranking below can
    // surface the best matches even when more than `max` products match.
    const docs = await col
      .find({ keywords: { $all: tokens } })
      .limit(Math.min(max * 4, 40))
      .toArray();

    const lower = term.toLowerCase();
    const results = docs
      .map(toApiProduct)
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(lower) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(lower) ? 0 : 1;
        return aStarts - bStarts || a.name.localeCompare(b.name, 'he');
      })
      .slice(0, max);

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.json({ products: results });
  } catch (err) {
    res.status(500).json({ error: `${err}` });
  }
}
