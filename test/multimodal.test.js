const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DEFAULT_PROMPT, transcribeAudio } = require('../src/media/transcriber');
const { classifyImage } = require('../src/media/vision');
const { createRequestId, logEvent } = require('../src/logger');

const audioFixture = Buffer.alloc(2048, 1);
audioFixture.write('OggS', 0, 'ascii');
const imageFixture = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const visionOptions = {
  endpoint: 'https://vision.example.test/classify',
  tokenId: 'test-token-id',
  tokenSecret: 'test-token-secret'
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('transcriber rejects empty and undersized audio without a network call', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return jsonResponse({ text: 'should not run' });
  };

  assert.equal((await transcribeAudio(Buffer.alloc(0), { apiKey: 'test', fetchImpl })).ok, false);
  assert.equal((await transcribeAudio(Buffer.alloc(1023), { apiKey: 'test', fetchImpl })).ok, false);
  assert.equal(fetchCalls, 0);
});

test('transcriber rejects malformed base64 and enforces a local size cap', async () => {
  const malformed = await transcribeAudio('%%%not-base64%%%', { apiKey: 'test' });
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /base64 is malformed/);

  const tooLarge = await transcribeAudio(audioFixture, {
    apiKey: 'test',
    maxAudioBytes: 1024,
    fetchImpl: async () => jsonResponse({ text: 'not called' })
  });
  assert.equal(tooLarge.ok, false);
  assert.match(tooLarge.error, /local limit/);

  let fetchCalls = 0;
  const oversizedBase64 = await transcribeAudio('A'.repeat(4096), {
    apiKey: 'test',
    maxAudioBytes: 1024,
    fetchImpl: async () => {
      fetchCalls++;
      return jsonResponse({ text: 'not called' });
    }
  });
  assert.equal(oversizedBase64.ok, false);
  assert.match(oversizedBase64.error, /local limit/);
  assert.equal(fetchCalls, 0);
});

test('transcriber rejects data that does not match the declared container', async () => {
  const result = await transcribeAudio(Buffer.alloc(2048, 1), {
    apiKey: 'test',
    filename: 'voice.ogg',
    fetchImpl: async () => { throw new Error('fetch should not run'); }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /does not match \.ogg format/);
});

test('transcriber sends OGG multipart data and returns a valid transcript', async () => {
  let request;
  const result = await transcribeAudio(audioFixture, {
    apiKey: 'test-api-key',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return jsonResponse({ text: 'How much is the rose massager?' });
    }
  });

  assert.deepEqual(result, { ok: true, text: 'How much is the rose massager?' });
  assert.match(request.url, /audio\/transcriptions$/);
  assert.equal(request.init.headers.Authorization, 'Bearer test-api-key');
  assert.equal(request.init.body.get('model'), 'whisper-large-v3');
  assert.equal(request.init.body.get('prompt'), DEFAULT_PROMPT);
  assert.equal(request.init.body.get('language'), 'en');
  assert.equal(request.init.body.get('response_format'), 'json');
  assert.equal(request.init.body.get('file').name, 'voice.ogg');
  assert.equal(request.init.body.get('file').type, 'audio/ogg');
});

test('transcriber debug is opt-in and returns verbose_json audio telemetry', async () => {
  let request;
  const result = await transcribeAudio(audioFixture, {
    apiKey: 'test-api-key',
    debug: true,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return jsonResponse({
        text: 'I have used the licker before so let me try the sucker',
        duration: 22.87,
        language: 'english',
        segments: [
          { id: 0, start: 0.0, end: 5.2, text: 'I have used the licker before', avg_logprob: -0.18, no_speech_prob: 0.02 },
          { id: 1, start: 5.2, end: 10.4, text: 'so let me try the sucker', avg_logprob: -0.22, no_speech_prob: 0.04 }
        ]
      });
    }
  });

  assert.equal(request.init.body.get('response_format'), 'verbose_json');
  assert.equal(request.init.body.get('language'), 'en');
  assert.equal(result.ok, true);
  assert.equal(result.text, 'I have used the licker before so let me try the sucker');
  assert.equal(result.debug.model, 'whisper-large-v3');
  assert.equal(result.debug.audio_duration_seconds, 22.87);
  assert.equal(result.debug.detected_language, 'english');
  assert.equal(result.debug.avg_logprob, -0.2);
  assert.equal(result.debug.no_speech_prob, 0.04);
  assert.equal(result.debug.segments_count, 2);
  assert.equal(result.debug.segments.length, 2);
  assert.equal(result.debug.segments[0].text, 'I have used the licker before');
});

