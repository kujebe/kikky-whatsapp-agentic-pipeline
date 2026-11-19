const http = require('node:http');
const crypto = require('node:crypto');
const defaultConfig = require('./config');
const { openDatabase } = require('./db');

function verifyWebhookSignature(rawBody, signature, secretKey) {
  if (!signature || !secretKey || typeof signature !== 'string') {
    return false;
  }

  const expectedHex = crypto
    .createHmac('sha512', secretKey)
    .update(rawBody)
    .digest('hex');

  const sigBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedHex, 'utf8');

  if (sigBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
}

function extractOrderId(data) {
  if (data.metadata?.order_id) {
    return String(data.metadata.order_id).trim();
  }

  if (typeof data.reference === 'string') {
    const match = data.reference.match(/^kikky_(ord_[a-f0-9-]+)(?:_[a-f0-9]+)?$/i);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function handlePaystackPayload({ payload, signature, rawBody, db, config = defaultConfig, onPaymentVerified = null }) {
  if (!db) {
    return { ok: false, status: 500, error: 'Database required' };
  }

  const secretKey = config.paystackSecretKey;
  if (!verifyWebhookSignature(rawBody, signature, secretKey)) {
    return { ok: false, status: 401, error: 'Unauthorized: signature mismatch' };
  }

  if (payload.event !== 'charge.success') {
    return { ok: true, status: 200, message: 'Ignored non-charge event', event: payload.event };
  }

  const paymentData = payload.data || {};
  const reference = paymentData.reference;
  if (!reference) {
    return { ok: false, status: 400, error: 'Missing payment reference' };
  }

  if (paymentData.status !== 'success' || (paymentData.currency && paymentData.currency !== 'NGN')) {
    return { ok: true, status: 200, message: 'Ignored unsuccessful or non-NGN transaction' };
  }

  const existingPayment = db.prepare('SELECT id FROM payments WHERE reference = ?').get(reference);
  if (existingPayment) {
    return { ok: true, status: 200, message: 'Payment already processed (idempotent)', reference };
  }

  const orderId = extractOrderId(paymentData);
  if (!orderId) {
    const handoffId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO handoffs (id, reason, customer_summary, status)
      VALUES (?, ?, ?, 'pending')
    `).run(
      handoffId,
      `Paystack payment with unresolvable order_id: ref ${reference}`,
      JSON.stringify({ reference, amount: paymentData.amount })
    );
    return { ok: true, status: 200, message: 'Unresolved order flagged for human review' };
  }

  const paidNgn = Math.floor(Number(paymentData.amount || 0) / 100);
  const senderName = paymentData.customer?.first_name
    ? `${paymentData.customer.first_name} ${paymentData.customer.last_name || ''}`.trim()
    : (paymentData.metadata?.customer_name || 'Paystack Customer');

  let resultStatus = 'committed';

  const tx = db.transaction(() => {
    const dupCheck = db.prepare('SELECT id FROM payments WHERE reference = ?').get(reference);
    if (dupCheck) {
      resultStatus = 'duplicate';
      return;
    }

    const order = db.prepare('SELECT * FROM order_reservations WHERE id = ?').get(orderId);
    if (!order) {
      const handoffId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO handoffs (id, reason, customer_summary, status)
        VALUES (?, ?, ?, 'pending')
      `).run(
        handoffId,
        `Paystack payment received for non-existent order ${orderId}`,
        JSON.stringify({ reference, amount_ngn: paidNgn })
      );
      resultStatus = 'order_not_found';
      return;
    }

    if (order.status === 'EXPIRED') {
      const product = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(order.product_id);
      const availableStock = product?.stock_quantity ?? 0;

      if (availableStock >= order.quantity) {
        db.prepare('UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?').run(order.quantity, order.product_id);
      } else {
        const paymentId = 'pay_' + crypto.randomUUID();
        db.prepare(`
          INSERT INTO payments (id, order_id, session_id, amount, bank_name, sender_name, status, reference, raw_metadata)
          VALUES (?, ?, ?, ?, 'Paystack', ?, 'manual_review', ?, ?)
        `).run(paymentId, order.id, order.session_id, paidNgn, senderName, reference, JSON.stringify(paymentData));

        const handoffId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO handoffs (id, reason, customer_summary, status)
          VALUES (?, ?, ?, 'pending')
        `).run(
          handoffId,
          'Paystack payment received after hold expired and stock ran out',
          `Order ${order.id} expired. Customer paid ₦${paidNgn.toLocaleString('en-NG')}, but stock is 0.`
        );

        resultStatus = 'late_payment_stock_exhausted';
        return;
      }
    }

    const paymentId = 'pay_' + crypto.randomUUID();

    if (paidNgn >= order.total_amount) {
      db.prepare(`
        UPDATE order_reservations
        SET status = 'PAYMENT_VERIFIED',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(order.id);

      db.prepare(`
        INSERT INTO payments (id, order_id, session_id, amount, bank_name, sender_name, status, reference, raw_metadata)
        VALUES (?, ?, ?, ?, 'Paystack', ?, 'matched', ?, ?)
      `).run(paymentId, order.id, order.session_id, paidNgn, senderName, reference, JSON.stringify(paymentData));

      db.prepare(`
        UPDATE sessions
        SET order_stage = 'paid',
            updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ?
      `).run(order.session_id);

      resultStatus = 'payment_verified';
    } else {      db.prepare(`
        INSERT INTO payments (id, order_id, session_id, amount, bank_name, sender_name, status, reference, raw_metadata)
        VALUES (?, ?, ?, ?, 'Paystack', ?, 'underpaid', ?, ?)
      `).run(paymentId, order.id, order.session_id, paidNgn, senderName, reference, JSON.stringify(paymentData));

      resultStatus = 'underpaid';
    }
  });

  tx();

  if (resultStatus === 'payment_verified' && typeof onPaymentVerified === 'function') {
    const verifiedOrder = db.prepare('SELECT session_id, total_amount FROM order_reservations WHERE id = ?').get(orderId);
    if (verifiedOrder) {
      setImmediate(() => {
        try {
          onPaymentVerified(verifiedOrder.session_id, {
            order_id: orderId,
            amount_ngn: paidNgn,
            reference
          });
        } catch (callbackErr) {
          console.error('[WEBHOOK] onPaymentVerified callback error:', callbackErr.message);
        }
      });
    }
  }

  return { ok: true, status: 200, result: resultStatus, reference };
}

