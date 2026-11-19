'use strict';

require('dotenv').config();

const config = require('./config');
const { openDatabase } = require('./db');
const { releaseExpiredHolds } = require('./tools/orders');
const { startWebhookServer } = require('./webhook');
const { startWhatsAppBot } = require('./whatsapp/bot');

async function main() {
  const db = openDatabase();

  // Release any holds that expired while offline
  releaseExpiredHolds(db);

  // Drain leftover inbound_buffer rows from last run
  try {
    db.prepare(`UPDATE inbound_buffer SET status = 'stale' WHERE status = 'pending'`).run();
  } catch {
    // table may not exist on first run before migrations — db.js handles creation
  }

  // Keep releasing expired holds and dispatching payment reminders every 5 minutes
  const holdReleaseInterval = setInterval(() => {
    try { releaseExpiredHolds(db); } catch (err) {
      console.error('[INDEX] releaseExpiredHolds error:', err.message);
    }
    if (botHandle?.sendPaymentReminders) {
      botHandle.sendPaymentReminders().catch(err => {
        console.error('[INDEX] sendPaymentReminders error:', err.message);
      });
    }
  }, 5 * 60 * 1000);

  // Start Paystack webhook server
  let webhookServer = null;

  // Bot reference stored so we can wire onPaymentVerified after bot starts
  let botHandle = null;

  const onPaymentVerified = (sessionId, orderDetails) => {
    if (botHandle?.handlePaymentVerified) {
      botHandle.handlePaymentVerified({ sessionId, orderDetails });
    }
  };

  try {
    webhookServer = await startWebhookServer({
      db,
      config,
      port: config.paystackWebhookPort,
      onPaymentVerified
    });
    console.log(`[WEBHOOK] Paystack webhook listening on port ${config.paystackWebhookPort}`);
  } catch (err) {
    console.error(`[WEBHOOK] Failed to start webhook server: ${err.message}`);
    // Non-fatal — bot can still run without webhook
  }

  // Start WhatsApp bot
  try {
    botHandle = await startWhatsAppBot({
      db,
      config,
      onReady: () => {
        console.log('[BOT] WhatsApp bot connected and ready');
      },
      onPaymentVerified
    });
  } catch (err) {
    console.error(`[BOT] Failed to start WhatsApp bot: ${err.message}`);
    process.exit(1);
  }

  // Graceful shutdown
  async function shutdown(signal) {
    console.log(`\n[INDEX] ${signal} received — shutting down gracefully`);
    clearInterval(holdReleaseInterval);

    if (botHandle?.close) {
      try { await botHandle.close(); } catch {}
    }

    if (webhookServer) {
      await new Promise(resolve => webhookServer.close(resolve));
    }

    try { db.close(); } catch {}

    console.log('[INDEX] Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('[INDEX] Fatal startup error:', err);
  process.exit(1);
});
