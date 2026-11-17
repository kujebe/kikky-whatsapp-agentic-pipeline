const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { openDatabase } = require('../src/db');
const { seedTemporaryData } = require('../src/seed');
const { create_order_reservation } = require('../src/tools/orders');
const { save_delivery_details, deliveryDetailsSchema } = require('../src/tools/dispatch');
const { create_paystack_link } = require('../src/tools/paystack');
const {
  verifyWebhookSignature,
  handlePaystackPayload,
  startWebhookServer
} = require('../src/webhook');

function createTestDb() {
  const db = openDatabase(':memory:');
  seedTemporaryData(db);
  return db;
}

test('1. save_delivery_details: rejects when payment is not verified', () => {
  const db = createTestDb();
  const sessionId = 'test-session-unpaid';

  // Create an order in AWAITING_PAYMENT state
  const reservation = create_order_reservation(
    { product_id: 'rose-massager-01', state: 'Ondo', city: 'Akure' },
    { db, sessionId }
  );
  assert.equal(reservation.ok, true);

  const result = save_delivery_details(
    {
      recipient_name: 'Blessing Okon',
      recipient_phone: '08031234567',
      delivery_address: '14 Alagbaka Estate, Akure'
    },
    { db, sessionId }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'payment_unverified');
  assert.match(result.error, /Payment must be verified/);

  db.close();
});

test('2. save_delivery_details: succeeds, logs dispatch, and fulfills order when PAYMENT_VERIFIED', () => {
  const db = createTestDb();
  const sessionId = 'test-session-paid';

  const reservation = create_order_reservation(
    { product_id: 'rose-massager-01', state: 'Ondo', city: 'Akure' },
    { db, sessionId }
  );
  assert.equal(reservation.ok, true);

  // Transition order to PAYMENT_VERIFIED
  db.prepare("UPDATE order_reservations SET status = 'PAYMENT_VERIFIED' WHERE id = ?").run(reservation.order_id);

  const emittedEvents = [];
  const mockEmit = (event, payload) => emittedEvents.push({ event, payload });

  const result = save_delivery_details(
    {
      recipient_name: 'Funke Akindele',
      recipient_phone: '+234 802 345 6789',
      delivery_address: 'Shop 4, Oba Adesida Road, Akure'
    },
    { db, sessionId, emit: mockEmit }
  );

  assert.equal(result.ok, true);
  assert.ok(result.dispatch_id.startsWith('disp_'));
  assert.match(result.rider_slip, /KIKKY RIDER DISPATCH SLIP/);
  assert.match(result.rider_slip, /Funke Akindele/);
  assert.match(result.rider_slip, /2348023456789/);
  assert.match(result.rider_slip, /Shop 4, Oba Adesida Road/);

  // Verify DB state
  const updatedOrder = db.prepare('SELECT status FROM order_reservations WHERE id = ?').get(reservation.order_id);
  assert.equal(updatedOrder.status, 'FULFILLED');

  const dispatchRow = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(result.dispatch_id);
  assert.equal(dispatchRow.order_id, reservation.order_id);
  assert.equal(dispatchRow.recipient_name, 'Funke Akindele');
  assert.equal(dispatchRow.status, 'pending_rider');

  const sessionRow = db.prepare('SELECT delivery_address, order_stage FROM sessions WHERE session_id = ?').get(sessionId);
  assert.equal(sessionRow.delivery_address, 'Shop 4, Oba Adesida Road, Akure');
  assert.equal(sessionRow.order_stage, 'fulfilled');

  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].event, 'rider.dispatch.ready');

  db.close();
});

test('3. save_delivery_details: allows updating address if order is FULFILLED and dispatch is pending_rider', () => {
  const db = createTestDb();
  const sessionId = 'test-session-update';

  const reservation = create_order_reservation(
    { product_id: 'rose-massager-01', state: 'Ondo', city: 'Akure' },
    { db, sessionId }
  );
  db.prepare("UPDATE order_reservations SET status = 'PAYMENT_VERIFIED' WHERE id = ?").run(reservation.order_id);

  const firstSave = save_delivery_details(
    {
      recipient_name: 'Tola',
      recipient_phone: '08030001122',
      delivery_address: 'Old Address 1'
    },
    { db, sessionId }
  );
  assert.equal(firstSave.ok, true);

  // Customer corrects address
  const secondSave = save_delivery_details(
    {
      recipient_name: 'Tola Adegoke',
      recipient_phone: '08030001122',
      delivery_address: 'Correct Flat 2B, Alagbaka GRA, Akure'
    },
    { db, sessionId }
  );

  assert.equal(secondSave.ok, true);
  assert.equal(secondSave.dispatch_id, firstSave.dispatch_id);
  assert.match(secondSave.rider_slip, /Correct Flat 2B, Alagbaka GRA/);
  assert.match(secondSave.message, /updated/);

  const dispatchRow = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(firstSave.dispatch_id);
  assert.equal(dispatchRow.delivery_address, 'Correct Flat 2B, Alagbaka GRA, Akure');
  assert.equal(dispatchRow.recipient_name, 'Tola Adegoke');

  db.close();
});

