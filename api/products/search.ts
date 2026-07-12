import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireApiKey } from '../../lib/auth';
import { products, ProductDoc } from '../../lib/mongo';
import { toApiProduct, qp } from '../../lib/serialize';

// GET /api/products/search?q=<term>&max=<n>
//
// Mirrors the old client-side search: combine a prefix match on nameLower with
// a word-prefix match on the keywords array, dedupe, and rank exact
// name-prefix hits first.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireApiKey(req, res)) return;

  const term = qp(req.query.q).trim().toLowerCase();
  const max = Math.min(Math.max(parseInt(qp(req.query.max) || '8', 10) || 8, 1), 25);
  if (term.length < 2) {
    res.json({ products: [] });
    return;
  }

  try {
    const col = await products();
    const [prefix, keyword] = await Promise.all([
      col
        // Range scan on the nameLower index: all names starting with `term`.
        .find({ nameLower: { $gte: term, $lt: term + '￿' } })
        .limit(max)
        .toArray(),
      col.find({ keywords: term }).limit(max).toArray(),
    ]);

    const byId = new Map<string, ProductDoc>();
    for (const d of [...prefix, ...keyword]) {
      if (!byId.has(d._id)) byId.set(d._id, d);
    }

    const results = [...byId.values()]
      .map(toApiProduct)
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(term) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(term) ? 0 : 1;
        return aStarts - bStarts || a.name.localeCompare(b.name, 'he');
      })
      .slice(0, max);

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.json({ products: results });
  } catch (err) {
    res.status(500).json({ error: `${err}` });
  }
}
