'use strict';

/**
 * src/whatsapp/helpers.js
 *
 * JID resolution, session ID normalisation, and inbound message
 * content extraction — all WhatsApp-specific logic lives here.
 * No agent or tools imports allowed in this file.
 */

// JIDs we must never reply to
const IGNORED_JID_SUFFIXES = ['@broadcast', '@g.us', '@newsletter'];

/**
 * Returns true when the JID represents a chat we should handle.
 */
function isHandleable(remoteJid) {
  if (!remoteJid || typeof remoteJid !== 'string') return false;
  return !IGNORED_JID_SUFFIXES.some(suffix => remoteJid.endsWith(suffix));
}

/**
 * Derive a stable, normalised sessionId from a remoteJid.
 * Always digits-only for phone JIDs; raw for @lid until resolved.
 */
function jidToSessionId(jid) {
  if (!jid) return null;
  // Strip @s.whatsapp.net, @lid, etc. — keep only digits for phone JIDs
  const digits = jid.replace(/@.*$/, '').replace(/\D/g, '');
  // Fall back to raw jid prefix if no digits (unusual @lid format)
  return digits.length >= 7 ? digits : jid.replace(/@.*$/, '');
}

/**
 * Resolve the canonical reply JID and sessionId from an inbound message.
 *
 * @lid resolution strategy (Baileys v7):
 *   1. Use m.key.remoteJidAlt if present (Baileys sets this automatically).
 *   2. Check lid_mappings table for a previously resolved phone.
 *   3. Fall back to raw @lid for now; merge later when phone is revealed.
 *
 * @param {object} m  - Baileys message object
 * @param {object} db - better-sqlite3 database
 * @returns {{ replyJid: string, sessionId: string, isLid: boolean }}
 */
function resolveJid(m, db) {
  const remoteJid = m.key?.remoteJid || '';

  if (!isHandleable(remoteJid)) {
    return null;
  }

  // Best case: direct phone JID
  if (remoteJid.endsWith('@s.whatsapp.net')) {
    return {
      replyJid: remoteJid,
      sessionId: jidToSessionId(remoteJid),
      isLid: false
    };
  }

  // @lid JID — attempt resolution
  if (remoteJid.endsWith('@lid')) {
    // 1. Baileys sometimes provides the phone JID in remoteJidAlt
    const altJid = m.key?.remoteJidAlt;
    if (altJid && altJid.endsWith('@s.whatsapp.net')) {
      // Persist the mapping so we can merge future @lid messages
      if (db) {
        try {
          db.prepare(`
            INSERT INTO lid_mappings (lid_jid, phone_jid)
            VALUES (?, ?)
            ON CONFLICT(lid_jid) DO UPDATE SET phone_jid = excluded.phone_jid
          `).run(remoteJid, altJid);
        } catch {
          // non-fatal
        }
      }
      return {
        replyJid: altJid,
        sessionId: jidToSessionId(altJid),
        isLid: false
      };
    }

    // 2. Check persistent mapping table
    if (db) {
      try {
        const row = db.prepare('SELECT phone_jid FROM lid_mappings WHERE lid_jid = ?').get(remoteJid);
        if (row?.phone_jid) {
          return {
            replyJid: row.phone_jid,
            sessionId: jidToSessionId(row.phone_jid),
            isLid: false
          };
        }
      } catch {
        // non-fatal
      }
    }

    // 3. Use @lid as-is; will be merged later when phone is revealed
    const lidSessionId = jidToSessionId(remoteJid);
    return {
      replyJid: remoteJid,
      sessionId: lidSessionId,
      isLid: true
    };
  }

  // Unknown JID format — treat best-effort
  return {
    replyJid: remoteJid,
    sessionId: jidToSessionId(remoteJid),
    isLid: false
  };
}

/**
 * Extract the actionable content from an inbound Baileys message.
 *
 * Returns one of:
 *   { type: 'text',  text: string }
 *   { type: 'audio', buffer: Buffer }
 *   { type: 'image', buffer: Buffer, caption: string | null }
 *   null  (ignored / protocol message)
 *
 * Uses dynamic import so downloadMediaMessage (ESM) can be called.
 */
async function extractInboundContent(m, { logger } = {}) {
  const msg = m.message;
  if (!msg) return null;

  const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
  const log = logger || { warn: () => {} };

  // ── text ──────────────────────────────────────────────────────────────────
  const textContent =
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    null;

  if (textContent) {
    const contextInfo = msg.extendedTextMessage?.contextInfo;
    const quoted = contextInfo?.quotedMessage;
    let quotedText = null;
    if (quoted) {
      quotedText =
        quoted.conversation ||
        quoted.extendedTextMessage?.text ||
        quoted.imageMessage?.caption ||
        null;
    }

    const fullText = quotedText
      ? `[Replying to: "${quotedText.trim()}"] ${textContent.trim()}`
      : textContent.trim();

    return { type: 'text', text: fullText };
  }

  // ── image ─────────────────────────────────────────────────────────────────
  const imageMsg = msg.imageMessage || msg.viewOnceMessageV2?.message?.imageMessage;
  if (imageMsg) {
    try {
      const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: log });
      const caption = imageMsg.caption?.trim() || null;
      return { type: 'image', buffer, caption };
    } catch (err) {
      log.warn({ err }, '[helpers] Failed to download image');
      return null;
    }
  }

  // ── audio / voice note ────────────────────────────────────────────────────
  const audioMsg = msg.audioMessage || msg.viewOnceMessageV2?.message?.audioMessage;
  if (audioMsg) {
    try {
      const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: log });
      return { type: 'audio', buffer };
    } catch (err) {
      log.warn({ err }, '[helpers] Failed to download audio');
      return null;
    }
  }

  // ── ignored protocol messages ─────────────────────────────────────────────
  if (
    msg.protocolMessage ||
    msg.reactionMessage ||
    msg.senderKeyDistributionMessage ||
    msg.messageContextInfo
  ) {
    return null;
  }

  return null;
}

module.exports = { isHandleable, jidToSessionId, resolveJid, extractInboundContent };
