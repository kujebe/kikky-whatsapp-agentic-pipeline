const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { logEvent } = require('../logger');
const config = require('../config');

const deliveryDetailsSchema = z.object({
  recipient_name: z.string().trim().min(1, 'Recipient name is required'),
  recipient_phone: z.string().trim().refine((val) => {
    const digits = val.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 14;
  }, { message: 'Recipient phone number must contain between 10 and 14 digits' }),
  delivery_address: z.string().trim().min(3, 'Delivery address must be at least 3 characters')
});

function formatRiderSlip({ order, productName, recipient_name, recipient_phone, delivery_address, currencySymbol }) {
  const loc = order.delivery_city ? `${order.delivery_city}, ${order.delivery_state}` : order.delivery_state;
  const formattedTotal = Number(order.total_amount).toLocaleString('en-NG');

  return [
    '=== KIKKY RIDER DISPATCH SLIP ===',
    `Order ID: ${order.id}`,
    `Recipient: ${recipient_name}`,
    `Phone: ${recipient_phone}`,
    `Address: ${delivery_address}`,
    `Destination: ${loc}`,
    `Item: ${productName} (Qty: ${order.quantity})`,
    `Total Paid: ${currencySymbol}${formattedTotal}`,
    'Package: 100% Plain Discreet Sealed Box',
    'Status: PENDING RIDER PICKUP',
    '================================='
  ].join('\n');
}

function save_delivery_details(input, { db, sessionId, config: customConfig, emit = logEvent } = {}) {
  if (!db) {
    return { ok: false, error: 'Database instance is required', error_code: 'db_required' };
  }

  const effectiveSessionId = (sessionId && String(sessionId).trim()) || 'sim-default';
  const effectiveConfig = customConfig || config;
  const currency = effectiveConfig.currencySymbol || '₦';

  const parsed = deliveryDetailsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid delivery details: ${parsed.error.issues.map(i => i.message).join('; ')}`,
      error_code: 'invalid_arguments'
    };
  }

  const { recipient_name, recipient_phone, delivery_address } = parsed.data;
  const cleanPhone = recipient_phone.replace(/\D/g, '');

  const latestOrder = db.prepare(`
    SELECT * FROM order_reservations
    WHERE session_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(effectiveSessionId);

  if (!latestOrder) {
    return {
      ok: false,
      error: 'No order reservation found for this session.',
      error_code: 'no_order'
    };
  }

  let isUpdate = false;
  let existingDispatch = null;

  if (latestOrder.status === 'FULFILLED') {
    existingDispatch = db.prepare(`
      SELECT * FROM dispatches
      WHERE order_id = ? AND status = 'pending_rider'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(latestOrder.id);

    if (!existingDispatch) {
      return {
        ok: false,
        error: 'Order has already been fulfilled and dispatched.',
        error_code: 'order_already_fulfilled'
      };
    }
    isUpdate = true;
  } else if (latestOrder.status !== 'PAYMENT_VERIFIED') {
    return {
      ok: false,
      error: 'Payment must be verified before dispatching a rider.',
      error_code: 'payment_unverified'
    };
  }

  let productName = 'Adult Wellness Item';
  const product = db.prepare('SELECT name FROM products WHERE id = ?').get(latestOrder.product_id);
  if (product?.name) {
    productName = product.name;
  }

  const riderSlip = formatRiderSlip({
    order: latestOrder,
    productName,
    recipient_name,
    recipient_phone: cleanPhone,
    delivery_address,
    currencySymbol: currency
  });

  let dispatchId;

  const tx = db.transaction(() => {
    if (isUpdate && existingDispatch) {
      dispatchId = existingDispatch.id;
      db.prepare(`
        UPDATE dispatches
        SET recipient_name = ?,
            recipient_phone = ?,
            delivery_address = ?,
            rider_slip = ?
        WHERE id = ?
      `).run(recipient_name, cleanPhone, delivery_address, riderSlip, dispatchId);
    } else {
      dispatchId = 'disp_' + randomUUID();
      db.prepare(`
        INSERT INTO dispatches (id, order_id, session_id, recipient_name, recipient_phone, delivery_address, rider_slip, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_rider')
      `).run(dispatchId, latestOrder.id, effectiveSessionId, recipient_name, cleanPhone, delivery_address, riderSlip);

      db.prepare(`
        UPDATE order_reservations
        SET status = 'FULFILLED',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(latestOrder.id);
    }

    db.prepare(`
      UPDATE sessions
      SET delivery_address = ?,
          customer_name = coalesce(customer_name, ?),
          customer_phone = coalesce(customer_phone, ?),
          order_stage = 'fulfilled',
          updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `).run(delivery_address, recipient_name, cleanPhone, effectiveSessionId);
  });

  tx();

  try {
    emit('rider.dispatch.ready', {
      order_id: latestOrder.id,
      dispatch_id: dispatchId,
      rider_slip: riderSlip
    });
  } catch {
    // Non-blocking telemetry
  }

  return {
    ok: true,
    dispatch_id: dispatchId,
    rider_slip: riderSlip,
    message: isUpdate
      ? 'Delivery details updated and rider slip refreshed.'
      : 'Delivery details saved and rider alerted.'
  };
}

module.exports = {
  save_delivery_details,
  formatRiderSlip,
  deliveryDetailsSchema
};
