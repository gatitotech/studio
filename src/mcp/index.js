import fs from 'node:fs';
import path from 'node:path';
import { studioHome, readJsonFile, writeJsonFile } from '../cli/paths.js';
import { ToolError } from '../tools/errors.js';
import { discoverMcpServers } from './discover.js';
import { McpClient } from './client.js';

function sanitize(value) {
  return String(value || 'tool').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'tool';
}

function readConfigFile(file) {
  const data = readJsonFile(file, null);
  if (!data || typeof data !== 'object') return {};
  const servers = data.mcpServers || data.servers || data;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
  return servers;
}

function normalizeEntry(entry) {
  if (typeof entry === 'string') return { type: 'http', url: entry };
  if (!entry || typeof entry !== 'object') return null;
  if (entry.url) return { type: 'http', ...entry };
  if (entry.command) return { type: 'stdio', ...entry };
  return null;
}

function persistableEntry(raw) {
  const entry = normalizeEntry(raw);
  if (!entry) return null;
  const { type, url, command, args, env, cwd, headers } = entry;
  if (type === 'http') {
    const output = { type: 'http', url: String(url) };
    if (headers && typeof headers === 'object' && Object.keys(headers).length) output.headers = headers;
    return output;
  }
  const output = { command: String(command) };
  if (Array.isArray(args) && args.length) output.args = args.map(String);
  if (env && typeof env === 'object' && Object.keys(env).length) {
    output.env = Object.fromEntries(Object.entries(env).map(([key, value]) => [String(key), String(value)]));
  }
  if (cwd) output.cwd = String(cwd);
  return output;
}

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export function loadMcpConfig({ cwd, config }) {
  const merged = {};
  for (const file of [
    path.join(studioHome(), 'mcp.json'),
    path.join(cwd, '.gatita', 'mcp.json'),
    path.join(cwd, '.gatita-studio', 'mcp.json'),
    path.join(cwd, '.mcp.json'),
  ]) {
    if (!fs.existsSync(file)) continue;
    Object.assign(merged, readConfigFile(file));
  }
  Object.assign(merged, config.mcp || {});
  return merged;
}

export class McpManager {
  constructor({ cwd, config }) {
    this.cwd = cwd;
    this.config = config;
    this.clients = new Map();
    this.toolMap = new Map();
    this.errors = [];
    this.definitions = [];
  }

  mcpConfigFiles() {
    return [
      path.join(studioHome(), 'mcp.json'),
      path.join(this.cwd, '.gatita', 'mcp.json'),
      path.join(this.cwd, '.gatita-studio', 'mcp.json'),
      path.join(this.cwd, '.mcp.json'),
    ];
  }

  async connectAll() {
    const servers = loadMcpConfig({ cwd: this.cwd, config: this.config });
    const entries = Object.entries(servers)
      .map(([name, raw]) => [name, normalizeEntry(raw)])
      .filter(([, entry]) => entry && entry.enabled !== false);
    await Promise.allSettled(entries.map(async ([name, entry]) => {
      const client = new McpClient({ name, config: entry });
      try {
        await client.connect();
        this.clients.set(name, client);
        this.registerTools(name, client);
      } catch (error) {
        client.close();
        const detail = error?.message || 'Connection failed.';
        const stderr = client.errorDetail;
        this.errors.push({ server: name, message: `${detail}${stderr ? ` — ${stderr.trim().split('\n')[0]}` : ''}`.slice(0, 400) });
      }
    }));
    return this;
  }

  registerTools(name, client) {
    for (const tool of client.tools) {
      const publicName = `mcp__${sanitize(name)}__${sanitize(tool.name)}`;
      if (this.toolMap.has(publicName)) continue;
      this.toolMap.set(publicName, { client, server: name, toolName: tool.name, tool });
      this.definitions.push({
        name: publicName,
        group: 'mcp',
        description: `[${name}] ${tool.description || tool.name}`,
        parameters: tool.inputSchema,
        server: name,
      });
    }
  }

  closeServer(name) {
    const client = this.clients.get(name);
    if (client) client.close();
    this.clients.delete(name);
    this.toolMap = new Map([...this.toolMap.entries()].filter(([, entry]) => entry.server !== name));
    this.definitions = this.definitions.filter((definition) => definition.server !== name);
    this.errors = this.errors.filter((error) => error.server !== name);
  }

