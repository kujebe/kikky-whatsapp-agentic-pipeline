const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
require('dotenv').config();

const { openDatabase } = require('../src/db');
const { seedTemporaryData } = require('../src/seed');
const { dispatchTextTurn, dispatchAudioTurn, dispatchImageTurn } = require('../src/agent/dispatcher');
const { createDebouncer } = require('../src/debounce');
const { releaseExpiredHolds } = require('../src/tools/orders');

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const GRAY = '\x1b[90m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function parseMediaCommand(input, commandPrefix) {
  const idx = input.indexOf(commandPrefix);
  if (idx === -1) return null;

  const textBefore = input.slice(0, idx).trim();
  const rest = input.slice(idx + commandPrefix.length).trim();
  if (!rest) return { filePath: '', caption: textBefore };

  let filePath = '';
  let textAfter = '';

  if (rest.startsWith('"')) {
    const closingQuote = rest.indexOf('"', 1);
    if (closingQuote !== -1) {
      filePath = rest.slice(1, closingQuote).trim();
      textAfter = rest.slice(closingQuote + 1).trim();
    } else {
      filePath = rest.slice(1).trim();
    }
  } else if (rest.startsWith("'")) {
    const closingQuote = rest.indexOf("'", 1);
    if (closingQuote !== -1) {
      filePath = rest.slice(1, closingQuote).trim();
      textAfter = rest.slice(closingQuote + 1).trim();
    } else {
      filePath = rest.slice(1).trim();
    }
  } else {
    const tokens = rest.split(/\s+/);
    let candidatePath = tokens[0];
    candidatePath = candidatePath.replace(/(\.(?:png|jpe?g|webp|opus|ogg|wav|mp3|m4a|flac))\b[.,;:!?]*/i, '$1');
    filePath = candidatePath;
    textAfter = tokens.slice(1).join(' ').trim();
  }

  textAfter = textAfter.replace(/^[.,;:!?]+\s*/, '');
  const captionParts = [textBefore, textAfter].filter(Boolean);
  const caption = captionParts.join(' ').trim();

  return { filePath, caption };
}

