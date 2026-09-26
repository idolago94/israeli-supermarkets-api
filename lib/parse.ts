// ─── PriceFull / Price XML parsing ───────────────────────────────────────────
//
// Both file types (full snapshot and intraday delta) share the same Item
// schema, so a single parser handles both. Ported unchanged from the original
// Cloud Function so barcode normalization and keyword generation stay
// byte-for-byte compatible with the data already produced.

import { decodeEntities, tagValue } from './xml';

export interface ParsedItem {
  code: string;
  name: string;
  price: number;
  brand?: string;
  /** Human-readable size label, derived from Quantity + UnitOfMeasure ("1.32 ליטר"). */
  unitQty?: string;
  // ─── Raw measurement fields (product-level; intrinsic to the barcode) ────────
  /** Source UnitQty — the unit the item is priced by ("ליטר", "ק"ג"). */
  measureUnitQty?: string;
  /** Source Quantity — the numeric size (1.32). */
  quantity?: number;
  /** Source UnitOfMeasure — unit of `quantity`. */
  unitOfMeasure?: string;
  /** Source QtyInPackage — units per package. */
  qtyInPackage?: string;
  /** Source bIsWeighted — true when sold by weight (deli/produce). */
  isWeighted?: boolean;
  // ─── Per-chain price fields (vary by chain) ──────────────────────────────────
  /** Source UnitOfMeasurePrice — price per unit of measure (₪/ליטר). */
  unitOfMeasurePrice?: number;
  /** Source AllowDiscount — whether the chain allows discounts on this item. */
  allowDiscount?: boolean;
}

const UNKNOWN = 'לא ידוע';

/** Trimmed text, or '' when empty or the standard "unknown" placeholder. */
function cleanText(value: string): string {
  const t = value.trim();
  return t && t !== UNKNOWN ? t : '';
}

/** '1' → true, '0' → false, anything else → undefined. */
function parseBool(value: string): boolean | undefined {
  const t = value.trim();
  if (t === '1') return true;
  if (t === '0') return false;
  return undefined;
}

/** Parsed positive number, or undefined when missing/non-positive. */
function parsePositive(value: string): number | undefined {
  const n = parseFloat(value);
  return isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Normalize barcodes so the same product matches across chains: digits only,
 * leading zeros stripped. Codes shorter than 7 digits are chain-internal PLU
 * codes (produce, deli) that would collide across chains, so they're skipped.
 */
export function normalizeBarcode(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 7 ? digits : '';
}

/**
 * Split a free-text search term into keyword tokens to match against the
 * `keywords` array stored per product. Uses the same word extraction as
 * `generateKeywords`, and truncates each word to 12 chars — the max prefix
 * length stored — so a full-word query still matches a stored prefix token.
 * The caller requires ALL returned tokens to be present ($all), which makes
 * multi-word queries order-independent and tolerant of extra words in the name
 * (e.g. "חלב דל לקטוז" matches "חלב טרי דל לקטוז").
 */
export function searchTokens(term: string): string[] {
  const words = term
    .toLowerCase()
    .split(/[^\p{L}\p{N}%]+/u)
    .filter((w) => w.length >= 2)
    .map((w) => w.slice(0, 12));
  return [...new Set(words)];
}

/**
 * Pick the canonical display name from the names the individual chains give the
 * same product. Rule: the **shortest** non-empty name (the most concise, least
 * marketing-padded), with a Hebrew-collated tiebreak for determinism on equal
 * lengths. Empty/whitespace names are ignored; an all-empty input yields ''.
 *
 * This is the JS spec/reference for the selection the sync performs inline via
 * an aggregation-pipeline update in `writeChainPrices` (lib/sync.ts). To switch
 * the product rule (e.g. longest, or chain-priority), change this one function
 * and the matching pipeline stage.
 */
export function pickCanonicalName(names: string[]): string {
  const cleaned = names.map((n) => (n ?? '').trim()).filter((n) => n.length > 0);
  if (!cleaned.length) return '';
  return cleaned.reduce((best, n) => {
    if (n.length < best.length) return n;
    if (n.length === best.length && n.localeCompare(best, 'he') < 0) return n;
    return best;
  });
}

/**
 * Word-prefix tokens powering the client's autocomplete keyword query.
 *
 * Every word in the name is indexed (each truncated to a 12-char prefix set),
 * with no cap on the number of words or the total keyword count. Earlier limits
 * (first 8 words / 80 keywords) silently dropped the distinguishing tail words
 * of long Hebrew product names — e.g. "דל לקטוז" at the end of a long milk name
 * — so those products never matched a `$all` search on the missing tokens.
 */
export function generateKeywords(name: string): string[] {
  const words = name
    .toLowerCase()
    .split(/[^\p{L}\p{N}%]+/u)
    .filter((w) => w.length >= 2);
  const out = new Set<string>();
  for (const word of words) {
    for (let i = 2; i <= Math.min(word.length, 12); i++) {
      out.add(word.slice(0, i));
    }
  }
  return [...out];
}

function trimTrailingZeros(qty: string): string {
  return qty.replace(/\.?0+$/, '');
}

export function parsePriceItemsXml(xml: string, maxItems: number): ParsedItem[] {
  const items: ParsedItem[] = [];
  const itemRe = /<Item(?:\s[^>]*)?>([\s\S]*?)<\/Item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null && items.length < maxItems) {
    const block = match[1];
    const code = normalizeBarcode(tagValue(block, 'ItemCode'));
    const name = tagValue(block, 'ItemName');
    const price = parseFloat(tagValue(block, 'ItemPrice'));
    if (!code || !name || !isFinite(price) || price <= 0) continue;

    // Most chains emit <ManufactureName> (no "r"); the previous code only
    // looked up <ManufacturerName>, so brand was empty for them. Check both
    // spellings so neither variant regresses.
    const brand = cleanText(
      tagValue(block, 'ManufactureName') || tagValue(block, 'ManufacturerName'),
    );
    const qtyRaw = tagValue(block, 'Quantity');
    const measureUnitQty = cleanText(tagValue(block, 'UnitQty'));
    const quantity = parsePositive(qtyRaw);
    const unitOfMeasure = cleanText(tagValue(block, 'UnitOfMeasure'));
    const qtyInPackage = cleanText(tagValue(block, 'QtyInPackage'));
    const isWeighted = parseBool(tagValue(block, 'bIsWeighted'));
    const unitOfMeasurePrice = parsePositive(tagValue(block, 'UnitOfMeasurePrice'));
    const allowDiscount = parseBool(tagValue(block, 'AllowDiscount'));
    items.push({
      code,
      name,
      price,
      ...(brand ? { brand } : {}),
      ...(qtyRaw && unitOfMeasure ? { unitQty: `${trimTrailingZeros(qtyRaw)} ${unitOfMeasure}` } : {}),
      ...(measureUnitQty ? { measureUnitQty } : {}),
      ...(quantity != null ? { quantity } : {}),
      ...(unitOfMeasure ? { unitOfMeasure } : {}),
      ...(qtyInPackage ? { qtyInPackage } : {}),
      ...(isWeighted != null ? { isWeighted } : {}),
      ...(unitOfMeasurePrice != null ? { unitOfMeasurePrice } : {}),
      ...(allowDiscount != null ? { allowDiscount } : {}),
    });
  }
  return items;
}
