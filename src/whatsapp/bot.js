'use strict';

/**
 * src/whatsapp/bot.js
 *
 * WhatsApp bot socket — Baileys v7, production-safe.
 *
 * Rules enforced here:
 *   1. No agent/ or tools/ imports. All agent calls go through dispatcher.
 *   2. Dynamic await import() for all @whiskeysockets/baileys usage.
 *   3. No useMultiFileAuthState — SQLite auth only.
 *   4. fromMe split: bot's own IDs (botSentMessageIds) → ignore;
 *      unrecognised fromMe → human co-pilot mute.
 *   5. Per-session FIFO promise chain prevents race conditions.
 *   6. inbound_buffer persisted before debounce; deleted after reply.
 */

const { createDebouncer } = require('../debounce');
const { useSqliteAuthState } = require('./auth-store');
const { resolveJid, extractInboundContent } = require('./helpers');
const { dispatchTextTurn, dispatchAudioTurn, dispatchImageTurn } = require('../agent/dispatcher');
const { getOrCreateSession } = require('../agent/session');
const { releaseExpiredHolds, getPendingReminders, markReminderSent } = require('../tools/orders');
const { getSessionHistory, saveSessionHistory } = require('../db');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Bounded self-sent message ID set (max 2000 entries, FIFO eviction)
class BoundedSet {
  constructor(limit = 2000) {
    this._limit = limit;
    this._set = new Set();
  }
  add(id) {
    if (this._set.size >= this._limit) {
      this._set.delete(this._set.values().next().value);
    }
    this._set.add(id);
    return this;
  }
  has(id) { return this._set.has(id); }
  delete(id) { return this._set.delete(id); }
}

// Per-session promise chain for FIFO ordering
const sessionQueues = new Map();
function enqueueForSession(sessionId, task) {
  const current = sessionQueues.get(sessionId) || Promise.resolve();
  const next = current.then(task).catch(() => {});
  sessionQueues.set(sessionId, next);
  // Clean up resolved chains to avoid memory growth
  next.finally(() => {
    if (sessionQueues.get(sessionId) === next) {
      sessionQueues.delete(sessionId);
    }
  });
  return next;
}

/**
 * startWhatsAppBot — connect to WhatsApp Web via Baileys and wire
 * inbound messages to the agent dispatcher.
 *
 * @param {object} opts
 * @param {object} opts.db          - better-sqlite3 database (shared)
 * @param {object} opts.config      - loaded config object
 * @param {function} [opts.onReady] - called when socket connects
 * @param {function} [opts.onPaymentVerified] - called by webhook on charge.success
 * @returns {Promise<{ sock, safeSend, botSentMessageIds, close }>}
 */