  async addServer(name, entry, { scope = 'global' } = {}) {
    const cleanName = String(name || '').trim();
    if (!NAME_PATTERN.test(cleanName)) {
      throw new ToolError('mcp_bad_name', 'Server names must be 1-40 characters: letters, digits, dashes, underscores.');
    }
    const normalized = normalizeEntry(entry);
    const persistable = persistableEntry(entry);
    if (!normalized || !persistable) {
      throw new ToolError('mcp_bad_config', 'Provide either a url (HTTP server) or a command (stdio server, with optional args and env).');
    }
    if (normalized.enabled === false) {
      throw new ToolError('mcp_bad_config', 'The server is marked disabled. Set it to enabled to connect it.');
    }
    const client = new McpClient({ name: cleanName, config: normalized });
    try {
      await client.connect();
    } catch (error) {
      const stderr = client.errorDetail;
      client.close();
      const detail = [String(error?.message || 'Connection failed.'), stderr ? stderr.trim().split('\n')[0] : '']
        .filter(Boolean)
        .join(' — ')
        .slice(0, 400);
      throw new ToolError('mcp_connect_failed', detail);
    }
    this.closeServer(cleanName);
    this.clients.set(cleanName, client);
    this.registerTools(cleanName, client);

    const target = scope === 'project'
      ? path.join(this.cwd, '.gatita', 'mcp.json')
      : path.join(studioHome(), 'mcp.json');
    let warning = '';
    try {
      const data = readJsonFile(target, {}) || {};
      const section = (data && typeof data === 'object' && data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers))
        ? { ...data.mcpServers }
        : {};
      section[cleanName] = persistable;
      writeJsonFile(target, { ...data, mcpServers: section }, { mode: 0o600 });
    } catch (error) {
      warning = `Connected for this session, but could not save it to ${target}: ${error?.message || error}`;
    }
    return {
      name: cleanName,
      tools: client.tools.map((tool) => tool.name),
      file: warning ? '' : target,
      warning,
    };
  }

  removeServer(name) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new ToolError('mcp_bad_name', 'Provide the name of the server to remove.');
    const wasConnected = this.clients.has(cleanName);
    this.closeServer(cleanName);
    const removedFrom = [];
    for (const file of this.mcpConfigFiles()) {
      try {
        const data = readJsonFile(file, null);
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        const section = data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)
          ? data.mcpServers
          : data;
        if (!Object.prototype.hasOwnProperty.call(section, cleanName)) continue;
        if (section === data) {
          const { [cleanName]: _dropped, ...rest } = data;
          writeJsonFile(file, rest, { mode: 0o600 });
        } else {
          const { [cleanName]: _dropped, ...rest } = section;
          writeJsonFile(file, { ...data, mcpServers: rest }, { mode: 0o600 });
        }
        removedFrom.push(file);
      } catch {
        // A broken file should not block removing from the others.
      }
    }
    if (this.config?.mcp && Object.prototype.hasOwnProperty.call(this.config.mcp, cleanName)) {
      delete this.config.mcp[cleanName];
      removedFrom.push('in-memory config');
    }
    return { name: cleanName, wasConnected, removedFrom };
  }

  call(name, args) {
    const entry = this.toolMap.get(name);
    if (!entry) throw new ToolError('mcp_unknown_tool', 'That MCP tool is not available.');
    return entry.client.callTool(entry.toolName, args);
  }

  async execute(name, args) {
    const entry = this.toolMap.get(name);
    if (!entry) throw new ToolError('mcp_unknown_tool', 'That MCP tool is not available.');
    let result;
    try {
      result = await this.call(name, args);
    } catch (error) {
      throw new ToolError('mcp_failed', String(error?.message || 'MCP tool failed.').slice(0, 600));
    }
    const output = [];
    const images = [];
    for (const item of Array.isArray(result?.content) ? result.content : []) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'text') output.push(String(item.text || ''));
      else if (item.type === 'image' && item.data) {
        const mimeType = String(item.mimeType || 'image/png');
        images.push({ dataUrl: `data:${mimeType};base64,${item.data}`, mediaType: mimeType });
        output.push(`[image ${mimeType}]`);
      } else if (item.type === 'resource') {
        output.push(String(item.resource?.text || item.resource?.uri || '[resource]'));
      } else {
        output.push(JSON.stringify(item));
      }
    }
    return {
      title: `${entry.server}: ${entry.toolName}`,
      output: output.join('\n') || (result?.isError ? 'MCP tool reported an error.' : 'MCP tool finished with no output.'),
      images,
      isError: Boolean(result?.isError),
    };
  }

  toolDefinitions() {
    return this.definitions;
  }

  toolNames() {
    const byServer = new Map();
    for (const definition of this.definitions) {
      const list = byServer.get(definition.server) || [];
      list.push(definition.name);
      byServer.set(definition.server, list);
    }
    return byServer;
  }

  status() {
    const toolNames = this.toolNames();
    return {
      servers: [...this.clients.values()].map((client) => ({
        name: client.name,
        connected: client.connected,
        tools: client.tools.length,
        toolNames: toolNames.get(client.name) || [],
        version: client.version,
      })),
      errors: this.errors,
    };
  }

  closeAll() {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    this.toolMap.clear();
    this.definitions = [];
  }
}

export function createMcpManager(options) {
  return new McpManager(options);
}

