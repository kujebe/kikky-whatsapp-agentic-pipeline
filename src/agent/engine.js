const { createTools } = require('../tools');
const { getToolDefinitions } = require('./tools');
const { getSystemPrompt } = require('./prompt');

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'Qwen/Qwen2.5-7B-Instruct';
const DEFAULT_MAX_STEPS = 3;
const DEFAULT_TIMEOUT_MS = 30000;
const TOOL_PENDING_REPLY = 'Let me check that for you right away.';

function resolveChatEndpoint(baseUrl) {
  const trimmed = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

function parseRetryDelayMs(response, errorBody, attempt) {
  const retryHeader = response?.headers?.get ? response.headers.get('retry-after') : null;
  if (retryHeader) {
    const sec = parseFloat(retryHeader);
    if (!isNaN(sec) && sec > 0) return Math.min(Math.round(sec * 1000), 15000);
  }
  if (typeof errorBody === 'string') {
    const match = errorBody.match(/try again in\s+([\d.]+)\s*(s|ms)?/i);
    if (match) {
      const val = parseFloat(match[1]);
      const unit = match[2]?.toLowerCase();
      if (!isNaN(val)) {
        const ms = unit === 'ms' ? val : val * 1000;
        return Math.min(Math.round(ms) + 150, 15000);
      }
    }
  }
  return Math.min(Math.pow(2, attempt) * 500, 8000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseToolArguments(rawArgs) {
  if (typeof rawArgs === 'object' && rawArgs !== null) {
    return rawArgs;
  }
  if (!rawArgs || typeof rawArgs !== 'string') {
    return {};
  }
  try {
    return JSON.parse(rawArgs);
  } catch (error) {
    return { _parse_error: `Failed to parse arguments JSON: ${error.message}`, _raw: rawArgs };
  }
}

async function requestChatCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  toolChoice,
  timeoutMs,
  fetchClient = globalThis.fetch,
  headers: customHeaders = {},
  maxRetries = 2
}) {
  const isModal = baseUrl && baseUrl.includes('modal.run');
  const effectiveKey = apiKey || process.env.LLM_API_KEY || process.env.GROQ_API_KEY || (isModal ? 'modal' : '');
  if (!effectiveKey) {
    throw new Error('LLM API key is required. Set LLM_API_KEY or GROQ_API_KEY.');
  }

  const endpoint = resolveChatEndpoint(baseUrl);
  const bodyPayload = {
    model,
    messages,
    temperature: 0.2
  };

  if (tools && tools.length > 0) {
    bodyPayload.tools = tools;
    if (toolChoice) {
      bodyPayload.tool_choice = toolChoice;
    }
  }

  const requestHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${effectiveKey}`,
    ...customHeaders
  };

  const modalTokenId = process.env.MODAL_LLM_TOKEN_ID || process.env.MODAL_VISION_TOKEN_ID;
  const modalTokenSecret = process.env.MODAL_LLM_TOKEN_SECRET || process.env.MODAL_VISION_TOKEN_SECRET;
  if (modalTokenId && modalTokenSecret) {
    requestHeaders['Modal-Key'] = modalTokenId;
    requestHeaders['Modal-Secret'] = modalTokenSecret;
  }

  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    let errorBody = '';
    try {
      response = await fetchClient(endpoint, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(bodyPayload),
        signal: controller.signal
      });
    } catch (networkError) {
      if (controller.signal.aborted) {
        throw new Error(`LLM request timed out after ${timeoutMs}ms`);
      }
      throw new Error(`LLM network error: ${networkError.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      errorBody = await response.text().catch(() => '');
      if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
        attempt += 1;
        const delayMs = parseRetryDelayMs(response, errorBody, attempt);
        await sleep(delayMs);
        continue;
      }
      throw new Error(`LLM provider error (${response.status}): ${errorBody.slice(0, 300)}`);
    }

    const data = await response.json();
    const choice = data.choices && data.choices[0];
    if (!choice || !choice.message) {
      throw new Error('LLM provider returned empty choices');
    }

    return choice.message;
  }
}

