const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { openDatabase } = require('../src/db');
const { seedTemporaryData } = require('../src/seed');
const { createTools } = require('../src/tools');

const toolNames = ['search_catalog', 'get_product_details', 'calculate_shipping', 'escalate_to_human'];

async function main() {
  const db = openDatabase();
  seedTemporaryData(db);
  const tools = createTools(db);
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  const lines = terminal[Symbol.asyncIterator]();

  async function ask(prompt) {
    stdout.write(prompt);
    const next = await lines.next();
    return next.done ? 'q' : next.value;
  }

  console.log('Temporary data only. Enter a tool number and JSON arguments; q exits.');
  console.log('1) search_catalog  2) get_product_details  3) calculate_shipping  4) escalate_to_human');

  try {
    while (true) {
      const choice = (await ask('\nTool [1-4/q]: ')).trim().toLowerCase();
      if (choice === 'q') break;

      const index = Number(choice) - 1;
      if (!Number.isInteger(index) || !toolNames[index]) {
        console.log('Choose 1, 2, 3, 4, or q.');
        continue;
      }

      const rawInput = await ask('Arguments as JSON: ');
      let args;
      try {
        args = JSON.parse(rawInput);
      } catch {
        console.log('Invalid JSON arguments.');
        continue;
      }

      const name = toolNames[index];
      const startedAt = performance.now();
      const result = tools[name](args);
      console.log(`[TOOL] ${name}`);
      console.log(`[INPUT_FIELDS] ${JSON.stringify(Object.keys(args || {}))}`);
      console.log(`[DURATION] ${(performance.now() - startedAt).toFixed(2)} ms`);
      console.log(`[OUTPUT] ${JSON.stringify(result, null, 2)}`);
    }
  } finally {
    terminal.close();
    db.close();
  }
}

main().catch(error => {
  console.error('Tool harness failed:', error.message);
  process.exitCode = 1;
});