async function main() {
  const db = openDatabase();
  seedTemporaryData(db);

  const terminal = readline.createInterface({ input: stdin, output: stdout });
  let conversationHistory = [];
  let sessionId = `sim-${Date.now()}`;

  console.log(`\n${BOLD}====================================================${RESET}`);
  console.log(`${BOLD}${GREEN}  Kikky Luxury Femcare - ReAct Chat Simulator (Stage 4)${RESET}`);
  console.log(`${BOLD}====================================================${RESET}`);
  console.log(`${GRAY}Commands:${RESET}`);
  console.log(`  ${YELLOW}/voice <path>${RESET}                   - Send audio voice note to Kikky`);
  console.log(`  ${YELLOW}/image <path>${RESET}                   - Send product image or photo`);
  console.log(`  ${YELLOW}/receipt <path>${RESET}                 - Send payment receipt image for verification`);
  console.log(`  ${YELLOW}/burst <msg1> | <msg2> | <msg3>${RESET} - Test 8-second debounce buffer`);
  console.log(`  ${YELLOW}/session${RESET}                        - Print current session & order hold state`);
  console.log(`  ${YELLOW}/history${RESET}                        - Print current session messages`);
  console.log(`  ${YELLOW}/reset${RESET}                          - Reset session & cancel active inventory holds`);
  console.log(`  ${YELLOW}exit${RESET} or ${YELLOW}q${RESET}                       - Quit simulator\n`);

  function printKikkyReply(result) {
    if (result.replies && result.replies.length > 1) {
      console.log('');
      for (let i = 0; i < result.replies.length; i++) {
        const prefix = i === 0 ? `${GREEN}${BOLD}Kikky > ${RESET}` : `${GREEN}      > ${RESET}`;
        console.log(`${prefix}${result.replies[i]}`);
      }
      console.log('');
    } else {
      console.log(`\n${GREEN}${BOLD}Kikky > ${RESET}${result.reply}\n`);
    }
  }

  try {
    while (true) {
      const input = await terminal.question(`${CYAN}${BOLD}Customer > ${RESET}`);
      const trimmed = input.trim();

      if (!trimmed) continue;
      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'q') {
        console.log(`\n${GRAY}Closing Kikky simulator. Bye!${RESET}`);
        break;
      }

      if (trimmed.toLowerCase() === '/reset') {
        try {
          const activeHold = db.prepare(`
            SELECT * FROM order_reservations WHERE session_id = ? AND status = 'AWAITING_PAYMENT'
          `).get(sessionId);
          if (activeHold) {
            db.transaction(() => {
              db.prepare('UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?').run(activeHold.quantity, activeHold.product_id);
              db.prepare("UPDATE order_reservations SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(activeHold.id);
            })();
          }
          releaseExpiredHolds(db);
        } catch {
          // ignore cleanup errors on reset
        }

        conversationHistory = [];
        sessionId = `sim-${Date.now()}`;
        console.log(`${GRAY}[Session reset, active reservations cancelled, and stock released]${RESET}\n`);
        continue;
      }

      if (trimmed.toLowerCase() === '/session') {
        const currentSession = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
        const currentReservation = db.prepare(`
          SELECT r.*, p.name as product_name
          FROM order_reservations r
          LEFT JOIN products p ON r.product_id = p.id
          WHERE r.session_id = ?
          ORDER BY r.created_at DESC
          LIMIT 1
        `).get(sessionId);
        const recentPayments = db.prepare(`
          SELECT id, order_id, amount, bank_name, sender_name, receipt_date, status, created_at
          FROM payments
          WHERE session_id = ?
          ORDER BY created_at DESC
          LIMIT 3
        `).all(sessionId);

        console.log(`\n${GRAY}--- Session & Reservation State (${sessionId}) ---${RESET}`);
        console.log(JSON.stringify({
          session: currentSession || { status: 'uninitialized' },
          active_reservation: currentReservation || null,
          recent_payments: recentPayments
        }, null, 2));
        console.log(`${GRAY}--------------------------------------------------${RESET}\n`);
        continue;
      }

      if (trimmed.startsWith('/burst')) {
        const burstPayload = trimmed.slice(6).trim();
        const burstMessages = burstPayload.split('|').map(m => m.trim()).filter(Boolean);
        if (burstMessages.length === 0) {
          console.log(`${RED}Usage: /burst <msg1> | <msg2> | <msg3>${RESET}\n`);
          continue;
        }

        console.log(`${GRAY}[Pushed ${burstMessages.length} messages simultaneously to 8-second debounce buffer. Waiting for flush...]${RESET}`);
        await new Promise((resolve) => {
          const debouncer = createDebouncer({
            quietMs: 8000,
            maxWaitMs: 15000,
            onFlush: async (key, batched) => {
              console.log(`\n${GRAY}[Debounce flushed ${batched.length} messages into single turn]:${RESET}`);
              for (const b of batched) {
                console.log(`${CYAN}  • "${b}"${RESET}`);
              }
              const combinedText = batched.join('\n');
              const result = await dispatchTextTurn({
                text: combinedText,
                history: conversationHistory,
                db,
                options: { debug: true, sessionId }
              });
              if (!result.ok) {
                console.log(`${RED}[Error] ${result.error}${RESET}\n`);
              } else {
                conversationHistory = result.messages;
                printKikkyReply(result);
              }
              resolve();
            }
          });

          for (const msg of burstMessages) {
            debouncer.push(sessionId, msg);
          }
        });
        continue;
      }

      if (trimmed.toLowerCase() === '/history') {
        console.log(`\n${GRAY}--- Session History (${conversationHistory.length} messages) ---${RESET}`);
        for (const msg of conversationHistory) {
          const roleColor = msg.role === 'user' ? CYAN : (msg.role === 'assistant' ? GREEN : GRAY);
          console.log(`${roleColor}[${msg.role}]${RESET} ${msg.content || (msg.tool_calls ? JSON.stringify(msg.tool_calls) : '')}`);
        }
        console.log(`${GRAY}--------------------------------------------${RESET}\n`);
        continue;
      }

      const voiceCommand = parseMediaCommand(trimmed, '/voice');
      if (voiceCommand) {
        const { filePath, caption } = voiceCommand;
        if (!filePath) {
          console.log(`${RED}Please specify an audio file path: /voice <path> [caption]${RESET}\n`);
          continue;
        }

        const resolvedPath = path.resolve(process.cwd(), filePath);
        if (!fs.existsSync(resolvedPath)) {
          console.log(`${RED}Audio file not found: ${resolvedPath}${RESET}\n`);
          continue;
        }

        console.log(`${GRAY}[Transcribing voice note via Groq: ${path.basename(resolvedPath)}]...${RESET}`);
        if (caption) {
          console.log(`${GRAY}[Customer Caption: "${caption}"]${RESET}`);
        }

        const audioBuffer = fs.readFileSync(resolvedPath);
        const result = await dispatchAudioTurn({
          audioBuffer,
          caption,
          history: conversationHistory,
          db,
          options: { debug: true, sessionId }
        });

        if (!result.ok) {
          console.log(`${RED}[Error] ${result.error}${RESET}\n`);
          continue;
        }

        conversationHistory = result.messages;
        printKikkyReply(result);
        continue;
      }

      const receiptCommand = parseMediaCommand(trimmed, '/receipt');
      if (receiptCommand) {
        const { filePath, caption } = receiptCommand;
        if (!filePath) {
          console.log(`${RED}Please specify a receipt image file path: /receipt <path> [caption]${RESET}\n`);
          continue;
        }

        const resolvedPath = path.resolve(process.cwd(), filePath);
        if (!fs.existsSync(resolvedPath)) {
          console.log(`${RED}Receipt file not found: ${resolvedPath}${RESET}\n`);
          continue;
        }

        console.log(`${GRAY}[Processing receipt via Modal & verifying hold: ${path.basename(resolvedPath)}]...${RESET}`);
        if (caption) {
          console.log(`${GRAY}[Customer Caption: "${caption}"]${RESET}`);
        }

        const imageBuffer = fs.readFileSync(resolvedPath);
        const result = await dispatchImageTurn({
          imageBuffer,
          caption,
          history: conversationHistory,
          db,
          options: { debug: true, sessionId }
        });

        if (!result.ok) {
          console.log(`${RED}[Error] ${result.error}${RESET}\n`);
          continue;
        }

        conversationHistory = result.messages;
        printKikkyReply(result);
        continue;
      }

      const imageCommand = parseMediaCommand(trimmed, '/image');
      if (imageCommand) {
        const { filePath, caption } = imageCommand;
        if (!filePath) {
          console.log(`${RED}Please specify an image file path: /image <path> [caption]${RESET}\n`);
          continue;
        }

        const resolvedPath = path.resolve(process.cwd(), filePath);
        if (!fs.existsSync(resolvedPath)) {
          console.log(`${RED}Image file not found: ${resolvedPath}${RESET}\n`);
          continue;
        }

        console.log(`${GRAY}[Classifying image via Modal: ${path.basename(resolvedPath)}]...${RESET}`);
        if (caption) {
          console.log(`${GRAY}[Customer Caption: "${caption}"]${RESET}`);
        }

        const imageBuffer = fs.readFileSync(resolvedPath);
        const result = await dispatchImageTurn({
          imageBuffer,
          caption,
          history: conversationHistory,
          db,
          options: { debug: true, sessionId }
        });

        if (!result.ok) {
          console.log(`${RED}[Error] ${result.error}${RESET}\n`);
          continue;
        }

        conversationHistory = result.messages;
        printKikkyReply(result);
        continue;
      }

      const result = await dispatchTextTurn({
        text: trimmed,
        history: conversationHistory,
        db,
        options: { debug: true, sessionId }
      });

      if (!result.ok) {
        console.log(`${RED}[Error] ${result.error}${RESET}\n`);
        continue;
      }

      conversationHistory = result.messages;
      printKikkyReply(result);
    }
  } finally {
    terminal.close();
    db.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`${RED}Fatal simulator error:${RESET}`, err);
    process.exit(1);
  });
}

module.exports = { main, parseMediaCommand };
