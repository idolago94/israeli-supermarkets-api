import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../../lib/pg';
import { requireApiKey } from '../../../lib/auth';
import { qp } from '../../../lib/serialize';
import { toApiProductDetailV2, ProductDetailRow } from '../../../lib/serializeV2';

// GET /api/v2/products/:barcode
//
// v2 equivalent of GET /api/products/:barcode — full per-store price
// breakdown (not per-chain), the actual point of the v2 schema: every branch
// that carries the barcode, cheapest first. No PATCH here yet — v2 has no
// admin/departments-editing endpoint (see README "Catalog v2").
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireApiKey(req, res)) return;

  const barcode = qp(req.query.barcode);
  if (!barcode) {
    res.status(400).json({ error: 'missing barcode' });
    return;
  }

  try {
    const rows = await sql<ProductDetailRow[]>`
      select
        p.barcode, p.name, p.brand, p.unit_qty, p.measure_unit_qty, p.measure_quantity,
        p.measure_unit_of_measure, p.measure_qty_in_package, p.measure_is_weighted, p.departments,
        (
          select json_agg(json_build_object(
            'chainId', s.chain_id, 'chainName', c.name_he,
            'storeId', s.store_code, 'storeName', s.name,
            'price', pr.price, 'unitOfMeasurePrice', pr.unit_of_measure_price,
            'allowDiscount', pr.allow_discount, 'updatedAt', pr.updated_at
          ) order by pr.price asc)
          from prices pr
          join stores s on s.id = pr.store_id
          join chains c on c.id = s.chain_id
          where pr.product_id = p.id
        ) as prices
      from products p
      where p.barcode = ${barcode}
    `;

    if (!rows.length) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.json({ product: toApiProductDetailV2(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: `${err}` });
  }
}
