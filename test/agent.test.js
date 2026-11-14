const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const { seedTemporaryData } = require('../src/seed');
const { getSystemPrompt } = require('../src/agent/prompt');
const { getToolDefinitions } = require('../src/agent/tools');
const { runAgentTurn, parseToolArguments, sanitizeCustomerFacingOutput } = require('../src/agent/engine');
const {
  dispatchTextTurn,
  dispatchAudioTurn,
  dispatchImageTurn,
  UNCLEAR_AUDIO_MESSAGE
} = require('../src/agent/dispatcher');
const { parseMediaCommand } = require('../scripts/simulate-chat');

function createInMemoryTestDb() {
  const db = openDatabase(':memory:');
  seedTemporaryData(db);
  return db;
}

function createMockFetch(responses) {
  let callIndex = 0;
  const requests = [];

  const mockFn = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });

    const currentResponse = responses[callIndex];
    callIndex += 1;

    if (!currentResponse) {
      throw new Error(`Unexpected mock call ${callIndex}`);
    }

    if (currentResponse instanceof Error) {
      throw currentResponse;
    }

    if (currentResponse.status && currentResponse.status !== 200) {
      return {
        ok: false,
        status: currentResponse.status,
        text: async () => currentResponse.body || 'Error',
        json: async () => ({ error: currentResponse.body })
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: currentResponse.message
          }
        ]
      })
    };
  };

  mockFn.requests = requests;
  return mockFn;
}

test('prompt and tools export valid operational definitions', () => {
  const prompt = getSystemPrompt();
  assert.match(prompt, /Kikky Luxury Femcare/);
  assert.match(prompt, /Shop 32A Akure/);
  assert.match(prompt, /5140099034/);
  assert.match(prompt, /Moniepoint/);

  const tools = getToolDefinitions();
  assert.equal(tools.length, 6);
  const toolNames = tools.map(t => t.function.name).sort();
  assert.deepEqual(toolNames, [
    'calculate_shipping',
    'check_store_hours',
    'escalate_to_human',
    'get_product_details',
    'record_waitlist_request',
    'search_catalog'
  ]);
});

test('parseToolArguments handles strings, objects, and malformed JSON safely', () => {
  assert.deepEqual(parseToolArguments('{"query":"vibe"}'), { query: 'vibe' });
  assert.deepEqual(parseToolArguments({ query: 'vibe' }), { query: 'vibe' });
  assert.deepEqual(parseToolArguments(''), {});
  const malformed = parseToolArguments('{bad_json:');
  assert.ok(malformed._parse_error);
});

test('agent runs ReAct loop, executes search_catalog tool, and returns final reply', async () => {
  const db = createInMemoryTestDb();

  const mockFetch = createMockFetch([
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: {
              name: 'search_catalog',
              arguments: JSON.stringify({ query: 'rose' })
            }
          }
        ]
      }
    },
    {
      message: {
        role: 'assistant',
        content: 'Good afternoon ma. We have the Rose Flower Sucker in stock for 28,000 NGN at Shop 32A Akure Mall.',
        tool_calls: null
      }
    }
  ]);

  const result = await runAgentTurn({
    messages: [{ role: 'user', content: 'Do you have rose sucker?' }],
    db,
    options: {
      apiKey: 'test-key',
      fetchClient: mockFetch,
      debug: false
    }
  });

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].tool, 'search_catalog');
  assert.equal(result.steps[0].input.query, 'rose');
  assert.equal(result.steps[0].output.ok, true);
  assert.equal(result.escalated, false);
  assert.match(result.reply, /Rose Flower Sucker/);

  assert.equal(result.messages.length, 5);
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[1].role, 'user');
  assert.equal(result.messages[2].role, 'assistant');
  assert.equal(result.messages[3].role, 'tool');
  assert.equal(result.messages[3].tool_call_id, 'call_123');
  assert.equal(result.messages[4].role, 'assistant');

  db.close();
});

