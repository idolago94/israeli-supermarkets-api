import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../../lib/pg';
import { requireApiKey } from '../../../lib/auth';
import { encodeCursor, decodeCursor, qp } from '../../../lib/serialize';
import { toApiProductSummaryV2, ProductSummaryRow } from '../../../lib/serializeV2';

const productColumns = sql`
  p.id, p.barcode, p.name, p.name_lower, p.brand, p.unit_qty,
  p.measure_unit_qty, p.measure_quantity, p.measure_unit_of_measure,
  p.measure_qty_in_package, p.measure_is_weighted, p.departments
`;

// GET /api/v2/products?chain=&limit=&cursor=
//
// v2 equivalent of /api/products. Prices are per (product, store) here, not
// per chain, so the list view returns an aggregate per product — cheapest /
// priciest / how many stores carry it — rather than a full per-store array
// (that's what /api/v2/products/:barcode is for; putting up to ~100 rows per
// product in a 30-product page would make the list response huge for no
// benefit here).
//
//   • chain unset → alphabetical (name_lower), same ordering as v1.
//   • chain set   → only products that chain's stores carry, cheapest-in-that-
//     chain first (MIN(price) joined through stores.chain_id).
//
// Keyset pagination, same opaque-cursor shape as v1 (lib/serialize.ts).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireApiKey(req, res)) return;

  const chain = qp(req.query.chain);
  const limit = Math.min(Math.max(parseInt(qp(req.query.limit) || '30', 10) || 30, 1), 100);
  const cursor = decodeCursor(qp(req.query.cursor) || undefined);

  try {
    let rows: ProductSummaryRow[];

    if (chain) {
      const cursorPrice = cursor && typeof cursor.price === 'number' ? cursor.price : -1;
      const cursorId = cursor && typeof cursor.id === 'number' ? cursor.id : -1;
      rows = await sql<ProductSummaryRow[]>`
        with agg as (
          select pr.product_id, min(pr.price) as cheapest, max(pr.price) as priciest, count(*) as store_count
          from prices pr
          join stores s on s.id = pr.store_id
          where s.chain_id = ${chain}
          group by pr.product_id
        )
        select ${productColumns}, agg.cheapest, agg.priciest, agg.store_count
        from products p
        join agg on agg.product_id = p.id
        where (agg.cheapest, p.id) > (${cursorPrice}, ${cursorId})
        order by agg.cheapest, p.id
        limit ${limit}
      `;
    } else {
      const cursorName = cursor && typeof cursor.nameLower === 'string' ? cursor.nameLower : '';
      const cursorId = cursor && typeof cursor.id === 'number' ? cursor.id : -1;
      rows = await sql<ProductSummaryRow[]>`
        with agg as (
          select product_id, min(price) as cheapest, max(price) as priciest, count(*) as store_count
          from prices
          group by product_id
        )
        select ${productColumns}, agg.cheapest, agg.priciest, agg.store_count
        from products p
        join agg on agg.product_id = p.id
        where (p.name_lower, p.id) > (${cursorName}, ${cursorId})
        order by p.name_lower, p.id
        limit ${limit}
      `;
    }

    const hasMore = rows.length === limit;
    let nextCursor: string | null = null;
    if (hasMore) {
      const last = rows[rows.length - 1] as any;
      nextCursor = chain
        ? encodeCursor({ price: Number(last.cheapest), id: last.id })
        : encodeCursor({ nameLower: last.name_lower, id: last.id });
    }

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.json({ products: rows.map(toApiProductSummaryV2), cursor: nextCursor, hasMore });
  } catch (err) {
    res.status(500).json({ error: `${err}` });
  }
}
