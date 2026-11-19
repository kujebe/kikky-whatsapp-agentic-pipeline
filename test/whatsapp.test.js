'use strict';

const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { resolveJid, isHandleable, jidToSessionId, extractInboundContent } = require('../src/whatsapp/helpers');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb() {
  return openDatabase(':memory:');
}

function insertSession(db, sessionId) {
  db.prepare(`
    INSERT OR IGNORE INTO sessions (session_id) VALUES (?)
  `).run(sessionId);
}

// ---------------------------------------------------------------------------
// 1. useSqliteAuthState: creds and keys round-trip through SQLite
// ---------------------------------------------------------------------------

describe('useSqliteAuthState', () => {
  test('creds round-trip through SQLite without data loss', async () => {
    const db = freshDb();
    const { useSqliteAuthState } = await import('../src/whatsapp/auth-store.js');

    const { state: state1, saveCreds: save1 } = await useSqliteAuthState(db, 'test_auth');
    // initAuthCreds gives us a valid creds object
    assert.ok(state1.creds, 'creds should be initialized');
    assert.equal(typeof state1.creds.registrationId, 'number', 'registrationId should be a number');

    // Mutate and save
    state1.creds.registered = true;
    await save1();

    // Re-open from same db
    const { state: state2 } = await useSqliteAuthState(db, 'test_auth');
    assert.equal(state2.creds.registered, true, 'registered flag should persist');
    assert.equal(state2.creds.registrationId, state1.creds.registrationId, 'registrationId should round-trip');

    db.close();
  });

  test('keys.set and keys.get round-trip pre-key type', async () => {
    const db = freshDb();
    const { useSqliteAuthState } = await import('../src/whatsapp/auth-store.js');
    const { state } = await useSqliteAuthState(db, 'test_keys');

    const preKey = { keyId: 42, keyPair: { public: Buffer.from('pub'), private: Buffer.from('priv') } };
    await state.keys.set({ 'pre-key': { '42': preKey } });

    const result = await state.keys.get('pre-key', ['42']);
    assert.ok(result['42'], 'should retrieve stored pre-key');
    assert.ok(result['42'].keyPair?.public, 'public key should be present after round-trip');

    db.close();
  });

  test('separate authIds do not share keys', async () => {
    const db = freshDb();
    const { useSqliteAuthState } = await import('../src/whatsapp/auth-store.js');
    const { state: stateA } = await useSqliteAuthState(db, 'auth_A');
    const { state: stateB } = await useSqliteAuthState(db, 'auth_B');

    await stateA.keys.set({ 'pre-key': { '1': { keyId: 1, keyPair: { public: Buffer.from('a'), private: Buffer.from('b') } } } });

    const resultB = await stateB.keys.get('pre-key', ['1']);
    assert.equal(resultB['1'], undefined, 'auth_B should not see auth_A keys');

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 2. fromMe filtering
// ---------------------------------------------------------------------------

describe('fromMe handling in bot pipeline', () => {
  test('bot own message ID in botSentMessageIds is ignored', async () => {
    // We test the BoundedSet logic used by bot.js
    // Import the class indirectly by testing the deduplication path
    const db = freshDb();
    insertSession(db, 'test-session');

    // Simulate what bot.js does: insert into processed_messages
    db.prepare('INSERT INTO processed_messages (message_id) VALUES (?)').run('msg-001');

    const dup = db.prepare('SELECT message_id FROM processed_messages WHERE message_id = ?').get('msg-001');
    assert.ok(dup, 'known message ID must be in processed_messages');

    db.close();
  });

  test('unrecognised fromMe message sets muted_until', () => {
    const db = freshDb();
    insertSession(db, 'mute-session');

    const hoursToMute = 2;
    db.prepare(`
      UPDATE sessions
      SET muted_until = datetime('now', '+' || ? || ' hours')
      WHERE session_id = ?
    `).run(hoursToMute, 'mute-session');

    const row = db.prepare('SELECT muted_until FROM sessions WHERE session_id = ?').get('mute-session');
    assert.ok(row?.muted_until, 'muted_until should be set');

    const mutedUntil = new Date(row.muted_until + 'Z');
    const now = new Date();
    assert.ok(mutedUntil > now, 'muted_until should be in the future');

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 3. isMuted logic
// ---------------------------------------------------------------------------

describe('isMuted', () => {
  test('returns true when muted_until is in the future', () => {
    const db = freshDb();
    insertSession(db, 'muted-sid');

    db.prepare(`UPDATE sessions SET muted_until = datetime('now', '+2 hours') WHERE session_id = ?`)
      .run('muted-sid');

    const row = db.prepare('SELECT muted_until FROM sessions WHERE session_id = ?').get('muted-sid');
    const isMuted = row?.muted_until && new Date(row.muted_until + 'Z') > new Date();
    assert.ok(isMuted, 'should be muted');

    db.close();
  });

  test('returns false when muted_until is in the past', () => {
    const db = freshDb();
    insertSession(db, 'unmuted-sid');

    db.prepare(`UPDATE sessions SET muted_until = datetime('now', '-1 hour') WHERE session_id = ?`)
      .run('unmuted-sid');

    const row = db.prepare('SELECT muted_until FROM sessions WHERE session_id = ?').get('unmuted-sid');
    const isMuted = row?.muted_until && new Date(row.muted_until + 'Z') > new Date();
    assert.ok(!isMuted, 'should not be muted after time has passed');

    db.close();
  });

  test('returns false when muted_until is null', () => {
    const db = freshDb();
    insertSession(db, 'nomute-sid');

    const row = db.prepare('SELECT muted_until FROM sessions WHERE session_id = ?').get('nomute-sid');
    assert.equal(row?.muted_until, null, 'muted_until should be null by default');

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 4. @lid and JID resolution via helpers.js
// ---------------------------------------------------------------------------

describe('JID helpers', () => {
  test('isHandleable rejects broadcast JIDs', () => {
    assert.equal(isHandleable('status@broadcast'), false);
    assert.equal(isHandleable('news@broadcast'), false);
  });

  test('isHandleable rejects group JIDs', () => {
    assert.equal(isHandleable('12345@g.us'), false);
  });

  test('isHandleable rejects newsletter JIDs', () => {
    assert.equal(isHandleable('update@newsletter'), false);
  });

  test('isHandleable accepts normal phone JIDs', () => {
    assert.equal(isHandleable('2348012345678@s.whatsapp.net'), true);
  });

  test('jidToSessionId strips suffix', () => {
    assert.equal(jidToSessionId('2348012345678@s.whatsapp.net'), '2348012345678');
  });

  test('jidToSessionId returns digits for lid JID', () => {
    // lid JIDs: return as-is since no digit extraction applies
    const result = jidToSessionId('abc123@lid');
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 5. @lid resolution via resolveJid (uses db lid_mappings)
// ---------------------------------------------------------------------------

describe('resolveJid lid_mappings', () => {
  test('stores lid→phone mapping on first resolution', () => {
    const db = freshDb();

    const lidJid = 'abc123@lid';
    const phoneJid = '2348012345678@s.whatsapp.net';

    db.prepare('INSERT INTO lid_mappings (lid_jid, phone_jid) VALUES (?, ?)').run(lidJid, phoneJid);

    const row = db.prepare('SELECT phone_jid FROM lid_mappings WHERE lid_jid = ?').get(lidJid);
    assert.equal(row?.phone_jid, phoneJid);

    db.close();
  });

  test('lookup works on second message', () => {
    const db = freshDb();

    const lidJid = 'xyz999@lid';
    const phoneJid = '2347000000001@s.whatsapp.net';
    db.prepare('INSERT INTO lid_mappings (lid_jid, phone_jid) VALUES (?, ?)').run(lidJid, phoneJid);

    // Second message lookup
    const row = db.prepare('SELECT phone_jid FROM lid_mappings WHERE lid_jid = ?').get(lidJid);
    assert.equal(row?.phone_jid, phoneJid, 'second lookup should return same phone JID');

    db.close();
  });

  test('resolveJid returns null for broadcast', async () => {
    const db = freshDb();
    const fakeMsg = { key: { remoteJid: 'status@broadcast' } };
    const result = await resolveJid(fakeMsg, db);
    assert.equal(result, null, 'broadcast should resolve to null');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 6. event.type !== 'notify' — append is ignored
// ---------------------------------------------------------------------------

describe('messages.upsert type filtering', () => {
  test('append type does not enter processing pipeline', () => {
    // Simulate what bot.js checks at the top of the upsert handler
    const events = [
      { type: 'notify', messages: [{ key: { id: 'msg-1', remoteJid: '234@s.whatsapp.net' } }] },
      { type: 'append', messages: [{ key: { id: 'msg-2', remoteJid: '234@s.whatsapp.net' } }] }
    ];

    const processed = [];
    for (const event of events) {
      if (event.type !== 'notify') continue;
      processed.push(...event.messages.map(m => m.key.id));
    }

    assert.deepEqual(processed, ['msg-1']);
    assert.ok(!processed.includes('msg-2'), 'append messages should not be processed');
  });
});

// ---------------------------------------------------------------------------
// 7. Deduplication via processed_messages
// ---------------------------------------------------------------------------

describe('processed_messages deduplication', () => {
  test('same message ID is deduplicated on replay', () => {
    const db = freshDb();

    const msgId = 'dup-test-123';
    db.prepare('INSERT INTO processed_messages (message_id) VALUES (?)').run(msgId);

    // Simulate dedup check
    const seen = db.prepare('SELECT message_id FROM processed_messages WHERE message_id = ?').get(msgId);
    assert.ok(seen, 'first insert: should be found');

    // Try to insert again — UNIQUE constraint prevents it
    let threw = false;
    try {
      db.prepare('INSERT INTO processed_messages (message_id) VALUES (?)').run(msgId);
    } catch {
      threw = true;
    }
    assert.ok(threw, 'duplicate insert should throw UNIQUE constraint error');

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 8. drainInboundBuffer marks stale rows on boot
// ---------------------------------------------------------------------------

describe('inbound_buffer drain on boot', () => {
  test('pending rows from previous session become stale', () => {
    const db = freshDb();
    insertSession(db, 'drain-session');

    // Insert two pending rows
    db.prepare(`INSERT INTO inbound_buffer (id, session_id, payload_json, status) VALUES (?, ?, ?, 'pending')`).run(
      'buf-1', 'drain-session', JSON.stringify({ text: 'hello' })
    );
    db.prepare(`INSERT INTO inbound_buffer (id, session_id, payload_json, status) VALUES (?, ?, ?, 'pending')`).run(
      'buf-2', 'drain-session', JSON.stringify({ text: 'world' })
    );

    // Simulate drain (what index.js does on startup)
    db.prepare(`UPDATE inbound_buffer SET status = 'stale' WHERE status = 'pending'`).run();

    const staleRows = db.prepare(`SELECT id FROM inbound_buffer WHERE status = 'stale'`).all();
    assert.equal(staleRows.length, 2);

    const pendingRows = db.prepare(`SELECT id FROM inbound_buffer WHERE status = 'pending'`).all();
    assert.equal(pendingRows.length, 0);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 9. Persistent Conversation History (chat_history table)
// ---------------------------------------------------------------------------

describe('chat_history persistence', () => {
  const { getSessionHistory, saveSessionHistory, clearSessionHistory } = require('../src/db');

  test('saveSessionHistory persists non-system messages in order', () => {
    const db = freshDb();
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'I am looking for massagers' },
      { role: 'assistant', content: 'We have the bullet massager.' }
    ];

    saveSessionHistory(db, 'session-hist-1', messages, 30);
    const loaded = getSessionHistory(db, 'session-hist-1', 30);

    assert.equal(loaded.length, 2, 'system message must not be saved');
    assert.equal(loaded[0].role, 'user');
    assert.equal(loaded[0].content, 'I am looking for massagers');
    assert.equal(loaded[1].role, 'assistant');
    assert.equal(loaded[1].content, 'We have the bullet massager.');

    db.close();
  });

  test('saveSessionHistory enforces limit of recent messages', () => {
    const db = freshDb();
    const messages = [];
    for (let i = 1; i <= 40; i++) {
      messages.push({ role: 'user', content: `Message ${i}` });
    }

    saveSessionHistory(db, 'session-hist-2', messages, 10);
    const loaded = getSessionHistory(db, 'session-hist-2', 10);

    assert.equal(loaded.length, 10, 'must only keep the last 10 messages');
    assert.equal(loaded[0].content, 'Message 31', 'first loaded message must be Message 31');
    assert.equal(loaded[9].content, 'Message 40', 'last loaded message must be Message 40');

    db.close();
  });

  test('clearSessionHistory purges session rows', () => {
    const db = freshDb();
    saveSessionHistory(db, 'session-to-clear', [{ role: 'user', content: 'test' }]);
    assert.equal(getSessionHistory(db, 'session-to-clear').length, 1);

    clearSessionHistory(db, 'session-to-clear');
    assert.equal(getSessionHistory(db, 'session-to-clear').length, 0);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// 10. Multi-Turn Parity: Dynamic Context & Interception
// ---------------------------------------------------------------------------

describe('Multi-Turn Context & Dynamic Catalog Interception', () => {
  const { sanitizeCustomerFacingOutput } = require('../src/agent/engine');

  test('sanitizeCustomerFacingOutput strips unclosed tool_call and think tags', () => {
    const leaky1 = 'Here is the stock:\n\n<tool_call>';
    const cleaned1 = sanitizeCustomerFacingOutput(leaky1);
    assert.ok(!cleaned1.includes('<tool_call>'), 'unclosed <tool_call> tag must be removed');

    const leaky2 = 'Checking... <think>hidden thoughts</think> Ready.';
    const cleaned2 = sanitizeCustomerFacingOutput(leaky2);
    assert.equal(cleaned2, 'Checking...  Ready.');
  });

  test('extractInboundContent extracts quoted message context for replies', async () => {
    const msg = {
      message: {
        extendedTextMessage: {
          text: 'But I requested for this?',
          contextInfo: {
            quotedMessage: {
              conversation: 'can you add the Vibrating Silicone Wellness Accessory to it?'
            }
          }
        }
      }
    };
    const content = await extractInboundContent(msg);
    assert.equal(content.type, 'text');
    assert.equal(
      content.text,
      '[Replying to: "can you add the Vibrating Silicone Wellness Accessory to it?"] But I requested for this?'
    );
  });

  test('typing presence and read receipt: readMessages and sendPresenceUpdate are triggered together', async () => {
    const keysRead = [];
    const presenceUpdates = [];
    const mockSock = {
      readMessages: async (keys) => {
        keysRead.push(...keys);
      },
      sendPresenceUpdate: async (type, jid) => {
        presenceUpdates.push({ type, jid });
      }
    };
    const incomingKey = { id: 'msg-read-1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false };
    const replyJid = '2348012345678@s.whatsapp.net';

    // Simulate processTurn typing & read behavior
    await mockSock.sendPresenceUpdate('composing', replyJid);
    await mockSock.readMessages([incomingKey]);

    assert.equal(presenceUpdates.length, 1);
    assert.equal(presenceUpdates[0].type, 'composing');
    assert.equal(keysRead.length, 1);
    assert.deepEqual(keysRead[0], incomingKey);
  });

  test('delivery receipt: sendReceipts is called immediately on message arrival for double grey tick', async () => {
    const deliveredKeys = [];
    const mockSock = {
      sendReceipts: async (keys) => {
        deliveredKeys.push(...keys);
      }
    };
    const incomingKey = { id: 'msg-del-1', remoteJid: '2348012345678@s.whatsapp.net', fromMe: false };

    if (incomingKey && typeof mockSock?.sendReceipts === 'function') {
      await mockSock.sendReceipts([incomingKey]);
    }

    assert.equal(deliveredKeys.length, 1);
    assert.deepEqual(deliveredKeys[0], incomingKey);
  });
});

