const assert = require('node:assert/strict');
const { test, describe, beforeEach } = require('node:test');
const { openDatabase } = require('../src/db');
const { seedTemporaryData } = require('../src/seed');
const {
  releaseExpiredHolds,
  create_order_reservation,
  verify_transfer_receipt
} = require('../src/tools/orders');
const { createTools } = require('../src/tools');
const { dispatchImageTurn } = require('../src/agent/dispatcher');

describe('Stage 4: Order Reservations, Inventory Holds & Receipt Verification', () => {
  let db;

  beforeEach(() => {
    db = openDatabase(':memory:');
    seedTemporaryData(db);
  });

  test('1. Hold Creation: Reserving an item decrements stock and sets 45-minute expiry', () => {
    const roseBefore = db.prepare('SELECT stock_quantity, retail_price FROM products WHERE id = ?').get('rose-massager-01');
    assert.equal(roseBefore.stock_quantity, 5);

    const result = create_order_reservation({
      product_id: 'rose-massager-01',
      state: 'Ondo',
      city: 'Akure',
      quantity: 1
    }, { db, sessionId: 'session-hold-1' });

    assert.equal(result.ok, true);
    assert.match(result.order_id, /^ord_/);
    assert.equal(result.product_name, 'Rose Personal Massager');
    assert.equal(result.quantity, 1);
    assert.equal(result.item_price, 30000);
    assert.equal(result.delivery_fee, 1500);
    assert.equal(result.total_amount, 31500);
    assert.equal(result.hold_minutes, 45);
    assert.match(result.bank_details, /5140099034/);
    assert.match(result.bank_details, /Moniepoint MFB/);

    // Verify stock decremented
    const roseAfter = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('rose-massager-01');
    assert.equal(roseAfter.stock_quantity, 4);

    // Verify reservation row in SQLite
    const order = db.prepare('SELECT * FROM order_reservations WHERE id = ?').get(result.order_id);
    assert.ok(order);
    assert.equal(order.status, 'AWAITING_PAYMENT');
    assert.equal(order.session_id, 'session-hold-1');
    assert.equal(order.total_amount, 31500);

    // Verify session updated
    const session = db.prepare('SELECT order_stage, delivery_state, delivery_city FROM sessions WHERE session_id = ?').get('session-hold-1');
    assert.equal(session.order_stage, 'awaiting_payment');
    assert.equal(session.delivery_state, 'Ondo');
    assert.equal(session.delivery_city, 'Akure');
  });

  test('2. Product Switch: Reserving a different item releases original item stock without inventory loss', () => {
    // Customer first reserves Rose Massager
    const firstRes = create_order_reservation({
      product_id: 'rose-massager-01',
      state: 'Ondo',
      city: 'Akure'
    }, { db, sessionId: 'session-switch' });
    assert.equal(firstRes.ok, true);

    const roseDuring = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('rose-massager-01');
    assert.equal(roseDuring.stock_quantity, 4);

    const gelBefore = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('wellness-gel-03');
    assert.equal(gelBefore.stock_quantity, 15);

    // Customer changes mind and reserves Wellness Gel
    const secondRes = create_order_reservation({
      product_id: 'wellness-gel-03',
      state: 'Ondo',
      city: 'Akure'
    }, { db, sessionId: 'session-switch' });
    assert.equal(secondRes.ok, true);
    assert.notEqual(firstRes.order_id, secondRes.order_id);

    // Rose stock restored back to 5
    const roseRestored = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('rose-massager-01');
    assert.equal(roseRestored.stock_quantity, 5);

    // Gel stock decremented from 15 to 14
    const gelAfter = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('wellness-gel-03');
    assert.equal(gelAfter.stock_quantity, 14);

    // First order marked CANCELLED
    const oldOrder = db.prepare('SELECT status FROM order_reservations WHERE id = ?').get(firstRes.order_id);
    assert.equal(oldOrder.status, 'CANCELLED');
  });

  test('3. Duplicate Protection: Re-triggering reservation on same item and destination does not double-decrement', () => {
    const firstRes = create_order_reservation({
      product_id: 'rose-massager-01',
      state: 'Ondo',
      city: 'Akure'
    }, { db, sessionId: 'session-dup' });
    assert.equal(firstRes.ok, true);

    const stockFirst = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('rose-massager-01');
    assert.equal(stockFirst.stock_quantity, 4);

    // Duplicate call (e.g. repeated user message or retry)
    const secondRes = create_order_reservation({
      product_id: 'rose-massager-01',
      state: 'Ondo',
      city: 'Akure'
    }, { db, sessionId: 'session-dup' });
    assert.equal(secondRes.ok, true);
    assert.equal(firstRes.order_id, secondRes.order_id);

    // Stock should still be 4, NOT 3
    const stockSecond = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('rose-massager-01');
    assert.equal(stockSecond.stock_quantity, 4);
  });

  test('4. Hold Expiry: Advancing simulated time and running releaseExpiredHolds restores stock', () => {
    const res = create_order_reservation({
      product_id: 'rose-massager-01',
      state: 'Ondo',
      city: 'Akure'
    }, { db, sessionId: 'session-expire' });
    assert.equal(res.ok, true);

    assert.equal(db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('rose-massager-01').stock_quantity, 4);

    // Artificially age the reservation timestamp past expiration
    db.prepare(`
      UPDATE order_reservations
      SET hold_expires_at = datetime('now', '-5 minutes')
      WHERE id = ?
    `).run(res.order_id);

    const releasedCount = releaseExpiredHolds(db);
    assert.equal(releasedCount, 1);

    // Stock must be restored to 5
    const restoredStock = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('rose-massager-01');
    assert.equal(restoredStock.stock_quantity, 5);

    // Status updated to EXPIRED
    const expiredOrder = db.prepare('SELECT status FROM order_reservations WHERE id = ?').get(res.order_id);
    assert.equal(expiredOrder.status, 'EXPIRED');
  });

  test('5. Full Payment: Exact amount transitions order to PAYMENT_VERIFIED and records matched payment', () => {
    const res = create_order_reservation({
      product_id: 'rose-massager-01',
      state: 'Ondo',
      city: 'Akure'
    }, { db, sessionId: 'session-pay-full' });
    assert.equal(res.ok, true);
    assert.equal(res.total_amount, 31500);

    const payResult = verify_transfer_receipt({
      extracted_amount: 31500,
      bank_name: 'Moniepoint MFB',
      sender_name: 'Omotola Adebayo',
      receipt_date: '2026-11-14 14:32:00'
    }, { db, sessionId: 'session-pay-full' });

    assert.equal(payResult.ok, true);
    assert.equal(payResult.matched, true);
    assert.equal(payResult.paid, 31500);
    assert.equal(payResult.expected, 31500);
    assert.match(payResult.message, /Payment verified/);

    // Verify database state
    const order = db.prepare('SELECT status FROM order_reservations WHERE id = ?').get(res.order_id);
    assert.equal(order.status, 'PAYMENT_VERIFIED');

    const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(res.order_id);
    assert.ok(payment);
    assert.equal(payment.status, 'matched');
    assert.equal(payment.amount, 31500);
    assert.equal(payment.sender_name, 'Omotola Adebayo');

    const session = db.prepare('SELECT order_stage FROM sessions WHERE session_id = ?').get('session-pay-full');
    assert.equal(session.order_stage, 'paid');
  });

  test('6. Underpayment: Insufficient amount reports balance_due and leaves order AWAITING_PAYMENT', () => {
    const res = create_order_reservation({
      product_id: 'rose-massager-01',
      state: 'Ondo',
      city: 'Akure'
    }, { db, sessionId: 'session-underpay' });
    assert.equal(res.total_amount, 31500);

    const payResult = verify_transfer_receipt({
      extracted_amount: 20000,
      bank_name: 'GTBank',
      sender_name: 'John Doe'
    }, { db, sessionId: 'session-underpay' });

    assert.equal(payResult.ok, false);
    assert.equal(payResult.underpaid, true);
    assert.equal(payResult.paid, 20000);
    assert.equal(payResult.expected, 31500);
    assert.equal(payResult.balance_due, 11500);
    assert.match(payResult.message, /Payment underpaid/);

    // Order remains AWAITING_PAYMENT
    const order = db.prepare('SELECT status FROM order_reservations WHERE id = ?').get(res.order_id);
    assert.equal(order.status, 'AWAITING_PAYMENT');

    // Payment recorded as underpaid
    const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(res.order_id);
    assert.ok(payment);
    assert.equal(payment.status, 'underpaid');
    assert.equal(payment.amount, 20000);
  });

  test('7. Overpayment: Payment exceeding total amount passes verification cleanly', () => {
    const res = create_order_reservation({
      product_id: 'rose-massager-01',
      state: 'Ondo',
      city: 'Akure'
    }, { db, sessionId: 'session-overpay' });
    assert.equal(res.total_amount, 31500);

    // Customer sends ₦35,000 (covers total and adds tip/express dispatch fee)
    const payResult = verify_transfer_receipt({
      extracted_amount: 35000,
      bank_name: 'Kuda Bank'
    }, { db, sessionId: 'session-overpay' });

    assert.equal(payResult.ok, true);
    assert.equal(payResult.matched, true);
    assert.equal(payResult.paid, 35000);
    assert.equal(payResult.expected, 31500);

    const order = db.prepare('SELECT status FROM order_reservations WHERE id = ?').get(res.order_id);
    assert.equal(order.status, 'PAYMENT_VERIFIED');
  });

  test('8. Out of Stock: Items with insufficient stock reject reservations safely', () => {
    // Exhaust stock
    db.prepare('UPDATE products SET stock_quantity = 0 WHERE id = ?').run('rose-massager-01');

    const result = create_order_reservation({
      product_id: 'rose-massager-01',
      state: 'Ondo',
      city: 'Akure'
    }, { db, sessionId: 'session-soldout' });

    assert.equal(result.ok, false);
    assert.equal(result.error_code, 'out_of_stock');
    assert.match(result.error, /sold out/i);
  });

  test('9. Expired Hold on Receipt Verification: Returns hold_expired error code', () => {
    const res = create_order_reservation({
      product_id: 'rose-massager-01',
      state: 'Ondo',
      city: 'Akure'
    }, { db, sessionId: 'session-expired-receipt' });

    // Age the hold
    db.prepare(`
      UPDATE order_reservations
      SET hold_expires_at = datetime('now', '-10 minutes')
      WHERE id = ?
    `).run(res.order_id);

    const payResult = verify_transfer_receipt({
      extracted_amount: 29000
    }, { db, sessionId: 'session-expired-receipt' });

    assert.equal(payResult.ok, false);
    assert.equal(payResult.error_code, 'hold_expired');
    assert.match(payResult.error, /Reservation expired/);
  });

  test('10. Scoped Tool Execution: createTools binds sessionId to order reservation tools', () => {
    const tools = createTools(db, { sessionId: 'scoped-user-123' });

    const res = tools.create_order_reservation({
      product_id: 'wellness-gel-03',
      state: 'Ondo',
      city: 'Akure'
    });

    assert.equal(res.ok, true);
    const order = db.prepare('SELECT session_id FROM order_reservations WHERE id = ?').get(res.order_id);
    assert.equal(order.session_id, 'scoped-user-123');

    const verify = tools.verify_transfer_receipt({
      extracted_amount: res.total_amount
    });
    assert.equal(verify.ok, true);
    assert.equal(verify.matched, true);
  });

  test('11. Deterministic Receipt Interception in dispatchImageTurn verified against order hold', async () => {
    // 1. Setup an active reservation for this session
    const reservation = create_order_reservation({
      product_id: 'rose-massager-01',
      state: 'Ondo',
      city: 'Akure'
    }, { db, sessionId: 'receipt-interception-sess' });
    assert.equal(reservation.ok, true);

    // 2. Mock vision returning payment_receipt with exact total amount
    const mockVision = async () => ({
      ok: true,
      data: {
        type: 'payment_receipt',
        amount: reservation.total_amount,
        bank: 'Moniepoint MFB',
        sender: 'Kikelomo Ajayi',
        date: '2026-11-14'
      }
    });

    const mockFetch = async (url, opts) => {
      const parsedBody = JSON.parse(opts.body);
      const lastUserMsg = parsedBody.messages[parsedBody.messages.length - 1].content;
      // Ensure the system note was injected into the prompt
      assert.match(lastUserMsg, /SYSTEM NOTE: Receipt automatically verified/);
      assert.match(lastUserMsg, /Payment verified/);

      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: 'Thank you so much ma! Payment is confirmed. Please send your full street address and phone number for the rider.'
            }
          }]
        })
      };
    };

    const turnResult = await dispatchImageTurn({
      imageBuffer: Buffer.alloc(100),
      db,
      visionFn: mockVision,
      options: {
        sessionId: 'receipt-interception-sess',
        apiKey: 'test-key',
        fetchClient: mockFetch
      }
    });

    assert.equal(turnResult.ok, true);
    assert.match(turnResult.reply, /Thank you so much ma/);

    // Check payment record was inserted in SQLite
    const payment = db.prepare('SELECT * FROM payments WHERE session_id = ?').get('receipt-interception-sess');
    assert.ok(payment);
    assert.equal(payment.status, 'matched');
    assert.equal(payment.amount, reservation.total_amount);

    // Order status updated
    const order = db.prepare('SELECT status FROM order_reservations WHERE id = ?').get(reservation.order_id);
    assert.equal(order.status, 'PAYMENT_VERIFIED');
  });
});