function extractFallbackToolCalls(content = '') {
  if (!content || typeof content !== 'string') {
    return { calls: null, cleanText: '' };
  }

  // 1. Check for [TOOL_CALLS] tag: [TOOL_CALLS] [...]
  const tcMatch = content.match(/\[TOOL_CALLS\]\s*(\[[\s\S]*?\])/);
  if (tcMatch) {
    let jsonStr = tcMatch[1];
    // Fix unescaped quotes in "arguments": "{...}"
    jsonStr = jsonStr.replace(/"arguments":\s*"(\{[\s\S]*?\})"/g, '"arguments": $1');
    try {
      const candidate = JSON.parse(jsonStr);
      if (Array.isArray(candidate) && candidate.length > 0) {
        const calls = candidate
          .filter(c => c && c.name)
          .map((c, idx) => ({
            id: `call_${Date.now()}_${idx}`,
            type: 'function',
            function: {
              name: c.name,
              arguments: typeof c.arguments === 'object' ? JSON.stringify(c.arguments) : String(c.arguments || '{}')
            }
          }));
        if (calls.length > 0) {
          const cleanText = content.replace(/\[TOOL_CALLS\]\s*\[[\s\S]*?\]/g, '').trim();
          return { calls, cleanText };
        }
      }
    } catch (_) {}
  }

  // 2. Check for XML tag: <tool_call>...</tool_call>
  const xmlMatch = content.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  if (xmlMatch) {
    try {
      const candidate = JSON.parse(xmlMatch[1].trim());
      if (candidate && candidate.name) {
        const calls = [{
          id: `call_${Date.now()}_0`,
          type: 'function',
          function: {
            name: candidate.name,
            arguments: typeof candidate.arguments === 'object' ? JSON.stringify(candidate.arguments) : String(candidate.arguments || '{}')
          }
        }];
        const cleanText = content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
        return { calls, cleanText };
      }
    } catch (_) {}
  }

  // 3. Check for bare JSON array: [{"name": "..."}]
  const bareMatch = content.match(/(\[\s*\{[\s\S]*?"name"[\s\S]*?\}\s*\])/);
  if (bareMatch) {
    let jsonStr = bareMatch[1];
    jsonStr = jsonStr.replace(/"arguments":\s*"(\{[\s\S]*?\})"/g, '"arguments": $1');
    try {
      const candidate = JSON.parse(jsonStr);
      if (Array.isArray(candidate) && candidate.length > 0 && candidate.every(c => c && c.name)) {
        const calls = candidate.map((c, idx) => ({
          id: `call_${Date.now()}_${idx}`,
          type: 'function',
          function: {
            name: c.name,
            arguments: typeof c.arguments === 'object' ? JSON.stringify(c.arguments) : String(c.arguments || '{}')
          }
        }));
        const cleanText = (content.slice(0, bareMatch.index) + content.slice(bareMatch.index + bareMatch[0].length)).trim();
        return { calls, cleanText };
      }
    } catch (_) {}
  }

  return { calls: null, cleanText: content };
}