function createWebhookServer({ db, config = defaultConfig, onPaymentVerified = null }) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', store: config.storeName }));
      return;
    }

    if (req.method !== 'POST' || !req.url.startsWith('/webhooks/paystack')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));

    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const signature = req.headers['x-paystack-signature'];

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const outcome = handlePaystackPayload({
        payload,
        signature,
        rawBody,
        db,
        config,
        onPaymentVerified
      });

      res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(outcome));
    });
  });

  return server;
}

function startWebhookServer({ db, config = defaultConfig, port = config.paystackWebhookPort || 3001, onPaymentVerified = null } = {}) {
  const activeDb = db || openDatabase();
  const server = createWebhookServer({ db: activeDb, config, onPaymentVerified });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => {
      resolve(server);
    });
  });
}

if (require.main === module) {
  const db = openDatabase();
  const port = defaultConfig.paystackWebhookPort || 3001;
  startWebhookServer({ db, port }).then(() => {
    console.log(`[PAYSTACK WEBHOOK] Listening on http://localhost:${port}/webhooks/paystack`);
  }).catch((err) => {
    console.error(`[PAYSTACK WEBHOOK] Failed to start server: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  verifyWebhookSignature,
  handlePaystackPayload,
  createWebhookServer,
  startWebhookServer,
  extractOrderId
};