test('4. create_paystack_link: converts total_amount to Kobo and sends required payload to Paystack API', async () => {
  const db = createTestDb();
  const sessionId = 'test-session-paystack-init';

  const reservation = create_order_reservation(
    { product_id: 'rose-massager-01', state: 'Ondo', city: 'Akure' },
    { db, sessionId }
  );
  assert.equal(reservation.ok, true);

  let capturedUrl = '';
  let capturedOptions = null;

  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        message: 'Authorization URL created',
        data: {
          authorization_url: 'https://checkout.paystack.com/mock_token_123',
          access_code: 'mock_code',
          reference: JSON.parse(options.body).reference
        }
      })
    };
  };

  const testConfig = {
    paystackSecretKey: 'sk_test_mock_12345',
    fallbackEmailDomain: 'kikkytest.ng',
    storeDescriptor: 'KLF Luxury Care'
  };

  const result = await create_paystack_link(
    { customer_email: 'buyer@example.com' },
    { db, sessionId, config: testConfig, fetchClient: mockFetch }
  );

  assert.equal(result.ok, true);
  assert.equal(result.payment_url, 'https://checkout.paystack.com/mock_token_123');
  assert.equal(result.amount_ngn, reservation.total_amount);

  assert.equal(capturedUrl, 'https://api.paystack.co/transaction/initialize');
  assert.equal(capturedOptions.headers['Authorization'], 'Bearer sk_test_mock_12345');

  const sentBody = JSON.parse(capturedOptions.body);
  assert.equal(sentBody.email, 'buyer@example.com');
  assert.equal(sentBody.amount, reservation.total_amount * 100);
  assert.equal(sentBody.metadata.order_id, reservation.order_id);
  assert.equal(sentBody.metadata.session_id, sessionId);

  db.close();
});

test('5. webhook: signature verification rejects invalid or mismatched signatures safely', () => {
  const secretKey = 'sk_test_sample_secret';
  const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'test_ref' } });

  // 1. Correct signature
  const validSig = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  assert.equal(verifyWebhookSignature(rawBody, validSig, secretKey), true);

  // 2. Tampered body
  assert.equal(verifyWebhookSignature(rawBody + 'tamper', validSig, secretKey), false);

  // 3. Different length signature (must not throw RangeError)
  assert.equal(verifyWebhookSignature(rawBody, 'short_invalid_sig', secretKey), false);
  assert.equal(verifyWebhookSignature(rawBody, '', secretKey), false);
  assert.equal(verifyWebhookSignature(rawBody, null, secretKey), false);
});

test('6. webhook: confirms order on valid signature and ignores duplicate reference idempotently', () => {
  const db = createTestDb();
  const sessionId = 'test-session-webhook';
  const secretKey = 'sk_test_webhook_secret';
  const config = { paystackSecretKey: secretKey, storeName: 'Kikky Luxury Femcare' };

  const reservation = create_order_reservation(
    { product_id: 'rose-massager-01', state: 'Ondo', city: 'Akure' },
    { db, sessionId }
  );

  const testRef = `kikky_${reservation.order_id}_${Date.now()}`;
  const payload = {
    event: 'charge.success',
    data: {
      status: 'success',
      reference: testRef,
      amount: reservation.total_amount * 100,
      currency: 'NGN',
      metadata: {
        order_id: reservation.order_id,
        session_id: sessionId
      },
      customer: {
        first_name: 'Amaka',
        last_name: 'Chukwu'
      }
    }
  };

  const rawBody = JSON.stringify(payload);
  const signature = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');

  // First webhook delivery
  const firstResult = handlePaystackPayload({
    payload,
    signature,
    rawBody,
    db,
    config
  });

  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.result, 'payment_verified');

  const verifiedOrder = db.prepare('SELECT status FROM order_reservations WHERE id = ?').get(reservation.order_id);
  assert.equal(verifiedOrder.status, 'PAYMENT_VERIFIED');

  const paymentRecord = db.prepare('SELECT * FROM payments WHERE reference = ?').get(testRef);
  assert.ok(paymentRecord);
  assert.equal(paymentRecord.amount, reservation.total_amount);
  assert.equal(paymentRecord.status, 'matched');
  assert.equal(paymentRecord.bank_name, 'Paystack');

  // Second duplicate webhook delivery
  const secondResult = handlePaystackPayload({
    payload,
    signature,
    rawBody,
    db,
    config
  });

  assert.equal(secondResult.ok, true);
  assert.match(secondResult.message, /idempotent/);

  // Payments table still has only 1 row for this reference
  const paymentCount = db.prepare('SELECT count(*) as cnt FROM payments WHERE reference = ?').get(testRef);
  assert.equal(paymentCount.cnt, 1);

  db.close();
});

