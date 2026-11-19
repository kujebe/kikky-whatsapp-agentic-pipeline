'use strict';

/**
 * src/whatsapp/auth-store.js
 *
 * Production SQLite auth adapter for Baileys v7+.
 * Replaces useMultiFileAuthState (file-based) which corrupts Signal
 * sessions on concurrent restarts or cloud deployments.
 *
 * Uses dynamic import() so this CJS file can safely load the ESM-only
 * @whiskeysockets/baileys package.
 */

async function useSqliteAuthState(db, authId = 'kikky_main') {
  const {
    initAuthCreds,
    BufferJSON,
    proto,
    makeCacheableSignalKeyStore
  } = await import('@whiskeysockets/baileys');

  const pino = (await import('pino')).default;
  const logger = pino({ level: 'silent' });

  const keyPrefix = `${authId}:`;

  // ── helpers ───────────────────────────────────────────────────────────────

  function dbGet(key) {
    const row = db.prepare('SELECT value FROM baileys_auth WHERE key = ?').get(keyPrefix + key);
    if (!row) return undefined;
    try {
      return JSON.parse(row.value, BufferJSON.reviver);
    } catch {
      return undefined;
    }
  }

  function dbSet(key, value) {
    const serialized = JSON.stringify(value, BufferJSON.replacer);
    db.prepare(
      'INSERT INTO baileys_auth (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(keyPrefix + key, serialized);
  }

  function dbDelete(key) {
    db.prepare('DELETE FROM baileys_auth WHERE key = ?').run(keyPrefix + key);
  }

  // ── creds ─────────────────────────────────────────────────────────────────

  let creds = dbGet('creds');
  if (!creds) {
    creds = initAuthCreds();
    dbSet('creds', creds);
  }

  async function saveCreds() {
    dbSet('creds', creds);
  }

  // ── Signal key store ──────────────────────────────────────────────────────

  const APP_STATE_KEY_PREFIX = 'app-state-sync-key-';

  const keys = {
    get(type, ids) {
      const data = {};
      for (const id of ids) {
        const storageKey = `${type}:${id}`;
        let value = dbGet(storageKey);
        if (value === undefined) continue;

        // Rehydrate app-state-sync-key proto objects
        if (type === 'app-state-sync-key' && value && typeof value === 'object') {
          try {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          } catch {
            // keep raw value if proto rehydration fails
          }
        }

        data[id] = value;
      }
      return data;
    },

    set(data) {
      const writeTx = db.transaction(() => {
        for (const [type, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries || {})) {
            const storageKey = `${type}:${id}`;
            if (value == null) {
              dbDelete(storageKey);
            } else {
              dbSet(storageKey, value);
            }
          }
        }
      });
      writeTx();
    }
  };

  const cacheableKeys = makeCacheableSignalKeyStore(keys, logger);

  return {
    state: { creds, keys: cacheableKeys },
    saveCreds
  };
}

module.exports = { useSqliteAuthState };
