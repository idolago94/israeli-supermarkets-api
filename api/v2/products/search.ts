import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../../lib/pg';
import { requireApiKey } from '../../../lib/auth';
import { searchTokens } from '../../../lib/parse';
import { encodeCursor, decodeCursor, qp } from '../../../lib/serialize';
import { toApiProductSummaryV2, ProductSummaryRow } from '../../../lib/serializeV2';

const productColumns = sql`
  p.id, p.barcode, p.name, p.name_lower, p.brand, p.unit_qty,
  p.measure_unit_qty, p.measure_quantity, p.measure_unit_of_measure,
  p.measure_qty_in_package, p.measure_is_weighted, p.departments
`;

// GET /api/v2/products/search?q=<term>&limit=<n>&cursor=<opaque>
//
// v2 equivalent of /api/products/search. `keywords @>` (array containment)
// requires every token to be present, same "$all" semantics as v1 — so
// "חלב דל לקטוז" still matches "חלב טרי דל לקטוז". Same (name_lower, id)
// keyset ordering as the browse endpoint.
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

  const cursorName = cursor && typeof cursor.nameLower === 'string' ? cursor.nameLower : '';
  const cursorId = cursor && typeof cursor.id === 'number' ? cursor.id : -1;

  try {
    const rows = await sql<ProductSummaryRow[]>`
      with agg as (
        select product_id, min(price) as cheapest, max(price) as priciest, count(*) as store_count
        from prices
        group by product_id
      )
      select ${productColumns}, agg.cheapest, agg.priciest, agg.store_count
      from products p
      join agg on agg.product_id = p.id
      where p.keywords @> ${tokens}
        and (p.name_lower, p.id) > (${cursorName}, ${cursorId})
      order by p.name_lower, p.id
      limit ${limit}
    `;

    const hasMore = rows.length === limit;
    let nextCursor: string | null = null;
    if (hasMore) {
      const last = rows[rows.length - 1] as any;
      nextCursor = encodeCursor({ nameLower: last.name_lower, id: last.id });
    }

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.json({ products: rows.map(toApiProductSummaryV2), cursor: nextCursor, hasMore });
  } catch (err) {
    res.status(500).json({ error: `${err}` });
  }
}
