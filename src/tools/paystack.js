const crypto = require('node:crypto');
const defaultConfig = require('../config');
const { create_order_reservation } = require('./orders');

const PAYSTACK_INIT_URL = 'https://api.paystack.co/transaction/initialize';

async function create_paystack_link(input = {}, { db, sessionId, config: customConfig, fetchClient = globalThis.fetch } = {}) {
  if (!db) {
    return { ok: false, error: 'Database instance is required', error_code: 'db_required' };
  }

  const effectiveSessionId = (sessionId && String(sessionId).trim()) || 'sim-default';
  const effectiveConfig = customConfig || defaultConfig;

  let order = db.prepare(`
    SELECT * FROM order_reservations
    WHERE session_id = ? AND status = 'AWAITING_PAYMENT'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(effectiveSessionId);

  // Auto-reservation: If no active hold exists, book it automatically from input, session, or recent history
  if (!order) {
    const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(effectiveSessionId);
    const targetState = input.state?.trim();
    const targetCity = input.city?.trim() || undefined;
    let targetProductId = input.product_id?.trim();

    if (!targetProductId && session?.active_cart_json && session.active_cart_json !== '{}') {
      try {
        const cart = JSON.parse(session.active_cart_json);
        targetProductId = cart.product_id || (Array.isArray(cart.items) && cart.items[0]?.product_id);
      } catch {
        // ignore parse error
      }
    }

    if (!targetProductId) {
      // Look in any reservation (including EXPIRED/CANCELLED) for this session
      const pastHold = db.prepare(`
        SELECT product_id FROM order_reservations
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(effectiveSessionId);
      if (pastHold?.product_id) {
        targetProductId = pastHold.product_id;
      }
    }

    // Do NOT fall back to past order delivery_state — that could be a stale location
    // from a previous unrelated purchase. The customer must provide their current destination
    // before card payment auto-reservation, or it will be held as PENDING.

    if (targetProductId) {
      const resArgs = { quantity: input.quantity || 1 };
      if (Array.isArray(input.items) && input.items.length > 0) {
        resArgs.items = input.items;
      } else {
        resArgs.product_id = targetProductId;
      }
      if (targetState) {
        resArgs.state = targetState;
        if (targetCity) resArgs.city = targetCity;
      }
      const resResult = create_order_reservation(resArgs, { db, sessionId: effectiveSessionId });

      if (resResult?.ok && resResult.order_id) {
        order = db.prepare('SELECT * FROM order_reservations WHERE id = ?').get(resResult.order_id);
      }
    }
  }

  if (!order) {
    return {
      ok: false,
      error: 'No active order reservation found. Confirm product and delivery location first.',
      error_code: 'no_active_reservation'
    };
  }

  const prod = db.prepare('SELECT name FROM products WHERE id = ?').get(order.product_id);
  const productName = prod?.name || order.product_id;

  // Always generate a fresh unique reference — Paystack rejects re-used references
  const reference = `kikky_${order.id}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const storeId = effectiveConfig.storeId || 'kikky_luxuryfemcare';
  const fallbackUrl = effectiveConfig.paystackPaymentUrl || `https://paystack.com/pay/${storeId}`;

  const secretKey = effectiveConfig.paystackSecretKey;
  if (!secretKey) {
    return {
      ok: true,
      payment_url: fallbackUrl,
      reference,
      amount_ngn: order.total_amount,
      order_id: order.id,
      product_name: productName,
      note: 'Direct Paystack store checkout'
    };
  }

  let email = input.customer_email?.trim();
  if (!email || !email.includes('@')) {
    const session = db.prepare('SELECT customer_phone FROM sessions WHERE session_id = ?').get(effectiveSessionId);
    const cleanPhone = (session?.customer_phone || '').replace(/\D/g, '');
    const userIdentifier = cleanPhone || effectiveSessionId.replace(/[^a-zA-Z0-9]/g, '');
    email = `customer_${userIdentifier || 'checkout'}@${effectiveConfig.fallbackEmailDomain || 'kikkycare.ng'}`;
  }

  const amountKobo = Math.round(Number(order.total_amount) * 100);

  const payload = {
    email,
    amount: amountKobo,
    reference,
    channels: ['card', 'bank_transfer', 'ussd'],
    metadata: {
      order_id: order.id,
      session_id: effectiveSessionId,
      custom_fields: [
        { display_name: 'Merchant', variable_name: 'merchant', value: effectiveConfig.storeDescriptor || 'KLF Luxury Care' },
        { display_name: 'Order ID', variable_name: 'order_id', value: order.id }
      ]
    }
  };

  if (effectiveConfig.paystackCallbackUrl) {
    payload.callback_url = effectiveConfig.paystackCallbackUrl;
  }

  try {
    const response = await fetchClient(PAYSTACK_INIT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.status || !data?.data?.authorization_url) {
      if (fallbackUrl) {
        return {
          ok: true,
          payment_url: fallbackUrl,
          reference,
          amount_ngn: order.total_amount,
          order_id: order.id,
          product_name: productName,
          note: 'Direct Paystack store checkout'
        };
      }
      return {
        ok: false,
        error: 'Could not reach payment provider.',
        error_code: 'paystack_api_error',
        provider_message: data?.message || response.statusText
      };
    }

    return {
      ok: true,
      payment_url: data.data.authorization_url,
      reference: data.data.reference || reference,
      amount_ngn: order.total_amount,
      order_id: order.id,
      product_name: productName
    };
  } catch {
    if (fallbackUrl) {
      return {
        ok: true,
        payment_url: fallbackUrl,
        reference,
        amount_ngn: order.total_amount,
        order_id: order.id,
        product_name: productName,
        note: 'Direct Paystack store checkout'
      };
    }
    return {
      ok: false,
      error: 'Could not reach payment provider.',
      error_code: 'network_failure'
    };
  }
}

module.exports = {
  create_paystack_link,
  PAYSTACK_INIT_URL
};
