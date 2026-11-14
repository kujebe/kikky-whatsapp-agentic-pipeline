const { createRequestId, logEvent } = require('../logger');

const GROQ_TRANSCRIPTION_URL = process.env.GROQ_TRANSCRIPTION_URL || 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_PROMPT = process.env.TRANSCRIPTION_CONTEXT_PROMPT || 'Customer voice note at Kikky adult store in Akure. Inquiries about personal massagers, clit lickers, rose suckers, vibrators, lubricants, wellness accessories, delivery, and Moniepoint payments.';
const MIN_AUDIO_BYTES = 1024;
const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXTENSION = {
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  webm: 'audio/webm',
  flac: 'audio/flac',
  mp4: 'audio/mp4',
  mpeg: 'audio/mpeg',
  mpga: 'audio/mpeg'
};

function decodeAudio(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input !== 'string') throw new TypeError('Audio must be a Buffer or base64 string');

  const dataUriMatch = input.match(/^data:audio\/[^;,]+;base64,(.*)$/is);
  const encoded = (dataUriMatch ? dataUriMatch[1] : input).replace(/\s/g, '');
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new TypeError('Audio base64 is malformed');
  }
  return Buffer.from(encoded, 'base64');
}

function hasExpectedSignature(audio, extension) {
  switch (extension) {
    case 'ogg':
    case 'opus':
      return audio.subarray(0, 4).toString('ascii') === 'OggS';
    case 'wav':
      return audio.subarray(0, 4).toString('ascii') === 'RIFF'
        && audio.subarray(8, 12).toString('ascii') === 'WAVE';
    case 'flac':
      return audio.subarray(0, 4).toString('ascii') === 'fLaC';
    case 'webm':
      return audio.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    case 'mp4':
    case 'm4a':
      return audio.subarray(4, 8).toString('ascii') === 'ftyp';
    case 'mp3':
    case 'mpeg':
    case 'mpga':
      return audio.subarray(0, 3).toString('ascii') === 'ID3'
        || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0);
    default:
      return false;
  }
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function transcribeAudioInternal(input, options = {}) {
  const maxBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
  if (typeof input === 'string') {
    const dataUriMatch = input.match(/^data:audio\/[^;,]+;base64,(.*)$/is);
    const encodedLength = (dataUriMatch ? dataUriMatch[1] : input).replace(/\s/g, '').length;
    if (encodedLength > Math.ceil(maxBytes * 4 / 3) + 8) {
      return { ok: false, error: `Transcription failed: audio exceeds the ${maxBytes}-byte local limit` };
    }
  }

  let audio;
  try {
    audio = decodeAudio(input);
  } catch (error) {
    return { ok: false, error: `Transcription failed: ${error.message}` };
  }

  if (audio.length < MIN_AUDIO_BYTES) {
    return { ok: false, error: 'Transcription failed: audio buffer must be at least 1 KB' };
  }

  if (audio.length > maxBytes) {
    return { ok: false, error: `Transcription failed: audio exceeds the ${maxBytes}-byte local limit` };
  }

  const apiKey = options.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) return { ok: false, error: 'Transcription failed: GROQ_API_KEY is not configured' };

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'Transcription failed: fetch is not available in this Node.js runtime' };
  }

  const filename = options.filename ?? 'voice.ogg';
  const extension = filename.split('.').pop().toLowerCase();
  const mimeType = options.mimeType ?? MIME_BY_EXTENSION[extension];
  if (!mimeType || !MIME_BY_EXTENSION[extension]) {
    return { ok: false, error: 'Transcription failed: unsupported audio file type' };
  }
  if (!hasExpectedSignature(audio, extension)) {
    return { ok: false, error: `Transcription failed: audio data does not match .${extension} format` };
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  const emit = options.logEvent ?? logEvent;

  try {
    const isDebug = Boolean(options.debug);
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mimeType }), filename);
    form.append('model', options.model ?? 'whisper-large-v3');
    form.append('prompt', options.prompt ?? DEFAULT_PROMPT);
    const language = options.language ?? 'en';
    if (language) {
      form.append('language', language);
    }
    form.append('response_format', isDebug ? 'verbose_json' : 'json');

    emit('provider.request.started', {
      request_id: options.requestId,
      component: 'audio',
      stage: 'groq_transcription',
      provider: 'groq'
    });
    const response = await fetchImpl(options.endpoint ?? GROQ_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal
    });
    emit('provider.request.completed', {
      request_id: options.requestId,
      component: 'audio',
      stage: 'groq_transcription',
      provider: 'groq',
      http_status: response.status,
      duration_ms: performance.now() - startedAt
    });
    const payload = await responseJson(response);

    if (!response.ok) {
      const reason = payload?.error?.message || payload?.error || `Groq returned HTTP ${response.status}`;
      return { ok: false, error: `Transcription failed: ${String(reason).slice(0, 300)}` };
    }
    if (typeof payload?.text !== 'string' || payload.text.trim().length === 0) {
      return { ok: false, error: 'Transcription failed: Groq returned an invalid response' };
    }

    const text = payload.text.trim();
    if (!isDebug) {
      return { ok: true, text };
    }

    const segments = Array.isArray(payload.segments) ? payload.segments : [];
    const validLogprobs = segments
      .map(s => s.avg_logprob)
      .filter(lp => typeof lp === 'number' && Number.isFinite(lp));
    const validNoSpeech = segments
      .map(s => s.no_speech_prob)
      .filter(nsp => typeof nsp === 'number' && Number.isFinite(nsp));

    const avgLogprob = validLogprobs.length > 0
      ? Number((validLogprobs.reduce((sum, v) => sum + v, 0) / validLogprobs.length).toFixed(3))
      : null;
    const maxNoSpeechProb = validNoSpeech.length > 0
      ? Number(Math.max(...validNoSpeech).toFixed(4))
      : null;

    const debug = {
      model: options.model ?? 'whisper-large-v3',
      audio_duration_seconds: typeof payload.duration === 'number' ? Number(payload.duration.toFixed(2)) : null,
      detected_language: typeof payload.language === 'string' ? payload.language : null,
      avg_logprob: avgLogprob,
      no_speech_prob: maxNoSpeechProb,
      segments_count: segments.length,
      segments: segments.map(s => ({
        id: s.id,
        start: s.start != null ? Number(s.start.toFixed(2)) : undefined,
        end: s.end != null ? Number(s.end.toFixed(2)) : undefined,
        text: typeof s.text === 'string' ? s.text.trim() : '',
        avg_logprob: typeof s.avg_logprob === 'number' ? Number(s.avg_logprob.toFixed(3)) : undefined
      }))
    };

    return { ok: true, text, debug };
  } catch (error) {
    const reason = controller.signal.aborted ? 'request timed out' : (error?.message || 'network error');
    emit('provider.request.failed', {
      request_id: options.requestId,
      component: 'audio',
      stage: 'groq_transcription',
      provider: 'groq',
      error_code: controller.signal.aborted ? 'timeout' : 'network_error',
      duration_ms: performance.now() - startedAt
    });
    return { ok: false, error: `Transcription failed: ${String(reason).slice(0, 200)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeAudio(input, options = {}) {
  const requestId = options.requestId ?? createRequestId();
  const emit = options.logEvent ?? logEvent;
  const startedAt = performance.now();
  const byteCount = Buffer.isBuffer(input)
    ? input.length
    : typeof input === 'string'
      ? Math.floor(input.length * 3 / 4)
      : 0;

  emit('media.request.started', {
    request_id: requestId,
    component: 'audio',
    stage: 'transcription',
    bytes: byteCount
  });

  const result = await transcribeAudioInternal(input, { ...options, requestId, logEvent: emit });
  emit('media.request.completed', {
    request_id: requestId,
    component: 'audio',
    stage: 'transcription',
    outcome: result.ok ? 'success' : 'error',
    duration_ms: performance.now() - startedAt,
    transcript_chars: result.ok ? result.text.length : undefined,
    audio_duration_seconds: result.ok && result.debug ? result.debug.audio_duration_seconds : undefined,
    avg_logprob: result.ok && result.debug ? result.debug.avg_logprob : undefined,
    detected_language: result.ok && result.debug ? result.debug.detected_language : undefined,
    error_code: result.ok ? undefined : 'transcription_failed'
  });
  return result;
}

module.exports = {
  DEFAULT_MAX_AUDIO_BYTES,
  DEFAULT_PROMPT,
  GROQ_TRANSCRIPTION_URL,
  MIN_AUDIO_BYTES,
  transcribeAudio
};