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

test('search finds a plural query and never exposes min_price', () => {
  const result = tools.search_catalog({ query: 'massagers' });
  assert.equal(result.ok, true);
  const rose = result.products.find(product => product.id === 'rose-massager-01');
  assert.ok(rose);
  assert.equal(rose.name, 'Rose Personal Massager');
  assert.equal(rose.stock_quantity, 5);
  for (const product of result.products) assert.equal('min_price' in product, false);
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

test('details return public fields and never expose min_price', () => {
  const result = tools.get_product_details({ product_id: 'silicone-accessory-05' });
  assert.equal(result.ok, true);
  assert.equal(result.product.stock_quantity, 0);
  assert.equal('min_price' in result.product, false);
  assert.equal('image_url' in result.product, false);
});

test('unknown product returns the requested descriptive error', () => {
  assert.deepEqual(tools.get_product_details({ product_id: 'missing' }), {
    ok: false,
    error: 'Product not found for ID: missing'
  });
});

test('shipping state-only lookup uses the case-insensitive state baseline', () => {
  const baseline = tools.calculate_shipping({ state: 'ondo' });
  assert.equal(baseline.ok, true);
  assert.equal(baseline.delivery.city, undefined);
  assert.equal(baseline.delivery.fee, 2500);
});

test('shipping prefers a city rate and unknown state returns escalation guidance', () => {
  const result = tools.calculate_shipping({ state: 'Ondo', city: 'Akure' });
  assert.equal(result.ok, true);
  assert.equal(result.delivery.fee, 1500);
  assert.equal(result.delivery.estimated_days, '1-2');

  const missing = tools.calculate_shipping({ state: 'Kano' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'Shipping not available for state: Kano. Escalate to staff.');
});

test('seeding is idempotent for state-level shipping defaults', () => {
  seedTemporaryData(db);
  seedTemporaryData(db);
  const row = db.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE state = 'Ondo' AND city IS NULL").get();
  assert.equal(row.count, 1);
});

test('city lookup falls back to the state baseline when there is no city row', () => {
  const result = tools.calculate_shipping({ state: 'Lagos', city: 'Ikeja' });
  assert.equal(result.ok, true);
  assert.equal(result.delivery.city, undefined);
  assert.equal(result.delivery.fee, 6000);
});

test('escalation creates a pending handoff record', () => {
  const result = tools.escalate_to_human({
    reason: 'medical_question',
    customer_summary: 'Customer asked for product health advice.'
  });

  assert.equal(result.ok, true);
  assert.match(result.handoff_id, /^[0-9a-f-]{36}$/i);
  assert.equal(result.message, 'Chat successfully flagged for human staff review.');

  const row = db.prepare('SELECT * FROM handoffs WHERE id = ?').get(result.handoff_id);
  assert.equal(row.reason, 'medical_question');
  assert.equal(row.customer_summary, 'Customer asked for product health advice.');
  assert.equal(row.status, 'pending');
});

test('FTS index remains synchronized after product changes', () => {
  db.prepare(`
    INSERT INTO products
      (id, name, category, description, usage_summary, retail_price, min_price, stock_quantity)
    VALUES ('test-item', 'Test Item', 'testing', 'temporary FTS record', 'test', 100, 100, 1)
  `).run();
  assert.equal(tools.search_catalog({ query: 'temporary' }).products[0].id, 'test-item');

  db.prepare("UPDATE products SET name = 'Renamed Item', description = 'updated record' WHERE id = 'test-item'").run();
  assert.equal(tools.search_catalog({ query: 'renamed' }).products[0].id, 'test-item');
  assert.equal(tools.search_catalog({ query: 'temporary' }).count, 0);

  db.prepare("DELETE FROM products WHERE id = 'test-item'").run();
  assert.equal(tools.search_catalog({ query: 'renamed' }).count, 0);
});