test('transcriber returns structured errors for missing keys, provider failures, and malformed responses', async () => {
  const missingKey = await transcribeAudio(audioFixture, { apiKey: '' });
  assert.equal(missingKey.ok, false);
  assert.match(missingKey.error, /GROQ_API_KEY/);

  const providerError = await transcribeAudio(audioFixture, {
    apiKey: 'test',
    fetchImpl: async () => jsonResponse({ error: { message: 'rate limited' } }, 429)
  });
  assert.equal(providerError.ok, false);
  assert.match(providerError.error, /rate limited/);

  const malformedResponse = await transcribeAudio(audioFixture, {
    apiKey: 'test',
    fetchImpl: async () => jsonResponse({ unexpected: true })
  });
  assert.equal(malformedResponse.ok, false);
  assert.match(malformedResponse.error, /invalid response/);
});

test('transcriber converts a provider timeout into a structured error', async () => {
  const result = await transcribeAudio(audioFixture, {
    apiKey: 'test',
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
});

test('media client logs correlate stages without recording transcript or image content', async () => {
  const requestId = createRequestId();
  const lines = [];
  const emit = (event, fields) => logEvent(event, fields, line => lines.push(JSON.parse(line)));

  const audioResult = await transcribeAudio(audioFixture, {
    apiKey: 'secret-test-key',
    requestId,
    logEvent: emit,
    fetchImpl: async () => jsonResponse({ text: 'private transcript content' })
  });
  assert.equal(audioResult.ok, true);

  const imageResult = await classifyImage(imageFixture, {
    ...visionOptions,
    requestId,
    logEvent: emit,
    fetchImpl: async () => jsonResponse({ ok: true, data: { type: 'product_screenshot', keywords: ['private product keyword'] } })
  });
  assert.equal(imageResult.ok, true);

  assert.ok(lines.some(line => line.event === 'provider.request.started' && line.provider === 'groq'));
  assert.ok(lines.some(line => line.event === 'provider.request.started' && line.provider === 'modal'));
  assert.ok(lines.every(line => line.request_id === requestId));
  const serialized = JSON.stringify(lines);
  assert.equal(serialized.includes('private transcript content'), false);
  assert.equal(serialized.includes('private product keyword'), false);
  assert.equal(serialized.includes('secret-test-key'), false);
  assert.equal(serialized.includes(imageFixture.toString('base64')), false);
});

test('transcriber debug logs safe audio telemetry without recording transcript text', async () => {
  const requestId = createRequestId();
  const lines = [];
  const emit = (event, fields) => logEvent(event, fields, line => lines.push(JSON.parse(line)));

  const audioResult = await transcribeAudio(audioFixture, {
    apiKey: 'secret-test-key',
    requestId,
    debug: true,
    logEvent: emit,
    fetchImpl: async () => jsonResponse({
      text: 'private audio transcript',
      duration: 15.2,
      language: 'english',
      segments: [{ id: 0, start: 0, end: 15.2, text: 'private audio transcript', avg_logprob: -0.19, no_speech_prob: 0.03 }]
    })
  });

  assert.equal(audioResult.ok, true);
  const completed = lines.find(line => line.event === 'media.request.completed' && line.component === 'audio');
  assert.ok(completed);
  assert.equal(completed.audio_duration_seconds, 15.2);
  assert.equal(completed.detected_language, 'english');
  const serialized = JSON.stringify(lines);
  assert.equal(serialized.includes('private audio transcript'), false);
});

test('vision client rejects invalid images and missing configuration without network calls', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return jsonResponse({ ok: true, data: { type: 'general_media' } });
  };

  assert.equal((await classifyImage(Buffer.alloc(0), { ...visionOptions, fetchImpl })).ok, false);
  assert.equal((await classifyImage(imageFixture, {
    endpoint: '',
    tokenId: visionOptions.tokenId,
    tokenSecret: visionOptions.tokenSecret,
    fetchImpl
  })).ok, false);
  assert.equal(fetchCalls, 0);
});

