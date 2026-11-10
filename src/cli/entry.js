import { runClient } from './main.js';

runClient().catch((error) => {
  const message = error?.publicMessage || error?.message || String(error);
  console.error(`gatita-studio: ${message}`);
  process.exitCode = 1;
});
