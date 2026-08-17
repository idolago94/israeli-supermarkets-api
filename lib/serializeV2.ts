// ─── v2 API shapes (Postgres) ─────────────────────────────────────────────────
//
// postgres.js returns `numeric` columns as strings (avoids silent JS float
// precision loss) — every price/quantity field here needs an explicit
// Number() on the way out. Row shapes below match the exact column aliases
// the endpoints select; keep them in sync if a query's column list changes.

export interface ApiMeasureV2 {
  unitQty?: string;
  quantity?: number;
  unitOfMeasure?: string;
  qtyInPackage?: string;
  isWeighted?: boolean;
}

interface ProductFieldsRow {
  barcode: string;
  name: string;
  brand: string | null;
  unit_qty: string | null;
  measure_unit_qty: string | null;
  measure_quantity: string | null;
  measure_unit_of_measure: string | null;
  measure_qty_in_package: string | null;
  measure_is_weighted: boolean | null;
  departments: string[] | null;
}

function measureFrom(row: ProductFieldsRow): ApiMeasureV2 | undefined {
  const measure: ApiMeasureV2 = {};
  if (row.measure_unit_qty) measure.unitQty = row.measure_unit_qty;
  if (row.measure_quantity != null) measure.quantity = Number(row.measure_quantity);
  if (row.measure_unit_of_measure) measure.unitOfMeasure = row.measure_unit_of_measure;
  if (row.measure_qty_in_package) measure.qtyInPackage = row.measure_qty_in_package;
  if (row.measure_is_weighted != null) measure.isWeighted = row.measure_is_weighted;
  return Object.keys(measure).length ? measure : undefined;
}

// ─── List/search summary — aggregated across every store, not one row per store ──

export interface ApiProductSummaryV2 {
  id: string;
  name: string;
  brand?: string;
  unitQty?: string;
  measure?: ApiMeasureV2;
  departments?: string[];
  cheapestPrice: number;
  priciestPrice: number;
  priceVaries: boolean;
  storeCount: number;
}

export interface ProductSummaryRow extends ProductFieldsRow {
  cheapest: string;
  priciest: string;
  store_count: string | number;
}

export function toApiProductSummaryV2(row: ProductSummaryRow): ApiProductSummaryV2 {
  const cheapest = Number(row.cheapest);
  const priciest = Number(row.priciest);
  return {
    id: row.barcode,
    name: row.name ?? '',
    ...(row.brand ? { brand: row.brand } : {}),
    ...(row.unit_qty ? { unitQty: row.unit_qty } : {}),
    ...(measureFrom(row) ? { measure: measureFrom(row) } : {}),
    ...(row.departments && row.departments.length ? { departments: row.departments } : {}),
    cheapestPrice: cheapest,
    priciestPrice: priciest,
    priceVaries: cheapest !== priciest,
    storeCount: Number(row.store_count),
  };
}

// ─── Detail — full per-store breakdown, the point of the v2 schema ─────────────

export interface ApiStorePriceV2 {
  chainId: string;
  chainName: string;
  storeId: string;
  storeName: string;
  price: number;
  unitOfMeasurePrice?: number;
  allowDiscount?: boolean;
  updatedAt: string;
}

export interface ApiProductDetailV2 {
  id: string;
  name: string;
  brand?: string;
  unitQty?: string;
  measure?: ApiMeasureV2;
  departments?: string[];
  prices: ApiStorePriceV2[];
}

interface RawStorePrice {
  chainId: string;
  chainName: string;
  storeId: string;
  storeName: string;
  price: string | number;
  unitOfMeasurePrice: string | number | null;
  allowDiscount: boolean | null;
  updatedAt: string;
}

export interface ProductDetailRow extends ProductFieldsRow {
  prices: RawStorePrice[] | null;
}

export function toApiProductDetailV2(row: ProductDetailRow): ApiProductDetailV2 {
  const prices = (row.prices ?? []).map((p) => ({
    chainId: p.chainId,
    chainName: p.chainName,
    storeId: p.storeId,
    storeName: p.storeName,
    price: Number(p.price),
    ...(p.unitOfMeasurePrice != null ? { unitOfMeasurePrice: Number(p.unitOfMeasurePrice) } : {}),
    ...(p.allowDiscount != null ? { allowDiscount: p.allowDiscount } : {}),
    updatedAt: new Date(p.updatedAt).toISOString(),
  }));

  return {
    id: row.barcode,
    name: row.name ?? '',
    ...(row.brand ? { brand: row.brand } : {}),
    ...(row.unit_qty ? { unitQty: row.unit_qty } : {}),
    ...(measureFrom(row) ? { measure: measureFrom(row) } : {}),
    ...(row.departments && row.departments.length ? { departments: row.departments } : {}),
    prices,
  };
}
