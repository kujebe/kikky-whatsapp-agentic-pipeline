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

function createShippingTool(db) {
  return function calculate_shipping(input) {
    const parsed = shippingSchema.safeParse(input);
    if (!parsed.success) return validationError(parsed.error);

    const { state, city } = parsed.data;
    try {
      let delivery = null;

      if (city) {
        delivery = db.prepare(`
          SELECT state, city, fee, estimated_days
          FROM deliveries
          WHERE state = ? COLLATE NOCASE AND city = ? COLLATE NOCASE
          LIMIT 1
        `).get(state, city);
      }

      if (!delivery) {
        delivery = db.prepare(`
          SELECT state, city, fee, estimated_days
          FROM deliveries
          WHERE state = ? COLLATE NOCASE AND city IS NULL
          LIMIT 1
        `).get(state);
      }

      if (!delivery) {
        return {
          ok: false,
          error: `Shipping not available for state: ${state}. Escalate to staff.`
        };
      }

      return {
        ok: true,
        delivery: Object.fromEntries(Object.entries(delivery).filter(([, value]) => value !== null && value !== undefined))
      };
    } catch {
      return { ok: false, error: 'Error: shipping lookup failed' };
    }
  };
}

module.exports = { createShippingTool };