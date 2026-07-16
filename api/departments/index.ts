import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireApiKey } from '../../lib/auth';
import { products } from '../../lib/mongo';

// GET /api/departments
//
// Returns the distinct set of department names assigned across the catalog,
// sorted alphabetically (Hebrew collation). Powers the admin screen's
// department dropdown/filter and the app's per-department grouping. Both the
// current `departments` array and the legacy single `department` field are
// folded in so nothing disappears mid-migration.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireApiKey(req, res)) return;

  try {
    const col = await products();
    const [fromArray, legacy] = await Promise.all([
      col.distinct('departments'),
      col.distinct('department'),
    ]);

    const set = new Set<string>();
    for (const value of [...fromArray, ...legacy]) {
      if (typeof value === 'string' && value.trim()) set.add(value.trim());
    }
    const departments = [...set].sort((a, b) => a.localeCompare(b, 'he'));

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.json({ departments });
  } catch (err) {
    res.status(500).json({ error: `${err}` });
  }
}
