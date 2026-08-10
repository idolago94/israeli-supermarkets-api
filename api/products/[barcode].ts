import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { UpdateFilter } from 'mongodb';
import { requireApiKey } from '../../lib/auth';
import { products, ProductDoc } from '../../lib/mongo';
import { toApiProduct, qp } from '../../lib/serialize';

const MAX_DEPARTMENT_LEN = 100;
const MAX_DEPARTMENTS = 20;

// /api/products/:barcode
//   GET   → single catalog product (or 404).
//   PATCH → update the manually-assigned `departments` (admin screen).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireApiKey(req, res)) return;

  const barcode = qp(req.query.barcode);
  if (!barcode) {
    res.status(400).json({ error: 'missing barcode' });
    return;
  }

  if (req.method === 'PATCH' || req.method === 'PUT') {
    return updateDepartments(req, res, barcode);
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

// PATCH body: { departments: string[] } — the full set of departments the item
// belongs to. An empty array clears them. The legacy single-string `department`
// body is still accepted (wrapped into a one-element array) so older clients
// keep working. Saving always unsets the legacy `department` field, migrating
// the product to the multi-department shape.
async function updateDepartments(req: VercelRequest, res: VercelResponse, barcode: string) {
  const body = (typeof req.body === 'string' ? safeParse(req.body) : req.body) ?? {};
  const parsed = parseDepartments(body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const departments = parsed.departments;

  try {
    const col = await products();
    const update: UpdateFilter<ProductDoc> = departments.length
      ? { $set: { departments, updatedAt: new Date() }, $unset: { department: '' } }
      : { $unset: { departments: '', department: '' }, $set: { updatedAt: new Date() } };
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

// Normalize the request body into a clean, de-duplicated department list.
// Accepts `departments: string[]` or legacy `department: string`.
function parseDepartments(
  body: Record<string, unknown>,
): { departments: string[] } | { error: string } {
  let raw: unknown[];
  if ('departments' in body) {
    if (!Array.isArray(body.departments)) return { error: 'departments must be an array' };
    raw = body.departments;
  } else if ('department' in body) {
    raw = body.department == null ? [] : [body.department];
  } else {
    return { error: 'missing departments' };
  }

  const seen = new Set<string>();
  const departments: string[] = [];
  for (const entry of raw) {
    if (entry == null || entry === '') continue;
    if (typeof entry !== 'string') return { error: 'departments must be strings' };
    const name = entry.trim().slice(0, MAX_DEPARTMENT_LEN);
    const dedupeKey = name.toLowerCase();
    if (!name || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    departments.push(name);
    if (departments.length >= MAX_DEPARTMENTS) break;
  }
  return { departments };
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
