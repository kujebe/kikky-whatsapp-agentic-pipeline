const crypto = require('node:crypto');

const PAYMENT_ACCOUNT_SIGNAL = process.env.STORE_PAYMENT_ACCOUNT
  ? process.env.STORE_PAYMENT_ACCOUNT.split(' ')[0]
  : '5140099034';

function getOrCreateSession(db, sessionId = null, initialData = {}) {
  if (!db) {
    return {
      session_id: sessionId || crypto.randomUUID(),
      customer_phone: initialData.customer_phone || null,
      customer_name: initialData.customer_name || null,
      gender: initialData.gender || 'unknown',
      referral_source: initialData.referral_source || null,
      order_stage: initialData.order_stage || 'browsing',
      active_cart_json: initialData.active_cart_json || '{}',
      delivery_state: initialData.delivery_state || null,
      delivery_city: initialData.delivery_city || null,
      delivery_address: initialData.delivery_address || null,
      price_sensitivity: initialData.price_sensitivity || 'normal',
      notes: initialData.notes || null
    };
  }

  const id = (sessionId && String(sessionId).trim()) || crypto.randomUUID();

  const existing = db.prepare(`
    SELECT * FROM sessions WHERE session_id = ?
  `).get(id);

  if (existing) {
    return existing;
  }

  const newSession = {
    session_id: id,
    customer_phone: initialData.customer_phone || null,
    customer_name: initialData.customer_name || null,
    gender: initialData.gender || 'unknown',
    referral_source: initialData.referral_source || null,
    order_stage: initialData.order_stage || 'browsing',
    active_cart_json: initialData.active_cart_json || '{}',
    delivery_state: initialData.delivery_state || null,
    delivery_city: initialData.delivery_city || null,
    delivery_address: initialData.delivery_address || null,
    price_sensitivity: initialData.price_sensitivity || 'normal',
    notes: initialData.notes || null
  };

  db.prepare(`
    INSERT INTO sessions (
      session_id, customer_phone, customer_name, gender, referral_source,
      order_stage, active_cart_json, delivery_state, delivery_city,
      delivery_address, price_sensitivity, notes
    ) VALUES (
      @session_id, @customer_phone, @customer_name, @gender, @referral_source,
      @order_stage, @active_cart_json, @delivery_state, @delivery_city,
      @delivery_address, @price_sensitivity, @notes
    )
  `).run(newSession);

  return newSession;
}

function updateSession(db, sessionId, updates = {}) {
  if (!db || !sessionId || Object.keys(updates).length === 0) {
    return null;
  }

  const allowedFields = [
    'customer_phone', 'customer_name', 'gender', 'referral_source',
    'order_stage', 'active_cart_json', 'delivery_state', 'delivery_city',
    'delivery_address', 'price_sensitivity', 'notes'
  ];

  const setClauses = [];
  const params = { session_id: sessionId };

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClauses.push(`${key} = @${key}`);
      params[key] = value;
    }
  }

  if (setClauses.length === 0) {
    return null;
  }

  setClauses.push('updated_at = CURRENT_TIMESTAMP');

  db.prepare(`
    UPDATE sessions
    SET ${setClauses.join(', ')}
    WHERE session_id = @session_id
  `).run(params);

  return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
}

function extractSessionInferences(currentSession, userText = '', agentReply = '', steps = []) {
  const updates = {};
  const lowerText = userText.toLowerCase();
  const lowerReply = agentReply.toLowerCase();

  // 1. Referral source detection
  if (!currentSession.referral_source) {
    if (/\b(?:tik\s*tok)\b/i.test(lowerText)) {
      updates.referral_source = 'TikTok';
    } else if (/\b(?:instagram|insta|ig)\b/i.test(lowerText)) {
      updates.referral_source = 'Instagram';
    }
  }

  // 2. Gender inference & dynamic override (relational partner and kinship cues)
  const maleSpeakerPatterns = [
    /\bmy\s+(?:girl|girlfriend|wife|woman|babe)\b/i,
    /\bher\s+(?:rose|toy|dildo|gift)\b/i,
    /\b(?:as\s+a\s+guy|i\s+am\s+a\s+man|call\s+me\s+sir)\b/i
  ];

  const femaleSpeakerPatterns = [
    /\bmy\s+(?:guy|boyfriend|husband|man)\b/i,
    /\b(?:fellow\s+woman|as\s+a\s+lady|call\s+me\s+ma)\b/i
  ];

  if (maleSpeakerPatterns.some(p => p.test(lowerText))) {
    if (currentSession.gender !== 'male') {
      updates.gender = 'male';
    }
  } else if (femaleSpeakerPatterns.some(p => p.test(lowerText))) {
    if (currentSession.gender !== 'female') {
      updates.gender = 'female';
    }
  }

  // 3. Urgent hospitality or transit venue detection
  const hospitalityPatterns = /\b(?:hotel|lodge|lodging|motel|guest\s*house|resort|suites?|inn)\b/i;
  if (hospitalityPatterns.test(lowerText)) {
    updates.notes = 'urgent_hospitality_location';
  }

  // 4. Shipping / Delivery location detection
  for (const step of steps) {
    if (step.tool === 'calculate_shipping' && step.input?.state) {
      updates.delivery_state = step.input.state;
      if (step.input.city) {
        updates.delivery_city = step.input.city;
      }
    }
  }

  // 5. Order stage transitions
  if (userText.includes('payment_receipt') || lowerReply.includes('receipt received') || lowerReply.includes('payment received')) {
    updates.order_stage = 'paid';
  } else if (lowerReply.includes(PAYMENT_ACCOUNT_SIGNAL) || lowerReply.includes('moniepoint')) {
    if (currentSession.order_stage !== 'paid') {
      updates.order_stage = 'awaiting_payment';
    }
  } else if (lowerText.includes('last price') || lowerText.includes('discount') || lowerText.includes('5k') || lowerText.includes('reduce')) {
    if (currentSession.order_stage === 'browsing') {
      updates.order_stage = 'negotiating';
      updates.price_sensitivity = 'sensitive';
    }
  }

  // 6. Phone number extraction (Nigerian 11-digit national or E.164 format)
  const phoneMatch = userText.match(/(?:0|\+234)[789][01]\d{8}/);
  if (phoneMatch && !currentSession.customer_phone) {
    updates.customer_phone = phoneMatch[0];
  }

  return updates;
}

module.exports = {
  getOrCreateSession,
  updateSession,
  extractSessionInferences
};
