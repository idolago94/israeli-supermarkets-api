import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Filter, Sort } from 'mongodb';
import { requireApiKey } from '../../lib/auth';
import { products, ProductDoc } from '../../lib/mongo';
import { toApiProduct, encodeCursor, decodeCursor, qp } from '../../lib/serialize';

// Sentinel `department` value selecting products with no department assigned.
const NO_DEPARTMENT = '__none__';

// GET /api/products?chain=<id>&department=<name>&weighted=<0|1>&limit=<n>&cursor=<opaque>
//
// Paginated catalog browsing via keyset pagination (stable, index-friendly):
//   • chain unset → ordered by nameLower.
//   • chain set   → only products the chain carries, cheapest first (ordering
//     by prices.<chain>.price also filters out docs missing that chain).
//
// The optional department / weighted filters (used by the admin screen and the
// app's per-department view) narrow the result set on top of either ordering.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireApiKey(req, res)) return;

  const chain = qp(req.query.chain);
  const department = qp(req.query.department);
  const weighted = qp(req.query.weighted);
  const limit = Math.min(Math.max(parseInt(qp(req.query.limit) || '30', 10) || 30, 1), 100);
  const cursor = decodeCursor(qp(req.query.cursor) || undefined);

  try {
    const col = await products();
    // Filter is the AND of every active clause; empty → match everything.
    const clauses: Filter<ProductDoc>[] = [];

    if (department === NO_DEPARTMENT) {
      // Neither the multi-department array nor the legacy field carries a value.
      clauses.push({
        $and: [
          { $or: [{ departments: { $exists: false } }, { departments: { $size: 0 } }] },
          { department: { $exists: false } },
        ],
      });
    } else if (department) {
      // Match the array element or the legacy single field.
      clauses.push({ $or: [{ departments: department }, { department } ] });
    }

    if (weighted === '1') clauses.push({ 'measure.isWeighted': true });
    else if (weighted === '0') clauses.push({ 'measure.isWeighted': { $ne: true } });

    let sort: Sort;
    if (chain) {
      const priceKey = `prices.${chain}.price`;
      clauses.push({ [`prices.${chain}`]: { $exists: true } });
      sort = { [priceKey]: 1, _id: 1 };
      if (cursor && typeof cursor.price === 'number') {
        // (price, _id) keyset: next page starts strictly after the last row.
        clauses.push({
          $or: [
            { [priceKey]: { $gt: cursor.price } },
            { [priceKey]: cursor.price, _id: { $gt: cursor.id } },
          ],
        });
      }
    } else {
      sort = { nameLower: 1, _id: 1 };
      if (cursor && typeof cursor.nameLower === 'string') {
        clauses.push({
          $or: [
            { nameLower: { $gt: cursor.nameLower } },
            { nameLower: cursor.nameLower, _id: { $gt: cursor.id } },
          ],
        });
      }
    }

    const filter: Filter<ProductDoc> = clauses.length ? { $and: clauses } : {};

    const docs = await col.find(filter).sort(sort).limit(limit).toArray();
    const hasMore = docs.length === limit;

    let nextCursor: string | null = null;
    if (hasMore) {
      const last = docs[docs.length - 1];
      nextCursor = chain
        ? encodeCursor({ price: last.prices?.[chain]?.price, id: last._id })
        : encodeCursor({ nameLower: last.nameLower, id: last._id });
    }

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.json({ products: docs.map(toApiProduct), cursor: nextCursor, hasMore });
  } catch (err) {
    res.status(500).json({ error: `${err}` });
  }
}
