const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'kikky.sqlite');

function openDatabase(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      usage_summary TEXT NOT NULL,
      retail_price INTEGER NOT NULL CHECK (retail_price >= 0),
      min_price INTEGER NOT NULL CHECK (min_price >= 0 AND min_price <= retail_price),
      stock_quantity INTEGER NOT NULL CHECK (stock_quantity >= 0),
      image_url TEXT,
      search_tags TEXT
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY,
      state TEXT NOT NULL,
      city TEXT,
      fee INTEGER NOT NULL CHECK (fee >= 0),
      estimated_days TEXT NOT NULL,
      UNIQUE (state, city)
    );
    CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reason TEXT NOT NULL,
      customer_summary TEXT,
      status TEXT DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      customer_phone TEXT,
      customer_name TEXT,
      gender TEXT CHECK (gender IN ('female', 'male', 'unknown')) DEFAULT 'unknown',
      referral_source TEXT,
      order_stage TEXT DEFAULT 'browsing',
      active_cart_json TEXT DEFAULT '{}',
      delivery_state TEXT,
      delivery_city TEXT,
      delivery_address TEXT,
      price_sensitivity TEXT DEFAULT 'normal',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS store_hours (
      id INTEGER PRIMARY KEY,
      day_of_week TEXT NOT NULL UNIQUE,
      is_open INTEGER NOT NULL CHECK (is_open IN (0, 1)),
      open_time TEXT,
      close_time TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS waitlist (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      customer_contact TEXT NOT NULL,
      requested_item TEXT NOT NULL,
      specifications TEXT,
      deposit_offered INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
    CREATE INDEX IF NOT EXISTS idx_deliveries_state_city ON deliveries(state, city);
    CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(customer_phone);
    CREATE INDEX IF NOT EXISTS idx_waitlist_contact ON waitlist(customer_contact);
    CREATE INDEX IF NOT EXISTS idx_store_hours_day ON store_hours(day_of_week);
  `);

  const cityColumn = db.prepare('PRAGMA table_info(deliveries)')
    .all()
    .find(column => column.name === 'city');

  if (cityColumn?.notnull) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE deliveries_new (
          id INTEGER PRIMARY KEY,
          state TEXT NOT NULL,
          city TEXT,
          fee INTEGER NOT NULL CHECK (fee >= 0),
          estimated_days TEXT NOT NULL,
          UNIQUE (state, city)
        );
        INSERT INTO deliveries_new (id, state, city, fee, estimated_days)
        SELECT id, state, city, fee, estimated_days FROM deliveries;
        DROP TABLE deliveries;
        ALTER TABLE deliveries_new RENAME TO deliveries;
        CREATE INDEX IF NOT EXISTS idx_deliveries_state_city ON deliveries(state, city);
      `);
    })();
  }

  // search_tags indexes colloquial customer terms, slang, and common typos in FTS5
  // while keeping public-facing fields (name, description) sanitized.
  const productColumns = db.prepare('PRAGMA table_info(products)').all();
  if (!productColumns.some(column => column.name === 'search_tags')) {
    db.exec('ALTER TABLE products ADD COLUMN search_tags TEXT');
  }

  const ftsColumns = db.prepare('PRAGMA table_info(products_fts)').all();
  if (ftsColumns.length > 0 && !ftsColumns.some(column => column.name === 'search_tags')) {
    db.exec('DROP TABLE products_fts');
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(id, name, category, description, search_tags);

    CREATE TRIGGER IF NOT EXISTS products_fts_insert AFTER INSERT ON products BEGIN
      INSERT INTO products_fts(rowid, id, name, category, description, search_tags)
      VALUES (new.rowid, new.id, new.name, new.category, new.description, coalesce(new.search_tags, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS products_fts_update AFTER UPDATE ON products BEGIN
      DELETE FROM products_fts WHERE rowid = old.rowid;
      INSERT INTO products_fts(rowid, id, name, category, description, search_tags)
      VALUES (new.rowid, new.id, new.name, new.category, new.description, coalesce(new.search_tags, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS products_fts_delete AFTER DELETE ON products BEGIN
      DELETE FROM products_fts WHERE rowid = old.rowid;
    END;
  `);

  db.transaction(() => {
    db.exec('DELETE FROM products_fts');
    db.exec(`
      INSERT INTO products_fts(rowid, id, name, category, description, search_tags)
      SELECT rowid, id, name, category, description, coalesce(search_tags, '') FROM products
    `);
  })();

  return db;
}

module.exports = { DEFAULT_DB_PATH, openDatabase };