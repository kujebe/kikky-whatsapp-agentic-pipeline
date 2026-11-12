const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { openDatabase } = require('../src/db');
const { seedTemporaryData } = require('../src/seed');
const { createTools } = require('../src/tools');

let db;
let tools;

before(() => {
  db = openDatabase(':memory:');
  seedTemporaryData(db);
  tools = createTools(db);
});

after(() => db.close());

test('search returns matching fixture products and exact stock', () => {
  const result = tools.search_catalog({ query: 'massager', max_price: 30000 });
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.products[0].id, 'pocket-massager-02');
  assert.equal(result.products[0].stock_quantity, 8);
});

test('search safely treats SQL wildcard characters as text', () => {
  const result = tools.search_catalog({ query: '%' });
  assert.equal(result.ok, true);
  assert.equal(result.count, 0);
});

test('invalid input returns validation errors instead of throwing', () => {
  const result = tools.search_catalog({ query: '', max_price: -1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid arguments/);
});

test('details return exact stock and pricing bounds', () => {
  const result = tools.get_product_details({ product_id: 'silicone-accessory-05' });
  assert.equal(result.ok, true);
  assert.equal(result.product.stock_quantity, 0);
  assert.equal(result.product.min_price, 17000);
});

test('unknown product returns a readable error', () => {
  assert.deepEqual(tools.get_product_details({ product_id: 'missing' }), {
    ok: false,
    error: 'Error: product not found'
  });
});

test('shipping looks up a state and city without inventing unknown rates', () => {
  const result = tools.calculate_shipping({ state: 'FCT', city: 'abuja' });
  assert.equal(result.ok, true);
  assert.equal(result.delivery.fee, 7000);
  assert.equal(result.delivery.estimated_days, '3-5');

  const missing = tools.calculate_shipping({ state: 'Kano', city: 'Kano' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /shipping zone not found/);
});