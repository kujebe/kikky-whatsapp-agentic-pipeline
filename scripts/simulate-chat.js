const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
require('dotenv').config();

const { openDatabase } = require('../src/db');
const { seedTemporaryData } = require('../src/seed');
const { dispatchTextTurn, dispatchAudioTurn, dispatchImageTurn } = require('../src/agent/dispatcher');

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
  console.log(`${BOLD}${GREEN}  Kikky Luxury Femcare - ReAct Chat Simulator (Stage 3)${RESET}`);
  console.log(`${BOLD}====================================================${RESET}`);
  console.log(`${GRAY}Commands:${RESET}`);
  console.log(`  ${YELLOW}/voice <path>${RESET}  - Send audio voice note to Kikky`);
  console.log(`  ${YELLOW}/image <path>${RESET}  - Send image/receipt to Kikky`);
  console.log(`  ${YELLOW}/reset${RESET}         - Reset session conversation history`);
  console.log(`  ${YELLOW}/history${RESET}       - Print current session messages`);
  console.log(`  ${YELLOW}/session${RESET}       - Print current session state in SQLite`);
  console.log(`  ${YELLOW}exit${RESET} or ${YELLOW}q${RESET}      - Quit simulator\n`);

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
        conversationHistory = [];
        sessionId = `sim-${Date.now()}`;
        console.log(`${GRAY}[Session history and ID reset]${RESET}\n`);
        continue;
      }

      if (trimmed.toLowerCase() === '/session') {
        const currentSession = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
        console.log(`\n${GRAY}--- Session State (${sessionId}) ---${RESET}`);
        console.log(JSON.stringify(currentSession || { status: 'uninitialized' }, null, 2));
        console.log(`${GRAY}--------------------------------------------${RESET}\n`);
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
