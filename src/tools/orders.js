const crypto = require('node:crypto');
const { z } = require('zod');
const { calculateShippingFee } = require('./shipping');
const { getOrCreateSession } = require('../agent/session');
const { bankDetailsString } = require('../config');

const BANK_DETAILS_STRING = bankDetailsString;

const orderReservationSchema = z.object({
  product_id: z.string().trim().min(1).optional(),
  items: z.array(z.object({
    product_id: z.string().trim().min(1),
    quantity: z.coerce.number().int().positive().default(1)
  })).optional(),
  state: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  quantity: z.coerce.number().int().positive().optional(),
  add_to_order: z.boolean().optional(),
  pickup: z.boolean().optional()
}).refine(data => data.product_id || (Array.isArray(data.items) && data.items.length > 0) || data.state || data.pickup, {
  message: 'Either product_id, items array, state, or pickup must be provided'
});

function resolveProduct(db, identifier) {
  if (!identifier || typeof identifier !== 'string') return null;
  let product = db.prepare('SELECT * FROM products WHERE id = ?').get(identifier);
  if (!product) {
    product = db.prepare(`
      SELECT * FROM products
      WHERE id = ? COLLATE NOCASE OR name = ? COLLATE NOCASE
      LIMIT 1
    `).get(identifier, identifier);
  }
  if (!product) {
    const slugName = identifier.replace(/[-_]/g, ' ').trim();
    product = db.prepare(`
      SELECT * FROM products
      WHERE name LIKE ? COLLATE NOCASE OR search_tags LIKE ? COLLATE NOCASE
      LIMIT 1
    `).get(`%${slugName}%`, `%${slugName}%`);
  }
  return product;
}

