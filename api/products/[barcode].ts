import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireApiKey } from '../../lib/auth';
import { products } from '../../lib/mongo';
import { toApiProduct, qp } from '../../lib/serialize';

// GET /api/products/:barcode  → single catalog product (or 404).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireApiKey(req, res)) return;

  const barcode = qp(req.query.barcode);
  if (!barcode) {
    res.status(400).json({ error: 'missing barcode' });
    return;
  }

  try {
    const doc = await (await products()).findOne({ _id: barcode });
    if (!doc) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.json({ product: toApiProduct(doc) });
  } catch (err) {
    res.status(500).json({ error: `${err}` });
  }
}
