const { z } = require('zod');
const { createRequestId, logEvent } = require('../logger');

const productSchema = z.object({
  type: z.literal('product_screenshot'),
  keywords: z.array(z.string().trim().min(1).max(60)).min(1).max(12),
  confidence: z.number().min(0).max(1).optional()
}).strict();

const receiptSchema = z.object({
  type: z.literal('payment_receipt'),
  amount: z.number().nonnegative().nullable(),
  bank: z.string().max(120).nullable(),
  sender: z.string().max(160).nullable(),
  date: z.string().max(80).nullable(),
  confidence: z.number().min(0).max(1),
  verified: z.literal(false)
}).strict();

const generalSchema = z.object({ type: z.literal('general_media') }).strict();
const debugPassSchema = z.object({
  keys: z.array(z.string().max(60)).max(32),
  type: z.string().max(80).optional(),
  confidence: z.number().min(0).max(1).optional(),
  confidence_type: z.string().max(40).optional(),
  bbox_field: z.string().max(60).optional(),
  bbox_value_type: z.string().max(40).optional(),
  bbox_value_keys: z.array(z.string().max(60)).max(16).optional(),
  bbox: z.array(z.number()).length(4).optional(),
  product_field: z.string().max(60).optional(),
  product_value: z.unknown().optional(),
  keywords: z.array(z.string().max(60)).max(8).optional(),
  values_redacted: z.literal(true).optional()
}).strict();
const debugSchema = z.object({
  first_pass: debugPassSchema,
  second_pass: debugPassSchema.optional()
}).strict();
const classificationSchema = z.discriminatedUnion('type', [productSchema, receiptSchema, generalSchema]);
const MIN_IMAGE_BYTES = 8;
const DEFAULT_MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;

async function classifyImageInternal(input, options = {}) {
  if (!Buffer.isBuffer(input) || input.length < MIN_IMAGE_BYTES) {
    return { ok: false, error: 'Vision classification failed: image buffer is empty or invalid' };
  }
  const maxBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  if (input.length > maxBytes) {
    return { ok: false, error: `Vision classification failed: image exceeds the ${maxBytes}-byte local limit` };
  }

  const endpoint = options.endpoint ?? process.env.MODAL_VISION_URL;
  if (!endpoint) return { ok: false, error: 'Vision classification failed: MODAL_VISION_URL is not configured' };

  const tokenId = options.tokenId ?? process.env.MODAL_VISION_TOKEN_ID;
  const tokenSecret = options.tokenSecret ?? process.env.MODAL_VISION_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) {
    return { ok: false, error: 'Vision classification failed: Modal proxy token is not configured' };
  }

  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
    if (parsedEndpoint.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsedEndpoint.hostname)) {
      return { ok: false, error: 'Vision classification failed: endpoint must use HTTPS' };
    }
  } catch {
    return { ok: false, error: 'Vision classification failed: MODAL_VISION_URL is invalid' };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'Vision classification failed: fetch is not available in this Node.js runtime' };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? (Number(process.env.MODAL_VISION_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const startedAt = performance.now();
    const emit = options.logEvent ?? logEvent;
    emit('provider.request.started', {
      request_id: options.requestId,
      component: 'vision',
      stage: 'modal_classification',
      provider: 'modal'
    });
    const response = await fetchImpl(parsedEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Modal-Key': tokenId,
        'Modal-Secret': tokenSecret
      },
      body: JSON.stringify({
        request_id: options.requestId,
        image_base64: input.toString('base64'),
        debug: options.debug === true
      }),
      signal: controller.signal
    });
    emit('provider.request.completed', {
      request_id: options.requestId,
      component: 'vision',
      stage: 'modal_classification',
      provider: 'modal',
      http_status: response.status,
      duration_ms: performance.now() - startedAt
    });

    let payload;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, error: 'Vision classification failed: endpoint returned invalid JSON' };
    }

    if (!response.ok) {
      return { ok: false, error: `Vision classification failed: endpoint returned HTTP ${response.status}` };
    }
    if (payload?.ok !== true) {
      const errorMsg = typeof payload?.error === 'string' ? payload.error : 'Vision classification failed';
      if (options.debug === true && payload?.debug !== undefined) {
        const debug = debugSchema.safeParse(payload.debug);
        if (debug.success) {
          return { ok: false, error: errorMsg, debug: debug.data };
        }
      }
      return { ok: false, error: errorMsg };
    }

    const parsed = classificationSchema.safeParse(payload.data);
    if (!parsed.success) {
      return { ok: false, error: 'Vision classification failed: endpoint response did not match the expected schema' };
    }
    if (options.debug === true && payload.debug !== undefined) {
      const debug = debugSchema.safeParse(payload.debug);
      if (!debug.success) {
        return { ok: false, error: 'Vision classification failed: debug response did not match the expected schema' };
      }
      return { ok: true, data: parsed.data, debug: debug.data };
    }
    return { ok: true, data: parsed.data };
  } catch (error) {
    (options.logEvent ?? logEvent)('provider.request.failed', {
      request_id: options.requestId,
      component: 'vision',
      stage: 'modal_classification',
      provider: 'modal',
      error_code: timedOut || error?.name === 'AbortError' ? 'timeout' : 'network_error'
    });
    if (timedOut || error?.name === 'AbortError') {
      return { ok: false, error: 'Vision classification timed out' };
    }
    return { ok: false, error: 'Vision classification failed: endpoint unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

async function classifyImage(input, options = {}) {
  const requestId = options.requestId ?? createRequestId();
  const emit = options.logEvent ?? logEvent;
  const startedAt = performance.now();
  const byteCount = Buffer.isBuffer(input) ? input.length : 0;
  emit('media.request.started', {
    request_id: requestId,
    component: 'vision',
    stage: 'classification',
    bytes: byteCount
  });

  const result = await classifyImageInternal(input, { ...options, requestId, logEvent: emit });
  emit('media.request.completed', {
    request_id: requestId,
    component: 'vision',
    stage: 'classification',
    outcome: result.ok ? 'success' : 'error',
    result_type: result.ok ? result.data.type : undefined,
    duration_ms: performance.now() - startedAt,
    error_code: result.ok ? undefined : 'classification_failed'
  });
  return result;
}

module.exports = { DEFAULT_TIMEOUT_MS, classifyImage, classificationSchema };