function sanitizeCustomerFacingOutput(rawText = '', options = {}) {
  if (!rawText || typeof rawText !== 'string') {
    return '';
  }

  const hadContent = rawText.trim().length > 0;

  let text = rawText
    // Strip [TOOL_CALLS][...] block — greedy to end of line so the array doesn't linger
    .replace(/\[TOOL_CALLS\]\s*\[[\s\S]*?\]\s*/g, '')
    // Strip any residual bare [TOOL_CALLS] prefix without an array
    .replace(/\[TOOL_CALLS\]/g, '')
    // Strip XML tool call blocks
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    // Strip <think> reasoning blocks
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    // Strip bare JSON tool call arrays [{\"name\":...}]
    .replace(/\[\s*\{[\s\S]*?"name"\s*:[\s\S]*?\}\s*\]/g, '')
    // Strip single-object tool call JSON
    .replace(/\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"[\s\S]*?\}/g, '')
    .trim();

  if (!text && hadContent && options.fallbackIfEmpty !== false) {
    return TOOL_PENDING_REPLY;
  }

  return text;
}

function formatWhatsAppReplies(rawContent = '') {
  const sanitized = sanitizeCustomerFacingOutput(rawContent);
  if (!sanitized) {
    return [];
  }

  const trimmed = sanitized.trim();
  if (!trimmed) {
    return [];
  }

  const paragraphs = trimmed
    .split(/\n\s*\n+/)
    .map(p => p.trim())
    .filter(p => Boolean(p) && !p.startsWith('[TOOL_CALLS]') && !p.startsWith('{"ok"') && !p.startsWith('{"error"') && !/^\[\s*\{/.test(p));

  if (paragraphs.length > 1) {
    return paragraphs;
  }

  if (trimmed.includes('\n')) {
    const lines = trimmed
      .split(/\n+/)
      .map(p => p.trim())
      .filter(p => Boolean(p) && !p.startsWith('[TOOL_CALLS]') && !p.startsWith('{"ok"') && !p.startsWith('{"error"') && !/^\[\s*\{/.test(p));
    if (lines.length > 0) {
      return lines;
    }
  }

  return [trimmed];
}

function logDiagnostic(debug, label, payload) {
  if (!debug) return;
  const timeString = new Date().toISOString().slice(11, 19);
  if (typeof payload === 'object') {
    console.log(`\x1b[90m[${timeString}] [AGENT STEP] ${label}:\x1b[0m`, JSON.stringify(payload));
  } else {
    console.log(`\x1b[90m[${timeString}] [AGENT STEP] ${label}:\x1b[0m ${payload}`);
  }
}

async function runAgentTurn({
  messages,
  db,
  toolsInstance,
  options = {}
}) {
  const baseUrl = options.baseUrl || process.env.LLM_BASE_URL || DEFAULT_BASE_URL;
  const isModal = baseUrl && baseUrl.includes('modal.run');
  const apiKey = options.apiKey || process.env.LLM_API_KEY || process.env.GROQ_API_KEY || (isModal ? 'modal' : '');
  const model = options.model || process.env.LLM_MODEL || (isModal ? 'Qwen/Qwen2.5-7B-Instruct' : DEFAULT_MODEL);
  const maxSteps = options.maxSteps || DEFAULT_MAX_STEPS;
  const defaultTimeout = isModal ? 60000 : DEFAULT_TIMEOUT_MS;
  const timeoutMs = options.timeoutMs || (process.env.LLM_TIMEOUT_MS ? Number(process.env.LLM_TIMEOUT_MS) : defaultTimeout);
  const debug = options.debug ?? (process.env.DEBUG === 'true');
  const fetchClient = options.fetchClient || globalThis.fetch;

  const toolExecutors = toolsInstance || (db ? createTools(db) : {});
  const toolDefinitions = getToolDefinitions();

  const session = options.session;
  const historyCount = messages.filter(m => m.role === 'user' || m.role === 'assistant').length;
  const activeSystemPrompt = options.systemPrompt || getSystemPrompt({
    session,
    timeWat: options.timeWat,
    historyCount
  });

  const conversationHistory = [...messages];
  if (conversationHistory.length === 0 || conversationHistory[0].role !== 'system') {
    conversationHistory.unshift({
      role: 'system',
      content: activeSystemPrompt
    });
  } else if (!options.systemPrompt) {
    conversationHistory[0] = {
      role: 'system',
      content: activeSystemPrompt
    };
  }

  const executedSteps = [];
  let escalated = false;
  let currentStep = 0;

  while (currentStep < maxSteps) {
    currentStep += 1;
    logDiagnostic(debug, 'REASONING', `Evaluating turn at step ${currentStep}/${maxSteps}`);

    const assistantMessage = await requestChatCompletion({
      baseUrl,
      apiKey,
      model,
      messages: conversationHistory,
      tools: toolDefinitions,
      timeoutMs,
      fetchClient
    });

    let toolCalls = assistantMessage.tool_calls;
    if ((!toolCalls || toolCalls.length === 0) && assistantMessage.content) {
      const fallback = extractFallbackToolCalls(assistantMessage.content);
      if (fallback.calls && fallback.calls.length > 0) {
        logDiagnostic(debug, 'FALLBACK_TOOL_CALL', fallback.calls);
        toolCalls = fallback.calls;
        assistantMessage.tool_calls = fallback.calls;
        assistantMessage.content = fallback.cleanText || null;
      }
    }

    if (assistantMessage.content) {
      assistantMessage.content = sanitizeCustomerFacingOutput(assistantMessage.content);
    }

    conversationHistory.push(assistantMessage);

    if (!toolCalls || toolCalls.length === 0) {
      logDiagnostic(debug, 'REASONING', 'Model provided final text reply');
      let cleanReply = sanitizeCustomerFacingOutput(assistantMessage.content || '');
      if (!cleanReply) {
        cleanReply = TOOL_PENDING_REPLY;
      }
      return {
        reply: cleanReply,
        replies: formatWhatsAppReplies(cleanReply),
        messages: conversationHistory,
        steps: executedSteps,
        escalated
      };
    }

    for (const toolCall of toolCalls) {
      const toolName = toolCall.function?.name;
      const parsedArgs = parseToolArguments(toolCall.function?.arguments);

      logDiagnostic(debug, `TOOL CALL ${toolName}`, parsedArgs);

      const stepRecord = {
        step: currentStep,
        tool: toolName,
        input: parsedArgs,
        output: null,
        durationMs: 0
      };

      const startMs = performance.now();
      let toolResult;

      const executor = toolExecutors[toolName];
      if (typeof executor === 'function') {
        try {
          toolResult = await executor(parsedArgs);
        } catch (execError) {
          toolResult = { ok: false, error: `Tool execution error: ${execError.message}` };
        }
      } else {
        toolResult = { ok: false, error: `Tool '${toolName}' is not recognized or available` };
      }

      stepRecord.durationMs = Math.round(performance.now() - startMs);
      stepRecord.output = toolResult;
      executedSteps.push(stepRecord);

      if (toolName === 'escalate_to_human' && toolResult?.ok) {
        escalated = true;
      }

      logDiagnostic(debug, `TOOL RESULT ${toolName} (${stepRecord.durationMs}ms)`, toolResult);

      conversationHistory.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult)
      });
    }
  }

  logDiagnostic(debug, 'REASONING', `Reached max steps (${maxSteps}). Requesting final text response.`);
  const finalMessage = await requestChatCompletion({
    baseUrl,
    apiKey,
    model,
    messages: conversationHistory,
    tools: toolDefinitions,
    toolChoice: 'none',
    timeoutMs,
    fetchClient
  });

  if (finalMessage.content) {
    finalMessage.content = sanitizeCustomerFacingOutput(finalMessage.content);
  }
  conversationHistory.push(finalMessage);

  let cleanFinalReply = sanitizeCustomerFacingOutput(finalMessage.content || '');
  if (!cleanFinalReply) {
    cleanFinalReply = TOOL_PENDING_REPLY;
  }
  return {
    reply: cleanFinalReply,
    replies: formatWhatsAppReplies(cleanFinalReply),
    messages: conversationHistory,
    steps: executedSteps,
    escalated
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_STEPS,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  extractFallbackToolCalls,
  formatWhatsAppReplies,
  parseToolArguments,
  requestChatCompletion,
  runAgentTurn,
  sanitizeCustomerFacingOutput
};