test('7. webhook: late payment on expired hold decrements stock if available', () => {
  const db = createTestDb();
  const sessionId = 'test-session-late-stock';
  const secretKey = 'sk_test_late_key';
  const config = { paystackSecretKey: secretKey };

  const reservation = create_order_reservation(
    { product_id: 'rose-massager-01', state: 'Ondo', city: 'Akure' },
    { db, sessionId }
  );

  // Simulate hold expiration: status = EXPIRED and stock returned
  db.prepare("UPDATE order_reservations SET status = 'EXPIRED' WHERE id = ?").run(reservation.order_id);
  db.prepare("UPDATE products SET stock_quantity = 5 WHERE id = 'rose-massager-01'").run();

  const testRef = `kikky_${reservation.order_id}_late1`;
  const payload = {
    event: 'charge.success',
    data: {
      status: 'success',
      reference: testRef,
      amount: reservation.total_amount * 100,
      currency: 'NGN',
      metadata: { order_id: reservation.order_id }
    }
  };

  const rawBody = JSON.stringify(payload);
  const signature = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');

  const result = handlePaystackPayload({ payload, signature, rawBody, db, config });

  assert.equal(result.ok, true);
  assert.equal(result.result, 'payment_verified');

  // Stock decremented from 5 to 4
  const product = db.prepare("SELECT stock_quantity FROM products WHERE id = 'rose-massager-01'").get();
  assert.equal(product.stock_quantity, 4);

  const order = db.prepare('SELECT status FROM order_reservations WHERE id = ?').get(reservation.order_id);
  assert.equal(order.status, 'PAYMENT_VERIFIED');

  db.close();
});

test('8. webhook: late payment on expired hold with 0 stock records manual_review and handoff', () => {
  const db = createTestDb();
  const sessionId = 'test-session-late-nostock';
  const secretKey = 'sk_test_nostock_key';
  const config = { paystackSecretKey: secretKey };

  const reservation = create_order_reservation(
    { product_id: 'rose-massager-01', state: 'Ondo', city: 'Akure' },
    { db, sessionId }
  );

  // Set order EXPIRED and set product stock to 0
  db.prepare("UPDATE order_reservations SET status = 'EXPIRED' WHERE id = ?").run(reservation.order_id);
  db.prepare("UPDATE products SET stock_quantity = 0 WHERE id = 'rose-massager-01'").run();

  const testRef = `kikky_${reservation.order_id}_late0`;
  const payload = {
    event: 'charge.success',
    data: {
      status: 'success',
      reference: testRef,
      amount: reservation.total_amount * 100,
      currency: 'NGN',
      metadata: { order_id: reservation.order_id }
    }
  };

  const rawBody = JSON.stringify(payload);
  const signature = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');

  const result = handlePaystackPayload({ payload, signature, rawBody, db, config });

  assert.equal(result.ok, true);
  assert.equal(result.result, 'late_payment_stock_exhausted');

  // Stock remains 0 (no oversell)
  const product = db.prepare("SELECT stock_quantity FROM products WHERE id = 'rose-massager-01'").get();
  assert.equal(product.stock_quantity, 0);

  // Order remains EXPIRED
  const order = db.prepare('SELECT status FROM order_reservations WHERE id = ?').get(reservation.order_id);
  assert.equal(order.status, 'EXPIRED');

  // Payment logged as manual_review
  const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(testRef);
  assert.ok(payment);
  assert.equal(payment.status, 'manual_review');

  // Handoff created
  const handoffs = db.prepare("SELECT * FROM handoffs WHERE reason LIKE '%stock ran out%'").all();
  assert.ok(handoffs.length >= 1);

  db.close();
});

