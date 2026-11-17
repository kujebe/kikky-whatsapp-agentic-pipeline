const crypto = require('node:crypto');
const { z } = require('zod');
const { calculateShippingFee } = require('./shipping');
const { getOrCreateSession } = require('../agent/session');
const { bankDetailsString } = require('../config');

const BANK_DETAILS_STRING = bankDetailsString;

const orderReservationSchema = z.object({
  product_id: z.string().trim().min(1, 'Product ID is required'),
  state: z.string().trim().min(1, 'Destination state is required'),
  city: z.string().trim().min(1).optional(),
  quantity: z.coerce.number().int().positive().default(1)
});

function releaseExpiredHolds(db) {
  if (!db) return 0;

  const expiredRows = db.prepare(`
    SELECT id, product_id, quantity
    FROM order_reservations
    WHERE status = 'AWAITING_PAYMENT'
      AND datetime(hold_expires_at) < datetime('now')
  `).all();

  if (expiredRows.length === 0) {
    return 0;
  }

  const releaseTx = db.transaction(() => {
    const updateProductStock = db.prepare(`
      UPDATE products
      SET stock_quantity = stock_quantity + ?
      WHERE id = ?
    `);

    const updateOrderStatus = db.prepare(`
      UPDATE order_reservations
      SET status = 'EXPIRED',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    for (const row of expiredRows) {
      updateProductStock.run(row.quantity, row.product_id);
      updateOrderStatus.run(row.id);
    }
  });

  releaseTx();
  return expiredRows.length;
}

function create_order_reservation(input, { db, sessionId } = {}) {
  if (!db) {
    return { ok: false, error: 'Database instance is required', error_code: 'db_required' };
  }

  const effectiveSessionId = (sessionId && String(sessionId).trim()) || 'sim-default';
  getOrCreateSession(db, effectiveSessionId);

  releaseExpiredHolds(db);

  const parsed = orderReservationSchema.safeParse(input || {});
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid reservation arguments: ${parsed.error.issues.map(i => i.message).join('; ')}`,
      error_code: 'validation_error'
    };
  }

  const { product_id, state, city, quantity } = parsed.data;

  const activeHold = db.prepare(`
    SELECT *
    FROM order_reservations
    WHERE session_id = ? AND status = 'AWAITING_PAYMENT'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(effectiveSessionId);

  if (activeHold) {
    const isSameProduct = activeHold.product_id === product_id;
    const isSameQuantity = activeHold.quantity === quantity;
    const isSameState = (activeHold.delivery_state || '').trim().toLowerCase() === state.trim().toLowerCase();
    const isSameCity = (activeHold.delivery_city || '').trim().toLowerCase() === (city || '').trim().toLowerCase();

    if (isSameProduct && isSameQuantity && isSameState && isSameCity) {
      db.prepare(`
        UPDATE order_reservations
        SET hold_expires_at = datetime('now', '+45 minutes'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(activeHold.id);

      const prod = db.prepare('SELECT name FROM products WHERE id = ?').get(product_id);

      return {
        ok: true,
        order_id: activeHold.id,
        product_name: prod ? prod.name : product_id,
        quantity: activeHold.quantity,
        item_price: activeHold.unit_price,
        delivery_fee: activeHold.delivery_fee,
        total_amount: activeHold.total_amount,
        bank_details: BANK_DETAILS_STRING,
        hold_minutes: 45
      };
    }

    // Customer switched product, quantity, or location: cancel prior hold and restore stock
    db.transaction(() => {
      db.prepare(`
        UPDATE products
        SET stock_quantity = stock_quantity + ?
        WHERE id = ?
      `).run(activeHold.quantity, activeHold.product_id);

      db.prepare(`
        UPDATE order_reservations
        SET status = 'CANCELLED',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(activeHold.id);
    })();
  }

  let product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
  if (!product) {
    product = db.prepare(`
      SELECT * FROM products
      WHERE id = ? COLLATE NOCASE OR name = ? COLLATE NOCASE
      LIMIT 1
    `).get(product_id, product_id);
  }
  if (!product) {
    const slugName = product_id.replace(/[-_]/g, ' ').trim();
    product = db.prepare(`
      SELECT * FROM products
      WHERE name LIKE ? COLLATE NOCASE OR search_tags LIKE ? COLLATE NOCASE
      LIMIT 1
    `).get(`%${slugName}%`, `%${slugName}%`);
  }

  if (!product) {
    return {
      ok: false,
      error: `Product not found: ${product_id}`,
      error_code: 'product_not_found'
    };
  }

  if (product.stock_quantity < quantity) {
    return {
      ok: false,
      error: 'Item is sold out',
      error_code: 'out_of_stock'
    };
  }

  const shippingResult = calculateShippingFee(db, { state, city });
  if (!shippingResult.ok) {
    return {
      ok: false,
      error: shippingResult.error || `Shipping not available for state: ${state}`,
      error_code: 'shipping_unavailable'
    };
  }

  const deliveryFee = shippingResult.delivery.fee;
  const unitPrice = product.retail_price;
  const totalAmount = (unitPrice * quantity) + deliveryFee;
  const orderId = `ord_${crypto.randomUUID()}`;

  const createTx = db.transaction(() => {
    const updateRes = db.prepare(`
      UPDATE products
      SET stock_quantity = stock_quantity - ?
      WHERE id = ? AND stock_quantity >= ?
    `).run(quantity, product.id, quantity);

    if (updateRes.changes === 0) {
      throw new Error('OUT_OF_STOCK');
    }

    db.prepare(`
      INSERT INTO order_reservations (
        id, session_id, status, product_id, quantity, unit_price,
        delivery_state, delivery_city, delivery_fee, total_amount,
        hold_expires_at
      ) VALUES (
        ?, ?, 'AWAITING_PAYMENT', ?, ?, ?,
        ?, ?, ?, ?,
        datetime('now', '+45 minutes')
      )
    `).run(
      orderId,
      effectiveSessionId,
      product.id,
      quantity,
      unitPrice,
      state.trim(),
      city ? city.trim() : null,
      deliveryFee,
      totalAmount
    );

    db.prepare(`
      UPDATE sessions
      SET order_stage = 'awaiting_payment',
          delivery_state = ?,
          delivery_city = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `).run(
      state.trim(),
      city ? city.trim() : null,
      effectiveSessionId
    );
  });

  try {
    createTx();
  } catch (err) {
    if (err.message === 'OUT_OF_STOCK') {
      return { ok: false, error: 'Item is sold out', error_code: 'out_of_stock' };
    }
    throw err;
  }

  return {
    ok: true,
    order_id: orderId,
    product_name: product.name,
    quantity,
    item_price: unitPrice,
    delivery_fee: deliveryFee,
    total_amount: totalAmount,
    bank_details: BANK_DETAILS_STRING,
    hold_minutes: 45
  };
}

function verify_transfer_receipt(input, { db, sessionId } = {}) {
  if (!db) {
    return { ok: false, error: 'Database instance is required', error_code: 'db_required' };
  }

  const effectiveSessionId = (sessionId && String(sessionId).trim()) || 'sim-default';
  releaseExpiredHolds(db);

  const order = db.prepare(`
    SELECT *
    FROM order_reservations
    WHERE session_id = ? AND status = 'AWAITING_PAYMENT'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(effectiveSessionId);

  if (!order) {
    return {
      ok: false,
      error: 'Reservation expired. Checking if stock is still available.',
      error_code: 'hold_expired'
    };
  }

  let amountNum = null;
  if (typeof input?.extracted_amount === 'number') {
    amountNum = input.extracted_amount;
  } else if (typeof input?.amount === 'number') {
    amountNum = input.amount;
  } else if (input?.extracted_amount != null) {
    amountNum = Number(String(input.extracted_amount).replace(/[^0-9.]/g, ''));
  } else if (input?.amount != null) {
    amountNum = Number(String(input.amount).replace(/[^0-9.]/g, ''));
  }

  if (amountNum == null || Number.isNaN(amountNum) || amountNum <= 0) {
    return {
      ok: false,
      error: 'Invalid payment amount on receipt',
      error_code: 'invalid_amount'
    };
  }

  amountNum = Math.round(amountNum);

  const bankName = input?.bank_name || input?.bank || null;
  const senderName = input?.sender_name || input?.sender || null;
  const receiptDate = input?.receipt_date || input?.date || null;
  const rawMetadata = input?.raw_metadata
    ? (typeof input.raw_metadata === 'string' ? input.raw_metadata : JSON.stringify(input.raw_metadata))
    : (input ? JSON.stringify(input) : null);

  const paymentId = `pay_${crypto.randomUUID()}`;

  if (amountNum >= order.total_amount) {
    const handoffId = `hand_${crypto.randomUUID()}`;
    const matchTx = db.transaction(() => {
      db.prepare(`
        UPDATE order_reservations
        SET status = 'PAYMENT_VERIFIED',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(order.id);

      db.prepare(`
        INSERT INTO payments (
          id, order_id, session_id, amount, bank_name,
          sender_name, receipt_date, status, raw_metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'matched', ?)
      `).run(
        paymentId,
        order.id,
        effectiveSessionId,
        amountNum,
        bankName,
        senderName,
        receiptDate,
        rawMetadata
      );

      db.prepare(`
        INSERT INTO handoffs (id, reason, customer_summary, status)
        VALUES (?, 'Payment receipt matched - verify bank app alert before dispatch', ?, 'pending')
      `).run(
        handoffId,
        `Order ${order.id} matched receipt of ₦${amountNum}. Bank: ${bankName || 'Unknown'}, Sender: ${senderName || 'Unknown'}`
      );

      db.prepare(`
        UPDATE sessions
        SET order_stage = 'paid',
            updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ?
      `).run(effectiveSessionId);
    });

    matchTx();

    return {
      ok: true,
      matched: true,
      paid: amountNum,
      expected: order.total_amount,
      handoff_id: handoffId,
      message: 'Payment verified. Tell customer you have seen the receipt and are checking the alert on your app now, and ask for their delivery street address and calling phone number so you can arrange the rider.'
    };
  }

  // Underpaid case
  const previousUnderpaidCount = db.prepare(`
    SELECT COUNT(*) as count FROM payments WHERE session_id = ? AND status = 'underpaid'
  `).get(effectiveSessionId)?.count || 0;

  const underpaidTx = db.transaction(() => {
    db.prepare(`
      INSERT INTO payments (
        id, order_id, session_id, amount, bank_name,
        sender_name, receipt_date, status, raw_metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'underpaid', ?)
    `).run(
      paymentId,
      order.id,
      effectiveSessionId,
      amountNum,
      bankName,
      senderName,
      receiptDate,
      rawMetadata
    );

    if (previousUnderpaidCount >= 1) {
      const handoffId = `hand_${crypto.randomUUID()}`;
      db.prepare(`
        INSERT INTO handoffs (id, reason, customer_summary, status)
        VALUES (?, 'Repeated payment receipt discrepancy - requires manual review', ?, 'pending')
      `).run(
        handoffId,
        `Session ${effectiveSessionId} has ${previousUnderpaidCount + 1} underpaid receipt attempts. Expected ₦${order.total_amount}, latest receipt was ₦${amountNum}.`
      );
    }
  });

  underpaidTx();

  const balanceDue = order.total_amount - amountNum;
  if (previousUnderpaidCount >= 1) {
    return {
      ok: false,
      underpaid: true,
      escalated: true,
      paid: amountNum,
      expected: order.total_amount,
      balance_due: balanceDue,
      message: 'Payment underpaid repeatedly. Flagged for manual review. Assure customer you are checking the alert directly on your bank app.'
    };
  }

  return {
    ok: false,
    underpaid: true,
    paid: amountNum,
    expected: order.total_amount,
    balance_due: balanceDue,
    message: 'Payment underpaid. Inform customer of remaining balance.'
  };
}

module.exports = {
  releaseExpiredHolds,
  create_order_reservation,
  verify_transfer_receipt
};
