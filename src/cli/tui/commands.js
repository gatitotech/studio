import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveConfig } from '../config.js';
import { clearStoredAuth } from '../authStore.js';
import { bestEffortLogout } from '../commands.js';
import { createStyler } from '../theme.js';
import { writeClipboard } from '../clipboard.js';
import { discoverMcpServers } from '../../mcp/discover.js';
import { basenameForDisplay, formatTokens, plural, truncate } from '../../shared/util.js';
import { CLIENT_VERSION } from '../../shared/protocol.js';
import { checkForUpdate, downloadUpdate, installTarball, isOutOfDate, formatUpdateNotice } from '../update.js';

export const SLASH_COMMANDS = [
  { name: 'help', aliases: ['?'], description: 'Show keys and commands' },
  { name: 'settings', aliases: ['options', 'config'], description: 'Open settings' },
  { name: 'model', aliases: ['m'], description: 'Switch the Gatita model' },
  { name: 'reasoning', aliases: ['think'], description: 'Set thinking depth: off, low, max' },
  { name: 'thinking', description: 'Show or hide reasoning text' },
  { name: 'new', aliases: ['n'], description: 'Start a new chat' },
  { name: 'sessions', aliases: ['resume'], description: 'Switch conversations' },
  { name: 'rename', description: 'Rename this chat' },
  { name: 'delete', description: 'Delete this chat' },
  { name: 'folders', description: 'Choose a folder' },
  { name: 'folder', description: 'Move this chat to a folder' },
  { name: 'usage', description: 'Show token usage and limits' },
  { name: 'plan', aliases: ['p'], description: 'Plan mode: ask first, then write a buildable plan' },
  { name: 'build', aliases: ['b'], description: 'Build mode: build the approved plan or send a normal prompt' },
  { name: 'goal', description: 'Keep working until a goal is complete: /goal <task>, /goal stop' },
  { name: 'details', description: 'Show or hide work details in the transcript' },
  { name: 'reset', description: 'Use a banked reset to refill your limits' },
  { name: 'admin', description: 'Admin: reset usage or grant banked resets' },
  { name: 'compact', description: 'Summarize and shrink this conversation' },
  { name: 'clear', description: 'Clear this chat history' },
  { name: 'init', description: 'Create AGENTS.md project notes' },
  { name: 'computer', description: 'Toggle desktop control: on, off, status' },
  { name: 'skills', description: 'List or show installed skills' },
  { name: 'mcp', description: 'MCP servers and tools · /mcp discover scans localhost' },
  { name: 'plugins', description: 'Show loaded plugins' },
  { name: 'permissions', description: 'Toggle which tools need approval' },
  { name: 'sound', description: 'Toggle sounds for prompts and finished tasks' },
  { name: 'theme', description: 'Switch between dark and paper' },
  { name: 'cwd', description: 'Change the workspace folder' },
  { name: 'image', description: 'Attach an image for a vision model' },
  { name: 'copy', description: 'Copy the last answer to the clipboard' },
  { name: 'update', description: 'Check for and install Gatita Studio updates' },
  { name: 'version', aliases: ['v'], description: 'Show the Gatita Studio version' },
  { name: 'login', description: 'How to sign in again' },
  { name: 'logout', description: 'Sign out and quit' },
  { name: 'quit', aliases: ['q', 'exit'], description: 'Leave Gatita Studio' },
];

