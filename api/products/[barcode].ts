import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { UpdateFilter } from 'mongodb';
import { requireApiKey } from '../../lib/auth';
import { products, ProductDoc } from '../../lib/mongo';
import { toApiProduct, qp } from '../../lib/serialize';

const MAX_DEPARTMENT_LEN = 100;

// /api/products/:barcode
//   GET   → single catalog product (or 404).
//   PATCH → update the manually-assigned `department` (admin screen).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireApiKey(req, res)) return;

  const barcode = qp(req.query.barcode);
  if (!barcode) {
    res.status(400).json({ error: 'missing barcode' });
    return;
  }

  if (req.method === 'PATCH' || req.method === 'PUT') {
    return updateDepartment(req, res, barcode);
  }
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, PATCH');
    res.status(405).json({ error: 'method not allowed' });
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

// PATCH body: { department: string }. An empty/blank value clears the field.
async function updateDepartment(req: VercelRequest, res: VercelResponse, barcode: string) {
  const body = (typeof req.body === 'string' ? safeParse(req.body) : req.body) ?? {};
  if (!('department' in body)) {
    res.status(400).json({ error: 'missing department' });
    return;
  }
  const raw = body.department;
  if (raw != null && typeof raw !== 'string') {
    res.status(400).json({ error: 'department must be a string' });
    return;
  }
  const department = (raw ?? '').trim().slice(0, MAX_DEPARTMENT_LEN);

  try {
    const col = await products();
    const update: UpdateFilter<ProductDoc> = department
      ? { $set: { department, updatedAt: new Date() } }
      : { $unset: { department: '' }, $set: { updatedAt: new Date() } };
    const result = await col.updateOne({ _id: barcode }, update);
    if (!result.matchedCount) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const doc = await col.findOne({ _id: barcode });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ product: doc ? toApiProduct(doc) : null });
  } catch (err) {
    res.status(500).json({ error: `${err}` });
  }
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
