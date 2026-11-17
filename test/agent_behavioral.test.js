const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { openDatabase } = require('../src/db');
const { seedTemporaryData } = require('../src/seed');
const { createTools } = require('../src/tools');
const {
  runAgentTurn,
  extractFallbackToolCalls,
  sanitizeCustomerFacingOutput,
  formatWhatsAppReplies,
  extractLocationFromText,
  extractProductFromText,
  findProductAndLocation
} = require('../src/agent/engine');
const { extractSessionInferences } = require('../src/agent/session');
const { getSystemPrompt } = require('../src/agent/prompt');

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

test('agent handles Sunday inquiry by calling check_store_hours and reporting closed', async () => {
  let callCount = 0;
  const mockFetch = async (url, opts) => {
    callCount += 1;
    const body = JSON.parse(opts.body);

    if (callCount === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{
                id: 'call_hours_1',
                type: 'function',
                function: {
                  name: 'check_store_hours',
                  arguments: JSON.stringify({ day: 'Sunday' })
                }
              }]
            }
          }]
        })
      };
    }

    // Step 2: Final reply based on tool output
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: 'We are closed on Sundays at our shop in Akure Mall.\n\nLet me know if you would like to arrange a delivery instead!'
          }
        }]
      })
    };
  };

  const result = await runAgentTurn({
    messages: [{ role: 'user', content: 'Do you open on Sunday?' }],
    db,
    toolsInstance: tools,
    options: {
      apiKey: 'test-key',
      fetchClient: mockFetch
    }
  });

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].tool, 'check_store_hours');
  assert.equal(result.steps[0].output.is_open, false);
  assert.match(result.reply, /closed on Sundays/i);
});

test('agent handles out-of-stock item with waitlist pre-order tool execution', async () => {
  let callCount = 0;
  const mockFetch = async (url, opts) => {
    callCount += 1;
    if (callCount === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{
                id: 'call_search_1',
                type: 'function',
                function: {
                  name: 'search_catalog',
                  arguments: JSON.stringify({ query: '5 inch manual dildo' })
                }
              }]
            }
          }]
        })
      };
    }

    if (callCount === 2) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{
                id: 'call_waitlist_1',
                type: 'function',
                function: {
                  name: 'record_waitlist_request',
                  arguments: JSON.stringify({
                    customer_contact: '08098765432',
                    requested_item: 'Classic Manual Silicone Accessory',
                    specifications: '5 inches'
                  })
                }
              }]
            }
          }]
        })
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: 'The manual 5-inch is currently sold out, but I have noted down your contact.\n\nWe will alert you as soon as the restock lands next week!'
          }
        }]
      })
    };
  };

  const result = await runAgentTurn({
    messages: [
      { role: 'user', content: 'I want a 5 inch manual dildo. My number is 08098765432' }
    ],
    db,
    toolsInstance: tools,
    options: {
      apiKey: 'test-key',
      fetchClient: mockFetch
    }
  });

  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].tool, 'search_catalog');
  assert.equal(result.steps[1].tool, 'record_waitlist_request');
  assert.equal(result.steps[1].output.ok, true);
  assert.match(result.reply, /sold out/i);
  assert.match(result.reply, /restock/i);
});

test('agent practices active listening on Phase 1 incident story without premature price push', async () => {
  const mockFetch = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: 'That must be so stressful!\n\nWhat happened after?'
          }
        }]
      })
    };
  };

  const result = await runAgentTurn({
    messages: [
      { role: 'user', content: 'My girl left her rose in my hotel room on Friday, someone picked it up without telling me' }
    ],
    db,
    toolsInstance: tools,
    options: {
      apiKey: 'test-key',
      fetchClient: mockFetch
    }
  });

  assert.equal(result.steps.length, 0); // No premature tool call/checkout forced
  assert.match(result.reply, /stressful/i);
  assert.doesNotMatch(result.reply, /lost and found/i);
});

test('agent welcomes cross-sell inquiry and does not dismiss buy intent when customer asks for another product', async () => {
  let callCount = 0;
  const mockFetch = async (url, opts) => {
    callCount += 1;
    if (callCount === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{
                id: 'call_dildo_search',
                type: 'function',
                function: {
                  name: 'search_catalog',
                  arguments: JSON.stringify({ query: 'dildo' })
                }
              }]
            }
          }]
        })
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: 'Yes, we have dildos too!\n\nManual dildo is ₦22,500 and vibrating is ₦46,000.\n\nWould you like to add one to the card game?'
          }
        }]
      })
    };
  };

  const result = await runAgentTurn({
    messages: [
      { role: 'user', content: 'show me the couples card game' },
      { role: 'assistant', content: 'Couples cards are ₦10,000.' },
      { role: 'user', content: 'got dildos?' }
    ],
    db,
    toolsInstance: tools,
    options: {
      apiKey: 'test-key',
      fetchClient: mockFetch
    }
  });

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].tool, 'search_catalog');
  assert.match(result.reply, /dildo/i);
  assert.doesNotMatch(result.reply, /stick with/i); // Never dismiss buy intent!
});

