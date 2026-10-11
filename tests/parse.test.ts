import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePriceItemsXml } from '../lib/parse';
import { PRICE_XML } from './helpers';

test('parses the current item schema', () => {
  const items = parsePriceItemsXml(PRICE_XML, 100);
  assert.deepEqual(items.map((i) => [i.code, i.name, i.price]), [
    ['7290000000001', 'חלב', 6.9],
    ['7290000000002', 'לחם', 9.5],
  ]);
});

test('parses the legacy schema rami_levy branch 039 still publishes (<ItemNm>)', () => {
  const xml = `<Root><ChainId>7290058140886</ChainId><StoreId>39</StoreId><Items>
    <Item><ItemCode>7290000000116</ItemCode><ItemNm>תפוח עץ ירוק גרנד סמיט</ItemNm><ManufacturerName>ביכורי השקמה</ManufacturerName>
    <ItemPrice>13</ItemPrice><bIsWeighted>1</bIsWeighted></Item></Items></Root>`;
  const [item] = parsePriceItemsXml(xml, 100);
  assert.equal(item.name, 'תפוח עץ ירוק גרנד סמיט');
  assert.equal(item.price, 13);
  assert.equal(item.brand, 'ביכורי השקמה');
  assert.equal(item.isWeighted, true);
});
