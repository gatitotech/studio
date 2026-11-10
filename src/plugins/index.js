import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { studioHome } from '../cli/paths.js';
import { ToolError } from '../tools/errors.js';

const MAX_PLUGINS = 40;

function pluginFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(mjs|js)$/i.test(entry.name))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function normalizeTool(tool, pluginName) {
  if (!tool || typeof tool !== 'object') return null;
  const name = String(tool.name || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || typeof tool.execute !== 'function') return null;
  return {
    name,
    group: String(tool.group || 'plugin'),
    description: String(tool.description || `Tool from the ${pluginName} plugin.`).slice(0, 1024),
    parameters: tool.parameters && typeof tool.parameters === 'object'
      ? tool.parameters
      : { type: 'object', properties: {} },
    execute: tool.execute,
    plugin: pluginName,
  };
}

export async function loadPlugins({ cwd = process.cwd(), config = {} } = {}) {
  if (config.plugins === false) return { tools: [], commands: [], hooks: [], plugins: [] };
  const dirs = [path.join(studioHome(), 'plugins'), path.join(cwd, '.gatita', 'plugins')];
  const files = dirs.flatMap(pluginFiles).slice(0, MAX_PLUGINS);
  const tools = [];
  const commands = [];
  const hooks = [];
  const plugins = [];
  for (const file of files) {
    try {
      const module = await import(pathToFileURL(file).href);
      const definition = module.default || module.plugin || module;
      if (!definition || typeof definition !== 'object') continue;
      const name = String(definition.name || path.basename(file, path.extname(file))).slice(0, 60);
      for (const tool of Array.isArray(definition.tools) ? definition.tools : []) {
        const normalized = normalizeTool(tool, name);
        if (normalized) tools.push(normalized);
      }
      for (const command of Array.isArray(definition.commands) ? definition.commands : []) {
        if (command && typeof command.name === 'string' && typeof command.run === 'function') {
          commands.push({
            name: command.name.replace(/^\//, ''),
            description: String(command.description || ''),
            run: command.run,
            plugin: name,
          });
        }
      }
      for (const hook of Array.isArray(definition.hooks) ? definition.hooks : []) {
        if (hook && typeof hook.event === 'string' && typeof hook.run === 'function') {
          hooks.push({ event: hook.event, run: hook.run, plugin: name });
        }
      }
      plugins.push({ name, file, version: String(definition.version || '0.0.0') });
    } catch (error) {
      console.error(`plugin ${path.basename(file)} failed to load: ${error.message}`);
    }
  }
  return { tools, commands, hooks, plugins };
}

export async function runHook(hooks, event, payload) {
  let current = payload;
  for (const hook of hooks.filter((entry) => entry.event === event)) {
    try {
      const result = await hook.run(current);
      if (result && typeof result === 'object') current = result;
    } catch (error) {
      console.error(`plugin ${hook.plugin} hook ${event} failed: ${error.message}`);
    }
  }
  return current;
}

export function createPluginToolWrappers(pluginTools) {
  return pluginTools.map((tool) => ({
    name: tool.name,
    group: tool.group,
    description: tool.description,
    parameters: tool.parameters,
    async execute(args, context) {
      try {
        const result = await tool.execute(args, context);
        if (typeof result === 'string') return { title: tool.name, output: result };
        return result || { title: tool.name, output: 'Done.' };
      } catch (error) {
        throw new ToolError('plugin_tool_failed', String(error?.message || 'Plugin tool failed.'));
      }
    },
  }));
}
