import { CLIENT_VERSION } from '../shared/protocol.js';

const CLIENT_COMMANDS = new Set([
  'tui',
  'doctor',
  'login',
  'logout',
  'models',
  'usage',
  'mcp',
  'skills',
  'update',
  'help',
]);

export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  let command = 'tui';
  let rest = args;
  if (args[0] && CLIENT_COMMANDS.has(args[0])) {
    command = args[0];
    rest = args.slice(1);
  } else if (args.includes('--help') || args.includes('-h')) {
    command = 'help';
    rest = [];
  } else if (args.includes('--version') || args.includes('-v')) {
    command = '--version';
    rest = [];
  }
  return { command, rest };
}

export async function runClient(argv = process.argv.slice(2)) {
  const { command, rest } = parseArgs(argv);

  if (command === 'doctor') {
    const { runDoctorCommand } = await import('./commands.js');
    await runDoctorCommand();
    return;
  }
  if (command === 'login' || command === 'logout' || command === 'models' || command === 'usage' || command === 'update' || command === 'mcp' || command === 'skills') {
    const { runCliCommand } = await import('./commands.js');
    await runCliCommand(command, rest);
    return;
  }
  if (command === '--version') {
    console.log(CLIENT_VERSION);
    return;
  }
  if (command === 'help') {
    const { printHelp } = await import('./commands.js');
    printHelp();
    return;
  }
  const { runTui } = await import('./tui.js');
  await runTui({ args: rest });
}

export default { parseArgs, runClient };