function normalizeCommandName(value) {
  return String(value || '').replace(/^\//, '').toLowerCase();
}

export function commandSuggestions(input, extraCommands = []) {
  const text = String(input || '');
  const term = normalizeCommandName(text.startsWith('/') ? text.slice(1) : text);
  const commands = [
    ...SLASH_COMMANDS,
    ...(Array.isArray(extraCommands) ? extraCommands : []).map((command) => ({
      name: normalizeCommandName(command.name),
      aliases: [],
      description: command.description || `Plugin command from ${command.plugin || 'a plugin'}`,
    })),
  ];
  const unique = new Map();
  for (const command of commands) {
    if (!command.name || unique.has(command.name)) continue;
    unique.set(command.name, command);
  }
  return [...unique.values()]
    .filter((command) => {
      if (!term) return true;
      if (command.name.startsWith(term)) return true;
      return (command.aliases || []).some((alias) => alias.startsWith(term));
    })
    .sort((left, right) => {
      const leftExact = left.name === term ? 0 : left.name.startsWith(term) ? 1 : 2;
      const rightExact = right.name === term ? 0 : right.name.startsWith(term) ? 1 : 2;
      if (leftExact !== rightExact) return leftExact - rightExact;
      return left.name.localeCompare(right.name);
    });
}

function resolveAlias(name) {
  const clean = normalizeCommandName(name);
  const direct = SLASH_COMMANDS.find((command) => command.name === clean);
  if (direct) return direct.name;
  const aliased = SLASH_COMMANDS.find((command) => (command.aliases || []).includes(clean));
  return aliased ? aliased.name : clean;
}

function flash(app, message, color = 'muted') {
  app.setFlash(message, color);
}

function showText(app, title, body) {
  app.openDialog({
    type: 'text',
    title,
    body: Array.isArray(body) ? body : String(body || '').split('\n'),
    scroll: 0,
  });
}

function currentChat(app) {
  if (app.chat) return app.chat;
  flash(app, 'No chat is open. Send a message or run /new.', 'warning');
  return null;
}

function guardIdle(app, message = 'Wait for Gatita to finish first.') {
  if (!app.running) return true;
  flash(app, message, 'warning');
  return false;
}

function oneLine(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return truncate(text, max);
}

function summarizeMessages(messages) {
  const bullets = [];
  for (const message of messages) {
    if (message.role === 'user' && message.content) {
      bullets.push(`- User: ${oneLine(message.content, 140)}`);
    } else if (message.role === 'assistant') {
      if (message.content) bullets.push(`- Gatita: ${oneLine(message.content, 140)}`);
      if (Array.isArray(message.toolCalls) && message.toolCalls.length) {
        const names = message.toolCalls.map((call) => call.function?.name).filter(Boolean);
        if (names.length) bullets.push(`- Tools used: ${[...new Set(names)].join(', ')}`);
      }
    }
  }
  return (bullets.length ? bullets : ['- Earlier messages were compacted.']).slice(-14).join('\n');
}

function compactChat(app) {
  const chat = currentChat(app);
  if (!chat) return;
  if (!guardIdle(app)) return;
  const messages = app.store.listMessages(chat.id);
  if (messages.length <= 10) {
    flash(app, 'This conversation is already short.', 'muted');
    return;
  }
  const removed = messages.slice(0, messages.length - 10);
  let kept = messages.slice(-10);
  while (kept.length && kept[0].role === 'tool') kept = kept.slice(1);
  if (kept.length && kept[0].role === 'assistant' && Array.isArray(kept[0].toolCalls)) {
    kept = kept.slice(1);
    while (kept.length && kept[0].role === 'tool') kept = kept.slice(1);
  }
  if (!kept.length) {
    flash(app, 'Nothing safe to compact.', 'warning');
    return;
  }
  const todos = app.store.listTodos(chat.id);
  const summary = summarizeMessages(removed);
  app.store.deleteMessages(chat.id);
  app.store.addMessage(chat.id, {
    role: 'system',
    content: `Summary of earlier conversation (${removed.length} messages compacted):\n${summary}`,
  });
  for (const message of kept) {
    app.store.addMessage(chat.id, {
      id: message.id,
      role: message.role,
      content: message.content,
      reasoning: message.reasoning,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      name: message.name,
      createdAt: message.createdAt,
      meta: message.meta,
    });
  }
  if (todos.length) app.store.replaceTodos(chat.id, todos);
  app.messages = app.store.listMessages(chat.id);
  app.todos = app.store.listTodos(chat.id);
  app.transcriptCache.clear();
  app.followBottom = true;
  app.scrollOffset = 0;
  app.requestRender();
  flash(app, `Compacted ${removed.length} messages into a summary.`, 'success');
}

function projectTemplate(cwd) {
  const name = basenameForDisplay(cwd) || 'project';
  let packageInfo = null;
  try {
    packageInfo = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  } catch {
    packageInfo = null;
  }
  const scripts = packageInfo?.scripts && typeof packageInfo.scripts === 'object' ? packageInfo.scripts : {};
  const lines = [
    '# AGENTS.md',
    '',
    `Notes for Gatita Studio while working in ${name}.`,
    '',
    '## Project',
    `- Path: ${cwd}`,
    `- Name: ${packageInfo?.name || name}`,
  ];
  if (packageInfo?.description) lines.push(`- Summary: ${packageInfo.description}`);
  lines.push('', '## Commands');
  if (Object.keys(scripts).length) {
    for (const [key, value] of Object.entries(scripts)) {
      lines.push(`- ${key}: \`${value}\``);
    }
  } else {
    lines.push('- install: (fill in)');
    lines.push('- test: (fill in)');
    lines.push('- build: (fill in)');
  }
  lines.push(
    '',
    '## Conventions',
    '- Read files before editing them.',
    '- Match the existing style and structure.',
    '- Run the tests before claiming a change works.',
    '- Keep changes focused; do not rewrite unrelated code.',
    '',
  );
  return lines.join('\n');
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function listSkills(app) {
  if (!app.skills.length) {
    showText(app, 'skills', [
      app.styler.fg('muted', 'No skills installed.'),
      '',
      'The fastest way to add one: a premade example already exists at',
      `  ${app.styler.fg('accent', path.join(app.config.paths?.home || '~/.gatita-studio', 'skills', 'example', 'SKILL.md'))}`,
      'Copy that folder, rename it, and edit SKILL.md.',
      '',
      app.styler.fg('faint', 'Or create one from scratch:'),
      `  ${app.styler.fg('accent', 'mkdir -p ~/.gatita-studio/skills/my-skill')}`,
      `  ${app.styler.fg('accent', '$EDITOR ~/.gatita-studio/skills/my-skill/SKILL.md')}`,
      '',
      app.styler.fg('faint', 'Add SKILL.md with frontmatter like:'),
      '  ---',
      '  name: my-skill',
      '  description: What it does',
      '  ---',
      '',
      app.styler.fg('faint', 'Then type @ in the composer to mention it (@my-skill).'),
      '',
      app.styler.fg('faint', 'Skills are global: they live in ~/.gatita-studio/skills and work in every project.'),
      app.styler.fg('faint', 'Project skills can be added in .gatita/skills/<name>/SKILL.md.'),
    ]);
    return;
  }
  const body = app.skills.map((skill) => `${app.styler.fg('accent', skill.name)} ${app.styler.fg('faint', `(${skill.source})`)}\n  ${app.styler.fg('muted', skill.description || 'No description.')}`);
  showText(app, `skills · ${app.skills.length}`, [body.join('\n\n'), '', app.styler.fg('faint', 'Use @name in the composer to mention a skill, or /skills <name> to read one.')]);
}

async function showMcp(app, args = '') {
  const home = app.config.paths?.home || '~/.gatita-studio';
  const sub = String(args || '').trim().toLowerCase();
  if (sub === 'discover' || sub === 'scan') {
    flash(app, 'Scanning localhost for MCP servers…', 'muted');
    try {
      const found = await discoverMcpServers({});
      const body = [];
      if (found.http.length) {
        body.push(app.styler.fg('accent', 'HTTP servers answering an MCP handshake:'));
        for (const hit of found.http) {
          const label = hit.serverName ? `${hit.serverName}${hit.serverVersion ? ` ${hit.serverVersion}` : ''}` : 'unknown server';
          body.push(`  ${app.styler.fg('text', hit.url)} — ${app.styler.fg('muted', label)}`);
        }
      } else {
        body.push(app.styler.fg('muted', 'No HTTP MCP servers on localhost.'));
      }
      if (found.processes.length) {
        body.push('', app.styler.fg('accent', 'Processes that look like MCP servers:'));
        for (const proc of found.processes) body.push(`  ${app.styler.fg('text', `pid ${proc.pid}`)} ${app.styler.fg('faint', proc.commandLine)}`);
      }
      body.push('', app.styler.fg('faint', 'Attach one with: gst mcp add <name> --url <url>   or   --command <cmd> [--args …]'));
      body.push(app.styler.fg('faint', 'Or just ask gatita — she can discover and connect servers herself with the mcp tool.'));
      showText(app, 'mcp · discovery', body);
    } catch (error) {
      flash(app, `Discovery failed: ${error?.message || error}`, 'danger');
    }
    return;
  }
  const status = app.mcp?.status?.() || { servers: [], errors: [] };
  const body = [];
  if (!status.servers.length) body.push(app.styler.fg('muted', 'No MCP servers connected.'));
  for (const server of status.servers) {
    const dot = server.connected ? app.styler.fg('success', '●') : app.styler.fg('danger', '○');
    body.push(`${dot} ${app.styler.fg('text', server.name)} ${app.styler.fg('faint', `${plural(server.tools, 'tool')}${server.version ? ` · ${server.version}` : ''}`)}`);
    for (const tool of server.toolNames || []) body.push(`  ${app.styler.fg('faint', tool)}`);
  }
  for (const error of status.errors) {
    body.push(`${app.styler.fg('danger', '✗')} ${app.styler.fg('text', error.server)} ${app.styler.fg('faint', error.message)}`);
  }
  body.push(
    '',
    app.styler.fg('faint', 'Connect one in seconds:'),
    `  ${app.styler.fg('accent', 'gst mcp discover')}          probe this machine for running servers`,
    `  ${app.styler.fg('accent', 'gst mcp add <name> --url <url>')}`,
    `  ${app.styler.fg('accent', 'gst mcp add <name> --command <cmd> [--args "-y pkg …"]')}`,
    '',
    app.styler.fg('faint', `Or edit ${path.join(home, 'mcp.json')} — a premade example ships with it (flip enabled to true).`),
    app.styler.fg('faint', 'Gatita can also add and remove servers herself with her mcp tool; try "find running mcp servers".'),
  );
  showText(app, 'mcp', body);
}

function showPlugins(app) {
  const plugins = app.plugins?.plugins || [];
  const body = [];
  if (!plugins.length) {
    body.push(app.styler.fg('muted', 'No plugins loaded.'));
    body.push('', app.styler.fg('faint', `Drop a .mjs plugin into ${path.join(app.config.paths?.home || '~/.gatita-studio', 'plugins')}.`));
  }
  for (const plugin of plugins) {
    body.push(`${app.styler.fg('accent', plugin.name)} ${app.styler.fg('faint', plugin.version)}`);
    body.push(`  ${app.styler.fg('muted', plugin.file || '')}`);
  }
  if (plugins.length) {
    body.push('', app.styler.fg('faint', `${app.plugins.tools.length} plugin tools, ${app.plugins.commands.length} commands, ${app.plugins.hooks.length} hooks.`));
  }
  showText(app, 'plugins', body);
}

export async function executeSlashCommand(app, rawName, args = '', raw = '') {
  const name = resolveAlias(rawName);
  const pluginCommands = app.plugins?.commands || [];
  const pluginCommand = pluginCommands.find((command) => normalizeCommandName(command.name) === normalizeCommandName(rawName));
  if (pluginCommand) {
    try {
      const result = await pluginCommand.run({ app, args, text: raw, cwd: app.cwd });
      if (typeof result === 'string' && result.trim()) flash(app, result.trim(), 'success');
      else flash(app, `/${pluginCommand.name} finished.`, 'success');
    } catch (error) {
      flash(app, error?.message || 'Plugin command failed.', 'danger');
    }
    return;
  }

  switch (name) {
    case 'help':
      app.openDialog({ type: 'help', scroll: 0 });
      return;
    case 'settings':
      if (typeof app.openSettings === 'function') app.openSettings();
      else app.openDialog({ type: 'settings', index: 0 });
      return;
    case 'model':
      if (!args) {
        app.openDialog({ type: 'models', index: 0, filter: '' });
        return;
      }
      app.setModel(args);
      return;
    case 'reasoning': {
      const model = app.model();
      if (!model) {
        flash(app, 'No model is selected.', 'danger');
        return;
      }
      const levels = model.reasoningLevels || [];
      if (!args) {
        showText(app, 'reasoning', [
          `${app.styler.fg('muted', 'Current:')} ${app.styler.fg('accent', app.reasoning)}`,
          '',
          `${app.styler.fg('muted', 'Available:')} ${levels.length ? levels.join(', ') : 'this model has no reasoning levels'}`,
          '',
          app.styler.fg('faint', 'Use /reasoning off, /reasoning low, or /reasoning max.'),
        ]);
        return;
      }
      const aliases = { brief: 'low', short: 'low', deep: 'max', extensive: 'max', none: 'off', true: 'low' };
      app.setReasoning(aliases[args.toLowerCase()] || args.toLowerCase());
      return;
    }
    case 'thinking': {
      const value = String(args || '').trim().toLowerCase();
      const next = value === 'on' ? true
        : value === 'off' ? false
          : value === '' ? !app.config.showReasoning
            : null;
      if (next === null) {
        flash(app, 'Use /thinking on or /thinking off.', 'warning');
        return;
      }
      app.config.showReasoning = next;
      saveConfig(app.config);
      app.transcriptCache.clear();
      app.requestRender();
      flash(app, `Reasoning ${next ? 'summaries shown' : 'hidden'}.`, 'success');
      return;
    }
    case 'new': {
      const title = args.trim() || 'New chat';
      app.newChat({ title, folderId: app.config.lastFolderId || null, cwd: app.cwd });
      return;
    }
    case 'sessions':
      app.openDialog({ type: 'sessions', index: 0, filter: '' });
      return;
    case 'rename': {
      const chat = currentChat(app);
      if (!chat) return;
      if (!args) {
        app.promptInput({
          title: 'rename chat',
          value: chat.title,
          hint: 'enter to save · esc to cancel',
          onSubmit: (title) => {
            if (!title) return;
            app.store.renameChat(chat.id, title);
            app.chat = app.store.getChat(chat.id) || app.chat;
            app.refreshSidebar();
            app.transcriptCache.clear();
            app.requestRender();
            flash(app, 'Chat renamed.', 'success');
          },
        });
        return;
      }
      app.store.renameChat(chat.id, args);
      app.chat = app.store.getChat(chat.id) || app.chat;
      app.refreshSidebar();
      app.transcriptCache.clear();
      app.requestRender();
      flash(app, 'Chat renamed.', 'success');
      return;
    }
    case 'delete': {
      const chat = currentChat(app);
      if (!chat) return;
      if (!guardIdle(app, 'Wait for the current turn to finish.')) return;
      app.confirm(`Delete "${truncate(chat.title, 50)}" and its messages?`, () => {
        const goalKey = typeof app.goalStoreKey === 'function' ? app.goalStoreKey(chat.id) : null;
        if (goalKey) app.store.setSetting(goalKey, '');
        app.store.deleteChat(chat.id);
        app.chat = null;
        app.messages = [];
        app.todos = [];
        app.goal = null;
        app.refreshSidebar();
        app.registry?.setChat(null);
        const next = app.store.recentChats(1)[0];
        if (next) app.loadChat(next.id);
        else app.newChat({ cwd: app.cwd, startFresh: false });
        app.transcriptCache.clear();
        app.requestRender();
        flash(app, 'Chat deleted.', 'success');
      });
      return;
    }
    case 'folders':
      app.openDialog({ type: 'folders', index: 0 });
      return;
    case 'folder': {
      const wanted = args.trim();
      if (!wanted) {
        app.openDialog({ type: 'folders', index: 0 });
        return;
      }
      if (['none', 'all', 'off'].includes(wanted.toLowerCase())) {
        app.config.lastFolderId = null;
        saveConfig(app.config);
        if (app.chat) {
          app.store.updateChat(app.chat.id, { folderId: null });
          app.chat = app.store.getChat(app.chat.id) || app.chat;
        }
        app.refreshSidebar();
        app.requestRender();
        flash(app, 'Folder cleared.', 'success');
        return;
      }
      const folder = app.folders.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase())
        || app.folders.find((entry) => entry.name.toLowerCase().includes(wanted.toLowerCase()));
      if (!folder) {
        flash(app, `No folder named "${wanted}". Create one with /folders.`, 'warning');
        return;
      }
      app.config.lastFolderId = folder.id;
      saveConfig(app.config);
      if (app.chat) {
        app.store.updateChat(app.chat.id, { folderId: folder.id });
        app.chat = app.store.getChat(app.chat.id) || app.chat;
      }
      app.refreshSidebar();
      app.requestRender();
      flash(app, `Folder: ${folder.name}.`, 'success');
      return;
    }
    case 'usage':
      await app.openUsageDialog();
      return;
    case 'plan': {
      const value = args.trim();
      if (value && !guardIdle(app, 'Wait for the current turn to finish.')) return;
      app.mode = 'plan';
      app.config.mode = 'plan';
      saveConfig(app.config);
      app.transcriptCache.clear();
      app.requestRender();
      if (value) {
        await app.sendPrompt(value);
      } else {
        flash(app, 'Plan mode on. Gatita will ask clarifying questions first.', 'success');
      }
      return;
    }
    case 'build': {
      if (!guardIdle(app)) return;
      if (args.trim()) {
        app.mode = 'build';
        app.config.mode = 'build';
        saveConfig(app.config);
        await app.sendPrompt(args.trim());
        return;
      }
      app.mode = 'build';
      app.config.mode = 'build';
      saveConfig(app.config);
      app.transcriptCache.clear();
      app.requestRender();
      if (typeof app.acceptPlan === 'function' && app.acceptPlan()) return;
      flash(app, 'Build mode on. No approved plan waiting; send a normal prompt.', 'info');
      return;
    }
    case 'goal': {
      const value = args.trim();
      const lower = value.toLowerCase();
      if (!value || lower === 'status') {
        if (!app.goal) {
          showText(app, 'goal', [
            app.styler.fg('muted', 'No goal has been set for this chat.'),
            '',
            app.styler.fg('faint', 'Use /goal <task> to make Gatita keep working until it is complete.'),
          ]);
          return;
        }
        const statusColor = app.goal.status === 'complete' ? 'success' : app.goal.status === 'blocked' ? 'warning' : 'accent';
        const elapsed = app.goal.startedAt ? ` · ${Math.max(0, Math.round(((app.goal.completedAt || app.goal.blockedAt || Date.now()) - app.goal.startedAt) / 1000))}s` : '';
        const body = [
          `${app.styler.fg(statusColor, app.goal.status)}${app.styler.fg('faint', elapsed)}`,
          '',
          app.goal.text,
        ];
        if (app.goal.summary) body.push('', app.styler.fg('muted', app.goal.summary));
        if (app.goal.status === 'active') body.push('', app.styler.fg('faint', 'Use /goal stop to end it early.'));
        showText(app, 'goal', body);
        return;
      }
      if (['stop', 'clear', 'off', 'cancel', 'done'].includes(lower)) {
        if (!guardIdle(app)) return;
        if (!app.goal) {
          flash(app, 'No goal is set.', 'muted');
          return;
        }
        app.clearGoal();
        flash(app, 'Goal cleared.', 'success');
        return;
      }
      if (!guardIdle(app)) return;
      if (!app.chat) {
        const chat = app.newChat({
          folderId: app.config.lastFolderId || null,
          cwd: app.cwd,
          startFresh: false,
        });
        if (!chat) return;
      }
      if (app.mode !== 'build') {
        app.mode = 'build';
        app.config.mode = 'build';
        saveConfig(app.config);
      }
      app.setGoal(value);
      await app.sendPrompt(value);
      return;
    }
    case 'details':
      if (typeof app.toggleWork === 'function') app.toggleWork();
      return;
    case 'reset':
      await app.useBankedReset();
      return;
    case 'admin':
      await app.runAdminCommand(args);
      return;
    case 'compact':
      compactChat(app);
      return;
    case 'clear': {
      const chat = currentChat(app);
      if (!chat) return;
      if (!guardIdle(app)) return;
      app.confirm('Clear every message in this chat?', () => {
        app.store.deleteMessages(chat.id);
        app.messages = [];
        app.todos = [];
        app.transcriptCache.clear();
        app.scrollOffset = 0;
        app.followBottom = true;
        app.requestRender();
        flash(app, 'Chat cleared.', 'success');
      });
      return;
    }
    case 'init': {
      const file = path.join(app.cwd, 'AGENTS.md');
      if (fs.existsSync(file)) {
        flash(app, 'AGENTS.md already exists. Edit it directly.', 'warning');
        return;
      }
      try {
        fs.writeFileSync(file, `${projectTemplate(app.cwd)}\n`, 'utf8');
        flash(app, 'Created AGENTS.md. Fill in any gaps.', 'success');
      } catch (error) {
        flash(app, error.message || 'Could not create AGENTS.md.', 'danger');
      }
      return;
    }
    case 'computer': {
      const value = String(args || '').trim().toLowerCase();
      if (!value || value === 'status') {
        showText(app, 'computer use', [
          `${app.styler.fg('muted', 'Status:')} ${app.computer?.available ? app.styler.fg(app.config.computerUse ? 'success' : 'faint', app.config.computerUse ? 'on' : 'off') : app.styler.fg('danger', 'unavailable')}`,
          '',
          app.styler.fg('muted', 'Gatita can move the real mouse, click, type, take screenshots, and press keys.'),
          app.styler.fg('muted', 'Every action still asks for approval unless you allow the computer group.'),
          '',
          app.styler.fg('faint', 'Use /computer on or /computer off.'),
        ]);
        return;
      }
      if (!['on', 'off'].includes(value)) {
        flash(app, 'Use /computer on, /computer off, or /computer status.', 'warning');
        return;
      }
      const enable = value === 'on';
      if (enable && !app.computer?.available) {
        flash(app, 'Computer use is only available on Windows right now.', 'danger');
        return;
      }
      app.config.computerUse = enable;
      saveConfig(app.config);
      app.requestRender();
      flash(app, `Computer use ${enable ? 'enabled' : 'disabled'}. Every action is approval-gated.`, enable ? 'warning' : 'success');
      return;
    }
    case 'skills': {
      if (!args.trim()) {
        listSkills(app);
        return;
      }
      const wanted = args.trim().toLowerCase();
      const skill = app.skills.find((entry) => entry.name === wanted)
        || app.skills.find((entry) => entry.name.includes(wanted));
      if (!skill) {
        flash(app, `No skill named "${args.trim()}".`, 'warning');
        return;
      }
      showText(app, `skill · ${skill.name}`, [
        app.styler.fg('faint', skill.path),
        '',
        ...String(skill.content || '').split('\n'),
      ]);
      return;
    }
    case 'mcp':
      await showMcp(app, args);
      return;
    case 'plugins':
      showPlugins(app);
      return;
    case 'permissions':
      app.openDialog({ type: 'permissions', index: 0 });
      return;
    case 'sound': {
      const value = String(args || '').trim().toLowerCase();
      const next = value === 'on' ? true
        : value === 'off' ? false
          : value === '' ? !(app.config.sounds !== false)
            : null;
      if (next === null) {
        flash(app, 'Use /sound on, /sound off, or /sound.', 'warning');
        return;
      }
      app.config.sounds = next;
      saveConfig(app.config);
      flash(app, `Sounds ${next ? 'on' : 'off'}.`, 'success');
      return;
    }
    case 'theme': {
      const value = String(args || '').trim().toLowerCase();
      if (!value) {
        app.toggleTheme();
        return;
      }
      if (!['dark', 'paper'].includes(value)) {
        flash(app, 'Use /theme dark or /theme paper.', 'warning');
        return;
      }
      app.config.theme = value;
      saveConfig(app.config);
      app.styler = createStyler(value, { enabled: true });
      app.transcriptCache.clear();
      app.requestRender();
      flash(app, `Theme: ${value}.`, 'success');
      return;
    }
    case 'cwd': {
      if (!args.trim()) {
        showText(app, 'workspace', [
          app.styler.fg('muted', app.cwd),
          '',
          app.styler.fg('faint', 'Use /cwd <path> to move the workspace.'),
        ]);
        return;
      }
      const raw = args.trim().replace(/^~(?=$|[\\/])/, os.homedir());
      const target = path.resolve(app.cwd, raw).replace(/[\\/]+$/, '');
      try {
        const stat = fs.statSync(target);
        if (!stat.isDirectory()) {
          flash(app, 'That path is not a directory.', 'warning');
          return;
        }
      } catch {
        flash(app, `Folder not found: ${target}`, 'danger');
        return;
      }
      if (typeof app.setCwd !== 'function') {
        app.cwd = target;
        if (app.chat) app.store.updateChat(app.chat.id, { cwd: target });
        app.messages = app.chat ? app.store.listMessages(app.chat.id) : app.messages;
        app.transcriptCache.clear();
        app.requestRender();
        flash(app, `Workspace: ${target}`, 'success');
        return;
      }
      await app.setCwd(target);
      return;
    }
    case 'image': {
      const value = args.trim();
      if (!value) {
        flash(app, 'Usage: /image <path> or /image clear.', 'muted');
        return;
      }
      if (value === 'clear' || value === 'reset') {
        const removed = app.clearComposerImages();
        flash(app, removed ? `Cleared ${removed} image${removed === 1 ? '' : 's'}.` : 'No images attached.', removed ? 'success' : 'muted');
        return;
      }
      const raw = value.replace(/^['"]|['"]$/g, '').replace(/^~(?=$|[\\/])/, os.homedir());
      const file = path.resolve(app.cwd, raw);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) throw new Error('not a file');
        if (stat.size > 5 * 1024 * 1024) {
          flash(app, 'That image is larger than 5 MB.', 'warning');
          return;
        }
        const mediaType = mimeFor(file);
        const dataUrl = `data:${mediaType};base64,${fs.readFileSync(file).toString('base64')}`;
        app.attachImage({ path: file, name: path.basename(file), mediaType, dataUrl });
      } catch {
        flash(app, `Image not found: ${file}`, 'danger');
      }
      return;
    }
    case 'copy': {
      const last = [...app.messages].reverse().find((message) => message.role === 'assistant' && message.content);
      if (!last) {
        flash(app, 'No answer to copy yet.', 'muted');
        return;
      }
      try {
        await writeClipboard(last.content);
        app.setToast ? app.setToast('Last answer copied.', 'success') : flash(app, 'Last answer copied.', 'success');
      } catch (error) {
        flash(app, `Clipboard failed: ${error.message}`, 'danger');
      }
      return;
    }
    case 'login':
      flash(app, `Run gatita-studio login, then restart. Server: ${app.config.serverUrl}`, 'info');
      return;
    case 'update': {
      await app.setFlash('Checking for updates…', 'muted');
      app.requestRender();
      try {
        const state = await checkForUpdate({ force: true });
        const notice = formatUpdateNotice(state);
        if (!notice) {
          flash(app, `Gatita Studio is up to date (${state.latestVersion || 'current'}).`, 'success');
          return;
        }
        app.confirm(`${notice.message}\nDownload and install now?`, async () => {
          try {
            flash(app, 'Downloading update…', 'muted');
            app.requestRender();
            const buffer = await downloadUpdate({ tarballUrl: state.tarball });
            flash(app, 'Installing…', 'muted');
            app.requestRender();
            installTarball(buffer, { sha256: state.sha256 });
            flash(app, 'Gatita Studio updated. Please restart to use the new version.', 'success');
          } catch (error) {
            flash(app, `Update failed: ${error.message}`, 'danger');
          }
        });
      } catch (error) {
        flash(app, `Could not check for updates: ${error.message}`, 'danger');
      }
      return;
    }
    case 'logout': {
      app.confirm('Sign out of Gatita Studio?', async () => {
        const client = app.client;
        clearStoredAuth(app.config.serverUrl);
        app.setFlash('Signed out.', 'success');
        await bestEffortLogout(client);
        app.quit();
      });
      return;
    }
    case 'version':
      showText(app, 'version', [
        `${app.styler.fg('accent', 'gatita studio')} ${CLIENT_VERSION}`,
        '',
        app.styler.fg('muted', 'node ' + process.versions.node),
        app.styler.fg('faint', '/update checks the release manifest for a newer build'),
      ]);
      return;
    case 'quit':
      app.quit();
      return;
    default: {
      const suggestion = commandSuggestions(`/${rawName}`)[0];
      if (suggestion) flash(app, `Did you mean /${suggestion.name}?`, 'warning');
      else flash(app, `Unknown command /${rawName}. Try /help.`, 'warning');
    }
  }
}
