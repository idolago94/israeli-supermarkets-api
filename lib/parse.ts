// ─── PriceFull / Price XML parsing ───────────────────────────────────────────
//
// Both file types (full snapshot and intraday delta) share the same Item
// schema, so a single parser handles both. Ported unchanged from the original
// Cloud Function so barcode normalization and keyword generation stay
// byte-for-byte compatible with the data already produced.

export interface ParsedItem {
  code: string;
  name: string;
  price: number;
  brand?: string;
  unitQty?: string;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function tagValue(block: string, tag: string): string {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(block);
  return m ? decodeEntities(m[1]).trim() : '';
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

/** Word-prefix tokens powering the client's autocomplete keyword query. */
export function generateKeywords(name: string): string[] {
  const words = name
    .toLowerCase()
    .split(/[^\p{L}\p{N}%]+/u)
    .filter((w) => w.length >= 2);
  const out = new Set<string>();
  for (const word of words.slice(0, 8)) {
    for (let i = 2; i <= Math.min(word.length, 12); i++) {
      out.add(word.slice(0, i));
    }
  }
  return [...out].slice(0, 80);
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

    const brand = tagValue(block, 'ManufacturerName');
    const qty = tagValue(block, 'Quantity');
    const unit = tagValue(block, 'UnitOfMeasure');
    items.push({
      code,
      name,
      price,
      ...(brand && brand !== 'לא ידוע' ? { brand } : {}),
      ...(qty && unit ? { unitQty: `${trimTrailingZeros(qty)} ${unit}` } : {}),
    });
  }
  return items;
}
