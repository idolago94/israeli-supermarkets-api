import type { ParsedItem } from '../../lib/parse';
import type { ServiceConfig } from './config';
import { ValidationError } from './errors';

// ─── Pre-write sanity checks ───────────────────────────────────────────────────
//
// Runs between parse and write-db. A file that fails is marked failed and is
// NOT written, so a truncated or garbled file never replaces good data:
//   - full: at least `minItemsFull` items (every real branch carries
//     thousands), and no drop bigger than `maxItemDropRatio` versus the
//     branch's previous successful full file;
//   - both: at most `maxBadPriceRatio` of the items priced above `maxPrice`
//     (the parser already drops zero, negative and non-numeric prices).

export interface ValidationResult {
  itemCount: number;
  previousCount?: number;
  suspiciousPrices: number;
}

export function validateItems(
  kind: 'full' | 'delta',
  items: ParsedItem[],
  rules: ServiceConfig['validation'],
  previousCount?: number,
): ValidationResult {
  const itemCount = items.length;
  const suspiciousPrices = items.filter((i) => !(i.price > 0) || i.price > rules.maxPrice).length;
  const details = { itemCount, previousCount, suspiciousPrices };

  if (kind === 'full') {
    if (itemCount < rules.minItemsFull) {
      throw new ValidationError(
        `only ${itemCount} items (minimum ${rules.minItemsFull}) — likely a truncated or broken file`,
        details,
      );
    }
    if (previousCount && itemCount < previousCount * (1 - rules.maxItemDropRatio)) {
      const drop = Math.round((1 - itemCount / previousCount) * 100);
      throw new ValidationError(
        `item count fell ${drop}% (${previousCount} → ${itemCount}), over the ${Math.round(rules.maxItemDropRatio * 100)}% limit`,
        details,
      );
    }
  }
  if (itemCount && suspiciousPrices / itemCount > rules.maxBadPriceRatio) {
    throw new ValidationError(
      `${suspiciousPrices} of ${itemCount} items have a price above ₪${rules.maxPrice}`,
      details,
    );
  }
  return { itemCount, ...(previousCount != null ? { previousCount } : {}), suspiciousPrices };
}