test('agent recognizes pidgin agreement oya na as affirmative consent to proceed', async () => {
  const mockFetch = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: 'Sharp! We have vibrators, dildos, card games, and lubes.\n\nWhich one would you like to see first?'
          }
        }]
      })
    };
  };

  const result = await runAgentTurn({
    messages: [
      { role: 'user', content: 'what toys do you have?' },
      { role: 'assistant', content: 'We have some great toys and lubes here. Should I show you?' },
      { role: 'user', content: 'oya na' }
    ],
    db,
    toolsInstance: tools,
    options: {
      apiKey: 'test-key',
      fetchClient: mockFetch
    }
  });

  assert.doesNotMatch(result.reply, /no pressure/i); // Does not misinterpret 'oya na' as rejection!
  assert.match(result.reply, /vibrators|dildos|sharp/i);
});

test('agent executes commercial rescue when customer states replacement urgency and respects male gender', async () => {
  let callCount = 0;
  const mockFetch = async (url, opts) => {
    callCount += 1;
    if (callCount === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{
                id: 'call_rose_search',
                type: 'function',
                function: {
                  name: 'search_catalog',
                  arguments: JSON.stringify({ query: 'rose toy' })
                }
              }]
            }
          }]
        })
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: 'No problem sir, we have the Rose suction massager available for ₦30,000.\n\nSend your hotel address and our rider will deliver to you in 10 to 30 minutes!'
          }
        }]
      })
    };
  };

  const result = await runAgentTurn({
    messages: [
      { role: 'user', content: 'mama' },
      { role: 'assistant', content: 'Good evening! Welcome to Kikky Luxury Femcare.' },
      { role: 'user', content: 'My girl is coming today and will kill me if her rose is not found, I had to get a new one' }
    ],
    db,
    toolsInstance: tools,
    options: {
      apiKey: 'test-key',
      session: { gender: 'male', order_stage: 'browsing' },
      fetchClient: mockFetch
    }
  });

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].tool, 'search_catalog');
  assert.match(result.reply, /Rose/i);
  assert.match(result.reply, /30,000/);
  assert.match(result.reply, /rider/i);
  assert.doesNotMatch(result.reply, /\bma\b/i); // Must not address male customer as 'ma'
  assert.doesNotMatch(result.reply, /lost and found/i);
});

test('agent handles soft discount inquiry with warm firm price without running emojis or corporate promotion slop', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          role: 'assistant',
          content: 'That is the best price for both items.\n\n35,000 last.'
        }
      }]
    })
  });

  const result = await runAgentTurn({
    messages: [
      { role: 'user', content: 'ok, add am and cal my money' },
      { role: 'assistant', content: 'Adding Couples Cards and Rose Massager. Total is 35,000 NGN.' },
      { role: 'user', content: 'any discount?' }
    ],
    db,
    toolsInstance: tools,
    options: {
      apiKey: 'test-key',
      fetchClient: mockFetch
    }
  });

  assert.doesNotMatch(result.reply, /🏃/);
  assert.doesNotMatch(result.reply, /promotion/i);
  assert.doesNotMatch(result.reply, /campaign/i);
  assert.match(result.reply, /35,000/);
});

test('agent handles cart hesitation on "no" with order splitting or walk-in invitation without closing goodbye', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          role: 'assistant',
          content: 'No problem at all! You can start with just one item first, or you can come to Shop 32A Justrite in Akure Mall to check them out.'
        }
      }]
    })
  });

  const result = await runAgentTurn({
    messages: [
      { role: 'user', content: 'any discount?' },
      { role: 'assistant', content: 'That is the best price, 35,000 last.' },
      { role: 'user', content: 'no' }
    ],
    db,
    toolsInstance: tools,
    options: {
      apiKey: 'test-key',
      session: { order_stage: 'negotiating', active_cart_json: '{"items":["cards","rose"]}' },
      fetchClient: mockFetch
    }
  });

  assert.doesNotMatch(result.reply, /have a (great|nice) day/i);
  assert.doesNotMatch(result.reply, /feel free to reach out/i);
  assert.match(result.reply, /(start with just one|Shop 32A|Justrite|store)/i);
});

test('extractFallbackToolCalls parses [TOOL_CALLS] with unescaped quotes', () => {
  const raw = '[TOOL_CALLS][{"name": "search_catalog", "arguments": "{\"query\": \"vibrator\", \"max_price\": 20000}"}]';
  const result = extractFallbackToolCalls(raw);
  assert.ok(result.calls);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].function.name, 'search_catalog');
  assert.match(result.calls[0].function.arguments, /vibrator/);
});