async function startWhatsAppBot({ db, config, onReady, onPaymentVerified } = {}) {
  if (!db) throw new Error('[bot] db is required');
  if (!config) throw new Error('[bot] config is required');

  // ── dynamic Baileys import ────────────────────────────────────────────────
  const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
  } = await import('@whiskeysockets/baileys');

  const pino = (await import('pino')).default;
  const qrcode = (await import('qrcode-terminal')).default;

  const authId = config.whatsappAuthId || 'kikky_main';
  const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

  // ── auth ──────────────────────────────────────────────────────────────────
  const { state, saveCreds } = await useSqliteAuthState(db, authId);

  // ── Baileys version ───────────────────────────────────────────────────────
  const { version } = await fetchLatestBaileysVersion();

  const botSentMessageIds = new BoundedSet(2000);
  let sock = null;
  let debouncer = null;
  let closed = false;

  // ── getMessage: feeds Baileys retry decryption from wa_messages_store ─────
  function getMessage(key) {
    try {
      const row = db.prepare('SELECT message_json FROM wa_messages_store WHERE id = ?').get(key.id);
      if (!row) return undefined;
      return JSON.parse(row.message_json);
    } catch {
      return undefined;
    }
  }

  // ── safeSend: human-delay + presence + self-track ─────────────────────────
  async function safeSend(jid, content) {
    if (!sock || !jid) return null;
    try {
      const delay = 2000 + Math.floor(Math.random() * 2000);
      await sock.sendPresenceUpdate('composing', jid);
      await new Promise(r => setTimeout(r, delay));
      const sent = await sock.sendMessage(jid, content);
      if (sent?.key?.id) {
        botSentMessageIds.add(sent.key.id);
        // Persist to wa_messages_store for Baileys retry decryption
        try {
          db.prepare(`
            INSERT OR IGNORE INTO wa_messages_store (id, remote_jid, message_json)
            VALUES (?, ?, ?)
          `).run(sent.key.id, jid, JSON.stringify(sent.message || {}));
        } catch {
          // non-fatal store failure
        }
      }
      await sock.sendPresenceUpdate('paused', jid);
      return sent;
    } catch (err) {
      logger.warn({ err, jid }, '[bot] safeSend failed');
      return null;
    }
  }

  // ── isMuted: check sessions.muted_until ──────────────────────────────────
  function isMuted(sessionId) {
    try {
      const row = db.prepare(
        "SELECT muted_until FROM sessions WHERE session_id = ? AND muted_until > datetime('now')"
      ).get(sessionId);
      return Boolean(row);
    } catch {
      return false;
    }
  }

  function setMuted(sessionId, hours) {
    try {
      db.prepare(`
        UPDATE sessions
        SET muted_until = datetime('now', '+' || ? || ' hours'),
            updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ?
      `).run(String(hours), sessionId);
    } catch {
      // non-fatal
    }
  }

  // ── inbound_buffer helpers ────────────────────────────────────────────────
  function bufferInsert(bufferId, sessionId, payload) {
    try {
      db.prepare(`
        INSERT OR IGNORE INTO inbound_buffer (id, session_id, payload_json, status)
        VALUES (?, ?, ?, 'pending')
      `).run(bufferId, sessionId, JSON.stringify(payload));
    } catch {
      // non-fatal
    }
  }

  function bufferComplete(bufferId) {
    try {
      db.prepare("UPDATE inbound_buffer SET status = 'done' WHERE id = ?").run(bufferId);
    } catch {
      // non-fatal
    }
  }

  // ── deduplication ─────────────────────────────────────────────────────────
  function markSeen(messageId) {
    try {
      db.prepare(
        'INSERT OR IGNORE INTO processed_messages (message_id) VALUES (?)'
      ).run(messageId);
      return true;
    } catch {
      return false;
    }
  }

  function alreadySeen(messageId) {
    try {
      const row = db.prepare('SELECT 1 FROM processed_messages WHERE message_id = ?').get(messageId);
      return Boolean(row);
    } catch {
      return false;
    }
  }

  // ── send staff alert ──────────────────────────────────────────────────────
  async function sendStaffAlert(text) {
    const staffJid = config.staffAlertJid;
    if (!staffJid) return;
    try {
      await safeSend(staffJid, { text });
    } catch {
      // non-fatal staff alert failure
    }
  }

  // ── process one debounced turn ────────────────────────────────────────────
  async function processTurn({ sessionId, replyJid, messages, keys, history }) {
    // Show typing presence and mark read at the exact moment bot begins processing
    try {
      if (typeof sock?.sendPresenceUpdate === 'function') {
        await sock.sendPresenceUpdate('composing', replyJid);
      }
      if (Array.isArray(keys) && keys.length > 0 && typeof sock?.readMessages === 'function') {
        await sock.readMessages(keys);
      }
    } catch (presenceErr) {
      logger.debug({ err: presenceErr }, '[bot] Failed to set composing presence or read receipt');
    }

    const session = getOrCreateSession(db, sessionId);
    const activeHistory = (Array.isArray(history) && history.length > 0)
      ? history
      : getSessionHistory(db, sessionId, 30);

    let result;
    try {
      if (messages.length === 1 && messages[0].type === 'audio') {
        result = await dispatchAudioTurn({
          audioBuffer: messages[0].buffer,
          history: activeHistory,
          db,
          options: { sessionId, debug: false }
        });
      } else if (messages.length === 1 && messages[0].type === 'image') {
        result = await dispatchImageTurn({
          imageBuffer: messages[0].buffer,
          caption: messages[0].caption,
          history: activeHistory,
          db,
          options: { sessionId, debug: false }
        });
      } else {
        // Merge multiple text messages (debounce window)
        const combined = messages
          .filter(m => m.type === 'text' && m.text)
          .map(m => m.text)
          .join('\n');
        result = await dispatchTextTurn({
          text: combined || '[media]',
          history: activeHistory,
          db,
          options: { sessionId, debug: false }
        });
      }
    } finally {
      // Clear composing presence indicator
      try {
        if (typeof sock?.sendPresenceUpdate === 'function') {
          await sock.sendPresenceUpdate('paused', replyJid);
        }
      } catch {}
    }

    if (!result?.ok) {
      logger.warn({ sessionId, error: result?.error }, '[bot] Turn dispatch failed');
      return;
    }

    // Persist conversation history for session continuity across turns and restarts
    if (Array.isArray(result.messages)) {
      saveSessionHistory(db, sessionId, result.messages, 30);
    }

    // Send product media if returned by dispatcher
    if (result.media?.image_path && fs.existsSync(result.media.image_path)) {
      try {
        const imageBuffer = fs.readFileSync(result.media.image_path);
        await safeSend(replyJid, { image: imageBuffer, caption: result.media.caption || undefined });
      } catch (mediaErr) {
        logger.warn({ err: mediaErr, image_path: result.media.image_path }, '[bot] Failed to send media photo');
      }
    }

    // Send reply (split on WhatsApp message boundaries)
    const replies = result.replies || [result.reply];
    for (const text of replies) {
      if (text && text.trim()) {
        await safeSend(replyJid, { text });
      }
    }

    // If escalated, alert staff
    if (result.escalated) {
      const summary = `📌 *KIKKY HANDOFF ALERT*\nSession: ${sessionId}\nReason: Escalated to human staff\nLast message: ${messages.map(m => m.text || '[media]').join(' | ')}`;
      await sendStaffAlert(summary);
    }

    // Auto-push address prompt after Paystack payment verified
    // (triggered from webhook callback, not here — see onPaymentVerified below)
  }

  // ── connect / reconnect ───────────────────────────────────────────────────
  async function connect() {
    if (closed) return;

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: true,
      syncFullHistory: false,
      getMessage
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n╔═══════════════════════════════════════════╗');
        console.log('║  SCAN QR CODE IN WHATSAPP > LINKED DEVICES  ║');
        console.log('╚═══════════════════════════════════════════╝\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        console.log(`[bot] ✓ WhatsApp connected (${authId})`);

        // Wire per-session debouncer
        debouncer = createDebouncer({
          quietMs: parseInt(process.env.DEBOUNCE_QUIET_MS || '10000', 10),
          maxWaitMs: parseInt(process.env.DEBOUNCE_MAX_WAIT_MS || '15000', 10),
          onFlush: async (sessionId, bufferedItems) => {
            const { replyJid, bufferIds } = bufferedItems[0]._meta;
            const messages = bufferedItems.map(item => item.content);
            const keys = bufferedItems.map(item => item.key).filter(Boolean);

            enqueueForSession(sessionId, async () => {
              await processTurn({ sessionId, replyJid, messages, keys });
              for (const bid of bufferIds || []) bufferComplete(bid);
            });
          },
          onError: (err) => logger.warn({ err }, '[bot] Debounce flush error')
        });

        if (typeof onReady === 'function') {
          onReady({ sock, safeSend });
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        if (isLoggedOut) {
          console.warn('[bot] ⚠ Session logged out. Clear baileys_auth rows and restart to re-pair.');
          // Do NOT loop-reconnect on logout — operator must clear auth and restart
          return;
        }

        const delay = statusCode === 408 ? 5000 : 3000;
        console.log(`[bot] Connection closed (status ${statusCode}), reconnecting in ${delay}ms…`);
        setTimeout(connect, delay);
      }
    });

    // ── messages.upsert ───────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async (event) => {
      // Rule 1: ignore history syncs
      if (event.type !== 'notify') return;

      for (const m of event.messages) {
        if (!m.message) continue;

        // ── deduplication ───────────────────────────────────────────────
        const msgId = m.key?.id;
        if (!msgId) continue;
        if (alreadySeen(msgId)) continue;
        markSeen(msgId);

        // ── JID resolution ───────────────────────────────────────────────
        const resolved = resolveJid(m, db);
        if (!resolved) continue;
        const { replyJid, sessionId } = resolved;

        // ── fromMe split: bot vs human co-pilot ─────────────────────────
        if (m.key.fromMe === true) {
          if (botSentMessageIds.has(msgId)) {
            // Our own bot sent it → ignore
            continue;
          }
          // Kikky manually replied from her phone → mute bot
          getOrCreateSession(db, sessionId);
          const muteHours = config.humanMuteHours || 2;
          setMuted(sessionId, muteHours);
          console.log(`[bot] 🤫 [HUMAN TAKEOVER] Bot muted for ${sessionId} (${muteHours}h)`);
          continue;
        }

        // ── mute check ───────────────────────────────────────────────────
        if (isMuted(sessionId)) {
          logger.info({ sessionId }, '[bot] Muted — human co-pilot active, ignoring message');
          continue;
        }

        // ── extract content ──────────────────────────────────────────────
        const content = await extractInboundContent(m, { logger });
        if (!content) continue;

        // ── send delivery receipt immediately (double grey tick) ─────────
        try {
          if (m.key && typeof sock?.sendReceipts === 'function') {
            await sock.sendReceipts([m.key]);
          }
        } catch (deliveryErr) {
          logger.debug({ err: deliveryErr, key: m.key }, '[bot] Failed to send delivery receipt');
        }

        // ── ensure session exists ────────────────────────────────────────
        getOrCreateSession(db, sessionId);

        // Load persistent conversation history (last 30 messages)
        const history = getSessionHistory(db, sessionId, 30);

        // ── immediate ack for slow media ────────────────────────────────
        if (content.type === 'image') {
          // Fire-and-forget lightweight ack before heavy Modal vision call
          safeSend(replyJid, { text: 'Checking that photo for you, one moment…' }).catch(() => {});
        }

        // ── persist to inbound_buffer before debounce ────────────────────
        const bufferId = crypto.randomUUID();
        bufferInsert(bufferId, sessionId, { type: content.type, timestamp: Date.now() });

        // Push to debouncer — attach metadata and message key
        const debouncerPayload = {
          content,
          key: m.key,
          _meta: { replyJid, sessionId, bufferIds: [bufferId] }
        };

        if (!debouncer) {
          // Socket connected but debouncer not ready yet — process immediately
          await processTurn({ sessionId, replyJid, messages: [content], keys: m.key ? [m.key] : [] });
          bufferComplete(bufferId);
          continue;
        }

        // For audio and image, bypass debounce and process immediately
        if (content.type === 'audio' || content.type === 'image') {
          enqueueForSession(sessionId, async () => {
            await processTurn({ sessionId, replyJid, messages: [content], keys: m.key ? [m.key] : [] });
            bufferComplete(bufferId);
          });
        } else {
          debouncer.push(sessionId, debouncerPayload);
        }
      }
    });

    return sock;
  }

  // ── Paystack webhook callback (called from src/webhook.js) ───────────────
  async function handlePaymentVerified({ sessionId, orderDetails }) {
    if (!sessionId) return;

    // Find the customer JID from their session
    let customerJid = null;
    try {
      const session = db.prepare('SELECT customer_phone FROM sessions WHERE session_id = ?').get(sessionId);
      if (session?.customer_phone) {
        const digits = session.customer_phone.replace(/\D/g, '');
        // Nigerian number normalisation: 0801... → 234801...
        const e164 = digits.startsWith('0') ? `234${digits.slice(1)}` : digits;
        customerJid = `${e164}@s.whatsapp.net`;
      } else {
        // sessionId IS the phone digits when bot is live
        const digits = sessionId.replace(/\D/g, '');
        if (digits.length >= 10) {
          const e164 = digits.startsWith('0') ? `234${digits.slice(1)}` : digits;
          customerJid = `${e164}@s.whatsapp.net`;
        }
      }
    } catch {
      // non-fatal
    }

    // Alert staff
    const staffMsg = [
      '💰 *PAYMENT CONFIRMED*',
      `Order: ${orderDetails?.order_id || 'unknown'}`,
      `Amount: ₦${Number(orderDetails?.amount_ngn || 0).toLocaleString('en-NG')}`,
      `Session: ${sessionId}`
    ].join('\n');
    await sendStaffAlert(staffMsg);

    // Prompt customer for delivery address
    if (customerJid) {
      const customerMsg = [
        '✅ Your payment has been confirmed! 🎉',
        '',
        'Please send me:',
        '1. Your full name',
        '2. Your phone number for the rider to call on arrival',
        '3. Your exact street delivery address'
      ].join('\n');
      await safeSend(customerJid, { text: customerMsg });
    }
  }

  // ── payment reminder dispatch ─────────────────────────────────────────────
  async function sendPaymentReminders() {
    if (closed || !sock) return;
    try {
      const pending = getPendingReminders(db);
      for (const item of pending) {
        const jid = item.sessionId.includes('@') ? item.sessionId : `${item.sessionId}@s.whatsapp.net`;
        logger.info({ orderId: item.orderId, jid }, '[bot] Dispatching payment reminder');
        await safeSend(jid, { text: item.message });
        markReminderSent(db, item.orderId);
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[bot] Failed to send payment reminders');
    }
  }

  // ── start connection ──────────────────────────────────────────────────────
  await connect();

  function close() {
    closed = true;
    if (debouncer) debouncer.close();
    if (sock) {
      try { sock.end(); } catch { /* ignore */ }
    }
  }

  return { sock: () => sock, safeSend, botSentMessageIds, handlePaymentVerified, sendPaymentReminders, close };
}

/**
 * Drain stale pending rows from inbound_buffer on boot.
 * Rows that never got a reply (e.g. crash mid-turn) are logged for review.
 */
function drainInboundBuffer(db) {
  try {
    const stale = db.prepare(
      "SELECT id, session_id, payload_json, created_at FROM inbound_buffer WHERE status = 'pending' AND created_at < datetime('now', '-5 minutes')"
    ).all();

    if (stale.length > 0) {
      console.log(`[bot] ⚠ Found ${stale.length} stale inbound_buffer rows from previous run. Marking done — customer may need to resend.`);
      const markDone = db.prepare("UPDATE inbound_buffer SET status = 'stale' WHERE id = ?");
      const tx = db.transaction(() => {
        for (const row of stale) markDone.run(row.id);
      });
      tx();
    }
  } catch {
    // non-fatal
  }
}

module.exports = { startWhatsAppBot, drainInboundBuffer };
