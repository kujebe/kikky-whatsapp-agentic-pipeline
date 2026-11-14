const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { openDatabase } = require('../src/db');
const { seedTemporaryData } = require('../src/seed');
const { createTools } = require('../src/tools');
const { checkStoreHours } = require('../src/tools/store_hours');
const { recordWaitlistRequest } = require('../src/tools/waitlist');
const { getOrCreateSession, updateSession, extractSessionInferences } = require('../src/agent/session');
const { getSystemPrompt, formatWatTime } = require('../src/agent/prompt');
const { formatWhatsAppReplies, runAgentTurn } = require('../src/agent/engine');
const { dispatchTextTurn } = require('../src/agent/dispatcher');

let db;
let tools;

before(() => {
  db = openDatabase(':memory:');
  seedTemporaryData(db);
  tools = createTools(db);
});

after(() => {
  db.close();
});

test('check_store_hours correctly returns schedule for Monday to Saturday and Sunday', () => {
  const monday = tools.check_store_hours({ day: 'Monday' });
  assert.equal(monday.ok, true);
  assert.equal(monday.day, 'Monday');
  assert.equal(monday.is_open, true);
  assert.equal(monday.open_time, '09:00');
  assert.equal(monday.close_time, '19:00');
  assert.match(monday.store_address, /Shop 32A/);

  const sunday = tools.check_store_hours({ day: 'sunday' });
  assert.equal(sunday.ok, true);
  assert.equal(sunday.is_open, false);
  assert.match(sunday.notes, /Closed on Sundays/);

  const unknown = tools.check_store_hours({ day: 'InvalidDay' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /No store hours schedule found/);
});

test('record_waitlist_request safely stores customer pre-order details in SQLite', () => {
  const result = tools.record_waitlist_request({
    customer_contact: '08012345678',
    requested_item: '8 inch black dildo',
    specifications: 'Silicone vibrating',
    deposit_offered: 5000
  });

  assert.equal(result.ok, true);
  assert.ok(result.waitlist_id);
  assert.equal(result.item, '8 inch black dildo');
  assert.equal(result.contact, '08012345678');

  // Verify direct database entry
  const row = db.prepare('SELECT * FROM waitlist WHERE id = ?').get(result.waitlist_id);
  assert.ok(row);
  assert.equal(row.customer_contact, '08012345678');
  assert.equal(row.requested_item, '8 inch black dildo');
  assert.equal(row.deposit_offered, 5000);
  assert.equal(row.status, 'pending');

  // Validation errors
  const missingContact = tools.record_waitlist_request({ requested_item: 'Some item' });
  assert.equal(missingContact.ok, false);
  assert.match(missingContact.error, /contact/i);

  const missingItem = tools.record_waitlist_request({ customer_contact: '08012345678' });
  assert.equal(missingItem.ok, false);
  assert.match(missingItem.error, /item/i);
});

test('sessions table creates, updates, and persists multi-turn context', () => {
  const sessionId = 'test-session-123';
  const session = getOrCreateSession(db, sessionId, {
    referral_source: 'TikTok'
  });

  assert.equal(session.session_id, sessionId);
  assert.equal(session.referral_source, 'TikTok');
  assert.equal(session.order_stage, 'browsing');
  assert.equal(session.gender, 'unknown');

  const updated = updateSession(db, sessionId, {
    gender: 'female',
    order_stage: 'negotiating',
    delivery_state: 'Lagos',
    delivery_city: 'Shomolu',
    price_sensitivity: 'sensitive'
  });

  assert.equal(updated.gender, 'female');
  assert.equal(updated.order_stage, 'negotiating');
  assert.equal(updated.delivery_state, 'Lagos');
  assert.equal(updated.delivery_city, 'Shomolu');
  assert.equal(updated.price_sensitivity, 'sensitive');
});

test('extractSessionInferences detects referral origin, gender cues, and payment transitions', () => {
  const baseSession = {
    gender: 'unknown',
    referral_source: null,
    order_stage: 'browsing',
    customer_phone: null
  };

  const inf1 = extractSessionInferences(baseSession, 'Hello from TikTok, I want to buy a gift for my wife');
  assert.equal(inf1.referral_source, 'TikTok');
  assert.equal(inf1.gender, 'male');

  const inf2 = extractSessionInferences(baseSession, 'My number is 08023456789, deliver to Lagos');
  assert.equal(inf2.customer_phone, '08023456789');

  const inf3 = extractSessionInferences(baseSession, 'Can I get a discount? 5k last', '₦6,500 is the set price');
  assert.equal(inf3.order_stage, 'negotiating');
  assert.equal(inf3.price_sensitivity, 'sensitive');

  const inf4 = extractSessionInferences(baseSession, '[Customer sent a bank transfer receipt showing amount: 12500]', 'Receipt received, thank you!');
  assert.equal(inf4.order_stage, 'paid');

  // Dynamic gender override: previously mistaken 'female' overrides to 'male' on 'my girl'
  const femaleSession = { gender: 'female', referral_source: null, order_stage: 'browsing' };
  const inf5 = extractSessionInferences(femaleSession, 'My girl left her rose in my hotel room at Adwel');
  assert.equal(inf5.gender, 'male');
  assert.equal(inf5.notes, 'urgent_hospitality_location');
});

test('formatWatTime correctly computes West Africa Time and period of day', () => {
  const fixedUtcDate = new Date('2026-11-13T13:30:00Z'); // 13:30 UTC = 14:30 WAT
  const wat = formatWatTime(fixedUtcDate);
  assert.equal(wat.hours, 14);
  assert.equal(wat.periodOfDay, 'Afternoon');
  assert.equal(wat.timeString, '14:30 WAT');
  assert.equal(wat.dayName, 'Friday');
});

test('getSystemPrompt dynamically injects live WAT time and session state', () => {
  const prompt = getSystemPrompt({
    session: {
      gender: 'male',
      order_stage: 'awaiting_payment',
      referral_source: 'TikTok',
      delivery_state: 'Ondo',
      delivery_city: 'Akure'
    },
    timeWat: {
      timeString: '15:00 WAT',
      dayName: 'Friday',
      periodOfDay: 'Afternoon',
      hours: 15
    },
    historyCount: 3
  });

  assert.match(prompt, /Kikky Luxury Femcare/);
  assert.match(prompt, /Friday, 15:00 WAT \(Afternoon\)/);
  assert.match(prompt, /Detected Gender: male/);
  assert.match(prompt, /Order Stage: awaiting_payment/);
  assert.match(prompt, /Referral Source: TikTok/);
  assert.match(prompt, /Delivery Destination: Ondo, Akure/);
  assert.match(prompt, /Existing Turns in Chat: 3/);
  assert.match(prompt, /PRICE SHOCK/i);
  assert.match(prompt, /INVENTORY PRIVACY/i);
  assert.match(prompt, /GENDER/i);
  assert.match(prompt, /STEEP NUMERICAL LOWBALL/);
  assert.match(prompt, /SOFT DISCOUNT INQUIRY/);
  assert.match(prompt, /CART HESITATION RECOVERY/);
  assert.match(prompt, /PAYMENT BEFORE DISPATCH RULE/);
});

test('formatWhatsAppReplies cleanly divides paragraphs into separate chat bubbles', () => {
  const single = 'Good afternoon! Welcome to Kikky Luxury Femcare.';
  assert.deepEqual(formatWhatsAppReplies(single), [single]);

  const multi = 'Good afternoon!\n\nManual Dildo is ₦22,500.\nVibrating is ₦46,000.\n\nWhich one would you like?';
  const bubbles = formatWhatsAppReplies(multi);
  assert.equal(bubbles.length, 3);
  assert.equal(bubbles[0], 'Good afternoon!');
  assert.equal(bubbles[1], 'Manual Dildo is ₦22,500.\nVibrating is ₦46,000.');
  assert.equal(bubbles[2], 'Which one would you like?');
});

test('dispatchTextTurn integrates SQLite session state and returns dual reply outputs', async () => {
  const customFetch = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: 'Good afternoon!\n\nWelcome to Kikky Luxury Femcare. How can I help you today?'
          }
        }]
      })
    };
  };

  const sessionId = 'test-dispatch-session-999';
  const result = await dispatchTextTurn({
    text: 'Hello from TikTok',
    history: [],
    db,
    options: {
      apiKey: 'test-key',
      sessionId,
      fetchClient: customFetch
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.session.session_id, sessionId);
  assert.equal(result.session.referral_source, 'TikTok');
  assert.equal(result.replies.length, 2);
  assert.equal(result.replies[0], 'Good afternoon!');
  assert.match(result.reply, /Welcome to Kikky Luxury Femcare/);

  // Verify session in SQLite
  const saved = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
  assert.ok(saved);
  assert.equal(saved.referral_source, 'TikTok');
});
