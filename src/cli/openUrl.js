import { spawn } from 'node:child_process';

export const PLAN_URL = 'https://gatita.tech/api#plan';

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function openExternalUrl(url) {
  return new Promise((resolve, reject) => {
    const target = String(url || '').trim();
    if (!isSafeHttpUrl(target)) {
      reject(new Error('Invalid URL.'));
      return;
    }

    let command;
    let args;
    if (process.platform === 'win32') {
      command = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-Command', `Start-Process ${psSingleQuote(target)}`];
    } else if (process.platform === 'darwin') {
      command = 'open';
      args = [target];
    } else {
      command = 'xdg-open';
      args = [target];
    }

    let settled = false;
    let child;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });

    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      try {
        child.unref();
      } catch {
        // Ignore unref failures on non-standard handles.
      }
      resolve({ ok: true, url: target });
    });
  });
}
