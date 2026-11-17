const defaultConfig = require('../config');

const PAYSTACK_INIT_URL = 'https://api.paystack.co/transaction/initialize';

async function create_paystack_link(input = {}, { db, sessionId, config: customConfig, fetchClient = globalThis.fetch } = {}) {
  if (!db) {
    return { ok: false, error: 'Database instance is required', error_code: 'db_required' };
  }

  const effectiveSessionId = (sessionId && String(sessionId).trim()) || 'sim-default';
  const effectiveConfig = customConfig || defaultConfig;

  const order = db.prepare(`
    SELECT * FROM order_reservations
    WHERE session_id = ? AND status = 'AWAITING_PAYMENT'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(effectiveSessionId);

  if (!order) {
    return {
      ok: false,
      error: 'No active order reservation found. Confirm product and delivery location first.',
      error_code: 'no_active_reservation'
    };
  }

  const secretKey = effectiveConfig.paystackSecretKey;
  if (!secretKey) {
    return {
      ok: false,
      error: 'Payment gateway is temporarily unconfigured. Please pay via bank transfer.',
      error_code: 'missing_paystack_key'
    };
  }

  let email = input.customer_email?.trim();
  if (!email || !email.includes('@')) {
    const session = db.prepare('SELECT customer_phone FROM sessions WHERE session_id = ?').get(effectiveSessionId);
    const cleanPhone = (session?.customer_phone || '').replace(/\D/g, '');
    const userIdentifier = cleanPhone || effectiveSessionId.replace(/[^a-zA-Z0-9]/g, '');
    email = `customer_${userIdentifier || 'checkout'}@${effectiveConfig.fallbackEmailDomain || 'kikkycare.ng'}`;
  }

  const reference = `kikky_${order.id}_${Date.now()}`;
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
      amount_ngn: order.total_amount
    };
  } catch {
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
