import { tagValue } from './xml';

// ─── Stores.xml parsing ───────────────────────────────────────────────────────
//
// Every chain publishes a daily Stores file listing its physical branches,
// nested as <Root><SubChains><SubChain><Stores><Store>...</Store>...</Stores>
// </SubChain></SubChains></Root>. Confirmed the same shape across all four
// chains currently synced. Unlike PriceFull, this file is UTF-16LE — handled
// by cerberus.downloadFile's BOM detection, so this parser always receives
// already-decoded text.

export interface ParsedStore {
  storeId: string;
  subChainId?: string;
  name: string;
  address?: string;
  city?: string;
  zipCode?: string;
  storeType?: string;
}

export function parseStoresXml(xml: string): ParsedStore[] {
  const subChainRe = /<SubChain(?:\s[^>]*)?>([\s\S]*?)<\/SubChain>/gi;
  const stores: ParsedStore[] = [];
  let subChainMatch: RegExpExecArray | null;
  let sawSubChain = false;

  while ((subChainMatch = subChainRe.exec(xml)) !== null) {
    sawSubChain = true;
    const subChainBlock = subChainMatch[1];
    const subChainId = tagValue(subChainBlock, 'SubChainID') || undefined;
    stores.push(...parseStoreBlocks(subChainBlock, subChainId));
  }

  // Defensive fallback for a chain that skips the <SubChain> wrapper.
  return sawSubChain ? stores : parseStoreBlocks(xml, undefined);
}

function parseStoreBlocks(block: string, subChainId: string | undefined): ParsedStore[] {
  const storeRe = /<Store(?:\s[^>]*)?>([\s\S]*?)<\/Store>/gi;
  const out: ParsedStore[] = [];
  let m: RegExpExecArray | null;
  while ((m = storeRe.exec(block)) !== null) {
    const storeBlock = m[1];
    const storeId = tagValue(storeBlock, 'StoreID');
    if (!storeId) continue;
    out.push({
      storeId,
      subChainId,
      name: tagValue(storeBlock, 'StoreName'),
      address: tagValue(storeBlock, 'Address') || undefined,
      city: tagValue(storeBlock, 'City') || undefined,
      // Chains spell this both "ZIPCode" and "ZipCode" — tagValue's lookup is
      // already case-insensitive, so one call covers both.
      zipCode: tagValue(storeBlock, 'ZIPCode') || undefined,
      storeType: tagValue(storeBlock, 'StoreType') || undefined,
    });
  }
  return out;
}
