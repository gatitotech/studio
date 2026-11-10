import { execFile } from 'node:child_process';

// Best-effort discovery of locally running MCP servers. Gatita uses this to
// look around the machine: HTTP endpoints are probed with a JSON-RPC
// `initialize` handshake and processes are matched against well-known names.

const DEFAULT_PORTS = [
  3000, 3001, 3010, 3100, 3456, 4000, 5000, 5173, 5333, 6274, 6277, 8000, 8080, 8787, 9000, 9090,
];

const PROBE_PATHS = ['/mcp', '/'];
const MAX_BODY = 256 * 1024;

async function probeUrl(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'gatita-studio-discovery', version: '0.0.0' },
        },
      }),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) return null;
    const contentType = String(response.headers.get('content-type') || '');
    if (!contentType.includes('application/json') && !contentType.includes('text/event-stream')) return null;
    const raw = await readCapped(response);
    const payload = parseJsonRpc(raw, contentType);
    const serverInfo = payload?.result?.serverInfo || payload?.serverInfo;
    const protocolVersion = payload?.result?.protocolVersion || payload?.protocolVersion;
    if (!serverInfo && !protocolVersion) return null;
    return {
      url,
      serverName: String(serverInfo?.name || '').trim(),
      serverVersion: String(serverInfo?.version || '').trim(),
      protocolVersion: String(protocolVersion || '').trim(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response) {
  if (!response.body?.getReader) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < MAX_BODY) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore.
    }
  }
  return text;
}

function parseJsonRpc(raw, contentType) {
  const text = String(raw || '');
  if (contentType.includes('text/event-stream') || text.startsWith('event:') || text.includes('\ndata:')) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        return JSON.parse(data);
      } catch {
        // Keep scanning.
      }
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Matches likely MCP servers: modelcontextprotocol packages, mcp-server style
// binaries, `-m mcp` module runs, mcp*.js/py files, and the common
// @modelcontextprotocol/server-* packages. A bare word "mcp" is intentionally
// not enough — it matches this very command (gst mcp discover).
const PROCESS_PATTERN = new RegExp([
  '@modelcontextprotocol',
  'modelcontextprotocol',
  'mcp-server',
  '-m\\s+mcp\\b',
  '[\\\\/]mcp[-_.]',
  'server-(filesystem|git|github|gitlab|postgres|sqlite|memory|everything|puppeteer|playwright|fetch|time|sequential-thinking|redis|brave-search)',
].join('|'), 'i');

function listMcpProcesses({ timeoutMs = 4_000 } = {}) {
  return new Promise((resolve) => {
    const done = (processes) => resolve(processes);
    if (process.platform === 'win32') {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress',
        ],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          if (error) return done([]);
          done(extractProcesses(parseProcessJson(stdout)));
        },
      );
      return;
    }
    execFile('ps', ['-eo', 'pid=,args='], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return done([]);
      const rows = String(stdout || '').split('\n').map((line) => {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        return match ? { pid: Number(match[1]), commandLine: match[2] } : null;
      }).filter(Boolean);
      done(extractProcesses(rows));
    });
  });
}

function parseProcessJson(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || '[]').trim() || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => ({
      pid: Number(row?.ProcessId || 0),
      name: String(row?.Name || ''),
      commandLine: String(row?.CommandLine || ''),
    }));
  } catch {
    return [];
  }
}

function extractProcesses(rows) {
  const seen = new Set();
  const ownCommandLine = process.argv.join(' ');
  return (rows || [])
    .filter((row) => {
      if (row.pid === process.pid) return false;
      const commandLine = String(row.commandLine || '');
      if (!commandLine) return false;
      if (ownCommandLine && commandLine.includes(ownCommandLine)) return false;
      return PROCESS_PATTERN.test(`${commandLine} ${row.name || ''}`);
    })
    .map((row) => ({
      pid: row.pid,
      name: row.name || '',
      commandLine: String(row.commandLine || '').slice(0, 300),
    }))
    .filter((row) => {
      if (seen.has(row.commandLine)) return false;
      seen.add(row.commandLine);
      return true;
    })
    .slice(0, 20);
}

export async function discoverMcpServers({ ports = DEFAULT_PORTS, timeoutMs = 700 } = {}) {
  const http = [];
  await Promise.all(ports.map(async (port) => {
    for (const path of PROBE_PATHS) {
      const found = await probeUrl(`http://127.0.0.1:${port}${path}`, timeoutMs);
      if (found) {
        http.push(found);
        return;
      }
    }
  }));
  const processes = await listMcpProcesses();
  return { http, processes };
}
