'use strict';
/**
 * clean-sheet.js
 * Safe production test reset script.
 *
 * WIPES: All transient transaction tables (chat history, orders, sessions, etc.)
 * PROTECTS: baileys_auth (WhatsApp login), lid_mappings (phone JID map),
 *           products, deliveries, store_hours (static business data).
 *
 * Usage: node scripts/clean-sheet.js
 */

require('dotenv').config();
const { openDatabase } = require('../src/db');

const TRANSIENT_TABLES = [
  'order_reservations',
  'sessions',
  'chat_history',
  'inbound_buffer',
  'processed_messages',
  'payments',
  'dispatches',
  'handoffs',
  'waitlist',
  'wa_messages_store'
];

const PROTECTED_TABLES = [
  'baileys_auth',
  'lid_mappings',
  'products',
  'deliveries',
  'store_hours'
];

function main() {
  const db = openDatabase();

  console.log('\n=== Kikky Clean-Sheet Reset ===\n');

  // Verify all protected tables still have rows before wiping anything
  for (const table of PROTECTED_TABLES) {
    try {
      const row = db.prepare(`SELECT count(*) as cnt FROM ${table}`).get();
      console.log(`✅ PROTECTED  ${table.padEnd(20)} (${row.cnt} rows — untouched)`);
    } catch (err) {
      console.error(`❌ ERROR: Could not verify protected table "${table}": ${err.message}`);
      process.exit(1);
    }
  }

  console.log('');

  // Wipe transient tables inside a transaction so it's atomic
  const wipeTx = db.transaction(() => {
    for (const table of TRANSIENT_TABLES) {
      try {
        const { changes } = db.prepare(`DELETE FROM ${table}`).run();
        console.log(`🗑️  WIPED     ${table.padEnd(20)} (${changes} rows deleted)`);
      } catch (err) {
        // Table may not exist in older migrations — non-fatal, log and continue
        console.warn(`⚠️  SKIPPED   ${table.padEnd(20)} (${err.message})`);
      }
    }
  });

  wipeTx();

  // Compact the database to reclaim disk space
  db.prepare('VACUUM').run();
  console.log('\n✅ VACUUM complete. Database compacted.\n');

  // Final verification: protected tables still intact
  let allSafe = true;
  for (const table of PROTECTED_TABLES) {
    const row = db.prepare(`SELECT count(*) as cnt FROM ${table}`).get();
    if (row.cnt === 0 && (table === 'products' || table === 'deliveries' || table === 'store_hours')) {
      console.error(`❌ DANGER: Protected table "${table}" is empty! Seed data was lost.`);
      allSafe = false;
    }
  }

  if (allSafe) {
    console.log('✅ All protected tables verified intact. Safe to start fresh WhatsApp session.\n');
  } else {
    console.error('\n⛔ WARNING: Seed data appears missing. Run: node scripts/init-db.js to re-seed.\n');
    process.exit(1);
  }

  db.close();
}

main();