test('agent handles parallel tool calls in a single assistant turn', async () => {
  const db = createInMemoryTestDb();

  const mockFetch = createMockFetch([
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_search',
            type: 'function',
            function: {
              name: 'search_catalog',
              arguments: JSON.stringify({ query: 'vibrator' })
            }
          },
          {
            id: 'call_ship',
            type: 'function',
            function: {
              name: 'calculate_shipping',
              arguments: JSON.stringify({ state: 'Ondo', city: 'Akure' })
            }
          }
        ]
      }
    },
    {
      message: {
        role: 'assistant',
        content: 'Good evening ma, we have vibrators in stock and delivery within Akure is 1,500 NGN.',
        tool_calls: null
      }
    }
  ]);

  const result = await runAgentTurn({
    messages: [{ role: 'user', content: 'Vibrator price and shipping to Akure?' }],
    db,
    options: {
      apiKey: 'test-key',
      fetchClient: mockFetch
    }
  });

  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].tool, 'search_catalog');
  assert.equal(result.steps[1].tool, 'calculate_shipping');
  assert.equal(result.messages.filter(m => m.role === 'tool').length, 2);
  assert.match(result.reply, /1,500 NGN/);

  db.close();
});

test('agent feeds tool error back to model for self-correction without crashing', async () => {
  const db = createInMemoryTestDb();

  const mockFetch = createMockFetch([
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_err',
            type: 'function',
            function: {
              name: 'calculate_shipping',
              arguments: JSON.stringify({})
            }
          }
        ]
      }
    },
    {
      message: {
        role: 'assistant',
        content: 'Good day ma. Which state or city are you located in so I can check the delivery rate for you?',
        tool_calls: null
      }
    }
  ]);

  const result = await runAgentTurn({
    messages: [{ role: 'user', content: 'How much is delivery?' }],
    db,
    options: {
      apiKey: 'test-key',
      fetchClient: mockFetch
    }
  });

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].output.ok, false);
  assert.match(result.steps[0].output.error, /Invalid arguments/);
  assert.match(result.reply, /Which state/);

  db.close();
});

test('agent loop bounds terminate at MAX_STEPS = 3 with forced final completion', async () => {
  const db = createInMemoryTestDb();

  const mockFetch = createMockFetch([
    {
      message: {
        role: 'assistant',
        tool_calls: [{ id: 'c1', function: { name: 'search_catalog', arguments: '{"query":"toy"}' } }]
      }
    },
    {
      message: {
        role: 'assistant',
        tool_calls: [{ id: 'c2', function: { name: 'search_catalog', arguments: '{"query":"lube"}' } }]
      }
    },
    {
      message: {
        role: 'assistant',
        tool_calls: [{ id: 'c3', function: { name: 'search_catalog', arguments: '{"query":"oil"}' } }]
      }
    },
    {
      message: {
        role: 'assistant',
        content: 'Good day ma, here are the options available in our store.',
        tool_calls: null
      }
    }
  ]);

  const result = await runAgentTurn({
    messages: [{ role: 'user', content: 'What do you have?' }],
    db,
    options: {
      apiKey: 'test-key',
      maxSteps: 3,
      fetchClient: mockFetch
    }
  });

  assert.equal(result.steps.length, 3);
  assert.equal(result.reply, 'Good day ma, here are the options available in our store.');

  const finalRequest = mockFetch.requests[3];
  assert.equal(finalRequest.body.tool_choice, 'none');

  db.close();
});

test('escalate_to_human sets escalated flag to true', async () => {
  const db = createInMemoryTestDb();

  const mockFetch = createMockFetch([
    {
      message: {
        role: 'assistant',
        tool_calls: [
          {
            id: 'esc_1',
            function: {
              name: 'escalate_to_human',
              arguments: JSON.stringify({
                reason: 'medical_ingestible_request',
                customer_summary: 'Customer wants oral pills'
              })
            }
          }
        ]
      }
    },
    {
      message: {
        role: 'assistant',
        content: 'Ma, we only carry topical massage oils. I have notified our senior manager to attend to you.',
        tool_calls: null
      }
    }
  ]);

  const result = await runAgentTurn({
    messages: [{ role: 'user', content: 'Do you have breast boost pills to swallow?' }],
    db,
    options: {
      apiKey: 'test-key',
      fetchClient: mockFetch
    }
  });

  assert.equal(result.escalated, true);
  assert.equal(result.steps[0].tool, 'escalate_to_human');
  assert.equal(result.steps[0].output.ok, true);

  db.close();
});

