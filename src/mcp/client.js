import { spawn } from 'node:child_process';
import { CLIENT_VERSION } from '../shared/protocol.js';
import { AppError } from '../shared/errors.js';

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

function quoteArg(value) {
  const text = String(value);
  if (!/[ \t"&|<>^]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

class StdioTransport {
  constructor({ command, args = [], env = {}, cwd }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.stderr = '';
  }

  start() {
    if (this.child) return;
    const useShell = process.platform === 'win32' && !/\.exe$/i.test(this.command);
    const child = useShell
      ? spawn('cmd.exe', ['/d', '/s', '/c', [this.command, ...this.args].map(quoteArg).join(' ')], {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      : spawn(this.command, this.args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    this.child = child;
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-4000);
    });
    child.on('error', (error) => this.failAll(error));
    child.on('close', (code) => {
      this.closed = true;
      this.failAll(new Error(`MCP server exited with code ${code}.`));
    });
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > MAX_MESSAGE_BYTES) {
      this.failAll(new Error('MCP server sent too much data.'));
      this.buffer = '';
      return;
    }
    let guard = 0;
    while (this.buffer && guard < 1000) {
      guard += 1;
      if (this.buffer.startsWith('Content-Length:')) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = this.buffer.slice(0, headerEnd);
        const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] || 0);
        if (!length) {
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }
        const start = headerEnd + 4;
        if (this.buffer.length < start + length) return;
        const body = this.buffer.slice(start, start + length);
        this.buffer = this.buffer.slice(start + length);
        this.handleMessage(body);
        continue;
      }
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleMessage(line);
    }
  }

  handleMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message && message.id != null && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new AppError('mcp_error', String(message.error.message || 'MCP request failed.'), {
          publicMessage: String(message.error.message || 'MCP request failed.'),
        }));
      } else {
        entry.resolve(message.result);
      }
    }
  }

  failAll(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  request(method, params = {}, timeoutMs = 30_000) {
    this.start();
    if (this.closed) return Promise.reject(new Error('MCP server is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      try {
        this.child.stdin.write(`${payload}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.start();
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      // Ignore notification failures.
    }
  }

  close() {
    this.closed = true;
    this.failAll(new Error('MCP connection closed.'));
    try {
      this.child?.stdin.end();
      this.child?.kill();
    } catch {
      // Already gone.
    }
  }

  get stderrText() {
    return this.stderr;
  }
}

class HttpTransport {
  constructor({ url, headers = {} }) {
    this.url = url;
    this.headers = headers;
    this.sessionId = '';
    this.nextId = 1;
  }

  async request(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'user-agent': `gatita-studio/${CLIENT_VERSION}`,
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          ...this.headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
        redirect: 'error',
      });
      const session = response.headers.get('mcp-session-id');
      if (session) this.sessionId = session;
      if (!response.ok) {
        throw new Error(`MCP server returned ${response.status}.`);
      }
      const contentType = String(response.headers.get('content-type') || '');
      if (contentType.includes('text/event-stream')) {
        return await readSseResponse(response, id, controller.signal);
      }
      const payload = await response.json();
      if (payload?.error) throw new Error(String(payload.error.message || 'MCP request failed.'));
      return payload?.result ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  notify(method, params = {}) {
    fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      redirect: 'error',
    }).catch(() => {});
  }

  close() {
    // HTTP connections are stateless from the CLI side.
  }
}

async function readSseResponse(response, id, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const text = line.slice(5).trim();
          if (!text || text === '[DONE]') continue;
          try {
            const payload = JSON.parse(text);
            if (payload.id === id) {
              if (payload.error) throw new Error(String(payload.error.message || 'MCP request failed.'));
              return payload.result ?? null;
            }
          } catch (error) {
            if (error.message && !error.message.startsWith('Unexpected')) throw error;
          }
        }
      }
      if (done) break;
      if (signal.aborted) throw new Error('MCP request aborted.');
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore.
    }
    reader.releaseLock();
  }
  throw new Error('MCP stream ended without a response.');
}

export class McpClient {
  constructor({ name, config }) {
    this.name = name;
    this.config = config;
    this.transport = config.type === 'http' || config.url
      ? new HttpTransport({ url: config.url, headers: config.headers || {} })
      : new StdioTransport({
        command: config.command,
        args: Array.isArray(config.args) ? config.args.map(String) : [],
        env: config.env || {},
        cwd: config.cwd || undefined,
      });
    this.connected = false;
    this.tools = [];
    this.version = '';
  }

  async connect() {
    const result = await this.transport.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'gatita-studio', version: CLIENT_VERSION },
    }, 30_000);
    this.version = String(result?.protocolVersion || '');
    this.transport.notify('notifications/initialized', {});
    this.tools = await this.listTools();
    this.connected = true;
    return this;
  }

  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 5; page += 1) {
      const result = await this.transport.request('tools/list', cursor ? { cursor } : {}, 30_000);
      if (Array.isArray(result?.tools)) tools.push(...result.tools);
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools.map((tool) => ({
      name: String(tool.name || ''),
      description: String(tool.description || ''),
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} },
    })).filter((tool) => tool.name);
  }

  async callTool(name, args = {}) {
    const result = await this.transport.request('tools/call', { name, arguments: args }, 60_000);
    return result;
  }

  close() {
    this.transport.close();
    this.connected = false;
  }

  get errorDetail() {
    return this.transport.stderrText || '';
  }
}
