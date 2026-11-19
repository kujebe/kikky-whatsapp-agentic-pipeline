const { transcribeAudio } = require('../media/transcriber');
const { classifyImage } = require('../media/vision');
const { runAgentTurn } = require('./engine');
const { getOrCreateSession, updateSession, extractSessionInferences } = require('./session');
const { releaseExpiredHolds, verify_transfer_receipt } = require('../tools/orders');

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
  const sessionId = session?.session_id || options.sessionId;

  if (db) {
    releaseExpiredHolds(db);
  }

  let activeReservation = null;
  if (db && session) {
    try {
      activeReservation = db.prepare(`
        SELECT r.*, p.name as product_name
        FROM order_reservations r
        LEFT JOIN products p ON r.product_id = p.id
        WHERE r.session_id = ? AND r.status = 'AWAITING_PAYMENT'
          AND datetime(r.hold_expires_at) > datetime('now')
        ORDER BY r.created_at DESC
        LIMIT 1
      `).get(session.session_id);

      if (activeReservation?.items_json) {
        try {
          const items = JSON.parse(activeReservation.items_json);
          if (Array.isArray(items) && items.length > 0) {
            activeReservation.items = items;
            activeReservation.product_name = items.map(i => `${i.name || i.product_id}${i.quantity > 1 ? ` (x${i.quantity})` : ''}`).join(' + ');
          }
        } catch {
          // ignore parse error
        }
      }
    } catch {
      activeReservation = null;
    }
  }

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
        session,
        sessionId,
        activeReservation
      }
    });

    let updatedSession = session;
    if (db && session) {
      const inferences = extractSessionInferences(session, text.trim(), turnResult.reply, turnResult.steps);
      if (Object.keys(inferences).length > 0) {
        updatedSession = updateSession(db, session.session_id, inferences) || session;
      }
    }

    // Surface product image_path if any search_catalog step returned one
    let media = null;
    if (Array.isArray(turnResult.steps)) {
      for (const step of turnResult.steps) {
        if (
          step.tool === 'search_catalog' &&
          step.output?.ok &&
          Array.isArray(step.output.products) &&
          step.output.products.length === 1 &&
          step.output.products[0].image_path
        ) {
          media = { image_path: step.output.products[0].image_path, caption: turnResult.reply };
          break;
        }
      }
    }

    return {
      ok: true,
      reply: turnResult.reply,
      replies: turnResult.replies || [turnResult.reply],
      messages: turnResult.messages,
      steps: turnResult.steps,
      escalated: turnResult.escalated,
      session: updatedSession,
      ...(media ? { media } : {})
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
    const effectiveSessionId = options.sessionId || options.session?.session_id || 'sim-default';
    let verificationResult = null;
    if (db) {
      try {
        verificationResult = verify_transfer_receipt({
          extracted_amount: classification.amount,
          bank_name: classification.bank,
          sender_name: classification.sender,
          receipt_date: classification.date,
          raw_metadata: classification
        }, { db, sessionId: effectiveSessionId });
      } catch {
        verificationResult = null;
      }
    }

    const parts = [];
    if (classification.amount != null) parts.push(`amount: ${classification.amount}`);
    if (classification.bank) parts.push(`bank: ${classification.bank}`);
    if (classification.date) parts.push(`date: ${classification.date}`);
    if (classification.sender) parts.push(`sender: ${classification.sender}`);
    const receiptSummary = parts.length > 0 ? parts.join(', ') : 'bank transfer';

    let verificationEvent = '';
    if (verificationResult) {
      verificationEvent = ` [SYSTEM NOTE: Receipt automatically verified. Outcome: ${JSON.stringify(verificationResult)}]`;
      if (verificationResult.ok && verificationResult.matched) {
        verificationEvent += ` Payment verified and handoff logged for bank alert review. Speak as a solo Nigerian boutique owner: thank the customer warmly, say you've seen the receipt and are quickly checking the alert on your app now, and ask for their delivery street address and calling phone number so you can arrange their rider.`;
      } else if (verificationResult.escalated) {
        verificationEvent += ` Multiple payment discrepancies detected and flagged for staff review. Reassure the customer that you are checking the alert directly on your bank app.`;
      } else if (verificationResult.underpaid) {
        verificationEvent += ` Payment underpaid. Inform customer of remaining balance politely.`;
      } else if (verificationResult.error_code === 'hold_expired') {
        verificationEvent += ` Reservation expired. Checking if stock is still available.`;
      }
    } else {
      verificationEvent = ` Acknowledge receipt, say you are checking the alert on your app now, and ask for delivery street address and phone number for the rider.`;
    }

    if (cleanCaption) {
      simulatedUserPrompt = `[Customer sent a bank transfer receipt showing ${receiptSummary}]. Customer message: "${cleanCaption}".${verificationEvent}`;
    } else {
      simulatedUserPrompt = `[Customer sent a bank transfer receipt showing ${receiptSummary}].${verificationEvent}`;
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
