function createDebouncer({ quietMs = 8000, maxWaitMs = 15000, onFlush, onError = console.error }) {
  if (typeof onFlush !== 'function') throw new TypeError('onFlush must be a function');
  if (quietMs < 1 || maxWaitMs < quietMs) throw new RangeError('maxWaitMs must be at least quietMs');

  const buffers = new Map();

  function flush(key) {
    const buffer = buffers.get(key);
    if (!buffer) return;
    buffers.delete(key);
    clearTimeout(buffer.quietTimer);
    clearTimeout(buffer.maxTimer);

    try {
      onFlush(key, buffer.messages);
    } catch (error) {
      onError(error, key);
    }
  }

  function push(key, message) {
    let buffer = buffers.get(key);
    if (!buffer) {
      buffer = { messages: [], quietTimer: null, maxTimer: null };
      buffer.maxTimer = setTimeout(() => flush(key), maxWaitMs);
      buffers.set(key, buffer);
    }

    buffer.messages.push(message);
    clearTimeout(buffer.quietTimer);
    buffer.quietTimer = setTimeout(() => flush(key), quietMs);
  }

  function close() {
    for (const key of buffers.keys()) flush(key);
  }

  return { push, flush, close, pendingCount: () => buffers.size };
}

module.exports = { createDebouncer };