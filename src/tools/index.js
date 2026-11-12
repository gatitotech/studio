import { toToolError, ToolError } from './errors.js';
import { createFsTools } from './fs.js';
import { createBashTool } from './shell.js';
import { createProcessTool } from './process.js';
import { createPlanTool } from './plan.js';
import { createGoalTool } from './goal.js';
import { createTaskTools } from './tasks.js';
import { createWebfetchTool, createWebsearchTool } from './web.js';
import { createComputerTool } from '../computer/index.js';
import { createSkillTool } from '../skills/index.js';
import { createAskTool, createAskStatusTool } from './ask.js';
import { createPluginToolWrappers, runHook } from '../plugins/index.js';
import { createMcpTool } from '../mcp/index.js';
import { truncate } from '../shared/util.js';

const MAX_TOOL_OUTPUT = 100_000;

export function createTodoTool({ ctx }) {
  return {
    name: 'todo',
    group: 'todo',
    description: 'Read or replace the task list for this chat. Use it to plan multi-step work.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'Full list of tasks. Omit to read the current list.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
              priority: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
            required: ['content'],
          },
        },
      },
      additionalProperties: false,
    },
    async execute(args) {
      if (!ctx?.store || !ctx?.chatId) throw new ToolError('no_store', 'Todo list is unavailable.');
      if (args.todos === undefined) {
        const items = ctx.store.listTodos(ctx.chatId);
        return {
          title: 'Todo list',
          output: items.length
            ? items.map((item) => `- [${item.status === 'completed' ? 'x' : item.status === 'in_progress' ? '~' : ' '}] ${item.content}`).join('\n')
            : 'No tasks yet.',
        };
      }
      if (!Array.isArray(args.todos)) throw new ToolError('bad_arguments', 'todos must be an array.');
      const items = ctx.store.replaceTodos(ctx.chatId, args.todos.slice(0, 50));
      ctx.onTodos?.(items);
      return {
        title: `Updated ${items.length} tasks`,
        output: items.length
          ? items.map((item) => `- [${item.status === 'completed' ? 'x' : item.status === 'in_progress' ? '~' : ' '}] ${item.content}`).join('\n')
          : 'Task list cleared.',
      };
    },
  };
}

export function approvalGroupForTool(tool) {
  return tool.group || 'other';
}

// Groups a tool must belong to for plan mode to hand it to the agent. Everything
// that reads and asks is allowed; anything that writes, spawns, or reconfigures is not.
export const PLAN_MODE_ALLOWED_GROUPS = new Set(['read', 'search', 'todo', 'ask', 'web', 'plan']);

export function toolAllowedInPlan(tool) {
  return Boolean(tool) && PLAN_MODE_ALLOWED_GROUPS.has(tool.group || 'other');
}

export function toolNeedsApproval(tool, config, args) {
  const group = approvalGroupForTool(tool);
  if (group === 'read' || group === 'search' || group === 'todo' || group === 'ask' || group === 'plan') return false;
  // The mcp management tool is read-only for list/discover; connect/remove ask.
  if (tool?.name === 'mcp' && ['list', 'discover'].includes(String(args?.action || 'list'))) return false;
  if (group === 'web') return config.autoApprove?.web === false;
  if (group === 'edit') return config.autoApprove?.edit !== true;
  if (group === 'write') return config.autoApprove?.write !== true;
  if (group === 'shell') return config.autoApprove?.shell !== true;
  if (group === 'computer') return config.autoApprove?.computer !== true;
  if (group === 'mcp') return config.autoApprove?.mcp !== true;
  if (group === 'plugin') return config.autoApprove?.plugin === true;
  return true;
}

export function summarizeToolCall(tool, args) {
  const value = args || {};
  if (tool.name === 'bash') return String(value.command || '').split(/\r?\n/)[0].slice(0, 100);
  if (tool.name === 'read' || tool.name === 'write' || tool.name === 'edit') return String(value.path || '');
  if (tool.name === 'grep' || tool.name === 'glob') return `${value.pattern || ''}${value.path ? ` in ${value.path}` : ''}`;
  if (tool.name === 'webfetch') return String(value.url || '');
  if (tool.name === 'websearch') return String(value.query || '');
  if (tool.name === 'computer') return `${value.action || ''}${value.keys ? ` ${value.keys}` : ''}${value.text ? ` ${truncate(value.text, 40)}` : ''}`;
  if (tool.name === 'todo') return Array.isArray(value.todos) ? `${value.todos.length} tasks` : 'read list';
  try {
    return truncate(JSON.stringify(value), 100);
  } catch {
    return '';
  }
}

