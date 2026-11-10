import { spawn } from 'node:child_process';
import path from 'node:path';
import { ToolError } from './errors.js';
import { displayPath, resolvePath } from './fs.js';

const MAX_CAPTURE = 200 * 1024;
const TAIL_LIMIT = 12_000;

function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      child.kill('SIGKILL');
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function trim(text, limit = TAIL_LIMIT) {
  const value = String(text || '');
  if (value.length <= limit) return value;
  return value.slice(value.length - limit);
}

function header(session) {
  const seconds = Math.max(0, (Date.now() - session.startedAt) / 1000);
  const status = session.exited ? `exited ${session.exitCode ?? 'unknown'}${session.signal ? ` (${session.signal})` : ''}` : 'running';
  return `session: ${session.id} · ${status} · ${seconds.toFixed(1)}s · cwd: ${session.cwd}`;
}

export function createProcessTool({ cwd, config }) {
  const sessions = new Map();
  let nextSessionId = 1;
  const ctx = { cwd, config };

  function getSession(id) {
    const key = String(id || '').trim();
    const session = sessions.get(key);
    if (!session) throw new ToolError('bad_arguments', `No process session ${key || '(missing)'}. Use action="list" to see open sessions.`);
    return session;
  }

  function append(session, stream, chunk) {
    const text = chunk.toString('utf8');
    if (session.output.length < MAX_CAPTURE) {
      const room = MAX_CAPTURE - session.output.length;
      session.output += text.slice(0, room);
      if (text.length > room) session.truncated = true;
    } else {
      session.truncated = true;
    }
    session.streams[stream] = (session.streams[stream] || 0) + text.length;
  }

  function spawnSession(command, workdir) {
    const isWindows = process.platform === 'win32';
    const child = spawn(
      isWindows ? 'cmd.exe' : '/bin/sh',
      isWindows ? ['/d', '/s', '/c', command] : ['-c', command],
      {
        cwd: workdir,
        windowsHide: true,
        detached: !isWindows,
        env: { ...process.env, GATITA_STUDIO: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const id = `proc_${nextSessionId}`;
    nextSessionId += 1;
    const session = {
      id,
      child,
      command,
      cwd: displayPath(workdir, cwd),
      startedAt: Date.now(),
      output: '',
      truncated: false,
      exited: false,
      exitCode: null,
      signal: null,
      streams: { stdout: 0, stderr: 0 },
    };
    child.stdout.on('data', (chunk) => append(session, 'stdout', chunk));
    child.stderr.on('data', (chunk) => append(session, 'stderr', chunk));
    child.on('close', (code, signal) => {
      session.exited = true;
      session.exitCode = code ?? -1;
      session.signal = signal || null;
    });
    child.on('error', () => {
      session.exited = true;
      session.exitCode = -1;
    });
    sessions.set(id, session);
    return session;
  }

  function report(session) {
    const lines = [header(session), `$ ${session.command}`];
    if (session.output) {
      lines.push(trim(session.output));
      if (session.truncated) lines.push('… output earlier than the last 12 KB was dropped (200 KB stored at most)');
    } else {
      lines.push('(no output yet)');
    }
    if (session.exited) lines.push(`exit ${session.exitCode}${session.signal ? ` (${session.signal})` : ''}`);
    return { title: session.exited ? `Process ${session.id} exited` : `Process ${session.id}`, output: lines.join('\n'), meta: { sessionId: session.id, exited: session.exited, exitCode: session.exitCode, cwd: session.cwd } };
  }

  async function execute(args) {
    const action = String(args?.action || 'start').trim().toLowerCase();

    if (action === 'start') {
      const command = String(args?.command || '').trim();
      if (!command) throw new ToolError('bad_arguments', 'command is required when action is "start".');
      if (command.length > 20_000) throw new ToolError('bad_arguments', 'That command is too long.');
      const workdir = args?.cwd ? resolvePath(args.cwd, cwd) : cwd;
      const session = spawnSession(command, workdir);
      return {
        title: `Started ${command.split(/\r?\n/)[0].slice(0, 60)}`,
        output: `${header(session)}\n$ ${command}\nstarted. Use action="read" with sessionId="${session.id}" to check progress, action="stop" to stop it.`,
        meta: { sessionId: session.id, cwd: session.cwd },
      };
    }

    if (action === 'read') {
      const session = getSession(args?.sessionId || args?.session);
      return report(session);
    }

    if (action === 'write') {
      const session = getSession(args?.sessionId || args?.session);
      if (session.exited) {
        return { title: `Process ${session.id} exited`, output: `${header(session)}\nrefusing to write to an exited process.`, isError: true, meta: { sessionId: session.id, exited: true } };
      }
      const text = String(args?.text ?? args?.input ?? '');
      if (!text) throw new ToolError('bad_arguments', 'text is required when action is "write".');
      const ok = session.child.stdin.write(text);
      return { title: `Wrote ${text.length} bytes to ${session.id}`, output: `${header(session)}\nwrote ${text.length} bytes${ok ? '' : ' (stdin buffer full)'}.`, meta: { sessionId: session.id } };
    }

    if (action === 'stop') {
      const session = getSession(args?.sessionId || args?.session);
      killTree(session.child);
      sessions.delete(session.id);
      return { title: `Stopped ${session.id}`, output: `${header(session)}\nstop requested.`, meta: { sessionId: session.id } };
    }

    if (action === 'list') {
      const items = [...sessions.values()];
      if (!items.length) return { title: 'No process sessions', output: 'no open process sessions.', meta: { sessions: 0 } };
      return {
        title: `${items.length} process session${items.length === 1 ? '' : 's'}`,
        output: items.map((session) => `${session.id} · ${session.exited ? `exited ${session.exitCode}` : 'running'} · ${(Date.now() - session.startedAt).toFixed(0)}s · ${session.command.split(/\r?\n/)[0].slice(0, 80)}`).join('\n'),
        meta: { sessions: items.length },
      };
    }

    throw new ToolError('bad_arguments', `Unknown process action "${action}". Use start, read, write, stop, or list.`);
  }

  return {
    name: 'process',
    group: 'shell',
    description: 'Start, watch, write to, and stop a long-running process (dev servers, watchers, slow builds). Use this for jobs that outlive a normal command; use bash for short commands.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'read', 'write', 'stop', 'list'], description: 'What to do. "start" runs a command in the background and returns immediately.' },
        command: { type: 'string', description: 'Shell command to run, required for action="start".' },
        sessionId: { type: 'string', description: 'Session id from a previous start (for read/write/stop).' },
        cwd: { type: 'string', description: 'Working directory for the process, relative to the workspace. Only used with action="start".' },
        text: { type: 'string', description: 'Text to write to the process stdin (for action="write").' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    execute,
    cleanup() {
      for (const session of sessions.values()) {
        killTree(session.child);
      }
      sessions.clear();
    },
    // Test hook: resolve any pending waits and observe the session map.
    sessions,
    ctx,
  };
}
