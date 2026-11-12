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
      image_url TEXT
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY,
      state TEXT NOT NULL,
      city TEXT NOT NULL,
      fee INTEGER NOT NULL CHECK (fee >= 0),
      estimated_days TEXT NOT NULL,
      UNIQUE (state, city)
    );
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
    CREATE INDEX IF NOT EXISTS idx_deliveries_state_city ON deliveries(state, city);
  `);

  return db;
}

module.exports = { DEFAULT_DB_PATH, openDatabase };