function formatDiscovery({ http, processes }) {
  const lines = [];
  if (http.length) {
    lines.push('HTTP servers answering an MCP handshake on localhost:');
    for (const hit of http) {
      const label = hit.serverName ? `${hit.serverName}${hit.serverVersion ? ` ${hit.serverVersion}` : ''}` : 'unknown server';
      lines.push(`- ${hit.url} — ${label}${hit.protocolVersion ? ` (protocol ${hit.protocolVersion})` : ''}`);
    }
  }
  if (processes.length) {
    lines.push('Processes that look like MCP servers:');
    for (const proc of processes) {
      lines.push(`- pid ${proc.pid}: ${proc.commandLine}`);
    }
  }
  if (!lines.length) {
    lines.push('No local MCP servers found. HTTP ports probed: 3000, 3001, 3010, 3100, 3456, 4000, 5000, 5173, 5333, 6274, 6277, 8000, 8080, 8787, 9000, 9090. No MCP-like processes matched.');
  }
  return lines.join('\n');
}

// Gatita's own way to look at MCP: list what is configured, probe localhost
// for running servers, and connect or remove them. This tool is what makes
// MCP discoverable instead of a hand-edited file.
export function createMcpTool({ manager }) {
  return {
    name: 'mcp',
    group: 'mcp',
    description: [
      'Manage MCP (Model Context Protocol) servers for this session.',
      'Actions:',
      "- list: show configured servers, connection status, and tool names.",
      '- discover: probe localhost ports and local processes for running MCP servers.',
      '- add: connect a new server for this session and save it to mcp.json. Args: name; plus url for an HTTP server, or command (+ optional args, env, cwd) for a stdio server; scope: global (default, ~/.gatita-studio/mcp.json) or project (.gatita/mcp.json).',
      '- remove: disconnect and delete a server from mcp.json. Args: name.',
      'Use this whenever the user mentions MCP servers or you need a tool only an MCP server provides. Newly added servers are usable immediately (tools appear as mcp__<server>__<tool>).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'discover', 'add', 'remove'], description: 'What to do. Defaults to list.' },
        name: { type: 'string', description: 'Server name (letters, digits, dashes, underscores). Required for add and remove.' },
        url: { type: 'string', description: 'HTTP endpoint of the server, e.g. http://127.0.0.1:8000/mcp. Used with action=add.' },
        command: { type: 'string', description: 'Executable that starts a stdio MCP server. Used with action=add.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the command. Used with action=add.' },
        env: { type: 'object', description: 'Extra environment variables for the server process. Used with action=add.' },
        headers: { type: 'object', description: 'HTTP headers (e.g. an Authorization header). Used with action=add for HTTP servers.' },
        scope: { type: 'string', enum: ['global', 'project'], description: 'Where to save the server. Defaults to global.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const action = String(args.action || 'list').toLowerCase();
      if (action === 'list') {
        const status = manager.status();
        const lines = [];
        if (status.servers.length) {
          lines.push('Configured servers:');
          for (const server of status.servers) {
            const state = server.connected ? 'connected' : 'not connected';
            lines.push(`- ${server.name} — ${state}, ${server.tools} tool(s)${server.version ? ` · protocol ${server.version}` : ''}`);
            for (const tool of server.toolNames.slice(0, 60)) lines.push(`    ${tool}`);
          }
        } else {
          lines.push('No MCP servers configured yet.');
        }
        for (const error of status.errors) {
          lines.push(`error from ${error.server}: ${error.message}`);
        }
        lines.push('', 'Use action "discover" to probe this machine for running servers, or action "add" to connect one.');
        return { title: 'MCP servers', output: lines.join('\n') };
      }
      if (action === 'discover') {
        const found = await discoverMcpServers({});
        const text = formatDiscovery(found);
        return {
          title: 'MCP discovery',
          output: `${text}\n\nTo attach one: use action "add" with its url (for HTTP) or its command and args (for stdio).`,
        };
      }
      if (action === 'add') {
        if (!args.url && !args.command) {
          throw new ToolError('mcp_bad_config', 'Provide a url (HTTP server) or a command (stdio server).');
        }
        const result = await manager.addServer(String(args.name || ''), args, { scope: args.scope === 'project' ? 'project' : 'global' });
        const lines = [`Connected to ${result.name} with ${result.tools.length} tool(s): ${result.tools.join(', ')}.`];
        if (result.file) lines.push(`Saved to ${result.file}.`);
        if (result.warning) lines.push(`warning: ${result.warning}`);
        lines.push('The tools are usable right away as mcp__' + result.name + '__<tool>.');
        return { title: `Connected ${result.name}`, output: lines.join('\n') };
      }
      if (action === 'remove') {
        const result = manager.removeServer(String(args.name || ''));
        const lines = [result.wasConnected ? `Disconnected ${result.name}.` : `${result.name} was not connected.`];
        lines.push(result.removedFrom.length ? `Removed from ${result.removedFrom.join(', ')}.` : 'No config file contained it.');
        return { title: `Removed ${result.name}`, output: lines.join('\n') };
      }
      throw new ToolError('mcp_bad_action', `Unknown action "${action}". Use list, discover, add, or remove.`);
    },
  };
}