test('sanitizeCustomerFacingOutput strips tool tags and bare JSON from user reply', () => {
  const inputWithTags = 'Here is your item! [TOOL_CALLS][{"name": "search_catalog", "arguments": {}}]';
  assert.equal(sanitizeCustomerFacingOutput(inputWithTags), 'Here is your item!');

  const inputBareJson = '[{"name": "search_catalog", "arguments": {"query": "rose"}}]';
  assert.equal(sanitizeCustomerFacingOutput(inputBareJson), 'Let me check that for you right away.');

  const inputPureTags = '[TOOL_CALLS][{"name": "check_store_hours", "arguments": {}}]';
  assert.equal(sanitizeCustomerFacingOutput(inputPureTags), 'Let me check that for you right away.');
});

test('runAgentTurn intercepts leaked [TOOL_CALLS] in content, executes tool, and never exposes raw syntax', async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: '[TOOL_CALLS][{"name": "search_catalog", "arguments": "{\"query\": \"vibrator\", \"max_price\": 20000}"}]',
              tool_calls: null
            }
          }]
        })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: 'We have the Compact Bullet Massager for ₦17,000 available in stock.'
          }
        }]
      })
    };
  };

  const result = await runAgentTurn({
    messages: [{ role: 'user', content: 'got anything under 20k?' }],
    db,
    toolsInstance: tools,
    options: {
      apiKey: 'test-key',
      fetchClient: mockFetch
    }
  });

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].tool, 'search_catalog');
  assert.doesNotMatch(result.reply, /\[TOOL_CALLS\]/);
  assert.doesNotMatch(result.reply, /arguments/);
  assert.doesNotMatch(result.reply, /\{/);
  assert.match(result.reply, /17,000/);
});

test('prompt contains forbidden endearments, forbidden helpdesk scripts, and companion lubricant rules', () => {
  const prompt = getSystemPrompt();
  assert.match(prompt, /FORBIDDEN ENDEARMENTS/);
  assert.match(prompt, /FORBIDDEN HELPDESK SCRIPTS/);
  assert.match(prompt, /PLAYFUL PERSUASION/);
  assert.match(prompt, /COMPANION PRODUCT PAIRING/);
});

test('prompt contains no canned price traps, hardcoded numbers, or rigid script quotes', () => {
  const prompt = getSystemPrompt();
  // Ensure the model is not anchored to 46,000 or 35,000 in prompt text
  assert.doesNotMatch(prompt, /46,000/, 'Prompt must not contain hardcoded ₦46,000 anchor');
  assert.doesNotMatch(prompt, /35,000/, 'Prompt must not contain hardcoded ₦35,000 anchor');
  assert.doesNotMatch(prompt, /"No vex jare 😄"/, 'Prompt must not contain rigid canned quotes');
  assert.doesNotMatch(prompt, /"🏃‍♀️🏃‍♀️/, 'Prompt must not contain canned deflection scripts');
});

test('dynamic database product and location resolution works at runtime without code changes', () => {
  // Insert a new dynamic product into SQLite
  db.prepare(`
    INSERT INTO products (id, name, category, description, usage_summary, retail_price, min_price, stock_quantity, search_tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('lotus-vibrator-99', 'Lotus Flower Massager', 'toys', 'Dynamic luxury massager', 'Apply and enjoy', 42000, 40000, 5, 'lotus flower floral suction pink');

  // Insert a new dynamic delivery destination into SQLite
  db.prepare(`
    INSERT INTO deliveries (state, city, fee, estimated_days)
    VALUES (?, ?, ?, ?)
  `).run('Ekiti', 'Ado-Ekiti', 2500, '1-2 days');

  // Verify dynamic location extraction
  const loc = extractLocationFromText('I need delivery to Ado-Ekiti please', db);
  assert.ok(loc, 'Should find dynamic location from deliveries table');
  assert.equal(loc.state, 'Ekiti');
  assert.equal(loc.city, 'Ado-Ekiti');

  // Verify dynamic product extraction
  const prodId = extractProductFromText('I want the lotus flower', db);
  assert.equal(prodId, 'lotus-vibrator-99', 'Should dynamically resolve product from products table');

  // Verify combined findProductAndLocation
  const found = findProductAndLocation([
    { role: 'user', content: 'I want to buy the lotus flower to Ado-Ekiti' }
  ], null, db);
  assert.equal(found.productId, 'lotus-vibrator-99');
  assert.equal(found.location.state, 'Ekiti');
  assert.equal(found.location.city, 'Ado-Ekiti');
});

test('expanded gender and kinship cues infer correct relational gender', () => {
  const baseSession = { gender: 'unknown', referral_source: null, order_stage: 'browsing' };

  // Male speaker referencing female partner
  const maleInf1 = extractSessionInferences(baseSession, 'Buying this for my wifey');
  assert.equal(maleInf1.gender, 'male');

  const maleInf2 = extractSessionInferences(baseSession, 'Deliver this to my woman in Akure');
  assert.equal(maleInf2.gender, 'male');

  // Female speaker referencing male partner or honorific
  const femaleInf1 = extractSessionInferences(baseSession, 'My hubby asked me to check this out');
  assert.equal(femaleInf1.gender, 'female');

  const femaleInf2 = extractSessionInferences(baseSession, 'Call me madam please');
  assert.equal(femaleInf2.gender, 'female');
});
