import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function runBuffer(command, args, input, { timeoutMs = 10_000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    const chunks = [];
    let length = 0;
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
      if (length >= maxBytes) return;
      const room = maxBytes - length;
      chunks.push(room >= chunk.length ? chunk : chunk.subarray(0, room));
      length += Math.min(room, chunk.length);
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
      if (code === 0) resolve(Buffer.concat(chunks, length));
      else reject(new Error(stderr.trim() || `Clipboard command exited with code ${code}.`));
    });
    child.stdin.on('error', () => {
      // Ignore EPIPE when the child exits before reading stdin.
    });
    if (input == null) child.stdin.end();
    else child.stdin.end(String(input), 'utf8');
  });
}

async function run(command, args, input, options) {
  const output = await runBuffer(command, args, input, { ...options, maxBytes: 1_000_000 });
  return output.toString('utf8');
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

function looksLikePng(data) {
  return data.length > 8
    && data[0] === 0x89
    && data[1] === 0x50
    && data[2] === 0x4e
    && data[3] === 0x47;
}

function looksLikeJpeg(data) {
  return data.length > 4
    && data[0] === 0xff
    && data[1] === 0xd8
    && data[2] === 0xff;
}

function imageFromBuffer(data) {
  if (!data?.length || data.length > MAX_IMAGE_BYTES) return null;
  const mediaType = looksLikePng(data) ? 'image/png' : looksLikeJpeg(data) ? 'image/jpeg' : null;
  if (!mediaType) return null;
  return {
    mediaType,
    dataUrl: `data:${mediaType};base64,${data.toString('base64')}`,
  };
}

function imageFromFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) return null;
    return imageFromBuffer(fs.readFileSync(file));
  } catch {
    return null;
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gatita-clipboard-'));
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Temp cleanup is best effort.
  }
}

async function readMacClipboardImage() {
  const dir = tempDir();
  const pngFile = path.join(dir, 'clipboard.png');
  const tiffFile = path.join(dir, 'clipboard.tiff');
  try {
    const script = [
      `set targetPath to ${JSON.stringify(pngFile)}`,
      'try',
      '  set imageData to the clipboard as «class PNGf»',
      '  set outFile to open for access (POSIX file targetPath) with write permission',
      '  set eof outFile to 0',
      '  write imageData to outFile',
      '  close access outFile',
      '  return "png"',
      'on error',
      '  try',
      `    set tiffPath to ${JSON.stringify(tiffFile)}`,
      '    set imageData to the clipboard as «class TIFF»',
      '    set outFile to open for access (POSIX file tiffPath) with write permission',
      '    set eof outFile to 0',
      '    write imageData to outFile',
      '    close access outFile',
      '    return "tiff"',
      '  on error',
      '    return "none"',
      '  end try',
      'end try',
    ].join('\n');
    const result = await run('osascript', ['-e', script], null, { timeoutMs: 8000 });
    if (result.trim() === 'png') return imageFromFile(pngFile);
    if (result.trim() !== 'tiff') return null;
    await run('sips', ['-s', 'format', 'png', tiffFile, '--out', pngFile], null, { timeoutMs: 8000 });
    return imageFromFile(pngFile);
  } catch {
    return null;
  } finally {
    removeDir(dir);
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function readWindowsClipboardImage() {
  const dir = tempDir();
  const pngFile = path.join(dir, 'clipboard.png');
  try {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$image = [System.Windows.Forms.Clipboard]::GetImage()',
      'if ($null -eq $image) { exit 2 }',
      `$image.Save(${psQuote(pngFile)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$image.Dispose()',
    ].join('; ');
    await run('powershell.exe', ['-NoProfile', '-STA', '-Command', script], null, { timeoutMs: 8000 });
    return imageFromFile(pngFile);
  } catch {
    return null;
  } finally {
    removeDir(dir);
  }
}

async function readLinuxClipboardImage() {
  const attempts = [
    { command: 'wl-paste', args: ['--no-newline', '--type', 'image/png'] },
    { command: 'wl-paste', args: ['--no-newline', '--type', 'image/jpeg'] },
    { command: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'] },
    { command: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/jpeg', '-o'] },
  ];
  for (const attempt of attempts) {
    try {
      const data = await runBuffer(attempt.command, attempt.args, null, { timeoutMs: 8000, maxBytes: MAX_IMAGE_BYTES + 1 });
      if (data.length > MAX_IMAGE_BYTES) continue;
      const image = imageFromBuffer(data);
      if (image) return image;
    } catch {
      // Try the next clipboard backend.
    }
  }
  return null;
}

export async function readClipboardImage() {
  if (process.platform === 'darwin') return readMacClipboardImage();
  if (process.platform === 'win32') return readWindowsClipboardImage();
  return readLinuxClipboardImage();
}
