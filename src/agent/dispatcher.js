const { transcribeAudio } = require('../media/transcriber');
const { classifyImage } = require('../media/vision');
const { runAgentTurn } = require('./engine');
const { getOrCreateSession, updateSession, extractSessionInferences } = require('./session');

const UNCLEAR_AUDIO_MESSAGE = 'I could not hear that voice note clearly, please type it for me.';

function isAudioQualityError(errorMessage = '') {
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes('smaller than') ||
    lower.includes('empty') ||
    lower.includes('audio base64 is malformed') ||
    lower.includes('silent') ||
    lower.includes('format not supported') ||
    lower.includes('container')
  );
}

async function dispatchTextTurn({
  text,
  history = [],
  db,
  toolsInstance,
  options = {}
}) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, error: 'User message text cannot be empty', error_code: 'empty_text' };
  }

  const session = options.session || (db ? getOrCreateSession(db, options.sessionId, options.sessionData) : null);

  const updatedMessages = [
    ...history,
    { role: 'user', content: text.trim() }
  ];

  try {
    const turnResult = await runAgentTurn({
      messages: updatedMessages,
      db,
      toolsInstance,
      options: {
        ...options,
        session
      }
    });

    let updatedSession = session;
    if (db && session) {
      const inferences = extractSessionInferences(session, text.trim(), turnResult.reply, turnResult.steps);
      if (Object.keys(inferences).length > 0) {
        updatedSession = updateSession(db, session.session_id, inferences) || session;
      }
    }

    return {
      ok: true,
      reply: turnResult.reply,
      replies: turnResult.replies || [turnResult.reply],
      messages: turnResult.messages,
      steps: turnResult.steps,
      escalated: turnResult.escalated,
      session: updatedSession
    };
  } catch (error) {
    return {
      ok: false,
      error: `Agent execution failed: ${error.message}`,
      error_code: 'agent_turn_failed'
    };
  }
}

async function dispatchAudioTurn({
  audioBuffer,
  caption,
  history = [],
  db,
  toolsInstance,
  options = {},
  transcriberFn = transcribeAudio
}) {
  if (!audioBuffer) {
    return { ok: false, error: 'Audio input buffer is required', error_code: 'missing_audio' };
  }

  const transcriptionResult = await transcriberFn(audioBuffer, options.transcriberOptions || {});

  if (!transcriptionResult.ok) {
    if (isAudioQualityError(transcriptionResult.error)) {
      return {
        ok: true,
        reply: UNCLEAR_AUDIO_MESSAGE,
        messages: history,
        steps: [],
        escalated: false,
        transcription_status: 'unclear_audio'
      };
    }

    return {
      ok: false,
      error: transcriptionResult.error || 'Audio transcription infrastructure failure',
      error_code: 'transcription_infrastructure_failure'
    };
  }

  const userPrompt = transcriptionResult.text;
  if (!userPrompt || userPrompt.trim().length === 0) {
    return {
      ok: true,
      reply: UNCLEAR_AUDIO_MESSAGE,
      messages: history,
      steps: [],
      escalated: false,
      transcription_status: 'empty_transcript'
    };
  }

  const cleanCaption = typeof caption === 'string' && caption.trim().length > 0 ? caption.trim() : null;
  const combinedPrompt = cleanCaption
    ? `[Voice note transcription: "${userPrompt.trim()}"]. Customer message: "${cleanCaption}".`
    : userPrompt;

  return dispatchTextTurn({
    text: combinedPrompt,
    history,
    db,
    toolsInstance,
    options
  });
}

async function dispatchImageTurn({
  imageBuffer,
  caption,
  history = [],
  db,
  toolsInstance,
  options = {},
  visionFn = classifyImage
}) {
  if (!imageBuffer) {
    return { ok: false, error: 'Image input buffer is required', error_code: 'missing_image' };
  }

  const visionResult = await visionFn(imageBuffer, options.visionOptions || {});

  if (!visionResult.ok) {
    return {
      ok: false,
      error: visionResult.error || 'Vision classification failed',
      error_code: 'vision_classification_failure'
    };
  }

  const classification = visionResult.data;
  let simulatedUserPrompt = '';
  const cleanCaption = typeof caption === 'string' && caption.trim().length > 0 ? caption.trim() : null;

  if (classification.type === 'product_screenshot') {
    const keywords = Array.isArray(classification.keywords) ? classification.keywords.join(', ') : 'wellness product';
    if (cleanCaption) {
      simulatedUserPrompt = `[Customer sent an image of an item with keywords: ${keywords}]. Customer message: "${cleanCaption}". Check catalog and answer customer inquiry.`;
    } else {
      simulatedUserPrompt = `[Customer sent an image of an item with keywords: ${keywords}]. Check catalog and confirm availability.`;
    }
  } else if (classification.type === 'payment_receipt') {
    const parts = [];
    if (classification.amount != null) parts.push(`amount: ${classification.amount}`);
    if (classification.bank) parts.push(`bank: ${classification.bank}`);
    if (classification.date) parts.push(`date: ${classification.date}`);
    if (classification.sender) parts.push(`sender: ${classification.sender}`);
    const receiptSummary = parts.length > 0 ? parts.join(', ') : 'bank transfer';
    if (cleanCaption) {
      simulatedUserPrompt = `[Customer sent a bank transfer receipt showing ${receiptSummary}]. Customer message: "${cleanCaption}". Acknowledge receipt, confirm details, and ask for delivery address and phone number.`;
    } else {
      simulatedUserPrompt = `[Customer sent a bank transfer receipt showing ${receiptSummary}]. Acknowledge receipt and ask for delivery address and phone number.`;
    }
  } else {
    if (cleanCaption) {
      simulatedUserPrompt = `[Customer sent a photo or sticker]. Customer message: "${cleanCaption}". Respond politely to customer inquiry.`;
    } else {
      simulatedUserPrompt = '[Customer sent a photo or sticker]. Respond politely.';
    }
  }

  return dispatchTextTurn({
    text: simulatedUserPrompt,
    history,
    db,
    toolsInstance,
    options
  });
}

module.exports = {
  UNCLEAR_AUDIO_MESSAGE,
  dispatchAudioTurn,
  dispatchImageTurn,
  dispatchTextTurn,
  isAudioQualityError
};
