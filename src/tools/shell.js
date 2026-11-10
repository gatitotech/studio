import { spawn } from 'node:child_process';
import path from 'node:path';
import { ToolError } from './errors.js';
import { displayPath, resolvePath } from './fs.js';

const MAX_CAPTURE = 200 * 1024;
export const MAX_TIMEOUT_MS = 600_000;

function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      child.kill();
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

export function createBashTool({ cwd, config }) {
  return {
    name: 'bash',
    group: 'shell',
    description: 'Run a shell command in the workspace. Use for tests, builds, git, and package managers.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        cwd: { type: 'string', description: 'Working directory, relative to the workspace.' },
        timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds, maximum 600000. Omit to let the command run until it finishes or Gatita stops it.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async execute(args, context = {}) {
      const command = String(args.command || '').trim();
      if (!command) throw new ToolError('bad_arguments', 'command is required.');
      if (command.length > 20_000) throw new ToolError('bad_arguments', 'That command is too long.');
      const workdir = args.cwd ? resolvePath(args.cwd, cwd) : cwd;
      // Only an explicit per-call timeout limits the command. The persisted
      // shellTimeoutMs setting is intentionally ignored: long jobs should run
      // until they finish, and the process tool holds the long-running cases.
      const requestedTimeout = Number(args.timeoutMs);
      const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.min(MAX_TIMEOUT_MS, requestedTimeout)
        : 0;
      const isWindows = process.platform === 'win32';
      const child = spawn(
        isWindows ? 'cmd.exe' : '/bin/sh',
        isWindows ? ['/d', '/s', '/c', command] : ['-c', command],
        {
          cwd: workdir,
          windowsHide: true,
          detached: !isWindows,
          env: { ...process.env, GATITA_STUDIO: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      const append = (target, chunk) => {
        if (target.length >= MAX_CAPTURE) {
          truncated = true;
          return target;
        }
        const text = chunk.toString('utf8');
        const next = target + text;
        if (next.length > MAX_CAPTURE) {
          truncated = true;
          return next.slice(0, MAX_CAPTURE);
        }
        return next;
      };
      child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
      const timer = timeoutMs > 0 ? setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs) : null;
      const onAbort = () => {
        timedOut = false;
        killTree(child);
      };
      context?.signal?.addEventListener('abort', onAbort, { once: true });

      const exit = await new Promise((resolve) => {
        child.on('error', (error) => resolve({ code: -1, error }));
        child.on('close', (code, signal) => resolve({ code: code ?? -1, signal }));
      });
      if (timer) clearTimeout(timer);
      context?.signal?.removeEventListener('abort', onAbort);

      if (exit.error) {
        throw new ToolError('spawn_failed', `Could not start the command: ${exit.error.message}`);
      }
      const parts = [];
      parts.push(`$ ${command}`);
      if (stdout) parts.push(stdout.replace(/\s+$/, ''));
      if (stderr) parts.push(`[stderr]\n${stderr.replace(/\s+$/, '')}`);
      if (!stdout && !stderr) parts.push('(no output)');
      if (truncated) parts.push('… output truncated at 200 KB');
      if (timedOut) parts.push(`Command stopped after ${Math.round(timeoutMs / 1000)}s.`);
      parts.push(`exit ${exit.code}${exit.signal ? ` (${exit.signal})` : ''} in ${displayPath(workdir, cwd)}`);
      return {
        title: `Ran ${command.split(/\r?\n/)[0].slice(0, 60)}`,
        output: parts.join('\n'),
        meta: { exitCode: exit.code, timedOut, truncated, cwd: workdir },
        isError: exit.code !== 0,
      };
    },
  };
}
