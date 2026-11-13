const { randomUUID } = require('node:crypto');

const STRING_FIELDS = new Set([
  'component',
  'stage',
  'outcome',
  'result_type',
  'provider',
  'tool',
  'error_code',
  'fallback_reason',
  'detected_language'
]);
const NUMBER_FIELDS = new Set([
  'duration_ms',
  'bytes',
  'width',
  'height',
  'http_status',
  'confidence',
  'keyword_count',
  'transcript_chars',
  'result_count',
  'field_count',
  'audio_duration_seconds'
]);
const BOOLEAN_FIELDS = new Set(['bbox_valid', 'authenticated']);
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createRequestId() {
  return randomUUID();
}

function cleanString(value) {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 80);
  return /^[a-zA-Z0-9._:-]+$/.test(cleaned) ? cleaned : undefined;
}

function logEvent(event, fields = {}, sink) {
  if (!/^[a-z][a-z0-9._-]{0,79}$/.test(event)) return;
  if (!sink && (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT)) return;

  const entry = {
    timestamp: new Date().toISOString(),
    event
  };

  for (const [key, value] of Object.entries(fields)) {
    if (key === 'request_id' && typeof value === 'string' && REQUEST_ID_PATTERN.test(value)) {
      entry.request_id = value;
    } else if (STRING_FIELDS.has(key)) {
      const safeValue = cleanString(value);
      if (safeValue !== undefined) entry[key] = safeValue;
    } else if (NUMBER_FIELDS.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      entry[key] = Math.max(0, Math.min(value, 1_000_000_000));
    } else if (BOOLEAN_FIELDS.has(key) && typeof value === 'boolean') {
      entry[key] = value;
    }
  }

  try {
    (sink ?? console.log)(JSON.stringify(entry));
  } catch {
    // Logging failures must not break the operation being observed.
  }
}

module.exports = { createRequestId, logEvent };