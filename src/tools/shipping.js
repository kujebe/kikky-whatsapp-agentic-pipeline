const { z } = require('zod');

const shippingSchema = z.object({
  state: z.string().trim().min(1),
  city: z.string().trim().min(1).optional()
});

function validationError(error) {
  return {
    ok: false,
    error: `Invalid arguments: ${error.issues.map(issue => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ')}`
  };
}

function calculateShippingFee(db, { state, city } = {}) {
  if (!db || !state) {
    return { ok: false, error: 'State is required for shipping calculation' };
  }
  const cleanState = String(state).trim();
  const cleanCity = city ? String(city).trim() : null;

  try {
    let delivery = null;

    if (cleanCity) {
      delivery = db.prepare(`
        SELECT state, city, fee, estimated_days
        FROM deliveries
        WHERE state = ? COLLATE NOCASE AND city = ? COLLATE NOCASE
        LIMIT 1
      `).get(cleanState, cleanCity);
    }

    if (!delivery) {
      delivery = db.prepare(`
        SELECT state, city, fee, estimated_days
        FROM deliveries
        WHERE state = ? COLLATE NOCASE AND city IS NULL
        LIMIT 1
      `).get(cleanState);
    }

    if (!delivery) {
      delivery = db.prepare(`
        SELECT state, city, fee, estimated_days
        FROM deliveries
        WHERE city = ? COLLATE NOCASE
        LIMIT 1
      `).get(cleanState);
    }

    if (!delivery) {
      return {
        ok: false,
        error: `Shipping not available for state: ${cleanState}. Escalate to staff.`
      };
    }

    return {
      ok: true,
      delivery: Object.fromEntries(Object.entries(delivery).filter(([, value]) => value !== null && value !== undefined))
    };
  } catch {
    return { ok: false, error: 'Error: shipping lookup failed' };
  }
}

function createShippingTool(db) {
  return function calculate_shipping(input) {
    const parsed = shippingSchema.safeParse(input);
    if (!parsed.success) return validationError(parsed.error);

    const { state, city } = parsed.data;
    return calculateShippingFee(db, { state, city });
  };
}

module.exports = { createShippingTool, calculateShippingFee };