test('vision client sends authenticated image data and validates a classification', async () => {
  let request;
  const result = await classifyImage(imageFixture, {
    ...visionOptions,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return jsonResponse({
        ok: true,
        data: { type: 'product_screenshot', keywords: ['rose', 'massager'], confidence: 0.91 }
      });
    }
  });

  assert.deepEqual(result, {
    ok: true,
    data: { type: 'product_screenshot', keywords: ['rose', 'massager'], confidence: 0.91 }
  });
  assert.equal(request.init.headers['Modal-Key'], 'test-token-id');
  assert.equal(request.init.headers['Modal-Secret'], 'test-token-secret');
  assert.equal(JSON.parse(request.init.body).image_base64, imageFixture.toString('base64'));
  assert.equal(JSON.parse(request.init.body).debug, false);
});

test('vision debug is opt-in and returns the safe first and second pass summaries', async () => {
  let request;
  const result = await classifyImage(imageFixture, {
    ...visionOptions,
    debug: true,
    fetchImpl: async (_url, init) => {
      request = init;
      return jsonResponse({
        ok: true,
        data: { type: 'product_screenshot', keywords: ['rose', 'massager'], confidence: 0.9 },
        debug: {
          first_pass: {
            keys: ['type', 'product', 'bbox', 'confidence'],
            type: 'product_screenshot',
            confidence: 0.9,
            bbox_field: 'bbox',
            bbox: [120, 400, 460, 850],
            product_field: 'physical_intimate_product',
            product_value: { description: 'rose-shaped massager' }
          },
          second_pass: {
            keys: ['keywords'],
            keywords: ['rose', 'massager']
          }
        }
      });
    }
  });

  assert.equal(JSON.parse(request.body).debug, true);
  assert.equal(result.ok, true);
  assert.equal(result.debug.first_pass.bbox_field, 'bbox');
  assert.equal(result.debug.first_pass.product_value.description, 'rose-shaped massager');
  assert.deepEqual(result.debug.second_pass.keywords, ['rose', 'massager']);
});

test('vision debug never returns receipt field values', async () => {
  const result = await classifyImage(imageFixture, {
    ...visionOptions,
    debug: true,
    fetchImpl: async () => jsonResponse({
      ok: true,
      data: {
        type: 'payment_receipt',
        amount: 35000,
        bank: 'Example Bank',
        sender: 'Private Customer Name',
        date: '13 November 2026',
        confidence: 0.8,
        verified: false
      },
      debug: {
        first_pass: {
          keys: ['type', 'amount', 'bank', 'sender', 'date', 'confidence'],
          type: 'payment_receipt',
          confidence: 0.8,
          values_redacted: true
        }
      }
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.debug.first_pass.values_redacted, true);
  assert.equal(JSON.stringify(result.debug).includes('Private Customer Name'), false);
  assert.equal(JSON.stringify(result.debug).includes('Example Bank'), false);
});

test('vision client validates receipt candidates and rejects malformed classifications', async () => {
  const receipt = await classifyImage(imageFixture, {
    ...visionOptions,
    fetchImpl: async () => jsonResponse({
      ok: true,
      data: {
        type: 'payment_receipt',
        amount: 35000,
        bank: 'Moniepoint',
        sender: null,
        date: null,
        confidence: 0.7,
        verified: false
      }
    })
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.data.verified, false);

  const malformed = await classifyImage(imageFixture, {
    ...visionOptions,
    fetchImpl: async () => jsonResponse({ ok: true, data: { type: 'payment_receipt', amount: '35000' } })
  });
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /expected schema/);
});

test('vision client handles endpoint errors, invalid JSON, network errors, and timeouts', async () => {
  const endpointError = await classifyImage(imageFixture, {
    ...visionOptions,
    fetchImpl: async () => jsonResponse({ error: 'unauthorized' }, 401)
  });
  assert.equal(endpointError.ok, false);
  assert.match(endpointError.error, /HTTP 401/);

  const invalidJson = await classifyImage(imageFixture, {
    ...visionOptions,
    fetchImpl: async () => new Response('not json')
  });
  assert.equal(invalidJson.ok, false);
  assert.match(invalidJson.error, /invalid JSON/);

  const networkError = await classifyImage(imageFixture, {
    ...visionOptions,
    fetchImpl: async () => { throw new Error('network is down'); }
  });
  assert.equal(networkError.ok, false);
  assert.match(networkError.error, /endpoint unavailable/);

  const timeout = await classifyImage(imageFixture, {
    ...visionOptions,
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })
  });
  assert.deepEqual(timeout, { ok: false, error: 'Vision classification timed out' });
});