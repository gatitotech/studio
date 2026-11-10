import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ToolError } from '../tools/errors.js';

const HELPER = fileURLToPath(new URL('./win-helper.ps1', import.meta.url));

export const COMPUTER_HELPER_PATH = HELPER;

function runPowerShell(payload, { timeoutMs = 25_000 } = {}) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-Payload', encoded],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
        let parsed = null;
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          try {
            parsed = JSON.parse(lines[index]);
            break;
          } catch {
            // Keep looking for the JSON line.
          }
        }
        if (!parsed) {
          const message = String(stderr || error?.message || 'The computer helper returned no result.').trim();
          reject(new ToolError('computer_failed', message.slice(0, 500)));
          return;
        }
        if (!parsed.ok) {
          reject(new ToolError('computer_failed', String(parsed.error || 'That computer action failed.')));
          return;
        }
        resolve(parsed);
      },
    );
  });
}

function shotDirectory() {
  return path.join(os.tmpdir(), 'gatita-studio', 'shots');
}

function cleanOldShots() {
  const dir = shotDirectory();
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.png'))
      .map((name) => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((left, right) => right.time - left.time);
    for (const file of files.slice(20)) {
      fs.rmSync(path.join(dir, file.name), { force: true });
    }
  } catch {
    // Nothing to clean.
  }
}

export function createComputerController({ config }) {
  const enabled = () => {
    if (process.platform !== 'win32') {
      throw new ToolError('computer_unsupported', 'Computer use is only implemented on Windows right now.');
    }
    if (!config.computerUse) {
      throw new ToolError('computer_disabled', 'Computer use is off. Run /computer on to enable it.');
    }
    if (!fs.existsSync(HELPER)) {
      throw new ToolError('computer_missing', 'The computer helper script is missing.');
    }
  };

  return {
    available: process.platform === 'win32' && fs.existsSync(HELPER),
    enabled: Boolean(config.computerUse),

    async screenshot({ fullScreen = false } = {}) {
      enabled();
      const dir = shotDirectory();
      fs.mkdirSync(dir, { recursive: true });
      const outputPath = path.join(dir, `shot-${Date.now()}.png`);
      const result = await runPowerShell({ action: 'screenshot', outputPath, fullScreen: Boolean(fullScreen) });
      cleanOldShots();
      let dataUrl = '';
      try {
        const buffer = fs.readFileSync(outputPath);
        if (buffer.length <= 5 * 1024 * 1024) {
          dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
        }
      } catch {
        // The path is still returned even if the image could not be encoded.
      }
      return { ...result, dataUrl };
    },

    move(x, y) {
      enabled();
      return runPowerShell({ action: 'move', x, y });
    },

    click({ x, y, button = 'left', doubleClick = false } = {}) {
      enabled();
      return runPowerShell({ action: 'click', x, y, button, doubleClick: Boolean(doubleClick) });
    },

    scroll({ x, y, clicks }) {
      enabled();
      return runPowerShell({ action: 'scroll', x, y, clicks });
    },

    type(text) {
      enabled();
      return runPowerShell({ action: 'type', text });
    },

    key(keys) {
      enabled();
      return runPowerShell({ action: 'key', keys });
    },

    drag({ fromX, fromY, toX, toY }) {
      enabled();
      return runPowerShell({ action: 'drag', fromX, fromY, toX, toY });
    },

    cursor() {
      enabled();
      return runPowerShell({ action: 'cursor' });
    },
  };
}

function describeTarget(x, y) {
  if (Number.isFinite(x) && Number.isFinite(y)) return ` at ${x},${y}`;
  return '';
}