test('9. webhook http server: receives live POST request and verifies HMAC correctly', async () => {
  const db = createTestDb();
  const secretKey = 'sk_test_live_server_key';
  const testPort = 3199;
  const config = {
    paystackSecretKey: secretKey,
    paystackWebhookPort: testPort,
    storeName: 'Kikky Test Store'
  };

  const server = await startWebhookServer({ db, config, port: testPort });

  try {
    const reservation = create_order_reservation(
      { product_id: 'rose-massager-01', state: 'Ondo', city: 'Akure' },
      { db, sessionId: 'http-session' }
    );

    const testRef = `kikky_${reservation.order_id}_http`;
    const payload = {
      event: 'charge.success',
      data: {
        status: 'success',
        reference: testRef,
        amount: reservation.total_amount * 100,
        currency: 'NGN',
        metadata: { order_id: reservation.order_id }
      }
    };

    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');

    const res = await fetch(`http://localhost:${testPort}/webhooks/paystack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': signature
      },
      body: rawBody
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.result, 'payment_verified');

    // Reject invalid signature over HTTP
    const badRes = await fetch(`http://localhost:${testPort}/webhooks/paystack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': 'bad_sig'
      },
      body: rawBody
    });
    assert.equal(badRes.status, 401);
  } finally {
    server.close();
    db.close();
  }
});

test('10. create_paystack_link: falls back gracefully to merchant Paystack store URL when secretKey is unconfigured', async () => {
  const db = createTestDb();
  const sessionId = 'test-session-paystack-fallback';

  const reservation = create_order_reservation(
    { product_id: 'rose-massager-01', state: 'Ondo', city: 'Akure' },
    { db, sessionId }
  );

  const testConfig = {
    paystackSecretKey: '',
    storeId: 'kikky_luxuryfemcare',
    paystackPaymentUrl: 'https://paystack.com/pay/kikky_luxuryfemcare'
  };

  const result = await create_paystack_link({}, { db, sessionId, config: testConfig });
  assert.equal(result.ok, true);
  assert.equal(result.payment_url, 'https://paystack.com/pay/kikky_luxuryfemcare');
  assert.equal(result.amount_ngn, reservation.total_amount);
  assert.ok(result.reference.startsWith('kikky_'));

  db.close();
});

test('11. create_paystack_link: auto-books order reservation when none exists if product and location are provided or in session', async () => {
  const db = createTestDb();
  const sessionId = 'test-session-auto-book';

  // Seed session with delivery state but NO active order hold
  db.prepare(`
    INSERT INTO sessions (session_id, delivery_state, delivery_city, order_stage)
    VALUES (?, 'Lagos', 'Ikeja', 'browsing')
  `).run(sessionId);

  let capturedInitPayload = null;
  const mockFetch = async (url, options) => {
    capturedInitPayload = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        status: true,
        data: {
          authorization_url: 'https://checkout.paystack.com/test-auto-book-code',
          reference: capturedInitPayload.reference
        }
      })
    };
  };

  const testConfig = {
    paystackSecretKey: 'sk_test_fake123',
    fallbackEmailDomain: 'kikkycare.ng'
  };

  // Customer called create_paystack_link with product_id (or from history) when no reservation was created yet
  const result = await create_paystack_link(
    { product_id: 'wellness-gel-03' },
    { db, sessionId, config: testConfig, fetchClient: mockFetch }
  );

  assert.equal(result.ok, true);
  assert.equal(result.payment_url, 'https://checkout.paystack.com/test-auto-book-code');
  assert.ok(result.reference.startsWith('kikky_'));
  assert.ok(result.order_id.startsWith('ord_'));

  // Verify the reservation was actually created in SQLite
  const orderRow = db.prepare('SELECT * FROM order_reservations WHERE id = ?').get(result.order_id);
  assert.ok(orderRow);
  assert.equal(orderRow.session_id, sessionId);
  assert.equal(orderRow.product_id, 'wellness-gel-03');
  assert.equal(orderRow.status, 'AWAITING_PAYMENT');
  assert.equal(orderRow.delivery_state, 'Lagos');

  db.close();
});

test('12. create_paystack_link: returns clean error when neither product nor location can be resolved', async () => {
  const db = createTestDb();
  const sessionId = 'test-session-no-context';

  const result = await create_paystack_link({}, { db, sessionId });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'no_active_reservation');
  assert.match(result.error, /Confirm product and delivery location first/);

  db.close();
});

test('13. create_paystack_link: generates fresh distinct reference on consecutive calls', async () => {
  const db = createTestDb();
  const sessionId = 'test-session-fresh-refs';

  const reservation = create_order_reservation(
    { product_id: 'rose-massager-01', state: 'Ondo', city: 'Akure' },
    { db, sessionId }
  );

  const testConfig = {
    paystackSecretKey: '',
    storeId: 'kikky_luxuryfemcare',
    paystackPaymentUrl: 'https://paystack.com/pay/kikky_luxuryfemcare'
  };

  const res1 = await create_paystack_link({}, { db, sessionId, config: testConfig });
  await new Promise(r => setTimeout(r, 2));
  const res2 = await create_paystack_link({}, { db, sessionId, config: testConfig });

  assert.equal(res1.ok, true);
  assert.equal(res2.ok, true);
  assert.notEqual(res1.reference, res2.reference);

  db.close();
});
