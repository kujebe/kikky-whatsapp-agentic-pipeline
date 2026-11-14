const crypto = require('node:crypto');

function recordWaitlistRequest(db, rawInput = {}) {
  const contact = (rawInput.customer_contact && String(rawInput.customer_contact).trim()) || '';
  const requestedItem = (rawInput.requested_item && String(rawInput.requested_item).trim()) || '';
  const specs = rawInput.specifications ? String(rawInput.specifications).trim() : null;
  const deposit = Number.isInteger(rawInput.deposit_offered) && rawInput.deposit_offered > 0
    ? rawInput.deposit_offered
    : 0;
  const sessionId = rawInput.session_id ? String(rawInput.session_id).trim() : null;

  if (!contact) {
    return { ok: false, error: 'Customer contact phone number or details are required to record a restock request.' };
  }
  if (!requestedItem) {
    return { ok: false, error: 'Requested item description or name is required.' };
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO waitlist (id, session_id, customer_contact, requested_item, specifications, deposit_offered, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `).run(id, sessionId, contact, requestedItem, specs, deposit);

  return {
    ok: true,
    waitlist_id: id,
    message: 'Pre-order / restock notification recorded successfully. We will alert the customer when the item arrives.',
    item: requestedItem,
    contact
  };
}

module.exports = { recordWaitlistRequest };