test('dispatchTextTurn rejects empty input without calling LLM', async () => {
  const result = await dispatchTextTurn({ text: '   ' });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'empty_text');
});

test('dispatchAudioTurn returns UNCLEAR_AUDIO_MESSAGE on audio quality error without silent crash', async () => {
  const mockTranscriber = async () => ({
    ok: false,
    error: 'Audio buffer is smaller than 1024 bytes'
  });

  const result = await dispatchAudioTurn({
    audioBuffer: Buffer.from('too small'),
    transcriberFn: mockTranscriber
  });

  assert.equal(result.ok, true);
  assert.equal(result.reply, UNCLEAR_AUDIO_MESSAGE);
  assert.equal(result.transcription_status, 'unclear_audio');
});

test('dispatchAudioTurn returns infrastructure error when transcriber fails with 500 or timeout', async () => {
  const mockTranscriber = async () => ({
    ok: false,
    error: 'Transcription failed: HTTP 500 Internal Server Error'
  });

  const result = await dispatchAudioTurn({
    audioBuffer: Buffer.alloc(2000),
    transcriberFn: mockTranscriber
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'transcription_infrastructure_failure');
  assert.match(result.error, /HTTP 500/);
});

test('dispatchImageTurn translates product_screenshot keywords and receipts into agent prompt', async () => {
  const db = createInMemoryTestDb();

  const mockVisionProduct = async () => ({
    ok: true,
    data: {
      type: 'product_screenshot',
      keywords: ['rose sucker', 'clit stimulator']
    }
  });

  const mockFetchProduct = createMockFetch([
    {
      message: {
        role: 'assistant',
        content: 'Good day ma, we have the rose sucker in stock for 28,000 NGN.',
        tool_calls: null
      }
    }
  ]);

  const productResult = await dispatchImageTurn({
    imageBuffer: Buffer.alloc(100),
    db,
    visionFn: mockVisionProduct,
    options: { apiKey: 'test', fetchClient: mockFetchProduct }
  });

  assert.equal(productResult.ok, true);
  assert.match(mockFetchProduct.requests[0].body.messages[1].content, /Customer sent an image of an item with keywords: rose sucker, clit stimulator/);

  // Test Payment Receipt
  const mockVisionReceipt = async () => ({
    ok: true,
    data: {
      type: 'payment_receipt',
      amount: 30000,
      bank: 'Moniepoint',
      sender: 'Kikelomo Ajayi',
      date: '2026-11-13',
      confidence: 0.98,
      verified: false
    }
  });

  const mockFetchReceipt = createMockFetch([
    {
      message: {
        role: 'assistant',
        content: 'Payment received ma! Please send your delivery address and phone number for dispatch.',
        tool_calls: null
      }
    }
  ]);

  const receiptResult = await dispatchImageTurn({
    imageBuffer: Buffer.alloc(100),
    db,
    visionFn: mockVisionReceipt,
    options: { apiKey: 'test', fetchClient: mockFetchReceipt }
  });

  assert.equal(receiptResult.ok, true);
  assert.match(mockFetchReceipt.requests[0].body.messages[1].content, /bank transfer receipt showing amount: 30000, bank: Moniepoint/);

  // Test Product Screenshot with Caption
  const mockFetchWithCaption = createMockFetch([
    {
      message: {
        role: 'assistant',
        content: 'Sold out ma, we only have 7-inch variants currently.',
        tool_calls: null
      }
    }
  ]);

  const captionResult = await dispatchImageTurn({
    imageBuffer: Buffer.alloc(100),
    caption: 'Do you have the 8 inches from this dildo?',
    db,
    visionFn: mockVisionProduct,
    options: { apiKey: 'test', fetchClient: mockFetchWithCaption }
  });

  assert.equal(captionResult.ok, true);
  assert.match(
    mockFetchWithCaption.requests[0].body.messages[1].content,
    /Customer message: "Do you have the 8 inches from this dildo\?"/
  );

  db.close();
});

test('parseMediaCommand handles various path and caption formats', () => {
  const p1 = parseMediaCommand('/image /path/dildo_variants.png. Do you have the 8 inches from this dildo?', '/image');
  assert.equal(p1.filePath, '/path/dildo_variants.png');
  assert.equal(p1.caption, 'Do you have the 8 inches from this dildo?');

  const p2 = parseMediaCommand('/image /path/dildo_variants.png . Do you have the 8 inches from this dildo?', '/image');
  assert.equal(p2.filePath, '/path/dildo_variants.png');
  assert.equal(p2.caption, 'Do you have the 8 inches from this dildo?');

  const p3 = parseMediaCommand('Do you have the 8 inches from this dildo? /image /path/dildo_variants.png', '/image');
  assert.equal(p3.filePath, '/path/dildo_variants.png');
  assert.equal(p3.caption, 'Do you have the 8 inches from this dildo?');

  const p4 = parseMediaCommand('/image "/path with spaces/pic.png" please confirm price', '/image');
  assert.equal(p4.filePath, '/path with spaces/pic.png');
  assert.equal(p4.caption, 'please confirm price');

  const p5 = parseMediaCommand('/voice voice.opus check this', '/voice');
  assert.equal(p5.filePath, 'voice.opus');
  assert.equal(p5.caption, 'check this');
});

test('all generated text formats prices with ₦ and never contains ₹', async () => {
  const db = createInMemoryTestDb();

  // Test sanitizer directly
  const rawLeak = 'The price is ₹46,000 and ₹5,000 for lube.';
  const sanitized = sanitizeCustomerFacingOutput(rawLeak);
  assert.equal(sanitized.includes('₹'), false);
  assert.equal(sanitized.includes('₦46,000'), true);

  // Test full agent turn
  const mockFetch = createMockFetch([
    {
      message: {
        role: 'assistant',
        content: 'The Rose Massager is ₹30,000. Would you like to order?',
        tool_calls: null
      }
    }
  ]);

  const result = await runAgentTurn({
    messages: [{ role: 'user', content: 'how much is the rose?' }],
    db,
    options: { apiKey: 'test', fetchClient: mockFetch }
  });

  assert.equal(result.reply.includes('₹'), false);
  assert.match(result.reply, /₦30,000/);
  assert.equal(result.replies.some(r => r.includes('₹')), false);

  db.close();
});

test('when user asks for shipping to Ibadan, agent emits calculate_shipping tool call before replying', async () => {
  const db = createInMemoryTestDb();

  const mockFetch = createMockFetch([
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_ship_ibadan',
            type: 'function',
            function: {
              name: 'calculate_shipping',
              arguments: JSON.stringify({ state: 'Oyo', city: 'Ibadan' })
            }
          }
        ]
      }
    },
    {
      message: {
        role: 'assistant',
        content: 'Delivery to Ibadan, Oyo State is ₦3,500 via commercial transit (2-3 days).',
        tool_calls: null
      }
    }
  ]);

  const result = await runAgentTurn({
    messages: [{ role: 'user', content: 'How much to ship to Ibadan?' }],
    db,
    options: { apiKey: 'test', fetchClient: mockFetch }
  });

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].tool, 'calculate_shipping');
  assert.equal(result.steps[0].output.ok, true);
  assert.equal(result.steps[0].output.delivery.fee, 3500);
  assert.match(result.reply, /₦3,500/);
  assert.equal(result.reply.includes('₹'), false);

  db.close();
});

test('when user tries to negotiate price, agent holds retail_price firm and does not invent free delivery', async () => {
  const db = createInMemoryTestDb();

  const prompt = getSystemPrompt();
  assert.match(prompt, /BAN INVENTED DISCOUNTS & "SPLIT ORDERS"/);
  assert.match(prompt, /NEVER HALLUCINATE SHIPPING/);

  const mockFetch = createMockFetch([
    {
      message: {
        role: 'assistant',
        content: '🏃‍♀️🏃‍♀️ ₦46,000 is a good price.\n\nOur prices are firm, and we do not offer free shipping.',
        tool_calls: null
      }
    }
  ]);

  const result = await runAgentTurn({
    messages: [
      { role: 'user', content: 'can you make it 30k and free delivery?' }
    ],
    db,
    options: { apiKey: 'test', fetchClient: mockFetch }
  });

  assert.match(result.reply, /₦46,000/);
  assert.doesNotMatch(result.reply, /free delivery/i);
  assert.doesNotMatch(result.reply, /₹/);
  assert.equal(result.escalated, false);

  db.close();
});
