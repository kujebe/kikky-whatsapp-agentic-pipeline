const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRequestId, logEvent } = require('../src/logger');
const { openDatabase } = require('../src/db');
const { seedTemporaryData } = require('../src/seed');
const { createTools } = require('../src/tools');

function captureLogs() {
  const lines = [];
  return { lines, sink: line => lines.push(JSON.parse(line)) };
}

test('structured logger drops arbitrary and sensitive fields', () => {
  const { lines, sink } = captureLogs();
  const requestId = createRequestId();
  logEvent('media.request.completed', {
    request_id: requestId,
    component: 'vision',
    outcome: 'success',
    duration_ms: 12.5,
    transcript: 'private customer message',
    image_base64: 'private image data',
    api_key: 'private secret',
    prompt: 'private prompt',
    amount: 45000
  }, sink);

  assert.equal(lines.length, 1);
  assert.equal(lines[0].request_id, requestId);
  assert.equal(lines[0].duration_ms, 12.5);
  assert.equal(JSON.stringify(lines[0]).includes('private'), false);
  assert.equal('amount' in lines[0], false);
});

test('tool logs record safe call metadata but not argument or result content', () => {
  const db = openDatabase(':memory:');
  seedTemporaryData(db);
  const { lines, sink } = captureLogs();
  const tools = createTools(db, { emit: (event, fields) => logEvent(event, fields, sink) });

  const result = tools.escalate_to_human({
    reason: 'sensitive_reason',
    customer_summary: 'private customer summary'
  });

  assert.equal(result.ok, true);
  assert.deepEqual(lines.map(line => line.event), ['tool.call.started', 'tool.call.completed']);
  assert.equal(lines[0].tool, 'escalate_to_human');
  assert.equal(lines[0].field_count, 2);
  assert.equal(JSON.stringify(lines).includes('sensitive_reason'), false);
  assert.equal(JSON.stringify(lines).includes('private customer summary'), false);
  db.close();
});
