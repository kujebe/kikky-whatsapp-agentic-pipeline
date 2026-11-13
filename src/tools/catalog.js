const { z } = require('zod');

const searchSchema = z.object({
  query: z.string().trim().min(1).max(120),
  max_price: z.number().int().nonnegative().optional()
});

const detailsSchema = z.object({
  product_id: z.string().trim().min(1).max(80)
});

function validationError(error) {
  return {
    ok: false,
    error: `Invalid arguments: ${error.issues.map(issue => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ')}`
  };
}

function withoutEmptyFields(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null && value !== undefined));
}

function tokenVariants(token) {
  const variants = [token];
  if (token.length > 4 && token.endsWith('ies')) variants.push(`${token.slice(0, -3)}y`);
  if (token.length > 4 && token.endsWith('es')) variants.push(token.slice(0, -2));
  if (token.length > 3 && token.endsWith('s')) variants.push(token.slice(0, -1));
  return [...new Set(variants)];
}

function makeSearchTerms(query) {
  return query.toLocaleLowerCase('en-NG').match(/[\p{L}\p{N}]+/gu) || [];
}

function makeFtsQuery(terms, operator = 'AND') {
  return terms
    .map(term => `(${tokenVariants(term).map(variant => `"${variant.replaceAll('"', '""')}"*`).join(' OR ')})`)
    .join(` ${operator} `);
}

function searchWithLike(db, terms, maxPrice) {
  if (terms.length === 0) return [];

  const parameters = {};
  const wordConditions = terms.map((term, index) => {
    const variants = tokenVariants(term);
    const variantsSql = variants.map((variant, variantIndex) => {
      const parameter = `term${index}_${variantIndex}`;
      parameters[parameter] = `%${variant.replace(/[\\%_]/g, '\\$&')}%`;
      return `(name LIKE @${parameter} ESCAPE '\\' COLLATE NOCASE
        OR category LIKE @${parameter} ESCAPE '\\' COLLATE NOCASE
        OR description LIKE @${parameter} ESCAPE '\\' COLLATE NOCASE
        OR coalesce(search_tags, '') LIKE @${parameter} ESCAPE '\\' COLLATE NOCASE)`;
    });
    return `(${variantsSql.join(' OR ')})`;
  });

  parameters.maxPrice = maxPrice ?? null;
  const andRows = db.prepare(`
    SELECT id, name, category, retail_price, stock_quantity
    FROM products
    WHERE ${wordConditions.join(' AND ')}
      AND (@maxPrice IS NULL OR retail_price <= @maxPrice)
    ORDER BY name COLLATE NOCASE
    LIMIT 20
  `).all(parameters).map(withoutEmptyFields);

  if (andRows.length > 0 || terms.length <= 1) return andRows;

  const matchScoreSql = wordConditions.map(cond => `(CASE WHEN ${cond} THEN 1 ELSE 0 END)`).join(' + ');
  return db.prepare(`
    SELECT id, name, category, retail_price, stock_quantity
    FROM products
    WHERE (${wordConditions.join(' OR ')})
      AND (@maxPrice IS NULL OR retail_price <= @maxPrice)
    ORDER BY (${matchScoreSql}) DESC, name COLLATE NOCASE
    LIMIT 20
  `).all(parameters).map(withoutEmptyFields);
}

function createCatalogTools(db) {
  return {
    search_catalog(input) {
      const parsed = searchSchema.safeParse(input);
      if (!parsed.success) return validationError(parsed.error);

      try {
        const { query, max_price: maxPrice } = parsed.data;
        const terms = makeSearchTerms(query);
        if (terms.length === 0) return { ok: true, count: 0, products: [] };

        const andQuery = makeFtsQuery(terms, 'AND');
        let ftsRows = db.prepare(`
          SELECT p.id, p.name, p.category, p.retail_price, p.stock_quantity
          FROM products_fts
          JOIN products AS p ON p.rowid = products_fts.rowid
          WHERE products_fts MATCH @ftsQuery
            AND (@maxPrice IS NULL OR p.retail_price <= @maxPrice)
          ORDER BY p.name COLLATE NOCASE
          LIMIT 20
        `).all({ ftsQuery: andQuery, maxPrice: maxPrice ?? null });

        if (ftsRows.length === 0 && terms.length > 1) {
          const orQuery = makeFtsQuery(terms, 'OR');
          ftsRows = db.prepare(`
            SELECT p.id, p.name, p.category, p.retail_price, p.stock_quantity
            FROM products_fts
            JOIN products AS p ON p.rowid = products_fts.rowid
            WHERE products_fts MATCH @ftsQuery
              AND (@maxPrice IS NULL OR p.retail_price <= @maxPrice)
            ORDER BY bm25(products_fts), p.name COLLATE NOCASE
            LIMIT 20
          `).all({ ftsQuery: orQuery, maxPrice: maxPrice ?? null });
        }

        const products = ftsRows.length > 0 ? ftsRows.map(withoutEmptyFields) : searchWithLike(db, terms, maxPrice);
        return { ok: true, count: products.length, products };
      } catch {
        try {
          const products = searchWithLike(db, makeSearchTerms(parsed.data.query), parsed.data.max_price);
          return { ok: true, count: products.length, products };
        } catch {
          return { ok: false, error: 'Error: catalog search failed' };
        }
      }
    },

    get_product_details(input) {
      const parsed = detailsSchema.safeParse(input);
      if (!parsed.success) return validationError(parsed.error);

      try {
        const product = db.prepare(`
          SELECT id, name, category, description, usage_summary,
                 retail_price, stock_quantity
          FROM products
          WHERE id = ?
        `).get(parsed.data.product_id);

        if (!product) {
          return { ok: false, error: `Product not found for ID: ${parsed.data.product_id}` };
        }
        return { ok: true, product: withoutEmptyFields(product) };
      } catch {
        return { ok: false, error: 'Error: product details lookup failed' };
      }
    }
  };
}

module.exports = { createCatalogTools };