function releaseExpiredHolds(db) {
  if (!db) return 0;

  const expiredRows = db.prepare(`
    SELECT id, product_id, quantity, items_json
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
      if (row.items_json) {
        try {
          const items = JSON.parse(row.items_json);
          if (Array.isArray(items)) {
            for (const it of items) {
              updateProductStock.run(it.quantity || 1, it.product_id);
            }
          } else {
            updateProductStock.run(row.quantity, row.product_id);
          }
        } catch {
          updateProductStock.run(row.quantity, row.product_id);
        }
      } else {
        updateProductStock.run(row.quantity, row.product_id);
      }
      updateOrderStatus.run(row.id);
    }
  });

  releaseTx();

  // Purge EXPIRED rows older than 90 days to prevent table bloat
  // 90 days covers any realistic dispute or bank transfer investigation window
  try {
    db.prepare(`
      DELETE FROM order_reservations
      WHERE status = 'EXPIRED'
        AND datetime(updated_at) < datetime('now', '-90 days')
    `).run();
  } catch {
    // Non-fatal: purge failure should not break hold release
  }

  return expiredRows.length;
}

function create_order_reservation(input, { db, sessionId } = {}) {
  if (!db) {
    return { ok: false, error: 'Database instance is required', error_code: 'db_required' };
  }

  const effectiveSessionId = (sessionId && String(sessionId).trim()) || 'sim-default';
  const session = getOrCreateSession(db, effectiveSessionId);

  releaseExpiredHolds(db);

  const parsed = orderReservationSchema.safeParse(input || {});
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid reservation arguments: ${parsed.error.issues.map(i => i.message).join('; ')}`,
      error_code: 'validation_error'
    };
  }

  const activeHold = db.prepare(`
    SELECT *
    FROM order_reservations
    WHERE session_id = ? AND status = 'AWAITING_PAYMENT'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(effectiveSessionId);

  const isPickupExplicit = parsed.data.pickup === true || parsed.data.state?.trim().toUpperCase() === 'PICKUP';
  let targetState;
  let targetCity;
  let deliveryFee = 0;

  if (isPickupExplicit) {
    targetState = 'PICKUP';
    targetCity = 'STORE_PICKUP';
    deliveryFee = 0;
  } else if (parsed.data.state?.trim()) {
    targetState = parsed.data.state.trim();
    targetCity = parsed.data.city?.trim() || undefined;
    const shippingResult = calculateShippingFee(db, { state: targetState, city: targetCity });
    if (!shippingResult.ok) {
      return {
        ok: false,
        error: shippingResult.error || `Shipping not available for state: ${targetState}`,
        error_code: 'shipping_unavailable'
      };
    }
    deliveryFee = shippingResult.delivery.fee;
  } else if (activeHold && activeHold.delivery_state && activeHold.delivery_state !== 'PENDING') {
    targetState = activeHold.delivery_state;
    targetCity = parsed.data.city?.trim() || activeHold.delivery_city || undefined;
    if (targetState === 'PICKUP') {
      deliveryFee = 0;
    } else {
      const shippingResult = calculateShippingFee(db, { state: targetState, city: targetCity });
      if (!shippingResult.ok) {
        return {
          ok: false,
          error: shippingResult.error || `Shipping not available for state: ${targetState}`,
          error_code: 'shipping_unavailable'
        };
      }
      deliveryFee = shippingResult.delivery.fee;
    }
  } else {
    targetState = 'PENDING';
    targetCity = undefined;
    deliveryFee = 0;
  }

  let rawItems = [];
  if (Array.isArray(parsed.data.items) && parsed.data.items.length > 0) {
    rawItems = parsed.data.items;
  } else if (parsed.data.product_id) {
    const qty = parsed.data.quantity || (activeHold && (activeHold.product_id === parsed.data.product_id || resolveProduct(db, parsed.data.product_id)?.id === activeHold.product_id) ? activeHold.quantity : 1);
    rawItems = [{ product_id: parsed.data.product_id, quantity: qty }];
  } else if (activeHold) {
    if (activeHold.items_json) {
      try {
        const parsedItems = JSON.parse(activeHold.items_json);
        if (Array.isArray(parsedItems) && parsedItems.length > 0) rawItems = parsedItems;
      } catch { }
    }
    if (rawItems.length === 0 && activeHold.product_id) {
      rawItems = [{ product_id: activeHold.product_id, quantity: activeHold.quantity || 1 }];
    }
  }

  if (rawItems.length === 0) {
    return {
      ok: false,
      error: 'Either product_id or items array must be provided',
      error_code: 'items_required'
    };
  }

  if (parsed.data.add_to_order && activeHold) {
    let existingItems = [];
    if (activeHold.items_json) {
      try {
        const parsedItems = JSON.parse(activeHold.items_json);
        if (Array.isArray(parsedItems)) existingItems = parsedItems;
      } catch { }
    }
    if (existingItems.length === 0) {
      existingItems = [{ product_id: activeHold.product_id, quantity: activeHold.quantity }];
    }

    const combinedMap = new Map();
    for (const it of existingItems) {
      combinedMap.set(it.product_id, (combinedMap.get(it.product_id) || 0) + (it.quantity || 1));
    }
    for (const it of rawItems) {
      combinedMap.set(it.product_id, (combinedMap.get(it.product_id) || 0) + (it.quantity || 1));
    }
    rawItems = Array.from(combinedMap.entries()).map(([product_id, quantity]) => ({ product_id, quantity }));
  }

  const resolvedItems = [];
  let subtotal = 0;
  let totalQuantity = 0;

  for (const item of rawItems) {
    const prod = resolveProduct(db, item.product_id);
    if (!prod) {
      return {
        ok: false,
        error: `Product not found: ${item.product_id}`,
        error_code: 'product_not_found'
      };
    }

    const qty = item.quantity || 1;
    let currentlyHeld = 0;
    if (activeHold) {
      if (activeHold.items_json) {
        try {
          const prev = JSON.parse(activeHold.items_json);
          const m = prev.find(p => p.product_id === prod.id);
          if (m) currentlyHeld = m.quantity || 0;
        } catch { }
      } else if (activeHold.product_id === prod.id) {
        currentlyHeld = activeHold.quantity;
      }
    }

    if ((prod.stock_quantity + currentlyHeld) < qty) {
      return {
        ok: false,
        error: `Item is sold out: ${prod.name}`,
        error_code: 'out_of_stock'
      };
    }

    const itemTotal = prod.retail_price * qty;
    subtotal += itemTotal;
    totalQuantity += qty;
    resolvedItems.push({
      product_id: prod.id,
      name: prod.name,
      category: prod.category,
      unit_price: prod.retail_price,
      quantity: qty,
      total_price: itemTotal
    });
  }

  const totalAmount = subtotal + deliveryFee;
  const orderId = `ord_${crypto.randomUUID()}`;

  if (activeHold && !parsed.data.add_to_order) {
    let activeHoldItems = [];
    if (activeHold.items_json) {
      try { activeHoldItems = JSON.parse(activeHold.items_json); } catch { }
    }
    if (activeHoldItems.length === 0) {
      activeHoldItems = [{ product_id: activeHold.product_id, quantity: activeHold.quantity }];
    }

    const isSameItems = activeHoldItems.length === resolvedItems.length &&
      resolvedItems.every(r => {
        const m = activeHoldItems.find(a => a.product_id === r.product_id);
        return m && m.quantity === r.quantity;
      });

    if (isSameItems) {
      db.prepare(`
        UPDATE order_reservations
        SET delivery_state = ?,
            delivery_city = ?,
            delivery_fee = ?,
            total_amount = ?,
            hold_expires_at = datetime('now', '+45 minutes'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(targetState, targetCity || null, deliveryFee, totalAmount, activeHold.id);

      db.prepare(`
        UPDATE sessions
        SET order_stage = 'reserving',
            updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ?
      `).run(effectiveSessionId);

      return {
        ok: true,
        order_id: activeHold.id,
        product_name: resolvedItems.map(i => `${i.name}${i.quantity > 1 ? ` (x${i.quantity})` : ''}`).join(' + '),
        items: resolvedItems,
        quantity: totalQuantity,
        item_price: subtotal,
        delivery_fee: deliveryFee,
        total_amount: totalAmount,
        bank_details: BANK_DETAILS_STRING,
        hold_minutes: 45
      };
    }
  }

  const createTx = db.transaction(() => {
    if (activeHold) {
      if (activeHold.items_json) {
        try {
          const prev = JSON.parse(activeHold.items_json);
          for (const it of prev) {
            db.prepare('UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?').run(it.quantity || 1, it.product_id);
          }
        } catch {
          db.prepare('UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?').run(activeHold.quantity, activeHold.product_id);
        }
      } else {
        db.prepare('UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?').run(activeHold.quantity, activeHold.product_id);
      }
      db.prepare("UPDATE order_reservations SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(activeHold.id);
    }

    for (const item of resolvedItems) {
      const updateRes = db.prepare(`
        UPDATE products
        SET stock_quantity = stock_quantity - ?
        WHERE id = ? AND stock_quantity >= ?
      `).run(item.quantity, item.product_id, item.quantity);

      if (updateRes.changes === 0) {
        throw new Error('OUT_OF_STOCK');
      }
    }

    db.prepare(`
      INSERT INTO order_reservations (
        id, session_id, status, product_id, quantity, unit_price,
        delivery_state, delivery_city, delivery_fee, total_amount,
        items_json, hold_expires_at
      ) VALUES (
        ?, ?, 'AWAITING_PAYMENT', ?, ?, ?,
        ?, ?, ?, ?,
        ?, datetime('now', '+45 minutes')
      )
    `).run(
      orderId,
      effectiveSessionId,
      resolvedItems[0].product_id,
      totalQuantity,
      subtotal,
      targetState.trim(),
      targetCity ? targetCity.trim() : null,
      deliveryFee,
      totalAmount,
      JSON.stringify(resolvedItems)
    );

    // Update session order_stage only. Delivery location stays exclusively in order_reservations
    // to prevent cross-order pollution (same phone, different context, different destination).
    db.prepare(`
      UPDATE sessions
      SET order_stage = 'awaiting_payment',
          updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `).run(effectiveSessionId);
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
    product_name: resolvedItems.map(i => `${i.name}${i.quantity > 1 ? ` (x${i.quantity})` : ''}`).join(' + '),
    items: resolvedItems,
    quantity: totalQuantity,
    item_price: subtotal,
    subtotal: subtotal,
    items_subtotal: subtotal,
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

function isQuietHours(date = new Date()) {
  // WAT is UTC+1 (Nigeria time)
  const watMs = date.getTime() + 60 * 60 * 1000;
  const watDate = new Date(watMs);
  const hour = watDate.getUTCHours();
  // Quiet hours: 9:00 PM (21:00) to 9:00 AM (09:00)
  return hour >= 21 || hour < 9;
}

function getPendingReminders(db, { now = new Date() } = {}) {
  if (!db) return [];
  if (isQuietHours(now)) return [];

  const nowIso = now.toISOString().replace('T', ' ').slice(0, 19);

  let candidates = [];
  try {
    candidates = db.prepare(`
      SELECT r.*, p.name AS product_name, s.muted_until
      FROM order_reservations r
      LEFT JOIN products p ON r.product_id = p.id
      LEFT JOIN sessions s ON r.session_id = s.session_id
      WHERE r.status = 'AWAITING_PAYMENT'
        AND r.reminder_sent_at IS NULL
        AND datetime(r.hold_expires_at) > datetime(?)
        AND datetime(r.created_at, '+30 minutes') <= datetime(?)
        AND (s.muted_until IS NULL OR datetime(s.muted_until) <= datetime(?))
      ORDER BY r.created_at ASC
    `).all(nowIso, nowIso, nowIso);
  } catch {
    return [];
  }

  const reminders = [];
  for (const c of candidates) {

    let hasMessageAfter = false;
    try {
      const inboundMsg = db.prepare(`
        SELECT 1 FROM inbound_buffer
        WHERE session_id = ?
          AND datetime(created_at) > datetime(?, '+30 seconds')
        LIMIT 1
      `).get(c.session_id, c.created_at);
      if (inboundMsg) hasMessageAfter = true;
    } catch { }

    if (!hasMessageAfter) {
      try {
        const chatMsg = db.prepare(`
          SELECT 1 FROM chat_history
          WHERE session_id = ?
            AND json_extract(message_json, '$.role') = 'user'
            AND datetime(created_at) > datetime(?, '+30 seconds')
          LIMIT 1
        `).get(c.session_id, c.created_at);
        if (chatMsg) hasMessageAfter = true;
      } catch { }
    }

    if (hasMessageAfter) {
      continue;
    }

    let productName = c.product_name || c.product_id;
    if (c.items_json) {
      try {
        const items = JSON.parse(c.items_json);
        if (Array.isArray(items) && items.length > 0) {
          productName = items.map(i => `${i.name || i.product_id}${i.quantity > 1 ? ` (x${i.quantity})` : ''}`).join(' + ');
        }
      } catch { }
    }

    reminders.push({
      orderId: c.id,
      sessionId: c.session_id,
      productName,
      totalAmount: c.total_amount,
      message: `Hey! Just checking in on your order for ${productName} before our riders head out today. Should I hold it for you, or let it go? 😊`
    });
  }

  return reminders;
}

function markReminderSent(db, orderId) {
  if (!db || !orderId) return;
  try {
    db.prepare(`
      UPDATE order_reservations
      SET reminder_sent_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(orderId);
  } catch {
    // Non-fatal
  }
}

const updateFulfillmentSchema = z.object({
  pickup: z.boolean().optional(),
  state: z.string().trim().optional(),
  city: z.string().trim().optional()
}).refine(data => data.pickup !== undefined || data.state, {
  message: 'Either pickup or destination state must be provided'
});

function update_order_fulfillment(input, { db, sessionId } = {}) {
  if (!db) {
    return { ok: false, error: 'Database instance is required', error_code: 'db_required' };
  }

  const effectiveSessionId = (sessionId && String(sessionId).trim()) || 'sim-default';

  releaseExpiredHolds(db);

  const parsed = updateFulfillmentSchema.safeParse(input || {});
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid fulfillment arguments: ${parsed.error.issues.map(i => i.message).join('; ')}`,
      error_code: 'validation_error'
    };
  }

  const activeHold = db.prepare(`
    SELECT *
    FROM order_reservations
    WHERE session_id = ? AND status = 'AWAITING_PAYMENT'
      AND datetime(hold_expires_at) > datetime('now')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(effectiveSessionId);

  if (!activeHold) {
    return {
      ok: false,
      error: 'No active order reservation found to update. Confirm product order first.',
      error_code: 'no_active_reservation'
    };
  }

  const isPickup = parsed.data.pickup === true || parsed.data.state?.trim().toUpperCase() === 'PICKUP';
  let targetState;
  let targetCity;
  let deliveryFee = 0;

  if (isPickup) {
    targetState = 'PICKUP';
    targetCity = 'STORE_PICKUP';
    deliveryFee = 0;
  } else if (parsed.data.state?.trim()) {
    targetState = parsed.data.state.trim();
    targetCity = parsed.data.city?.trim() || undefined;
    const shippingResult = calculateShippingFee(db, { state: targetState, city: targetCity });
    if (!shippingResult.ok) {
      return {
        ok: false,
        error: shippingResult.error || `Shipping not available for state: ${targetState}`,
        error_code: 'shipping_unavailable'
      };
    }
    deliveryFee = shippingResult.delivery.fee;
  } else {
    targetState = 'PENDING';
    targetCity = undefined;
    deliveryFee = 0;
  }

  // Preserve existing items subtotal
  const subtotal = activeHold.unit_price;
  const totalAmount = subtotal + deliveryFee;

  db.prepare(`
    UPDATE order_reservations
    SET delivery_state = ?,
        delivery_city = ?,
        delivery_fee = ?,
        total_amount = ?,
        hold_expires_at = datetime('now', '+45 minutes'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(targetState, targetCity || null, deliveryFee, totalAmount, activeHold.id);

  let resolvedItems = [];
  if (activeHold.items_json) {
    try {
      resolvedItems = JSON.parse(activeHold.items_json);
    } catch { }
  }
  if (resolvedItems.length === 0) {
    const prod = db.prepare('SELECT name, category FROM products WHERE id = ?').get(activeHold.product_id);
    resolvedItems = [{
      product_id: activeHold.product_id,
      name: prod?.name || activeHold.product_id,
      category: prod?.category || 'wellness',
      unit_price: subtotal / (activeHold.quantity || 1),
      quantity: activeHold.quantity || 1,
      total_price: subtotal
    }];
  }

  return {
    ok: true,
    order_id: activeHold.id,
    product_name: resolvedItems.map(i => `${i.name}${i.quantity > 1 ? ` (x${i.quantity})` : ''}`).join(' + '),
    items: resolvedItems,
    quantity: activeHold.quantity,
    item_price: subtotal,
    subtotal: subtotal,
    items_subtotal: subtotal,
    delivery_fee: deliveryFee,
    total_amount: totalAmount,
    bank_details: BANK_DETAILS_STRING,
    hold_minutes: 45,
    fulfillment: targetState === 'PICKUP' ? 'pickup' : (targetState === 'PENDING' ? 'pending' : 'delivery')
  };
}

module.exports = {
  releaseExpiredHolds,
  create_order_reservation,
  update_order_fulfillment,
  verify_transfer_receipt,
  isQuietHours,
  getPendingReminders,
  markReminderSent
};
