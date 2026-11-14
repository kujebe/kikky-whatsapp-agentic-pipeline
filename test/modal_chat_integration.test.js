const test = require('node:test');
const assert = require('node:assert/strict');
const { requestChatCompletion, runAgentTurn } = require('../src/agent/engine');
const { openDatabase } = require('../src/db');
const { seedTemporaryData } = require('../src/seed');

test('engine resolves chat endpoints correctly across providers and modal', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'test response' } }]
      })
    };
  };

  // 1. Modal URL without /v1
  await requestChatCompletion({
    baseUrl: 'https://user--kikky-chat-server-chat-api.us-east.modal.run',
    apiKey: 'modal',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    messages: [{ role: 'user', content: 'hi' }],
    timeoutMs: 5000,
    fetchClient: fakeFetch
  });
  assert.equal(calls[0].url, 'https://user--kikky-chat-server-chat-api.us-east.modal.run/v1/chat/completions');

  // 2. Standard URL with /v1
  await requestChatCompletion({
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'gsk-test',
    model: 'openai/gpt-oss-120b',
    messages: [{ role: 'user', content: 'hi' }],
    timeoutMs: 5000,
    fetchClient: fakeFetch
  });
  assert.equal(calls[1].url, 'https://api.groq.com/openai/v1/chat/completions');
});

test('engine passes Modal proxy authentication headers when configured', async () => {
  const previousTokenId = process.env.MODAL_LLM_TOKEN_ID;
  const previousTokenSecret = process.env.MODAL_LLM_TOKEN_SECRET;

  process.env.MODAL_LLM_TOKEN_ID = 'test-token-id-123';
  process.env.MODAL_LLM_TOKEN_SECRET = 'test-token-secret-456';

  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'hello' } }]
      })
    };
  };

  try {
    await requestChatCompletion({
      baseUrl: 'https://user--kikky-vllm-agent-serve.modal.run/v1',
      apiKey: 'modal',
      model: 'Qwen/Qwen2.5-7B-Instruct',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 5000,
      fetchClient: fakeFetch
    });

    assert.equal(calls[0].options.headers['Modal-Key'], 'test-token-id-123');
    assert.equal(calls[0].options.headers['Modal-Secret'], 'test-token-secret-456');
    assert.equal(calls[0].options.headers['Authorization'], 'Bearer modal');
  } finally {
    if (previousTokenId) process.env.MODAL_LLM_TOKEN_ID = previousTokenId;
    else delete process.env.MODAL_LLM_TOKEN_ID;

    if (previousTokenSecret) process.env.MODAL_LLM_TOKEN_SECRET = previousTokenSecret;
    else delete process.env.MODAL_LLM_TOKEN_SECRET;
  }
});

test('engine retries on 429 rate limit errors with backoff and succeeds', async () => {
  let attempts = 0;
  const fakeFetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: (h) => (h === 'retry-after' ? '0.05' : null) },
        text: async () => JSON.stringify({ error: { message: 'Rate limit reached. Please try again in 50ms.' } })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'Recovered after rate limit!' } }]
      })
    };
  };

  const response = await requestChatCompletion({
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'test-key',
    model: 'openai/gpt-oss-120b',
    messages: [{ role: 'user', content: 'hello' }],
    timeoutMs: 5000,
    fetchClient: fakeFetch,
    maxRetries: 2
  });

  assert.equal(attempts, 2);
  assert.equal(response.content, 'Recovered after rate limit!');
});