export function createToolRegistry({
  cwd,
  config,
  store = null,
  chatId = null,
  computer = null,
  skills = [],
  mcp = null,
  askManager = null,
  planManager = null,
  goalManager = null,
  taskManager = null,
  pluginTools = [],
  hooks = [],
  onTodos = null,
}) {
  const ctx = { cwd, config, store, chatId, onTodos };
  const tools = [
    ...createFsTools({ cwd, ctx }),
    createBashTool({ cwd, config }),
    createProcessTool({ cwd, config }),
    createPlanTool({ planManager }),
    createGoalTool({ goalManager }),
    ...createTaskTools({ taskManager }),
    createWebfetchTool({ config }),
    createWebsearchTool({ config }),
    createTodoTool({ ctx }),
    createSkillTool({ skills }),
  ].filter(Boolean);
  if (computer) tools.push(createComputerTool({ computer }));
  if (askManager) tools.push(createAskTool({ askManager }), createAskStatusTool({ askManager }));
  if (mcp) tools.push(createMcpTool({ manager: mcp }));

  const wrapMcpDefinition = (definition) => ({
    name: definition.name,
    group: 'mcp',
    description: definition.description,
    parameters: definition.parameters,
    async execute(args) {
      return mcp.execute(definition.name, args || {});
    },
  });

  for (const definition of mcp?.toolDefinitions?.() || []) {
    tools.push(wrapMcpDefinition(definition));
  }
  tools.push(...createPluginToolWrappers(pluginTools));

  const byName = new Map();
  const liveTools = [];
  const register = (tool) => {
    if (!tool || byName.has(tool.name)) return false;
    byName.set(tool.name, tool);
    liveTools.push(tool);
    return true;
  };
  for (const tool of tools) register(tool);

  return {
    ctx,
    tools: liveTools,
    skillsForPrompt: Array.isArray(skills) ? skills : [],
    setChat(chatId) {
      ctx.chatId = chatId || null;
    },
    // Live-register MCP tools added after startup (e.g. a server the agent
    // connected mid-turn). Tools of a removed server simply fail with a clear
    // "not available" error until the next rebuild.
    registerTools(definitions) {
      let added = 0;
      for (const definition of definitions || []) {
        if (register(wrapMcpDefinition(definition))) added += 1;
      }
      return added;
    },
    // Pull any newly added MCP tool definitions from the manager into the
    // registry. Cheap to call after every mcp management call.
    syncMcp() {
      if (!mcp?.toolDefinitions) return 0;
      return this.registerTools(mcp.toolDefinitions());
    },
    get(name) {
      return byName.get(name) || null;
    },
    definitions({ mode } = {}) {
      return [...byName.values()]
        .filter((tool) => mode !== 'plan' || toolAllowedInPlan(tool))
        .map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
    },
    names() {
      return [...byName.keys()];
    },
    needsApproval(tool, args) {
      return toolNeedsApproval(tool, config, args);
    },
    cleanup() {
      for (const tool of liveTools) {
        try {
          tool.cleanup?.();
        } catch {
          // Cleanup is best effort.
        }
      }
    },
    async execute(name, args, { signal, mode } = {}) {
      const tool = byName.get(name);
      if (!tool) {
        return { ok: false, output: `Unknown tool: ${name}`, isError: true, tool: name };
      }
      // Last line of defense: the definitions filter hides mutating tools, but a
      // model that guesses one anyway gets a clear error instead of an action.
      if (mode === 'plan' && !toolAllowedInPlan(tool)) {
        return {
          ok: false,
          output: `"${name}" is not allowed in plan mode. Plan first: read files, ask questions, and submit a plan with the plan tool. The user switches to build mode when they are ready.`,
          isError: true,
          tool: name,
          code: 'plan_mode',
        };
      }
      let payload = { args: args || {}, toolName: name, cwd };
      try {
        payload = await runHook(hooks, 'beforeTool', payload);
        if (payload?.blocked) {
          return {
            ok: false,
            output: `Tool call blocked by a plugin: ${payload.reason || 'no reason given'}`,
            isError: true,
            tool: name,
          };
        }
        const result = await tool.execute(payload?.args || args || {}, { signal, ...ctx });
        let normalized = result;
        if (typeof normalized === 'string') normalized = { output: normalized };
        normalized = await runHook(hooks, 'afterTool', normalized || {});
        const output = String(normalized?.output ?? '').slice(0, MAX_TOOL_OUTPUT);
        return {
          ok: !normalized?.isError,
          output,
          isError: Boolean(normalized?.isError),
          title: normalized?.title || name,
          meta: normalized?.meta,
          images: Array.isArray(normalized?.images) ? normalized.images : [],
          tool: name,
        };
      } catch (error) {
        const toolError = toToolError(error);
        return {
          ok: false,
          output: `Error: ${toolError.publicMessage}`,
          isError: true,
          title: `Failed ${name}`,
          tool: name,
          code: toolError.code,
        };
      }
    },
  };
}
