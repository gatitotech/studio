#!/usr/bin/env node
const args = process.argv.slice(2);

async function main() {
  const { parseArgs, runClient } = await import('../src/cli/main.js');
  const parsed = parseArgs(args);
  if (parsed.command === 'help') {
    const { printHelp } = await import('../src/cli/commands.js');
    printHelp();
    return;
  }
  await runClient(args);
}

main().catch((error) => {
  const message = error?.publicMessage || error?.message || String(error);
  console.error(`gatita-studio: ${message}`);
  process.exitCode = 1;
});
