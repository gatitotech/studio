import { spawn } from 'node:child_process';

function run(command, args, input, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      reject(new Error('Clipboard command timed out.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-1_000_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `Clipboard command exited with code ${code}.`));
    });
    child.stdin.on('error', () => {
      // Ignore EPIPE when the child exits before reading stdin.
    });
    if (input == null) {
      child.stdin.end();
      return;
    }
    child.stdin.end(String(input), 'utf8');
  });
}

function candidates() {
  if (process.platform === 'win32') {
    return {
      write: [{ command: 'clip.exe', args: [] }],
      read: [
        { command: 'powershell.exe', args: ['-NoProfile', '-Command', 'Get-Clipboard -Raw'] },
        { command: 'pwsh', args: ['-NoProfile', '-Command', 'Get-Clipboard -Raw'] },
      ],
    };
  }
  if (process.platform === 'darwin') {
    return {
      write: [{ command: 'pbcopy', args: [] }],
      read: [{ command: 'pbpaste', args: [] }],
    };
  }
  return {
    write: [
      { command: 'xclip', args: ['-selection', 'clipboard'] },
      { command: 'xsel', args: ['--clipboard', '--input'] },
      { command: 'wl-copy', args: [] },
    ],
    read: [
      { command: 'xclip', args: ['-selection', 'clipboard', '-o'] },
      { command: 'xsel', args: ['--clipboard', '--output'] },
      { command: 'wl-paste', args: ['--no-newline'] },
    ],
  };
}

export async function writeClipboard(text) {
  const value = String(text ?? '');
  const attempts = candidates().write;
  let lastError = null;
  for (const attempt of attempts) {
    try {
      await run(attempt.command, attempt.args, value);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No clipboard command is available.');
}

export async function readClipboard() {
  const attempts = candidates().read;
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const output = await run(attempt.command, attempt.args, null);
      return output.replace(/\r\n/g, '\n');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No clipboard command is available.');
}
