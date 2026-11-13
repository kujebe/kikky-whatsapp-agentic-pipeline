require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { transcribeAudio } = require('../src/media/transcriber');
const { classifyImage } = require('../src/media/vision');

const AUDIO_TYPES = new Set(['.ogg', '.opus', '.mp3', '.m4a', '.wav', '.webm', '.flac', '.mp4', '.mpeg', '.mpga']);
const IMAGE_TYPES = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function printUsage() {
  console.log('Usage:');
  console.log('  npm run test-multimodal -- audio <path-to-audio>');
  console.log('  npm run test-multimodal -- audio <path-to-audio> --debug');
  console.log('  npm run test-multimodal -- image <path-to-image>');
  console.log('  npm run test-multimodal -- image <path-to-image> --debug');
}

async function main() {
  const [mode, filePath, ...flags] = process.argv.slice(2);
  const debug = flags.includes('--debug');
  if (!['audio', 'image'].includes(mode) || !filePath) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const supported = mode === 'audio' ? AUDIO_TYPES : IMAGE_TYPES;
  if (!supported.has(extension)) {
    console.error(`Unsupported ${mode} file extension: ${extension || '(none)'}`);
    process.exitCode = 2;
    return;
  }

  let buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch (error) {
    console.error(`Could not read ${filePath}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const startedAt = performance.now();
  const result = mode === 'audio'
    ? await transcribeAudio(buffer, { filename: path.basename(filePath), debug })
    : await classifyImage(buffer, { debug });
  const displayResult = result.ok && result.data?.type === 'payment_receipt'
    ? { ...result, data: { ...result.data, sender: result.data.sender ? '[redacted]' : null } }
    : result;

  console.log(`[TASK] ${mode === 'audio' ? 'audio transcription' : 'image classification'}`);
  console.log(`[FILE] ${filePath}`);
  console.log(`[DURATION] ${(performance.now() - startedAt).toFixed(2)} ms`);
  console.log(`[RESULT] ${JSON.stringify(displayResult, null, 2)}`);
  if (debug && result.debug) {
    if (mode === 'image') {
      console.log('[MODEL_DEBUG] One-request diagnostic output. Receipt values are redacted; other product-image details may appear here.');
    } else {
      console.log('[MODEL_DEBUG] Audio transcription diagnostics: model telemetry, duration, detected language, and segment confidence.');
    }
    console.log(JSON.stringify(result.debug, null, 2));
  }
  if (!result.ok) process.exitCode = 1;
}

main().catch(error => {
  console.error('Multimodal test failed:', error.message);
  process.exitCode = 1;
});