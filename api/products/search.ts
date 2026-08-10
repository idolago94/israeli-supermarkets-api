import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Filter } from 'mongodb';
import { requireApiKey } from '../../lib/auth';
import { products, ProductDoc } from '../../lib/mongo';
import { searchTokens } from '../../lib/parse';
import { toApiProduct, encodeCursor, decodeCursor, qp } from '../../lib/serialize';

// GET /api/products/search?q=<term>&limit=<n>&cursor=<opaque>
//
// Splits the term into word tokens and requires ALL of them to appear in the
// product's `keywords` array ($all). Because keywords hold word *prefixes*, this
// matches partial words, ignores word order, and tolerates extra words in the
// name — so "חלב דל לקטוז" finds "חלב טרי דל לקטוז".
//
// Paginated via keyset pagination on (nameLower, _id) — same stable,
// index-friendly ordering as the browse endpoint (api/products/index.ts) — so
// the app can load every match by following the cursor. Name order clusters
// prefix matches (e.g. products starting with "חלב") near the top for prefix
// queries, so ranking quality stays reasonable without the old in-memory sort.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireApiKey(req, res)) return;

  const term = qp(req.query.q).trim();
  const limit = Math.min(Math.max(parseInt(qp(req.query.limit) || '20', 10) || 20, 1), 50);
  const cursor = decodeCursor(qp(req.query.cursor) || undefined);
  const tokens = searchTokens(term);
  if (!tokens.length) {
    res.json({ products: [], cursor: null, hasMore: false });
    return;
  }

  try {
    const col = await products();
    const clauses: Filter<ProductDoc>[] = [{ keywords: { $all: tokens } }];

    if (cursor && typeof cursor.nameLower === 'string') {
      // (nameLower, _id) keyset: next page starts strictly after the last row.
      clauses.push({
        $or: [
          { nameLower: { $gt: cursor.nameLower } },
          { nameLower: cursor.nameLower, _id: { $gt: cursor.id } },
        ],
      });
    }

    const docs = await col
      .find({ $and: clauses })
      .sort({ nameLower: 1, _id: 1 })
      .limit(limit)
      .toArray();

    const hasMore = docs.length === limit;
    let nextCursor: string | null = null;
    if (hasMore) {
      const last = docs[docs.length - 1];
      nextCursor = encodeCursor({ nameLower: last.nameLower, id: last._id });
    }

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.json({ products: docs.map(toApiProduct), cursor: nextCursor, hasMore });
  } catch (err) {
    res.status(500).json({ error: `${err}` });
  }
}
