const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDebouncer } = require('../src/debounce');

test('debouncer combines messages per user after the quiet window', async () => {
  const flushed = [];
  const debouncer = createDebouncer({
    quietMs: 20,
    maxWaitMs: 80,
    onFlush: (key, messages) => flushed.push({ key, messages })
  });

  debouncer.push('user-a', 'Hi');
  debouncer.push('user-a', 'Do you have the gel?');
  await new Promise(resolve => setTimeout(resolve, 35));

  assert.deepEqual(flushed, [{ key: 'user-a', messages: ['Hi', 'Do you have the gel?'] }]);
  assert.equal(debouncer.pendingCount(), 0);
  debouncer.close();
});

test('maximum wait flushes a continuously active buffer', async () => {
  const flushed = [];
  const debouncer = createDebouncer({
    quietMs: 40,
    maxWaitMs: 65,
    onFlush: (key, messages) => flushed.push({ key, messages })
  });

  debouncer.push('user-b', 'one');
  const interval = setInterval(() => debouncer.push('user-b', 'more'), 15);
  await new Promise(resolve => setTimeout(resolve, 80));
  clearInterval(interval);

  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].key, 'user-b');
  assert.ok(flushed[0].messages.length >= 2);
  debouncer.close();
});