export function createComputerTool({ computer }) {
  return {
    name: 'computer',
    group: 'computer',
    description: 'Control the desktop: take screenshots, move the mouse, click, scroll, type text, and press keys. Requires explicit user approval for each action.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot', 'move', 'click', 'scroll', 'type', 'key', 'drag', 'cursor'],
          description: 'Action to perform.',
        },
        x: { type: 'integer', description: 'Screen x coordinate.' },
        y: { type: 'integer', description: 'Screen y coordinate.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for click.' },
        doubleClick: { type: 'boolean', description: 'Double click instead of single click.' },
        clicks: { type: 'integer', description: 'Scroll wheels, positive is up.' },
        text: { type: 'string', description: 'Text to type.' },
        keys: { type: 'string', description: 'Key or combo, for example ENTER, CTRL+S, ALT+TAB.' },
        fromX: { type: 'integer', description: 'Drag start x.' },
        fromY: { type: 'integer', description: 'Drag start y.' },
        toX: { type: 'integer', description: 'Drag end x.' },
        toY: { type: 'integer', description: 'Drag end y.' },
        fullScreen: { type: 'boolean', description: 'Capture every monitor for screenshots.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(args) {
      if (!computer.available) throw new ToolError('computer_unsupported', 'Computer use is not available on this platform.');
      const action = String(args.action || '');
      switch (action) {
        case 'screenshot': {
          const shot = await computer.screenshot({ fullScreen: args.fullScreen });
          return {
            title: 'Took a screenshot',
            output: `Screenshot ${shot.screenWidth}x${shot.screenHeight} saved (${shot.width}x${shot.height} image). Use it to decide the next action.`,
            images: shot.dataUrl ? [{ dataUrl: shot.dataUrl, mediaType: 'image/png' }] : [],
            meta: { path: shot.path, screenWidth: shot.screenWidth, screenHeight: shot.screenHeight },
          };
        }
        case 'move': {
          if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) throw new ToolError('bad_arguments', 'move needs x and y.');
          const result = await computer.move(args.x, args.y);
          return { title: `Moved to ${result.x},${result.y}`, output: `Moved the mouse to ${result.x},${result.y}.` };
        }
        case 'click': {
          const result = await computer.click({
            x: Number.isFinite(args.x) ? args.x : undefined,
            y: Number.isFinite(args.y) ? args.y : undefined,
            button: args.button || 'left',
            doubleClick: Boolean(args.doubleClick),
          });
          return {
            title: `${args.doubleClick ? 'Double clicked' : 'Clicked'} ${result.button}${describeTarget(args.x, args.y)}`,
            output: `${args.doubleClick ? 'Double clicked' : 'Clicked'} ${result.button} at ${result.x},${result.y}.`,
          };
        }
        case 'scroll': {
          const clicks = Math.max(-20, Math.min(20, Math.trunc(Number(args.clicks) || 0)));
          if (!clicks) throw new ToolError('bad_arguments', 'scroll needs a non-zero clicks value.');
          const result = await computer.scroll({
            x: Number.isFinite(args.x) ? args.x : undefined,
            y: Number.isFinite(args.y) ? args.y : undefined,
            clicks,
          });
          return { title: `Scrolled ${clicks > 0 ? 'up' : 'down'}`, output: `Scrolled ${Math.abs(result.clicks)} wheel steps.` };
        }
        case 'type': {
          const text = String(args.text ?? '');
          if (!text) throw new ToolError('bad_arguments', 'type needs text.');
          if (text.length > 10_000) throw new ToolError('too_long', 'Text is limited to 10000 characters per action.');
          const result = await computer.type(text);
          return { title: `Typed ${result.characters} characters`, output: `Typed ${result.characters} characters.` };
        }
        case 'key': {
          const keys = String(args.keys || '').trim();
          if (!keys) throw new ToolError('bad_arguments', 'key needs a key or combination.');
          const result = await computer.key(keys);
          return { title: `Pressed ${result.keys}`, output: `Pressed ${result.keys}.` };
        }
        case 'drag': {
          const values = [args.fromX, args.fromY, args.toX, args.toY].map(Number);
          if (values.some((value) => !Number.isFinite(value))) throw new ToolError('bad_arguments', 'drag needs fromX, fromY, toX, toY.');
          await computer.drag({ fromX: values[0], fromY: values[1], toX: values[2], toY: values[3] });
          return { title: `Dragged to ${values[2]},${values[3]}`, output: `Dragged from ${values[0]},${values[1]} to ${values[2]},${values[3]}.` };
        }
        case 'cursor': {
          const result = await computer.cursor();
          return { title: `Cursor at ${result.x},${result.y}`, output: `Cursor is at ${result.x},${result.y}. Screen is ${result.screenWidth}x${result.screenHeight}.` };
        }
        default:
          throw new ToolError('bad_arguments', `Unknown computer action: ${action}`);
      }
    },
  };
}
