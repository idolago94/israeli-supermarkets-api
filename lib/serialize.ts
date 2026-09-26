import { ProductDoc } from './mongo';

// API product shape returned to the app. `prices` is a sorted array (cheapest
// first) so the client can render it directly — mirrors the old Firestore
// docToProduct output, with dates as ISO strings.
export interface ApiProduct {
  id: string;
  name: string;
  brand?: string;
  unitQty?: string;
  departments?: string[];
  measure?: {
    unitQty?: string;
    quantity?: number;
    unitOfMeasure?: string;
    qtyInPackage?: string;
    isWeighted?: boolean;
  };
  prices: {
    chainId: string;
    chainName: string;
    price: number;
    unitOfMeasurePrice?: number;
    allowDiscount?: boolean;
    /** True when this chain's branches don't all sell the item at `price` —
     *  it's the cheapest of the per-branch prices, not a flat chain price. */
    priceVaries?: boolean;
    updatedAt: string;
  }[];
}

export function toApiProduct(doc: ProductDoc): ApiProduct {
  const prices = Object.entries(doc.prices ?? {})
    .map(([chainId, p]) => ({
      chainId,
      chainName: p.chainName ?? chainId,
      price: typeof p.price === 'number' ? p.price : parseFloat(String(p.price)),
      ...(typeof p.unitOfMeasurePrice === 'number' ? { unitOfMeasurePrice: p.unitOfMeasurePrice } : {}),
      ...(typeof p.allowDiscount === 'boolean' ? { allowDiscount: p.allowDiscount } : {}),
      ...(typeof p.priceVaries === 'boolean' ? { priceVaries: p.priceVaries } : {}),
      updatedAt:
        p.updatedAt instanceof Date
          ? p.updatedAt.toISOString()
          : new Date(p.updatedAt ?? Date.now()).toISOString(),
    }))
    .filter((p) => isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.price - b.price);

  const departments = productDepartments(doc);

  return {
    id: doc._id,
    name: doc.name ?? '',
    ...(doc.brand ? { brand: doc.brand } : {}),
    ...(doc.unitQty ? { unitQty: doc.unitQty } : {}),
    ...(departments.length ? { departments } : {}),
    ...(doc.measure && Object.keys(doc.measure).length ? { measure: doc.measure } : {}),
    prices,
  };
}

/**
 * A product's departments, folding in the legacy single `department` field so
 * items saved before the multi-department migration still report their category.
 */
export function productDepartments(doc: ProductDoc): string[] {
  const list = Array.isArray(doc.departments) ? doc.departments : [];
  const merged = doc.department && !list.includes(doc.department)
    ? [...list, doc.department]
    : list;
  return merged.filter((d): d is string => typeof d === 'string' && d.length > 0);
}

// ─── Opaque keyset-pagination cursor ─────────────────────────────────────────

export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor(raw: string | undefined): Record<string, any> | null {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Read a query param that may arrive as string | string[]. */
export function qp(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}
