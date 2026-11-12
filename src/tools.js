const { z } = require('zod');

const searchSchema = z.object({
  query: z.string().trim().min(1).max(120),
  max_price: z.number().int().nonnegative().optional()
});

const detailsSchema = z.object({
  product_id: z.string().trim().min(1).max(80)
});

const shippingSchema = z.object({
  state: z.string().trim().min(1).max(80),
  city: z.string().trim().min(1).max(80).optional()
});

function validationError(error) {
  return {
    ok: false,
    error: `Invalid arguments: ${error.issues.map(issue => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ')}`
  };
}

function createTools(db) {
  return {
    search_catalog(input) {
      const parsed = searchSchema.safeParse(input);
      if (!parsed.success) return validationError(parsed.error);

      try {
        const { query, max_price: maxPrice } = parsed.data;
        const escapedQuery = query.replace(/[\\%_]/g, '\\$&');
        const sql = `
          SELECT id, name, category, retail_price, stock_quantity
          FROM products
          WHERE (name LIKE @query ESCAPE '\\'
             OR category LIKE @query ESCAPE '\\'
             OR description LIKE @query ESCAPE '\\')
            AND (@maxPrice IS NULL OR retail_price <= @maxPrice)
          ORDER BY name COLLATE NOCASE
          LIMIT 20
        `;
        const results = db.prepare(sql).all({ query: `%${escapedQuery}%`, maxPrice: maxPrice ?? null });
        return { ok: true, count: results.length, products: results };
      } catch {
        return { ok: false, error: 'Error: catalog search failed' };
      }
    },

    get_product_details(input) {
      const parsed = detailsSchema.safeParse(input);
      if (!parsed.success) return validationError(parsed.error);

      try {
        const product = db.prepare(`
          SELECT id, name, category, description, usage_summary,
                 retail_price, min_price, stock_quantity, image_url
          FROM products
          WHERE id = ?
        `).get(parsed.data.product_id);

        if (!product) return { ok: false, error: 'Error: product not found' };
        return { ok: true, product };
      } catch {
        return { ok: false, error: 'Error: product details lookup failed' };
      }
    },

    calculate_shipping(input) {
      const parsed = shippingSchema.safeParse(input);
      if (!parsed.success) return validationError(parsed.error);

      try {
        const { state, city } = parsed.data;
        const matches = db.prepare(`
          SELECT state, city, fee, estimated_days
          FROM deliveries
          WHERE state = ? COLLATE NOCASE
            AND (? IS NULL OR city = ? COLLATE NOCASE)
          ORDER BY city COLLATE NOCASE
          LIMIT 2
        `).all(state, city ?? null, city ?? null);

        if (matches.length === 0) {
          return { ok: false, error: 'Error: shipping zone not found; confirm the state and city' };
        }
        if (matches.length > 1) {
          return { ok: false, error: 'Error: multiple cities found for this state; provide a city' };
        }
        return { ok: true, delivery: matches[0] };
      } catch {
        return { ok: false, error: 'Error: shipping lookup failed' };
      }
    }
  };
}

module.exports = { createTools };