// Standalone tool: pulls a chain's latest PriceFull file straight from the
// Cerberus portal and writes it to disk — no Mongo involved. Useful for
// eyeballing the raw source data for a chain locally.
//
// Usage: npx ts-node scripts/download-catalog.ts <chainId> [outDir]
// Example: npx ts-node scripts/download-catalog.ts osher_ad ./out

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ChainConfig, cerberusLogin, cerberusListFiles, pickLatestFile, downloadFile } from '../lib/cerberus';
import { parsePriceItemsXml } from '../lib/parse';

// Duplicated from lib/sync.ts (kept out of this script so importing it doesn't
// pull in lib/mongo.ts, which throws at load time without MONGODB_URI set).
const CHAINS: ChainConfig[] = [
  { id: 'osher_ad', nameHe: 'אושר עד', username: 'osherad' },
  { id: 'rami_levy', nameHe: 'רמי לוי', username: 'RamiLevi' },
  { id: 'yohananof', nameHe: 'יוחננוף', username: 'yohananof' },
  { id: 'tiv_taam', nameHe: 'טיב טעם', username: 'TivTaam' },
];

function findChain(id: string): ChainConfig | undefined {
  return CHAINS.find((c) => c.id === id);
}

async function main() {
  const chainId = process.argv[2];
  const outDir = process.argv[3] ?? '.';

  if (!chainId) {
    console.error(`Usage: npx ts-node scripts/download-catalog.ts <chainId> [outDir]`);
    console.error(`Known chains: ${CHAINS.map((c) => c.id).join(', ')}`);
    process.exit(1);
  }

  const chain = findChain(chainId);
  if (!chain) {
    console.error(`Unknown chain "${chainId}". Known chains: ${CHAINS.map((c) => c.id).join(', ')}`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  console.log(`Logging into Cerberus as "${chain.username}"...`);
  const cookie = await cerberusLogin(chain.username);

  console.log('Listing PriceFull files...');
  const files = await cerberusListFiles(cookie, 'PriceFull');
  const file = pickLatestFile(files, chain.storeId);
  if (!file) {
    console.error('No PriceFull file found for this chain.');
    process.exit(1);
  }

  console.log(`Downloading ${file}...`);
  const xml = await downloadFile(cookie, file);

  const xmlPath = join(outDir, `${chain.id}.PriceFull.xml`);
  writeFileSync(xmlPath, xml, 'utf8');
  console.log(`Wrote raw XML to ${xmlPath} (${xml.length.toLocaleString()} chars)`);

  const items = parsePriceItemsXml(xml, Number.MAX_SAFE_INTEGER);
  const jsonPath = join(outDir, `${chain.id}.catalog.json`);
  writeFileSync(jsonPath, JSON.stringify(items, null, 2), 'utf8');
  console.log(`Wrote parsed catalog to ${jsonPath} (${items.length.toLocaleString()} items)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
