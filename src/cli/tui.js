import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from './config.js';
import { createApiClient, ApiError } from './api.js';
import { openLocalStore } from './store.js';
import { ensureLogin } from './commands.js';
import { loadSkills } from '../skills/index.js';
import { loadPlugins } from '../plugins/index.js';
import { createMcpManager, loadMcpConfig } from '../mcp/index.js';
import { createComputerController } from '../computer/index.js';
import { createToolRegistry } from '../tools/index.js';
import { runAgent } from './agent.js';
import { checkForUpdate, formatUpdateNotice } from './update.js';
import { readClipboard, writeClipboard } from './clipboard.js';
import { playChime } from './sound.js';
import { Terminal } from './tui/terminal.js';
import { renderMarkdown, wrapPlain, roundedBox, progressBar, renderDialogBand, paintRow } from './tui/render.js';
import {
  createStyler,
  GLYPHS,
  SPINNER,
  THINKING,
  selectGlyph,
  truncateVisible,
  padEndVisible,
  visibleWidth,
  sliceVisible,
  stripAnsi,
  centerVisible,
} from './theme.js';
import {
  basenameForDisplay,
  formatClock,
  formatDuration,
  formatTokens,
  plural,
  truncate,
} from '../shared/util.js';
import { truncateToWidth } from './theme.js';
import { SLASH_COMMANDS, commandSuggestions, executeSlashCommand } from './tui/commands.js';
import { skillSuggestions, extractSkillMentions } from '../skills/index.js';

const TOOL_ICONS = {
  read: '▤',
  write: '✎',
  edit: '✎',
  ls: '▤',
  glob: '⌕',
  grep: '⌕',
  bash: '$',
  webfetch: '◈',
  websearch: '◈',
  todo: '☑',
  skill: '✦',
  computer: '▣',
  task: '◐',
};

function toolIcon(name) {
  if (TOOL_ICONS[name]) return TOOL_ICONS[name];
  if (name.startsWith('mcp__')) return '◇';
  return '⚙';
}

function makeTitle(text) {
  const first = String(text || '').trim().split(/\r?\n/)[0].replace(/\s+/g, ' ');
  if (!first) return 'New chat';
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

function reasoningLabel(level) {
  if (level === 'max') return 'deep';
  if (level === 'low') return 'brief';
  return 'off';
}

function codePointBefore(text, index) {
  if (index <= 0) return 0;
  const code = text.charCodeAt(index - 1);
  if (code >= 0xdc00 && code <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return index - 2;
  }
  return index - 1;
}

function codePointAfter(text, index) {
  if (index >= text.length) return text.length;
  const code = text.codePointAt(index);
  return index + (code > 0xffff ? 2 : 1);
}

function normalizeSelectionRange(a, b) {
  const aBefore = a.row < b.row || (a.row === b.row && a.col <= b.col);
  const start = aBefore ? a : b;
  const end = aBefore ? b : a;
  // Both ends of a drag are inclusive: the cell the finger is on belongs to the selection.
  return { start: { row: start.row, col: start.col }, end: { row: end.row, col: end.col + 1 } };
}

// Wrap multi-line copies in a markdown fence that is longer than any run of
// backticks inside the content, so the block pastes correctly anywhere.
function fenceSelectionText(text) {
  let maxRun = 0;
  for (const match of String(text).matchAll(/`+/g)) {
    if (match[0].length > maxRun) maxRun = match[0].length;
  }
  const fence = '`'.repeat(Math.max(3, maxRun + 1));
  return `${fence}\n${text}\n${fence}`;
}

export class App {
  constructor({ config, client, me, models, store, args = [] }) {
    this.config = config;
    this.client = client;
    this.me = me;
    this.models = models.data || [];
    this.defaultModel = models.defaultModel || config.defaultModel;
    this.store = store;
    this.args = args;
    this.styler = createStyler(config.theme || 'dark', { enabled: true });
    this.terminal = new Terminal();
    this.plan = me?.plan || { id: 'free', displayName: 'Free', windows: [] };
    this.quota = me?.quota || null;
    this.folders = [];
    this.recentChats = [];
    this.chat = null;
    this.messages = [];
    this.todos = [];
    this.cwd = process.cwd();
    this.modelId = config.defaultModel || this.defaultModel || 'gatita-fast';
    this.reasoning = config.reasoning || 'off';
    this.input = '';
    this.cursor = 0;
    this.promptHistory = [];
    this.historyIndex = -1;
    this.historyDraft = '';
    this.followBottom = true;
    this.scrollOffset = 0;
    this.running = false;
    this.abortController = null;
    this.stream = { active: false, text: '', reasoning: '', startedAt: 0, awaiting: false };
    this.activeTool = null;
    this.approval = null;
    this.dialog = null;
    this.flash = null;
    this.flashTimer = null;
    this.animationTick = 0;
    this.animationTimer = null;
    this.lastCtrlC = 0;
    this.expandedTools = new Set();
    this.pendingImages = [];
    this.online = true;
    this.sessionTokens = 0;
    this.lastTurnUsage = null;
    this.skills = [];
    this.plugins = null;
    this.mcp = null;
    this.computer = null;
    this.registry = null;
    this.transcriptCache = new Map();
    this.healthTimer = null;
    this.closed = false;
    this.donePromise = null;
    this.updateNotice = null;
    this.expandedReasoning = new Set();
    // Plan mode state: config.mode is the install default for new turns; planDraft
    // holds a submitted plan waiting on build acceptance.
    this.mode = ['plan', 'build'].includes(this.config.mode) ? this.config.mode : 'build';
    this.showWork = Boolean(this.config.showWork);
    this.planDraft = null;
    this.planQuestionsAsked = 0;
    // Text typed and submitted while gatita is running. It is drained into the
    // agent as real user messages after the next tool call.
    this.steeringQueue = [];
    this.lastError = null;
    this.pendingBuildPlan = null;
    this.composerScroll = 0;
    // Command/skill selector state.
    this.suggestionIndex = 0;
    // Text selection (mouse drag) state.
    this.selection = null;
    this.selectionDrag = null;
    this.lastClick = { time: 0, row: -1, column: -1, count: 0 };
    this.lastFramePlain = [];
    // Per-row selectable regions: consecutive column ranges that belong to one
    // section (sidebar, conversation, composer…). Selections cannot cross them.
    this.rowRegions = [];
    // Toast notifications (e.g. "Copied to clipboard").
    this.toast = null;
    this.toastTimer = null;
    // Injectable for tests; defaults to the OS sound player.
    this.soundPlayer = null;
    // Injectable for tests; defaults to the real clipboard.
    this.clipboard = { read: readClipboard, write: writeClipboard };
    // Open multiple-choice questions (the `ask` tool): id → { questions, openedAt, expiresAt, status, results }.
    this.questions = new Map();
    this.nextQuestionId = 0;
    this.questionTimers = new Map();
  }

  async init() {
    this.folders = this.store.listFolders();
    this.recentChats = this.store.recentChats(30);
    const lastId = this.config.lastChatId;
    if (!this.args.includes('--new') && lastId) {
      const chat = this.store.findChat(lastId);
      if (chat) this.loadChat(chat.id, { silent: true });
    }
    if (this.chat) {
      this.cwd = this.chat.cwd || this.cwd;
      this.modelId = this.chat.model || this.modelId;
      this.reasoning = this.chat.reasoning || this.reasoning;
      this.messages = this.store.listMessages(this.chat.id);
      this.todos = this.store.listTodos(this.chat.id);
    }
    this.ensureValidModel();
    try {
      this.promptHistory = JSON.parse(this.store.getSetting('prompt_history', '[]'));
      if (!Array.isArray(this.promptHistory)) this.promptHistory = [];
    } catch {
      this.promptHistory = [];
    }

    await this.buildIntegrations();
    this.refreshSidebar();
  }

  async checkUpdateOnStart() {
    try {
      const state = await checkForUpdate();
      const notice = formatUpdateNotice(state);
      if (notice) {
        this.updateNotice = notice;
        this.setFlash(`Update ${notice.latest} available. Run /update.`, 'warning');
        this.requestRender();
      }
    } catch {
      // Update checks are best-effort; never block startup.
    }
  }

  async buildIntegrations() {
    this.skills = loadSkills({ cwd: this.cwd });
    this.plugins = await loadPlugins({ cwd: this.cwd, config: this.config });
    this.mcp?.closeAll?.();
    this.mcp = createMcpManager({ cwd: this.cwd, config: this.config });
    const servers = loadMcpConfig({ cwd: this.cwd, config: this.config });
    if (Object.keys(servers).length) await this.mcp.connectAll();
    this.computer = createComputerController({ config: this.config });
    this.registry = createToolRegistry({
      cwd: this.cwd,
      config: this.config,
      store: this.store,
      chatId: this.chat?.id || null,
      computer: this.computer,
      skills: this.skills,
      mcp: this.mcp,
      askManager: {
        ask: (args) => this.presentQuestion(args),
        status: (id) => this.questionStatus(id),
      },
      planManager: {
        submit: ({ plan, questionsAsked = 0 }) => this.presentPlan(plan, questionsAsked),
      },
      pluginTools: this.plugins.tools,
      hooks: this.plugins.hooks,
      onTodos: (items) => {
        this.todos = items;
        this.requestRender();
      },
    });
  }

  async setCwd(dir) {
    const target = path.resolve(this.cwd, String(dir || '')).replace(/[\\/]+$/, '');
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      this.setFlash(`Folder not found: ${target}`, 'danger');
      return false;
    }
    if (!stat.isDirectory()) {
      this.setFlash('That path is not a directory.', 'warning');
      return false;
    }
    this.cwd = target;
    if (this.chat) {
      this.store.updateChat(this.chat.id, { cwd: target });
      this.chat = this.store.getChat(this.chat.id) || this.chat;
    }
    this.messages = this.chat ? this.store.listMessages(this.chat.id) : this.messages;
    this.transcriptCache.clear();
    await this.buildIntegrations();
    this.setFlash(`Workspace: ${target}`, 'success');
    this.requestRender();
    return true;
  }

  ensureValidModel() {
    const available = this.models.filter((model) => model.available);
    if (!available.length) return;
    const current = available.find((model) => model.id === this.modelId);
    if (!current) {
      const fallback = available.find((model) => model.id === this.defaultModel) || available.find((model) => model.default) || available[0];
      this.modelId = fallback.id;
    }
    const selected = this.model();
    if (selected && !selected.reasoningLevels.includes(this.reasoning)) {
      this.reasoning = selected.reasoningLevels.includes('off') ? 'off' : (selected.reasoningLevels[0] || 'off');
    }
  }

  model() {
    return this.models.find((entry) => entry.id === this.modelId) || this.models[0] || null;
  }

  refreshSidebar() {
    this.folders = this.store.listFolders();
    this.recentChats = this.store.recentChats(30);
  }

  loadChat(id, { silent = false } = {}) {
    const chat = this.store.findChat(id);
    if (!chat) {
      if (!silent) this.setFlash('That chat no longer exists.', 'danger');
      return false;
    }
    this.chat = chat;
    this.messages = this.store.listMessages(chat.id);
    this.todos = this.store.listTodos(chat.id);
    this.cwd = chat.cwd || this.cwd;
    this.modelId = chat.model || this.modelId;
    this.reasoning = chat.reasoning || this.reasoning;
    this.ensureValidModel();
    this.registry?.setChat(chat.id);
    this.config.lastChatId = chat.id;
    saveConfig(this.config);
    this.scrollOffset = 0;
    this.followBottom = true;
    this.transcriptCache.clear();
    this.refreshSidebar();
    this.requestRender();
    return true;
  }

  newChat({ title = 'New chat', folderId = null, cwd = this.cwd, startFresh = true } = {}) {
    if (this.running) {
      this.setFlash('Wait for the current turn to finish.', 'warning');
      return null;
    }
    const chat = this.store.createChat({
      title,
      folderId,
      model: this.modelId,
      reasoning: this.reasoning,
      cwd,
    });
    this.chat = chat;
    this.messages = [];
    this.todos = [];
    this.registry?.setChat(chat.id);
    this.config.lastChatId = chat.id;
    saveConfig(this.config);
    this.refreshSidebar();
    this.scrollOffset = 0;
    this.followBottom = true;
    this.transcriptCache.clear();
    if (startFresh) this.setFlash('New chat.', 'success');
    this.requestRender();
    return chat;
  }

  persistChat() {
    if (!this.chat) return;
    this.chat = this.store.updateChat(this.chat.id, {
      model: this.modelId,
      reasoning: this.reasoning,
      cwd: this.cwd,
    }) || this.chat;
    this.config.lastChatId = this.chat.id;
    this.config.defaultModel = this.modelId;
    this.config.reasoning = this.reasoning;
    saveConfig(this.config);
  }

  setModel(id) {
    const model = this.models.find((entry) => entry.id === id)
      || this.models.find((entry) => entry.name.toLowerCase() === String(id).toLowerCase())
      || this.models.find((entry) => entry.id.startsWith(String(id).toLowerCase()));
    if (!model) {
      this.setFlash(`No Gatita model matches "${id}".`, 'danger');
      return false;
    }
    if (!model.available) {
      this.setFlash(`${model.name} needs ${model.requiredPlan}.`, 'warning');
      return false;
    }
    this.modelId = model.id;
    if (!model.reasoningLevels.includes(this.reasoning)) {
      this.reasoning = model.reasoningLevels.includes('off') ? 'off' : (model.reasoningLevels[0] || 'off');
    }
    this.persistChat();
    this.setFlash(`Model set to ${model.name}.`, 'success');
    this.requestRender();
    return true;
  }

  setReasoning(level) {
    const model = this.model();
    const next = String(level || '').toLowerCase();
    if (!model?.reasoningLevels.length) {
      this.setFlash(`${model?.name || 'This model'} has no reasoning levels.`, 'warning');
      return false;
    }
    if (!model.reasoningLevels.includes(next)) {
      this.setFlash(`Use one of: ${model.reasoningLevels.join(', ')}.`, 'warning');
      return false;
    }
    this.reasoning = next;
    this.persistChat();
    this.setFlash(`Reasoning ${next}.`, 'success');
    this.requestRender();
    return true;
  }

  // Play a chime: once when Gatita needs the user's answer, twice when the
  // task is done. GATITA_NO_BELL and config.sounds both silence it. Set
  // GATITA_STUDIO_SOUND to an absolute path to a .wav to use your own.
  playSound(kind = 'prompt') {
    if (process.env.GATITA_NO_BELL) return;
    if (this.config.sounds === false) return;
    const custom = process.env.GATITA_STUDIO_SOUND || this.config.soundFile || '';
    const count = kind === 'done' ? 2 : 1;
    const play = this.soundPlayer || playChime;
    for (let index = 0; index < count; index += 1) {
      try {
        play(kind, custom, {
          onExhausted: () => {
            try {
              this.terminal?.bell?.();
            } catch {
              // A bell must never break the turn.
            }
          },
        });
      } catch {
        // Audio must never break the turn.
      }
    }
  }

  setFlash(text, color = 'muted') {
    this.flash = { text: String(text || ''), color, at: Date.now() };
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.requestRender(), 4200);
    this.flashTimer.unref?.();
    this.requestRender();
  }

  requestRender() {
    this.terminal?.requestRender();
  }

  startAnimation() {
    if (this.animationTimer) return;
    this.animationTimer = setInterval(() => {
      this.animationTick += 1;
      this.requestRender();
    }, 90);
    this.animationTimer.unref?.();
  }

  stopAnimation() {
    if (!this.animationTimer) return;
    clearInterval(this.animationTimer);
    this.animationTimer = null;
  }

  visibleFlash() {
    if (!this.flash) return null;
    if (Date.now() - this.flash.at > 4200) return null;
    return this.flash;
  }

  setToast(text, color = 'success') {
    this.toast = { text: String(text || ''), color, at: Date.now() };
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast = null;
      this.requestRender();
    }, 2400);
    this.toastTimer.unref?.();
    this.requestRender();
  }

  visibleToast() {
    if (!this.toast) return null;
    if (Date.now() - this.toast.at > 2400) return null;
    return this.toast;
  }

  // Shared by the composer renderer and the key handler: what the selector
  // currently shows, or null when it is hidden.
  visibleSuggestions() {
    if (this.running || this.dialog || this.approval) return null;
    const commandMatch = this.input.startsWith('/') && !this.input.includes(' ');
    const commands = commandMatch
      ? commandSuggestions(this.input, this.plugins?.commands || []).slice(0, 6)
      : [];
    const mentionMatch = /(?:^|\s)@([a-z0-9._-]*)$/i.exec(this.input || '');
    const mentions = mentionMatch
      ? skillSuggestions(String(mentionMatch[0]).replace(/^\s+/, ''), this.skills || []).slice(0, 6)
      : [];
    if (mentions.length) return { kind: 'skill', items: mentions };
    if (commands.length) return { kind: 'command', items: commands };
    return null;
  }

  suggestionSelection(items) {
    const index = Math.min(Math.max(0, this.suggestionIndex || 0), Math.max(0, items.length - 1));
    return { index, item: items[index] };
  }

  acceptSuggestion(suggestions) {
    const { item } = this.suggestionSelection(suggestions.items);
    const verb = suggestions.kind === 'skill' ? '@' : '/';
    if (!item) return;
    this.input = `${verb}${item.name} `;
    this.cursor = this.input.length;
    this.suggestionIndex = 0;
    this.requestRender();
  }

  clearSelection() {
    if (this.selection || this.selectionDrag) {
      this.selection = null;
      this.selectionDrag = null;
      this.requestRender();
    }
  }

  shimmer(text, tick) {
    if (!this.config.animations) return this.styler.fg('accent', text);
    const chars = [...text];
    const position = Math.floor(tick / 2) % (chars.length + 9) - 4;
    return chars.map((char, index) => {
      const distance = Math.abs(index - position);
      if (distance <= 2) return this.styler.fg('accent', char);
      return this.styler.fg('faint', char);
    }).join('');
  }

  layoutInput(text, cursor, width) {
    const lines = [];
    const lineStarts = [];
    let line = '';
    let col = 0;
    let cursorLine = 0;
    let cursorCol = 0;
    let index = 0;
    let lineStartIndex = 0;
    const pushLine = () => {
      lines.push(line);
      lineStarts.push(lineStartIndex);
      line = '';
      col = 0;
    };
    for (const char of String(text)) {
      if (index === cursor) {
        cursorLine = lines.length;
        cursorCol = col;
      }
      if (char === '\n') {
        pushLine();
        lineStartIndex = index + 1;
        index += 1;
        continue;
      }
      const charWidth = visibleWidth(char);
      if (col + charWidth > width) {
        pushLine();
        lineStartIndex = index;
      }
      line += char;
      col += charWidth;
      index += char.length;
    }
    if (cursor === String(text).length) {
      cursorLine = lines.length;
      cursorCol = col;
    }
    lines.push(line);
    lineStarts.push(lineStartIndex);
    return { lines, cursorLine, cursorCol, lineStarts };
  }

  async refreshAccount() {
    try {
      const me = await this.client.me({ timeoutMs: 15_000 });
      this.me = me;
      this.plan = me.plan;
      this.quota = me.quota;
      this.online = true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.setFlash('Session expired. Run gatita-studio login.', 'danger');
      } else {
        this.online = false;
      }
    }
    this.requestRender();
  }

  async sendPrompt(rawText) {
    const text = String(rawText || '').trim();
    if (!text || this.running) return;
    this.lastError = null;
    const model = this.model();
    if (!model) {
      this.setFlash('No Gatita model is available.', 'danger');
      return;
    }
    if (!model.available) {
      this.setFlash(`${model.name} needs ${model.requiredPlan}.`, 'warning');
      return;
    }
    if (this.pendingImages.length && !model.vision) {
      this.setFlash(`${model.name} cannot read images. Switch to Gatita Aura.`, 'warning');
      return;
    }

    this.pushHistory(text);
    this.input = '';
    this.cursor = 0;
    if (!this.chat) {
      this.newChat({ title: makeTitle(text), folderId: this.config.lastFolderId || null, cwd: this.cwd, startFresh: false });
    } else if (this.chat.title === 'New chat') {
      this.store.renameChat(this.chat.id, makeTitle(text));
      this.chat.title = makeTitle(text);
      this.refreshSidebar();
    }
    const images = this.pendingImages.map((image) => image.dataUrl);
    this.pendingImages = [];
    this.store.addMessage(this.chat.id, {
      role: 'user',
      content: text,
      meta: images.length ? { images } : null,
    });
    this.messages = this.store.listMessages(this.chat.id);
    this.transcriptCache.clear();
    this.followBottom = true;
    this.scrollOffset = 0;

    this.running = true;
    this.abortController = new AbortController();
    this.stream = { active: true, text: '', reasoning: '', startedAt: Date.now(), awaiting: true };
    this.activeTool = null;
    this.sessionTokens = 0;
    this.lastTurnUsage = null;
    this.startAnimation();
    this.requestRender();

    const mentionedSkills = extractSkillMentions(text, this.skills || []);
    const mentionedPrompt = mentionedSkills.length ? `The user mentioned skill(s): ${mentionedSkills.map((skill) => `@${skill.name} — ${skill.description || ''}`.trim()).join('; ')}. Use the skill tool with that name to load the full instructions before doing the work.` : '';

    const startedAt = Date.now();
    let result = null;
    try {
      result = await runAgent({
        api: this.client,
        config: this.config,
        store: this.store,
        chat: this.chat,
        cwd: this.cwd,
        model,
        plan: this.plan?.id || 'free',
        reasoning: this.reasoning,
        registry: this.registry,
        mode: this.mode,
        takeSteering: () => this.drainSteering(),
        extraPrompt: mentionedPrompt,
        approve: (request) => this.requestApproval(request),
        signal: this.abortController.signal,
        onEvent: (event) => this.onAgentEvent(event),
      });
      if (result?.aborted) {
        // Cancellation is not an error; keep the transcript honest.
        this.lastError = null;
      } else if (result?.error) {
        this.lastError = result.error.message || 'Gatita could not answer.';
      } else {
        const usageText = this.lastTurnUsage ? ` · ${formatTokens(this.lastTurnUsage.totalTokens)} tokens` : '';
        this.setFlash(`done in ${formatDuration(Date.now() - startedAt, { compact: true })}${usageText}`, 'success');
      }
    } catch (error) {
      this.lastError = String(error?.message || error || 'Something went wrong.');
    } finally {
      this.running = false;
      this.abortController = null;
      this.stream = { active: false, text: '', reasoning: '', startedAt: 0, awaiting: false };
      this.activeTool = null;
      this.stopAnimation();
      this.messages = this.store.listMessages(this.chat.id);
      this.transcriptCache.clear();
      this.todos = this.store.listTodos(this.chat.id);
      this.refreshSidebar();
      this.requestRender();
      this.refreshAccount();
      const failed = Boolean(result?.error);
      const leftover = !failed && !result?.aborted ? this.drainSteering() : [];
      if (leftover.length) await this.sendPrompt(leftover.join('\n\n'));
      const pending = this.pendingBuildPlan;
      this.pendingBuildPlan = null;
      if (pending && !failed) await this.sendPrompt(`Build this plan:\n\n${pending}`);
    }
  }

  queueSteering(rawText) {
    const text = String(rawText || '').trim();
    if (!text || !this.running) return false;
    this.steeringQueue.push(text);
    this.input = '';
    this.cursor = 0;
    this.suggestionIndex = 0;
    this.composerScroll = 0;
    this.setToast(`queued steering #${this.steeringQueue.length}`, 'accent');
    this.requestRender();
    return true;
  }

  drainSteering() {
    const items = [...this.steeringQueue];
    this.steeringQueue = [];
    return items;
  }

  pushHistory(text) {
    this.promptHistory = [text, ...this.promptHistory.filter((item) => item !== text)].slice(0, 100);
    this.historyIndex = -1;
    this.historyDraft = '';
    this.store.setSetting('prompt_history', JSON.stringify(this.promptHistory));
  }

  onAgentEvent(event) {
    switch (event.type) {
      case 'response_start':
        this.stream.awaiting = true;
        break;
      case 'text_delta':
        this.stream.text += event.delta;
        this.stream.awaiting = false;
        if (this.followBottom) this.scrollOffset = 0;
        break;
      case 'reasoning_delta':
        this.stream.reasoning += event.delta;
        this.stream.awaiting = false;
        break;
      case 'tool_start':
        this.activeTool = {
          callId: event.call.id,
          name: event.tool,
          summary: event.summary,
          args: event.args,
          startedAt: Date.now(),
        };
        break;
      case 'tool_result':
        this.activeTool = null;
        this.messages = this.store.listMessages(this.chat.id);
        this.transcriptCache.clear();
        if (event.result?.isError) {
          // Tool failures belong in the work log, not the status bar.
          this.lastError = `${event.tool || 'tool'}: ${truncate(String(event.result.output || '').replace(/\s+/g, ' ').trim(), 240)}`;
        } else {
          this.lastError = null;
        }
        break;
      case 'assistant':
        this.stream = { active: true, text: '', reasoning: '', startedAt: this.stream.startedAt, awaiting: true };
        this.messages = this.store.listMessages(this.chat.id);
        this.transcriptCache.clear();
        break;
      case 'image':
        this.messages = this.store.listMessages(this.chat.id);
        this.transcriptCache.clear();
        break;
      case 'usage':
        this.lastTurnUsage = event.totals;
        this.sessionTokens += Number(event.usage?.totalTokens || 0);
        break;
      case 'steering':
        // Agent drained the steering queue: refresh the transcript so the new
        // user turns are visible before the next tool runs.
        if (this.chat) {
          this.messages = this.store.listMessages(this.chat.id);
          this.transcriptCache.clear();
        }
        break;
      case 'notice':
        if (event.message) this.setFlash(event.message, 'info');
        break;
      case 'error':
        this.stream.active = false;
        this.lastError = String(event.error?.message || event.error || 'Gatita could not answer.');
        break;
      case 'done':
        this.stream = { active: false, text: '', reasoning: '', startedAt: 0, awaiting: false };
        this.activeTool = null;
        this.playSound('done');
        break;
      case 'aborted':
        this.stream.active = false;
        break;
      default:
        break;
    }
    this.requestRender();
  }

  requestApproval(request) {
    return new Promise((resolve) => {
      this.approval = { ...request, resolve };
      this.playSound('prompt');
      this.startAnimation();
      this.requestRender();
    });
  }

  finishApproval(approved, { remember = false, abort = false } = {}) {
    const current = this.approval;
    if (!current) return;
    this.approval = null;
    if (remember && approved) {
      const key = current.group === 'edit' ? 'edit'
        : current.group === 'write' ? 'write'
          : current.group === 'shell' ? 'shell'
            : current.group === 'computer' ? 'computer'
              : current.group === 'mcp' ? 'mcp'
                : current.group === 'plugin' ? 'plugin'
                  : current.group === 'web' ? 'web' : null;
      if (key) {
        this.config.autoApprove[key] = true;
        saveConfig(this.config);
        this.setFlash(`Allowing ${current.group} tools for this install.`, 'warning');
      }
    }
    if (abort) this.abortController?.abort();
    current.resolve(Boolean(approved));
    this.requestRender();
  }

  async executeSlash(raw) {
    const match = /^\/([A-Za-z0-9_-]+)\s*([\s\S]*)$/.exec(raw.trim());
    if (!match) {
      this.setFlash('Commands look like /help.', 'warning');
      return;
    }
    try {
      await executeSlashCommand(this, match[1].toLowerCase(), match[2].trim(), raw.trim());
    } catch (error) {
      this.setFlash(error?.message || 'Command failed.', 'danger');
    }
  }

  async openUsageDialog() {
    this.setFlash('Loading usage…', 'muted');
    try {
      const data = await this.client.usage(30);
      this.openDialog({ type: 'usage', data, scroll: 0 });
    } catch (error) {
      this.setFlash(error.message || 'Could not load usage.', 'danger');
    }
  }

  async useBankedReset() {
    if (this.running) {
      this.setFlash('Wait for the current turn to finish.', 'warning');
      return;
    }
    let summary = null;
    try {
      summary = await this.client.usageResets();
    } catch (error) {
      this.setFlash(error?.message || 'Could not check banked resets.', 'danger');
      return;
    }
    const count = Number(summary?.count || 0);
    if (count <= 0) {
      this.setFlash('No banked resets. An admin can grant you one.', 'warning');
      return;
    }
    const oldest = Number(summary?.nextExpiresAt || 0);
    const expiry = oldest ? ` · oldest expires in ${formatDuration(Math.max(0, oldest - Date.now()), { compact: true })}` : '';
    this.confirm(`Use 1 banked reset? You have ${count}${expiry}. Limits refill immediately.`, async () => {
      try {
        const result = await this.client.consumeReset();
        const left = Number(result?.bankedResets?.count ?? count - 1);
        this.setFlash(`Usage limits reset. ${left} banked reset${left === 1 ? '' : 's'} left.`, 'success');
        this.refreshAccount();
        this.requestRender();
      } catch (error) {
        this.setFlash(error?.message || 'Could not reset usage.', 'danger');
      }
    });
  }

  async runAdminCommand(args) {
    const parts = String(args || '').trim().split(/\s+/).filter(Boolean);
    const sub = (parts.shift() || '').toLowerCase();
    const rest = parts.join(' ');

    if (sub === 'resets') {
      try {
        const data = await this.client.adminListResets();
        const rows = (data?.data || []).map((entry) => {
          const scope = entry.scope === 'global' ? `global · ${entry.audience}` : `user ${entry.userId}`;
          const when = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '';
          const by = entry.createdBy != null ? ` · by ${entry.createdBy}` : '';
          const why = entry.reason ? ` · ${entry.reason}` : '';
          return `${when}  ${scope}${by}${why}`;
        });
        this.openDialog({ type: 'text', title: 'usage resets', body: rows.length ? rows : ['No resets yet.'], scroll: 0 });
      } catch (error) {
        this.setFlash(error?.message || 'Could not list resets.', 'danger');
      }
      return;
    }

    if (sub === 'reset') {
      const audience = (parts.shift() || 'all').toLowerCase();
      if (audience !== 'all' && audience !== 'paid') {
        this.setFlash('Usage: /admin reset all|paid [reason]', 'warning');
        return;
      }
      const reason = parts.join(' ') || 'manual reset';
      const label = audience === 'paid' ? 'all PAID users (Plus + Pro)' : 'ALL USERS';
      this.confirm(`Reset usage limits for ${label}? This cannot be undone.`, async () => {
        try {
          const result = await this.client.adminCreateReset({ audience, reason });
          this.setFlash(`Usage reset for ${label} (${result?.audience || audience}).`, 'success');
        } catch (error) {
          this.setFlash(error?.message || 'Could not reset usage.', 'danger');
        }
      });
      return;
    }

    if (sub === 'grant-reset') {
      const target = (parts.shift() || '').toLowerCase();
      if (!target) {
        this.setFlash('Usage: /admin grant-reset <email|all|paid> [count] [reason]', 'warning');
        return;
      }
      let count = Number(parts[0]);
      if (!Number.isFinite(count) || count < 1) count = 1;
      else parts.shift();
      const reason = parts.join(' ') || '';
      if (target === 'all' || target === 'paid') {
        const recipients = target === 'paid' ? 'all paid users (Plus + Pro)' : 'EVERY account';
        this.confirm(`Grant ${count} banked reset${count === 1 ? '' : 's'} to ${recipients}?`, async () => {
          try {
            const result = await this.client.adminGrantResets({ audience: target, count, reason });
            this.setFlash(`Granted ${result?.granted ?? count} banked resets across ${result?.recipients ?? '?'} accounts.`, 'success');
          } catch (error) {
            this.setFlash(error?.message || 'Could not grant resets.', 'danger');
          }
        });
        return;
      }
      if (!target.includes('@')) {
        this.setFlash('Provide an email, or "all" / "paid" to grant to an audience.', 'warning');
        return;
      }
      try {
        const result = await this.client.adminGrantResets({ email: target, count, reason });
        this.setFlash(`Granted ${result?.granted ?? count} banked reset${count === 1 ? '' : 's'} to ${target}.`, 'success');
      } catch (error) {
        this.setFlash(error?.message || 'Could not grant resets.', 'danger');
      }
      return;
    }

    this.setFlash('Admin commands: /admin reset all|paid [reason] · /admin grant-reset <email|all|paid> [count] [reason] · /admin resets', 'warning');
  }

  openDialog(dialog) {
    this.dialog = dialog;
    this.requestRender();
  }

  closeDialog() {
    const dialog = this.dialog;
    this.dialog = null;
    if (dialog?.resolve) dialog.resolve(false);
    if (dialog?.type === 'ask') {
      const entry = this.questions.get(dialog.questionId);
      if (entry && entry.status === 'waiting') entry.status = 'cancelled';
      const timer = this.questionTimers.get(dialog.questionId);
      if (timer) clearTimeout(timer);
      this.questionTimers.delete(dialog.questionId);
    }
    if (this.pendingQuestionId && !this.dialog) {
      const pending = this.pendingQuestionId;
      this.pendingQuestionId = null;
      const entry = this.questions.get(pending);
      if (entry && entry.status === 'waiting') {
        this.openDialog({ type: 'ask', questionId: pending, index: 0, selected: new Set(), cursor: 0 });
      }
    }
    this.requestRender();
  }

  confirm(message, onYes) {
    return new Promise((resolve) => {
      this.playSound('prompt');
      this.openDialog({
        type: 'confirm',
        message,
        resolve: (value) => {
          this.dialog = null;
          this.requestRender();
          if (value) onYes?.();
          resolve(value);
        },
      });
    });
  }

  promptInput({ title, value = '', hint = '', onSubmit }) {
    this.openDialog({
      type: 'input',
      title,
      value,
      cursor: value.length,
      hint,
      onSubmit: (text) => {
        this.dialog = null;
        this.requestRender();
        onSubmit?.(text);
      },
    });
  }

  toggleTheme() {
    this.config.theme = this.config.theme === 'paper' ? 'dark' : 'paper';
    saveConfig(this.config);
    this.styler = createStyler(this.config.theme, { enabled: true });
    this.transcriptCache.clear();
    this.setFlash(`Theme: ${this.config.theme}.`, 'success');
  }

  scrollBy(delta) {
    const total = this.transcriptLineCount;
    const viewport = this.conversationHeight || 1;
    const maxOffset = Math.max(0, total - viewport);
    this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
    this.followBottom = this.scrollOffset === 0;
    this.requestRender();
  }

  handleKey(key) {
    if (key.name === 'paste') {
      const askOpen = this.dialog?.type === 'ask' && this.dialog.otherOpen && !this.approval;
      if (this.approval) return;
      if (this.dialog && !askOpen) return;
      const pasted = key.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (askOpen) {
        const dialog = this.dialog;
        const text = dialog.otherText || '';
        const cur = Math.min(dialog.otherCursor || 0, text.length);
        dialog.otherText = (text.slice(0, cur) + pasted.split('\n')[0] + text.slice(cur)).slice(0, 2_000);
        dialog.otherCursor = Math.min(dialog.otherText.length, cur + pasted.split('\n')[0].length);
        this.requestRender();
      } else {
        this.insertText(pasted);
      }
      return;
    }
    if (key.name === 'mouse') {
      this.handleMouse(key);
      return;
    }
    if (key.ctrl && key.text === 'c') {
      if (this.approval) {
        this.finishApproval(false, { abort: true });
        return;
      }
      if (this.running) {
        this.abortController?.abort();
        this.setFlash('Stopping…', 'warning');
        return;
      }
      if (this.input) {
        this.input = '';
        this.cursor = 0;
        this.suggestionIndex = 0;
        this.requestRender();
        return;
      }
      const now = Date.now();
      if (now - this.lastCtrlC < 1200) {
        this.quit();
        return;
      }
      this.lastCtrlC = now;
      this.setFlash('Press ctrl+c again to quit.', 'warning');
      return;
    }
    if (key.ctrl && key.text === 'd' && !this.input && !this.running && !this.dialog && !this.approval) {
      this.quit();
      return;
    }
    if (key.ctrl && key.text === 'l') {
      this.requestRender();
      return;
    }
    if (this.approval) {
      this.handleApprovalKey(key);
      return;
    }
    if (this.dialog) {
      this.handleDialogKey(key);
      return;
    }
    if (key.name === 'pageup' || (key.shift && key.name === 'up')) {
      this.scrollBy(8);
      return;
    }
    if (key.name === 'pagedown' || (key.shift && key.name === 'down')) {
      this.scrollBy(-8);
      return;
    }
    if (key.name === 'escape') {
      this.clearSelection();
      if (this.running) {
        this.abortController?.abort();
        this.setFlash('Stopping…', 'warning');
      } else if (this.input) {
        this.input = '';
        this.cursor = 0;
        this.suggestionIndex = 0;
        this.requestRender();
      }
      return;
    }
    if (key.ctrl && key.text === 'o') {
      this.toggleLastTool();
      return;
    }
    if (key.ctrl && key.text === 't') {
      this.toggleWork();
      return;
    }
    if (key.ctrl && key.text === 'r') {
      this.toggleThinking();
      return;
    }
    if (key.name === 'm' && !key.ctrl && !key.alt && !this.dialog && !this.approval && !this.running) {
      this.toggleMinimizedThoughts();
      return;
    }
    // While running, the composer stays editable: enter queues a steering
    // message (see submitInput) and arrow keys still move inside it.
    const suggestions = this.visibleSuggestions();
    if (key.name === 'up' && suggestions) {
      this.suggestionIndex = Math.max(0, this.suggestionSelection(suggestions.items).index - 1);
      this.requestRender();
      return;
    }
    if (key.name === 'down' && suggestions) {
      this.suggestionIndex = Math.min(suggestions.items.length - 1, this.suggestionSelection(suggestions.items).index + 1);
      this.requestRender();
      return;
    }
    if (key.name === 'enter' && !key.alt && !key.shift) {
      if (suggestions && !key.ctrl) {
        const selected = this.suggestionSelection(suggestions.items).item;
        // An input that is exactly the selected slash command runs it.
        if (selected && suggestions.kind === 'command' && this.input.trim() === `/${selected.name}`) {
          this.submitInput();
          return;
        }
        this.acceptSuggestion(suggestions);
        return;
      }
      if (this.input.trim()) this.submitInput();
      return;
    }
    if (key.name === 'newline' || (key.name === 'enter' && (key.alt || key.shift))) {
      this.insertText('\n');
      return;
    }
    if (key.name === 'tab') {
      this.handleTab(suggestions);
      return;
    }
    if (key.name === 'backspace') {
      const before = codePointBefore(this.input, this.cursor);
      this.input = this.input.slice(0, before) + this.input.slice(this.cursor);
      this.cursor = before;
      this.suggestionIndex = 0;
      this.requestRender();
      return;
    }
    if (key.name === 'delete') {
      const after = codePointAfter(this.input, this.cursor);
      this.input = this.input.slice(0, this.cursor) + this.input.slice(after);
      this.suggestionIndex = 0;
      this.requestRender();
      return;
    }
    if (key.name === 'left') {
      if (key.ctrl) this.cursor = this.lineStart(this.cursor);
      else this.cursor = codePointBefore(this.input, this.cursor);
      this.requestRender();
      return;
    }
    if (key.name === 'right') {
      if (key.ctrl) this.cursor = this.lineEnd(this.cursor);
      else this.cursor = codePointAfter(this.input, this.cursor);
      this.requestRender();
      return;
    }
    if (key.name === 'home' || (key.ctrl && key.text === 'a')) {
      this.cursor = 0;
      this.requestRender();
      return;
    }
    if (key.name === 'end' || (key.ctrl && key.text === 'e')) {
      this.cursor = this.input.length;
      this.requestRender();
      return;
    }
    if (key.name === 'up') {
      if (!this.input) this.historyPrev();
      else this.moveLine(-1);
      return;
    }
    if (key.name === 'down') {
      if (!this.input) this.historyNext();
      else this.moveLine(1);
      return;
    }
    if (key.ctrl && key.text === 'u') {
      const start = this.lineStart(this.cursor);
      this.input = this.input.slice(0, start) + this.input.slice(this.cursor);
      this.cursor = start;
      this.suggestionIndex = 0;
      this.requestRender();
      return;
    }
    if (key.ctrl && key.text === 'k') {
      const end = this.lineEnd(this.cursor);
      this.input = this.input.slice(0, this.cursor) + this.input.slice(end);
      this.suggestionIndex = 0;
      this.requestRender();
      return;
    }
    if (key.ctrl && key.text === 'w') {
      this.deleteWord();
      return;
    }
    if (key.name === 'text' || key.name === 'char') {
      this.insertText(key.text);
    }
  }

  insertText(text) {
    if (!text) return;
    const clean = String(text).slice(0, 100_000);
    this.input = this.input.slice(0, this.cursor) + clean + this.input.slice(this.cursor);
    this.cursor += clean.length;
    this.suggestionIndex = 0;
    this.followBottom = true;
    this.requestRender();
  }

  lineStart(index) {
    const before = this.input.slice(0, index);
    const newline = before.lastIndexOf('\n');
    return newline + 1;
  }

  lineEnd(index) {
    const after = this.input.indexOf('\n', index);
    return after === -1 ? this.input.length : after;
  }

  composerTextWidth() {
    const inner = Math.max(8, (this.terminal?.columns || 80) - 2);
    return Math.max(4, inner - 2);
  }

  moveLine(direction) {
    // Navigation works on visual (wrapped) lines, not logical newlines, so the
    // arrows do what your eyes did with the cursor.
    const layout = this.layoutInput(this.input, this.cursor, this.composerTextWidth());
    const from = layout.cursorLine;
    const to = Math.max(0, Math.min(layout.lines.length - 1, from + direction));
    if (to === from) return;
    const column = layout.cursorCol;
    const targetStart = layout.lineStarts[to];
    const targetLimit = to + 1 < layout.lineStarts.length ? layout.lineStarts[to + 1] : this.input.length;
    let index = targetStart;
    let visible = 0;
    while (index < targetLimit) {
      if (this.input[index] === '\n') break;
      const code = this.input.codePointAt(index);
      const length = code > 0xffff ? 2 : 1;
      const width = visibleWidth(this.input.slice(index, index + length));
      if (visible + width > column) break;
      visible += width;
      index += length;
    }
    this.cursor = index;
    this.requestRender();
  }

  deleteWord() {
    let index = this.cursor;
    while (index > 0 && /\s/.test(this.input[index - 1])) index -= 1;
    while (index > 0 && !/\s/.test(this.input[index - 1])) index -= 1;
    this.input = this.input.slice(0, index) + this.input.slice(this.cursor);
    this.cursor = index;
    this.suggestionIndex = 0;
    this.requestRender();
  }

  historyPrev() {
    if (!this.promptHistory.length) return;
    if (this.historyIndex === -1) {
      this.historyDraft = this.input;
      this.historyIndex = 0;
    } else if (this.historyIndex < this.promptHistory.length - 1) {
      this.historyIndex += 1;
    } else {
      return;
    }
    this.input = this.promptHistory[this.historyIndex];
    this.cursor = this.input.length;
    this.suggestionIndex = 0;
    this.requestRender();
  }

  historyNext() {
    if (this.historyIndex === -1) return;
    if (this.historyIndex > 0) {
      this.historyIndex -= 1;
      this.input = this.promptHistory[this.historyIndex];
    } else {
      this.historyIndex = -1;
      this.input = this.historyDraft;
    }
    this.cursor = this.input.length;
    this.suggestionIndex = 0;
    this.requestRender();
  }

  handleTab(suggestions = this.visibleSuggestions()) {
    if (suggestions) {
      this.acceptSuggestion(suggestions);
      return;
    }
    this.insertText('  ');
  }

  submitInput() {
    const value = this.input;
    this.cursor = 0;
    this.suggestionIndex = 0;
    this.composerScroll = 0;
    // While gatita is working, everything you submit becomes steering text.
    if (this.running && value.trim()) {
      this.queueSteering(value);
      return;
    }
    // A pasted multi-line snippet that merely starts with / is not a command.
    if (!value.includes('\n') && value.trim().startsWith('/')) {
      this.input = '';
      this.executeSlash(value.trim());
      return;
    }
    this.sendPrompt(value);
  }

  toggleLastTool() {
    const toolMessages = this.messages.filter((message) => message.role === 'tool');
    const last = toolMessages[toolMessages.length - 1];
    if (!last) {
      this.setFlash('No tool output to expand.', 'muted');
      return;
    }
    const key = last.toolCallId || last.id;
    if (this.expandedTools.has(key)) this.expandedTools.delete(key);
    else this.expandedTools.add(key);
    this.transcriptCache.clear();
    this.requestRender();
  }

  toggleMinimizedThoughts() {
    const messagesWithReasoning = this.messages.filter((message) => message.role === 'assistant' && message.reasoning);
    if (!messagesWithReasoning.length) {
      this.setFlash('No thoughts to minimize.', 'muted');
      return;
    }
    const allExpanded = messagesWithReasoning.every((message) => this.expandedReasoning.has(message.id));
    if (allExpanded) {
      for (const message of messagesWithReasoning) this.expandedReasoning.delete(message.id);
      this.setFlash('Thoughts minimized.', 'success');
    } else {
      for (const message of messagesWithReasoning) this.expandedReasoning.add(message.id);
      this.setFlash('Thoughts expanded.', 'success');
    }
    this.transcriptCache.clear();
    this.requestRender();
  }

  toggleSound() {
    const next = this.config.sounds === false;
    this.config.sounds = next;
    saveConfig(this.config);
    this.requestRender();
    this.setFlash(`Sounds ${next ? 'on' : 'off'}.`, 'success');
  }

  settingsEntries() {
    const onOff = (value) => (value ? 'on' : 'off');
    return [
      { key: 'plan', label: 'plan mode', value: onOff(this.mode === 'plan'), toggle: () => this.togglePlanMode() },
      { key: 'thinking', label: 'thinking', value: onOff(this.thinkingExpanded()), toggle: () => this.toggleThinking() },
      { key: 'work', label: 'work details', value: onOff(this.showWork), toggle: () => this.toggleWork() },
      { key: 'sound', label: 'sounds', value: onOff(this.config.sounds !== false), toggle: () => this.toggleSound() },
      { key: 'theme', label: 'theme', value: this.config.theme || 'dark', toggle: () => this.toggleTheme() },
      { key: 'permissions', label: 'tool approvals', value: 'open', toggle: () => this.openDialog({ type: 'permissions', index: 0 }) },
    ];
  }

  openSettings() {
    this.openDialog({ type: 'settings', index: 0 });
  }

  toggleWork() {
    this.showWork = !this.showWork;
    this.config.showWork = this.showWork;
    saveConfig(this.config);
    this.transcriptCache.clear();
    this.requestRender();
    this.setFlash(this.showWork ? 'Work details shown.' : 'Work details hidden.', 'success');
  }

  thinkingExpanded() {
    const messages = Array.isArray(this.messages) ? this.messages : [];
    const withThoughts = messages.filter((message) => message.role === 'assistant' && message.reasoning);
    return withThoughts.length > 0 && withThoughts.every((message) => this.expandedReasoning.has(message.id));
  }

  toggleThinking() {
    // A visible button should reveal the actual thought text, so this mirrors
    // m rather than the collapsed config summary.
    this.toggleMinimizedThoughts();
  }

  togglePlanMode() {
    if (this.running) {
      this.setFlash('Wait for the current turn to finish.', 'warning');
      return null;
    }
    this.mode = this.mode === 'plan' ? 'build' : 'plan';
    this.config.mode = this.mode;
    saveConfig(this.config);
    this.transcriptCache.clear();
    this.requestRender();
    this.setToast(this.mode === 'plan' ? 'plan mode' : 'build mode', 'accent');
    return this.mode;
  }

  presentPlan(plan, questionsAsked = 0) {
    const text = String(plan || '').trim();
    if (!text) return false;
    this.planDraft = text;
    this.planQuestionsAsked = Number(questionsAsked) || 0;
    this.transcriptCache.clear();
    this.openDialog({ type: 'plan', scroll: 0, questionsAsked: this.planQuestionsAsked });
    return true;
  }

  acceptPlan() {
    const plan = this.planDraft;
    if (!plan) return false;
    this.mode = 'build';
    this.config.mode = 'build';
    this.planDraft = null;
    this.planQuestionsAsked = 0;
    saveConfig(this.config);
    this.transcriptCache.clear();
    if (this.dialog?.type === 'plan') this.dialog = null;
    if (this.running) {
      // The current turn still has to finish before build mode can start.
      this.pendingBuildPlan = plan;
      this.setToast('build starts when the current turn ends', 'accent');
      this.requestRender();
      return true;
    }
    this.requestRender();
    void this.sendPrompt(`Build this plan:\n\n${plan}`);
    return true;
  }

  // --- The `ask` tool: present multiple-choice questions on behalf of the agent ---

  presentQuestion({ questions, timeoutMs = 300_000 }) {
    const id = `q-${Date.now().toString(36)}-${(this.nextQuestionId += 1)}`;
    const entry = {
      questions,
      openedAt: Date.now(),
      expiresAt: Date.now() + Math.max(5_000, Number(timeoutMs) || 300_000),
      status: 'waiting',
      results: null,
    };
    this.questions.set(id, entry);
    const timer = setTimeout(() => this.expireQuestion(id), Math.max(5_000, entry.expiresAt - Date.now()));
    timer.unref?.();
    this.questionTimers.set(id, timer);
    if (!this.dialog) {
      this.openDialog({ type: 'ask', questionId: id, index: 0, selected: new Set(), cursor: 0 });
    } else {
      // Queue behind whatever dialog is open right now.
      this.pendingQuestionId = id;
    }
    this.requestRender();
    return { questionId: id };
  }

  expireQuestion(id) {
    const entry = this.questions.get(id);
    if (!entry || entry.status !== 'waiting') return;
    entry.status = 'timedOut';
    this.questionTimers.delete(id);
    if (this.pendingQuestionId === id) this.pendingQuestionId = null;
    if (this.dialog?.type === 'ask' && this.dialog.questionId === id) {
      this.dialog.expired = true;
    }
    if (entry.status === 'timedOut') {
      this.playSound('prompt');
      this.setFlash('The question timed out after 5 minutes. Gatita is cancelling the task and cleaning up.', 'warning');
    }
    if (this.dialog?.questionId === id) {
      this.dialog.resolve?.(false);
    }
    this.requestRender();
  }

  questionStatus(id) {
    const entry = this.questions.get(id);
    if (!entry) return null;
    return { ...entry, answered: entry.status === 'answered', timedOut: entry.status === 'timedOut' };
  }

  answerQuestion(id, result) {
    const entry = this.questions.get(id);
    if (!entry || entry.status !== 'waiting') return false;
    entry.status = 'answered';
    entry.results = result;
    const timer = this.questionTimers.get(id);
    if (timer) clearTimeout(timer);
    this.questionTimers.delete(id);
    if (this.pendingQuestionId === id) this.pendingQuestionId = null;
    if (this.dialog?.questionId === id) {
      this.dialog.resolve?.(true);
      this.dialog = null;
    }
    const summaryLines = (Array.isArray(result) ? result : []).map((answer) => {
      const value = answer.other || answer.text
        || (Array.isArray(answer.selectedLabels) ? answer.selectedLabels.join(', ') : '');
      return `- ${answer.question} -> ${value || '(no selection)'}`;
    });
    if (this.chat && summaryLines.length) {
      try {
        this.store.addMessage(this.chat.id, {
          role: 'tool',
          name: 'ask',
          content: summaryLines.join('\n'),
          toolCallId: `ask-${id}`,
          meta: { isError: false, title: 'Asked user' },
        });
      } catch {
        // Persisting the answer is a nice-to-have, never fatal.
      }
    }
    this.playSound('done');
    this.requestRender();
    return true;
  }

  closeQuestionWithoutAnswer(id) {
    const entry = this.questions.get(id);
    if (!entry) return;
    // Keep the terminal entry around: ask_status must still report its state
    // (cancelled after esc, timedOut after 5 minutes) to the agent.
    const timer = this.questionTimers.get(id);
    if (timer) clearTimeout(timer);
    this.questionTimers.delete(id);
    if (this.pendingQuestionId === id) this.pendingQuestionId = null;
    if (this.dialog?.questionId === id) {
      this.dialog.resolve?.(false);
      this.dialog = null;
    }
    if (this.pendingQuestionId && !this.dialog) {
      const pending = this.pendingQuestionId;
      this.pendingQuestionId = null;
      const next = this.questions.get(pending);
      if (next && next.status === 'waiting') {
        this.openDialog({ type: 'ask', questionId: pending, index: 0, selected: new Set(), cursor: 0 });
      }
    }
    this.requestRender();
  }

  askDialogState() {
    const dialog = this.dialog;
    if (!dialog || dialog.type !== 'ask') return null;
    const entry = this.questions.get(dialog.questionId);
    if (!entry) return null;
    return { dialog, entry };
  }

  handleAskKey(key) {
    const { dialog, entry } = this.askDialogState() || {};
    if (!dialog || !entry) return;
    if (dialog.expired) {
      if (key.name === 'escape' || key.name === 'enter') {
        this.closeQuestionWithoutAnswer(dialog.questionId);
      }
      this.requestRender();
      return;
    }
    if (key.name === 'escape') {
      entry.status = 'cancelled';
      this.closeQuestionWithoutAnswer(dialog.questionId);
      this.setFlash('Question closed. Gatita will pick a safe default or ask again.', 'warning');
      return;
    }
    const current = entry.questions[dialog.index] || entry.questions[0];
    if (!current) return;
    const draftKey = dialog.questionId;
    const commitCurrent = () => {
      // Single-select commits get appended at pick time; multi-select commits
      // whichever options are checked. Either way the draft grows by one.
      const picked = current.multiSelect
        ? current.options.filter((option) => dialog.selected.has(`${current.id}:${option.id}`))
        : (dialog.singlePick != null ? [current.options[dialog.singlePick]] : []);
      const record = dialog.singlePick != null
        ? { question: current.question, selectedOptions: [picked[0].id], selectedLabels: [picked[0].label], other: '', text: '' }
        : { question: current.question, selectedOptions: picked.map((option) => option.id), selectedLabels: picked.map((option) => option.label), other: '', text: '' };
      const next = this.askDraft?.[draftKey] || [];
      next.push(record);
      this.askDraft = { ...(this.askDraft || {}), [draftKey]: next };
      dialog.singlePick = null;
    };
    const advance = () => {
      const atLast = dialog.index >= entry.questions.length - 1;
      if (atLast) {
        const results = this.askDraft?.[draftKey] || [];
        delete this.askDraft[draftKey];
        this.answerQuestion(draftKey, results);
      } else {
        this.openDialog({ type: 'ask', questionId: draftKey, index: dialog.index + 1, selected: dialog.selected, cursor: 0 });
        this.requestRender();
      }
    };
    const commitCurrentOther = (value) => {
      const next = this.askDraft?.[draftKey] || [];
      next.push({ question: current.question, selectedOptions: [], selectedLabels: [], other: value, text: value });
      this.askDraft = { ...(this.askDraft || {}), [draftKey]: next };
      advance();
    };

    // Editing "other" text takes priority over option picking.
    if (dialog.otherOpen) {
      const text = dialog.otherText || '';
      const cur = Math.min(dialog.otherCursor || 0, text.length);
      if (key.name === 'enter') {
        const value = text.trim();
        if (!value) return;
        commitCurrentOther(value);
        return;
      }
      if (key.name === 'backspace') {
        dialog.otherText = text.slice(0, Math.max(0, cur - 1)) + text.slice(cur);
        dialog.otherCursor = Math.max(0, cur - 1);
      } else if (key.name === 'delete') {
        dialog.otherText = text.slice(0, cur) + text.slice(cur + 1);
      } else if (key.name === 'left') {
        dialog.otherCursor = Math.max(0, cur - 1);
      } else if (key.name === 'right') {
        dialog.otherCursor = Math.min(text.length, cur + 1);
      } else if (key.name === 'text' || key.name === 'char') {
        dialog.otherText = (text.slice(0, cur) + key.text + text.slice(cur)).slice(0, 2_000);
        dialog.otherCursor = cur + key.text.length;
      }
      this.requestRender();
      return;
    }

    if (key.name === 'up' || key.name === 'down') {
      const count = current.options.length + 1;
      const delta = key.name === 'up' ? -1 : 1;
      dialog.cursor = Math.max(0, Math.min(count - 1, (dialog.cursor || 0) + delta));
      this.requestRender();
      return;
    }
    if (key.name === 'tab') {
      if (current.multiSelect) commitCurrent();
      dialog.otherOpen = false;
      advance();
      return;
    }
    if (key.name === 'enter') {
      const cursor = dialog.cursor || 0;
      const isOther = cursor === current.options.length;
      if (isOther) {
        dialog.otherOpen = true;
        dialog.otherText = '';
        dialog.otherCursor = 0;
        this.requestRender();
        return;
      }
      const option = current.options[cursor];
      if (current.multiSelect) {
        const optionKey = `${current.id}:${option.id}`;
        if (dialog.selected.has(optionKey)) dialog.selected.delete(optionKey);
        else dialog.selected.add(optionKey);
        this.requestRender();
        return;
      }
      dialog.singlePick = cursor;
      commitCurrent();
      advance();
      return;
    }
    this.requestRender();
  }

  sameRowHits(row) {
    return Array.isArray(row) ? row : (row ? [row] : []);
  }

  hitAtColumn(row, column) {
    const col = Math.max(0, Number(column) - 1);
    return this.sameRowHits(row).find((hit) => {
      const start = Number(hit?.col ?? 0);
      const width = Number(hit?.width);
      const size = Number.isFinite(width) ? Math.max(0, width) : Number.POSITIVE_INFINITY;
      return col >= start && col < start + size;
    }) || null;
  }

  addHit(row, hit) {
    if (!hit) return;
    if (!this.hitRegions) return;
    const incoming = Array.isArray(hit) ? hit : [hit];
    const combined = [...this.sameRowHits(this.hitRegions[row]), ...incoming.filter(Boolean)];
    this.hitRegions[row] = combined.length === 1 ? combined[0] : combined;
  }

  handleMouse(key) {
    const { button, press, row, column } = key;
    if (button === 64 || button === 65) {
      const direction = button === 64 ? 1 : -1;
      if (this.dialog) {
        // List dialogs move selection; scrollable dialogs scroll their body
        if (this.dialog.type === 'models' || this.dialog.type === 'sessions' || this.dialog.type === 'permissions' || this.dialog.type === 'folders') {
          this.dialog.index = Math.max(0, (this.dialog.index || 0) - direction * 1);
          const count = this.dialogItemCount(this.dialog);
          this.dialog.index = Math.min(Math.max(0, count - 1), this.dialog.index);
        } else if (['usage', 'text', 'help', 'plan'].includes(this.dialog.type)) {
          this.dialog.scroll = Math.max(0, (this.dialog.scroll || 0) - direction * 2);
        }
        this.requestRender();
        return;
      }
      this.scrollBy(direction * 4);
      return;
    }
    // Right click pastes the clipboard into the composer (or the open input dialog).
    if (button === 2 && press) {
      this.pasteFromClipboard();
      return;
    }
    if (button === 0 && press) {
      // Clicking anything clears any visible selection.
      this.selection = null;
      const index = Number(row) - 1;
      const hit = this.hitAtColumn(this.hitRegions?.[index], column);
      if (hit) {
        this.selectionDrag = null;
        this.invokeHitRegion(hit, column);
        this.requestRender();
        return;
      }
      const cell = { row: Math.max(0, index), col: Math.max(0, Number(column) - 1) };
      const drag = this.makeSelectionDrag(cell);
      if (!drag) {
        this.selectionDrag = null;
        this.requestRender();
        return;
      }
      this.selectionDrag = drag;
      this.requestRender();
      return;
    }
    // Left-button motion while held (reported as button 32 with SGR 1002).
    if (button === 32) {
      const drag = this.selectionDrag;
      if (!drag) return;
      const bounds = drag.bounds;
      const cell = {
        row: Math.max(bounds.rowStart, Math.min(bounds.rowEnd, Number(row) - 1)),
        col: Math.max(bounds.colStart, Math.min(bounds.colEnd, Number(column) - 1)),
      };
      drag.current = cell;
      if (cell.row !== drag.anchor.row || cell.col !== drag.anchor.col) drag.dragging = true;
      if (drag.dragging) this.selection = { ...normalizeSelectionRange(drag.anchor, drag.current), bounds };
      this.requestRender();
      return;
    }
    if (button === 0 && !press) {
      const drag = this.selectionDrag;
      this.selectionDrag = null;
      if (drag?.dragging && this.selection) {
        const selection = this.selection;
        this.selection = null;
        void this.copySelection(selection);
        this.requestRender();
        return;
      }
      if (!drag) return;
      this.selection = null;
      const rowIndex = Math.max(0, Number(row) - 1);
      const colIndex = Math.max(0, Number(column) - 1);
      const now = Date.now();
      const same = this.lastClick.row === rowIndex && this.lastClick.column === colIndex && now - this.lastClick.time < 450;
      this.lastClick = { time: now, row: rowIndex, column: colIndex, count: same ? this.lastClick.count + 1 : 1 };
      if (this.lastClick.count === 2) this.selectWordAt(rowIndex, colIndex);
      else if (this.lastClick.count >= 3) {
        this.selectLineAt(rowIndex, colIndex);
        this.lastClick.count = 0;
      }
      return;
    }
  }

  invokeHitRegion(hit, column) {
    switch (hit.type) {
      case 'suggestion':
        this.input = hit.text;
        this.cursor = this.input.length;
        this.suggestionIndex = 0;
        this.requestRender();
        return;
      case 'resume': {
        if (this.running) {
          this.setFlash('Wait for the current turn to finish.', 'warning');
          return;
        }
        if (this.loadChat(hit.id)) this.setFlash('Chat opened.', 'success');
        return;
      }
      case 'folder': {
        this.config.lastFolderId = hit.id ?? null;
        saveConfig(this.config);
        if (this.chat) {
          this.store.updateChat(this.chat.id, { folderId: hit.id ?? null });
          this.chat = this.store.getChat(this.chat.id) || this.chat;
        }
        this.refreshSidebar();
        this.setFlash(hit.id ? 'Folder selected.' : 'Showing all chats.', 'success');
        return;
      }
      case 'new-chat':
        this.newChat({ folderId: this.config.lastFolderId || null, cwd: this.cwd });
        return;
      case 'use-plan':
        this.acceptPlan();
        return;
      case 'toggle-plan':
        this.togglePlanMode();
        return;
      case 'toggle-thinking':
        this.toggleThinking();
        return;
      case 'toggle-work':
        this.toggleWork();
        return;
      case 'open-usage':
        void this.openUsageDialog();
        return;
      case 'open-settings':
        this.openSettings();
        return;
      case 'setting': {
        if (this.dialog?.type !== 'settings') return;
        const entries = this.settingsEntries();
        const index = entries.findIndex((entry) => entry.key === hit.key);
        if (index < 0) return;
        if ((this.dialog.index || 0) === index) {
          this.handleDialogKey({ name: 'enter' });
        } else {
          this.dialog.index = index;
          this.requestRender();
        }
        return;
      }
      case 'new-folder':
        this.promptInput({
          title: 'new folder',
          hint: 'name',
          onSubmit: (name) => {
            const wanted = String(name || '').trim();
            if (!wanted) return;
            const folder = this.store.createFolder({ name: wanted, folderPath: this.cwd });
            this.config.lastFolderId = folder.id;
            saveConfig(this.config);
            this.refreshSidebar();
            this.setFlash(`Folder ${folder.name} created.`, 'success');
          },
        });
        return;
      case 'model':
        this.closeDialog();
        this.setModel(hit.id);
        return;
      case 'session': {
        if (this.running) {
          this.setFlash('Wait for the current turn to finish.', 'warning');
          return;
        }
        this.closeDialog();
        if (this.loadChat(hit.id)) this.setFlash('Chat opened.', 'success');
        return;
      }
      case 'open-folders':
        this.openDialog({ type: 'folders', index: 0 });
        return;
      case 'permission': {
        this.config.autoApprove[hit.key] = !this.config.autoApprove[hit.key];
        saveConfig(this.config);
        this.requestRender();
        return;
      }
      case 'confirm': {
        const mid = Math.floor((this.terminal.columns || 80) / 2);
        const accept = column <= mid;
        const current = this.dialog;
        if (current?.type === 'confirm') {
          this.dialog = null;
          this.requestRender();
          current.resolve?.(accept);
        }
        return;
      }
      case 'ask-option': {
        if (this.dialog?.type !== 'ask') return;
        if ((this.dialog.cursor || 0) === hit.index) {
          this.handleAskKey({ name: 'enter' });
        } else {
          this.dialog.cursor = hit.index;
          this.requestRender();
        }
        return;
      }
      case 'ask-other': {
        if (this.dialog?.type !== 'ask') return;
        const state = this.askDialogState();
        const count = state?.entry.questions[state.dialog.index]?.options.length || 0;
        if ((this.dialog.cursor || 0) === count) {
          this.handleAskKey({ name: 'enter' });
        } else {
          this.dialog.cursor = count;
          this.requestRender();
        }
        return;
      }
      default:
        return;
    }
  }

  makeSelectionDrag(cell) {
    const segments = this.rowRegions?.[cell.row] || [];
    const segment = segments.find((entry) => cell.col >= entry.col && cell.col < entry.col + entry.width);
    if (!segment) return null;
    const colStart = segment.col;
    const colEnd = segment.col + segment.width;
    const matches = (row) => (this.rowRegions?.[row] || []).some((entry) => entry.kind === segment.kind && entry.col === colStart && entry.width === segment.width);
    let rowStart = cell.row;
    let rowEnd = cell.row;
    while (rowStart > 0 && matches(rowStart - 1)) rowStart -= 1;
    while (rowEnd < (this.rowRegions?.length || 0) - 1 && matches(rowEnd + 1)) rowEnd += 1;
    return {
      anchor: cell,
      current: cell,
      dragging: false,
      bounds: { rowStart, rowEnd, colStart, colEnd },
    };
  }

  selectionBoundsAt(row, col) {
    const segments = this.rowRegions?.[row] || [];
    return segments.find((entry) => col >= entry.col && col < entry.col + entry.width) || null;
  }

  selectLineAt(row, col) {
    const plain = this.lastFramePlain?.[row] || '';
    const segment = this.selectionBoundsAt(row, col);
    const width = visibleWidth(plain);
    const start = segment ? segment.col : 0;
    const end = segment ? Math.min(segment.col + segment.width, width) : width;
    if (end <= start) return;
    void this.copySelection({ start: { row, col: start }, end: { row, col: end } });
  }

  async copySelection(selection) {
    const bounds = selection.bounds || { colStart: 0, colEnd: Infinity };
    const rows = [];
    for (let row = selection.start.row; row <= selection.end.row; row += 1) {
      const plain = this.lastFramePlain?.[row];
      if (plain == null) continue;
      const width = visibleWidth(plain);
      if (selection.start.row === selection.end.row) {
        rows.push(sliceVisible(plain, selection.start.col, Math.max(0, selection.end.col - selection.start.col)));
      } else if (row === selection.start.row) {
        const from = Math.min(selection.start.col, width);
        rows.push(sliceVisible(plain, from, Math.max(0, Math.min(bounds.colEnd, width) - from)));
      } else if (row === selection.end.row) {
        rows.push(sliceVisible(plain, Math.min(bounds.colStart, width), Math.max(0, selection.end.col - Math.min(bounds.colStart, width))));
      } else {
        const from = Math.min(bounds.colStart, width);
        rows.push(sliceVisible(plain, from, Math.max(0, Math.min(bounds.colEnd, width) - from)));
      }
    }
    const text = rows.map((line) => line.replace(/\s+$/g, '')).join('\n');
    if (!text.trim()) {
      this.setToast('Nothing to copy.', 'warning');
      return;
    }
    const lineCount = text.split('\n').length;
    const fenced = lineCount > 1;
    const payload = fenced ? fenceSelectionText(text) : text;
    try {
      await this.clipboard.write(payload);
      this.setToast(fenced
        ? `Copied ${lineCount} lines in a code fence.`
        : `Copied ${text.length} characters to the clipboard.`, 'success');
    } catch (error) {
      this.setToast(`Copy failed: ${error?.message || error}`, 'danger');
    }
  }

  wordCells(plain) {
    const cells = [];
    let visible = 0;
    for (const char of String(plain || '')) {
      const width = visibleWidth(char);
      cells.push({ char, start: visible, end: visible + width });
      visible += width;
    }
    return { cells, width: visible };
  }

  selectWordAt(row, col) {
    const plain = this.lastFramePlain?.[row] || '';
    const { cells, width } = this.wordCells(plain);
    if (!cells.length) return;
    const clamped = Math.max(0, Math.min(col, Math.max(0, width - 1)));
    let target = cells.findIndex((cell) => clamped >= cell.start && clamped < cell.end);
    if (target === -1) target = cells.length - 1;
    const isWord = (char) => /[A-Za-z0-9_\-./\\~@#:]/.test(char);
    let from = target;
    let to = target;
    if (isWord(cells[target].char)) {
      while (from > 0 && isWord(cells[from - 1].char)) from -= 1;
      while (to < cells.length - 1 && isWord(cells[to + 1].char)) to += 1;
    }
    const selection = { start: { row, col: cells[from].start }, end: { row, col: cells[to].end } };
    void this.copySelection(selection);
  }

  pasteFromClipboard() {
    this.clipboard.read().then((raw) => {
      const text = String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (!text) {
        this.setToast('Clipboard is empty.', 'warning');
        return;
      }
      const dialog = this.dialog;
      if (dialog?.type === 'input') {
        const capped = text.slice(0, 100_000);
        dialog.value = dialog.value.slice(0, dialog.cursor) + capped + dialog.value.slice(dialog.cursor);
        dialog.cursor += capped.length;
        this.requestRender();
        return;
      }
      if (this.approval || this.dialog) {
        this.setToast('Close the dialog first.', 'warning');
        return;
      }
      this.insertText(text);
    }).catch((error) => {
      this.setToast(`Clipboard failed: ${error?.message || error}`, 'danger');
    });
  }

  handleApprovalKey(key) {
    if (key.name === 'escape') {
      this.finishApproval(false, { abort: true });
      return;
    }
    const letter = (key.name === 'char' || key.name === 'text') ? String(key.text || '').toLowerCase() : '';
    if (letter === 'y') this.finishApproval(true);
    else if (letter === 'a') this.finishApproval(true, { remember: true });
    else if (letter === 'n') this.finishApproval(false);
    else if (key.name === 'enter') this.finishApproval(true);
  }

  dialogItems(dialog) {
    if (dialog.type === 'models') {
      const filter = String(dialog.filter || '').toLowerCase();
      return this.models.filter((model) => !filter || model.name.toLowerCase().includes(filter) || model.id.includes(filter));
    }
    if (dialog.type === 'sessions') {
      const filter = String(dialog.filter || '').toLowerCase();
      return this.recentChats.filter((chat) => !filter || chat.title.toLowerCase().includes(filter));
    }
    if (dialog.type === 'permissions') {
      return ['edit', 'write', 'shell', 'web', 'computer', 'mcp', 'plugin'];
    }
    if (dialog.type === 'settings') {
      return this.settingsEntries();
    }
    return [];
  }

  dialogItemCount(dialog) {
    if (dialog.type === 'folders') return this.folders.length + 1;
    return this.dialogItems(dialog).length;
  }

  handleDialogKey(key) {
    const dialog = this.dialog;
    if (!dialog) return;
    if (dialog.type === 'ask') {
      this.handleAskKey(key);
      return;
    }
    if (dialog.type === 'confirm') {
      const letter = (key.name === 'char' || key.name === 'text') ? String(key.text || '').toLowerCase() : '';
      if (letter === 'y') dialog.resolve(true);
      else if (letter === 'n') dialog.resolve(false);
      else if (key.name === 'enter') dialog.resolve(true);
      else if (key.name === 'escape') dialog.resolve(false);
      return;
    }
    if (dialog.type === 'input') {
      if (key.name === 'escape') {
        this.closeDialog();
      } else if (key.name === 'enter') {
        dialog.onSubmit?.(dialog.value.trim());
      } else if (key.name === 'backspace') {
        const before = codePointBefore(dialog.value, dialog.cursor);
        dialog.value = dialog.value.slice(0, before) + dialog.value.slice(dialog.cursor);
        dialog.cursor = before;
      } else if (key.name === 'delete') {
        const after = codePointAfter(dialog.value, dialog.cursor);
        dialog.value = dialog.value.slice(0, dialog.cursor) + dialog.value.slice(after);
      } else if (key.name === 'left') {
        dialog.cursor = codePointBefore(dialog.value, dialog.cursor);
      } else if (key.name === 'right') {
        dialog.cursor = codePointAfter(dialog.value, dialog.cursor);
      } else if (key.name === 'home') {
        dialog.cursor = 0;
      } else if (key.name === 'end') {
        dialog.cursor = dialog.value.length;
      } else if (key.name === 'text' || key.name === 'char') {
        dialog.value = dialog.value.slice(0, dialog.cursor) + key.text + dialog.value.slice(dialog.cursor);
        dialog.cursor += key.text.length;
      }
      this.requestRender();
      return;
    }
    if (dialog.type === 'plan') {
      if (key.name === 'escape') {
        this.dialog = null;
        this.requestRender();
        return;
      }
      if (key.name === 'enter') {
        this.acceptPlan();
        return;
      }
      if (key.name === 'up') { dialog.scroll = Math.max(0, (dialog.scroll || 0) - 1); this.requestRender(); return; }
      if (key.name === 'down') { dialog.scroll = (dialog.scroll || 0) + 1; this.requestRender(); return; }
      if (key.name === 'pageup') { dialog.scroll = Math.max(0, (dialog.scroll || 0) - 8); this.requestRender(); return; }
      if (key.name === 'pagedown') { dialog.scroll = (dialog.scroll || 0) + 8; this.requestRender(); return; }
      return;
    }
    if (dialog.type === 'help' || dialog.type === 'usage' || dialog.type === 'text') {
      if (key.name === 'escape' || key.name === 'enter') this.closeDialog();
      else if (key.name === 'up') { dialog.scroll = Math.max(0, (dialog.scroll || 0) - 1); this.requestRender(); }
      else if (key.name === 'down') { dialog.scroll = (dialog.scroll || 0) + 1; this.requestRender(); }
      else if (key.name === 'pageup') { dialog.scroll = Math.max(0, (dialog.scroll || 0) - 8); this.requestRender(); }
      else if (key.name === 'pagedown') { dialog.scroll = (dialog.scroll || 0) + 8; this.requestRender(); }
      return;
    }
    if (key.name === 'escape') {
      this.closeDialog();
      return;
    }
    if (key.name === 'up') {
      dialog.index = Math.max(0, (dialog.index || 0) - 1);
      this.requestRender();
      return;
    }
    if (key.name === 'down') {
      const count = this.dialogItemCount(dialog);
      dialog.index = Math.min(Math.max(0, count - 1), (dialog.index || 0) + 1);
      this.requestRender();
      return;
    }
    if (dialog.type === 'settings') {
      const entries = this.settingsEntries();
      const index = Math.max(0, Math.min(entries.length - 1, dialog.index || 0));
      const letter = (key.name === 'char' || key.name === 'text') ? String(key.text || '') : '';
      if (key.name === 'enter' || letter === ' ') {
        entries[index]?.toggle();
        this.requestRender();
      }
      return;
    }
    if (dialog.type === 'permissions') {
      if (key.name === 'enter' || ((key.name === 'char' || key.name === 'text') && String(key.text || '') === ' ')) {
        const keyName = this.dialogItems(dialog)[dialog.index || 0];
        this.config.autoApprove[keyName] = !this.config.autoApprove[keyName];
        saveConfig(this.config);
        this.requestRender();
      }
      return;
    }
    if (dialog.type === 'models' || dialog.type === 'sessions') {
      if (key.name === 'text' || key.name === 'char') {
        dialog.filter = `${dialog.filter || ''}${key.text}`;
        dialog.index = 0;
        this.requestRender();
      } else if (key.name === 'backspace') {
        dialog.filter = (dialog.filter || '').slice(0, -1);
        dialog.index = 0;
        this.requestRender();
      } else if (key.name === 'enter') {
        const items = this.dialogItems(dialog);
        const item = items[dialog.index || 0];
        if (!item) return;
        if (dialog.type === 'models') {
          this.closeDialog();
          this.setModel(item.id);
        } else {
          if (this.running) {
            this.setFlash('Wait for the current turn to finish.', 'warning');
            return;
          }
          this.closeDialog();
          this.loadChat(item.id);
          this.setFlash(`Resumed ${truncate(item.title, 50)}.`, 'success');
        }
      } else if (key.name === 'tab' && dialog.type === 'sessions') {
        this.closeDialog();
        this.newChat({ folderId: this.config.lastFolderId || null, cwd: this.cwd });
      }
      return;
    }
    if (dialog.type === 'folders') {
      if (key.name === 'enter') {
        const index = dialog.index || 0;
        const folder = index === 0 ? null : this.folders[index - 1];
        this.config.lastFolderId = folder ? folder.id : null;
        saveConfig(this.config);
        if (this.chat) {
          this.store.updateChat(this.chat.id, { folderId: folder ? folder.id : null });
          this.chat = this.store.getChat(this.chat.id) || this.chat;
        }
        this.refreshSidebar();
        this.closeDialog();
        this.setFlash(folder ? `Folder: ${folder.name}` : 'Folder: none', 'success');
      } else if ((key.name === 'char' || key.name === 'text') && String(key.text || '').toLowerCase() === 'n') {
        this.closeDialog();
        this.promptInput({
          title: 'new folder',
          hint: 'name',
          onSubmit: (name) => {
            if (!name) return;
            const folder = this.store.createFolder({ name, folderPath: this.cwd });
            this.config.lastFolderId = folder.id;
            saveConfig(this.config);
            this.refreshSidebar();
            this.setFlash(`Folder ${folder.name} created.`, 'success');
          },
        });
      }
    }
  }

  quit() {
    if (this.closed) return;
    this.closed = true;
    this.stopAnimation();
    clearInterval(this.healthTimer);
    clearTimeout(this.toastTimer);
    this.terminal.leave();
    this.registry?.cleanup?.();
    this.mcp?.closeAll?.();
    this.store.close();
    if (this.donePromise) this.donePromise();
  }

  async run() {
    await this.init();
    this.terminal.onKey((key) => this.handleKey(key));
    this.terminal.onResizeEvent(() => {
      this.transcriptCache.clear();
      this.requestRender();
    });
    this.terminal.enter();
    this.terminal.start(() => this.render());
    void this.checkUpdateOnStart();
    this.healthTimer = setInterval(() => {
      if (this.running) return;
      this.client.health({ timeoutMs: 6000 }).then(() => {
        if (!this.online) {
          this.online = true;
          this.requestRender();
        }
      }).catch(() => {
        if (this.online) {
          this.online = false;
          this.requestRender();
        }
      });
    }, 90_000);
    this.healthTimer.unref?.();
    return new Promise((resolve) => {
      this.donePromise = resolve;
    });
  }

  render() {
    const cols = this.terminal.columns;
    const rows = this.terminal.rows;
    this.hitRegions = new Array(rows).fill(null);
    const status = this.renderStatus(cols);
    const header = [this.renderHeader(cols), this.styler.fg('border', '─'.repeat(cols))];
    const composerHits = [];
    const composer = this.renderComposer(cols, composerHits);
    for (let index = 0; index < composerHits.length; index += 1) {
      if (composerHits[index]) this.addHit(rows - composer.length + index, composerHits[index]);
    }
    let middleRows = rows - header.length - composer.length - 1;
    if (middleRows < 3) {
      middleRows = Math.max(1, rows - header.length - 1 - 1);
    }
    const middle = [];
    const baseRow = header.length;
    const sidebarWidth = !(this.dialog || this.approval) && cols >= 104
      ? Math.min(32, Math.max(26, Math.floor(cols * 0.26)))
      : null;
    const rowRegions = [];
    const tag = (count, regions) => {
      for (let index = 0; index < count; index += 1) rowRegions.push(regions);
    };
    for (let index = 0; index < header.length; index += 1) {
      rowRegions.push([{ kind: 'header', col: 0, width: cols }]);
    }
    if (this.dialog || this.approval) {
      const dialogRows = this.approval
        ? this.renderApproval(middleRows, cols)
        : (this.dialog ? this.renderDialog(middleRows, cols, (index, hit) => {
          if (hit) this.addHit(baseRow + index, hit);
        }) : []);
      middle.push(...dialogRows);
      tag(dialogRows.length, [{ kind: 'dialog', col: 0, width: cols }]);
    } else if (sidebarWidth) {
      const convWidth = cols - sidebarWidth - 1;
      const sidebarHits = [];
      const sidebar = this.renderSidebar(middleRows, sidebarWidth, sidebarHits);
      const conversation = this.renderConversation(middleRows, convWidth);
      for (let index = 0; index < middleRows; index += 1) {
        const rowHits = [];
        if (sidebarHits[index]) rowHits.push(...this.sameRowHits(sidebarHits[index]));
        const transcriptHit = this.transcriptHits?.get((this.conversationStart || 0) + index);
        if (transcriptHit) rowHits.push(...this.sameRowHits(transcriptHit).map((entry) => ({ ...entry, col: Number(entry.col ?? 0) + sidebarWidth + 1 })));
        if (rowHits.length) this.addHit(baseRow + index, rowHits);
        middle.push(`${sidebar[index] || ''.padEnd(sidebarWidth)}${this.styler.fg('border', '│')}${conversation[index] || ''}`);
      }
      tag(middleRows, [{ kind: 'sidebar', col: 0, width: sidebarWidth }, { kind: 'conversation', col: sidebarWidth + 1, width: convWidth }]);
    } else {
      const conversation = this.renderConversation(middleRows, cols);
      middle.push(...conversation);
      for (let index = 0; index < middleRows; index += 1) {
        const transcriptHit = this.transcriptHits?.get((this.conversationStart || 0) + index);
        if (transcriptHit) this.addHit(baseRow + index, transcriptHit);
      }
      tag(middle.length, [{ kind: 'conversation', col: 0, width: cols }]);
    }
    tag(composer.length, [{ kind: 'composer', col: 0, width: cols }]);
    const frame = [...header, ...middle, ...composer];
    while (frame.length < rows - 1) frame.push('');
    frame.push(status);
    // Align regions with the final rows (pad rows belong to conversation).
    while (rowRegions.length < frame.length - 1) rowRegions.push([{ kind: 'conversation', col: 0, width: cols }]);
    rowRegions.push([{ kind: 'status', col: 0, width: cols }]);
    const view = frame.slice(0, rows);
    this.rowRegions = rowRegions.slice(0, view.length);
    if (this.selection) {
      const { start, end } = this.selection;
      const bounds = this.selection.bounds || { colStart: 0, colEnd: Infinity };
      for (let row = start.row; row <= Math.min(end.row, view.length - 1); row += 1) {
        const line = view[row];
        const width = visibleWidth(line);
        const from = Math.min(row === start.row ? start.col : bounds.colStart, width);
        const to = Math.min(row === end.row ? end.col : bounds.colEnd, width);
        if (to <= from) continue;
        view[row] = `${sliceVisible(line, 0, from)}\u001b[7m${sliceVisible(line, from, to - from)}\u001b[27m${sliceVisible(line, to)}`;
      }
    }
    const toast = this.visibleToast();
    if (toast && view.length) {
      const text = ` ${GLYPHS.checked} ${toast.text} `;
      const width = visibleWidth(text);
      const col = Math.max(0, cols - width - 1);
      const rowIndex = Math.min(2, view.length - 1);
      const line = view[rowIndex] || '';
      view[rowIndex] = `${sliceVisible(line, 0, col)}${this.styler.bg('surface2', this.styler.fg(toast.color || 'success', text))}${sliceVisible(line, col + width)}`;
    }
    this.lastFramePlain = view.map((line) => stripAnsi(line));
    return view.map((line) => paintRow(line, this.styler));
  }

  renderHeader(cols) {
    const s = this.styler;
    const left = [
      s.fg('accent', GLYPHS.cat),
      s.bold(s.fg('text', 'GATITA STUDIO')),
      s.fg('faint', '·'),
      s.fg('muted', basenameForDisplay(this.cwd)),
    ].join(' ');
    const planName = (this.plan?.displayName || 'Free').replace(/^Gatita\s+/i, '');
    const online = this.online ? s.fg('success', '●') : s.fg('danger', '○');
    const usage = this.mostRestrictiveWindow();
    const windowText = usage ? `${formatTokens(usage.remaining)} left` : '';
    const parts = [
      online,
      s.fg('accent', planName.toLowerCase()),
      windowText ? s.fg('muted', windowText) : '',
      s.fg('muted', this.model()?.name || this.modelId),
    ].filter(Boolean);
    if (this.updateNotice) {
      parts.push(s.fg('warning', `update: ${this.updateNotice.latest}`));
    }
    if (this.running) {
      const elapsed = this.stream.startedAt ? Date.now() - this.stream.startedAt : 0;
      parts.unshift(s.fg('accent', `${selectGlyph(SPINNER, this.animationTick)} ${formatDuration(elapsed, { compact: true })}`));
    }
    const right = parts.join(s.fg('faint', ' · '));
    return this.fitRow(` ${left}`, `${right} `, cols);
  }

  mostRestrictiveWindow() {
    const windows = this.quota?.windows || [];
    if (!windows.length) return null;
    return windows.reduce((best, window) => (!best || window.remaining < best.remaining ? window : best), null);
  }

  fitRow(left, right, cols) {
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    if (leftWidth + rightWidth + 1 > cols) {
      return truncateVisible(left, Math.max(0, cols - rightWidth - 1)) + ' ' + right;
    }
    return `${left}${' '.repeat(Math.max(1, cols - leftWidth - rightWidth))}${right}`;
  }

  renderStatus(cols) {
    const s = this.styler;
    let left;
    const flash = this.visibleFlash();
    if (flash) left = s.fg(flash.color, flash.text);
    else if (this.approval) left = s.fg('warning', 'approval needed · y allow · a always · n deny');
    else if (this.dialog) left = s.fg('faint', '↑↓ select · enter confirm · esc close');
    else if (this.running) left = s.fg('warning', 'working · esc interrupt · ctrl+c cancel');
    else if (this.mode === 'plan') left = s.fg('warning', 'plan mode · enter send · /build starts');
    else left = s.fg('faint', 'enter send · shift+enter newline · / commands · ctrl+c twice to quit');
    const reasoning = this.model()?.reasoningLevels?.length ? ` · think ${reasoningLabel(this.reasoning)}` : '';
    let right = `${this.model()?.name || this.modelId}${reasoning}`;
    if (this.scrollOffset > 0) right = `${GLYPHS.scrollUp} ${this.scrollOffset} · ${right}`;
    const content = this.fitRow(` ${left}`, `${s.fg('muted', right)} `, Math.max(10, cols));
    return s.bg('surface', padEndVisible(content, cols));
  }

  renderComposer(cols, hits = []) {
    const s = this.styler;
    const lines = [];
    const suggestionSet = this.visibleSuggestions();
    const activeSuggestions = suggestionSet?.items || [];
    const kind = suggestionSet?.kind || null;
    const selectedIndex = activeSuggestions.length ? this.suggestionSelection(activeSuggestions).index : -1;
    for (let index = 0; index < activeSuggestions.length; index += 1) {
      const suggestion = activeSuggestions[index];
      const selected = index === selectedIndex;
      const prefix = selected ? s.bg('surface2', s.fg('accent', ' › ')) : '   ';
      const verb = kind === 'skill' ? '@' : '/';
      const name = s.fg(selected ? 'accent' : 'text', `${verb}${suggestion.name.padEnd(10)}`);
      const description = s.fg('faint', truncate(suggestion.description, Math.max(8, cols - 20)));
      lines.push(`${prefix}${name} ${description}`);
      hits[lines.length - 1] = { type: 'suggestion', text: `${verb}${suggestion.name} ` };
    }
    const title = this.approval ? 'approval required'
      : this.running ? 'gatita is working'
        : this.dialog ? 'dialog open'
          : 'ask gatita';
    const inner = Math.max(8, cols - 2);
    const textWidth = Math.max(4, inner - 2);
    const inputLayout = this.layoutInput(this.input, this.cursor, textWidth);
    const maxLines = 5;
    const totalLines = inputLayout.lines.length;
    let top = this.composerScroll || 0;
    if (inputLayout.cursorLine < top) top = inputLayout.cursorLine;
    else if (inputLayout.cursorLine >= top + maxLines) top = Math.max(0, inputLayout.cursorLine - maxLines + 1);
    top = Math.max(0, Math.min(top, Math.max(0, totalLines - maxLines)));
    this.composerScroll = top;
    let visibleLines = inputLayout.lines.slice(top, top + maxLines);
    let cursorLine = inputLayout.cursorLine - top;
    let scrollHint = '';
    if (totalLines > maxLines) {
      scrollHint = ` ${top + 1}-${top + visibleLines.length}/${totalLines}`;
    }
    if (this.pendingImages.length) {
      const images = `▣ ${this.pendingImages.length} image${this.pendingImages.length === 1 ? '' : 's'} attached · /image clear`;
      lines.push(s.fg('info', truncateVisible(images, cols - 4)));
    }
    const topFill = Math.max(0, inner - visibleWidth(`${title}${scrollHint}`) - 3);
    lines.push(`${s.fg('accent', '╭─')} ${s.fg('muted', `${title}${scrollHint}`)} ${s.fg('border', '─'.repeat(topFill))}${s.fg('accent', '╮')}`);
    if (!visibleLines.length) visibleLines = [''];
    visibleLines.forEach((line, index) => {
      let content;
      if (this.input === '' && index === 0) {
        const placeholder = this.running ? 'type to steer · enter to queue' : 'ask gatita to build something';
        content = `${s.inverse(' ')} ${s.fg('faint', placeholder)}`;
      } else if (index === cursorLine && !this.dialog) {
        const cursorCol = Math.min(inputLayout.cursorCol, visibleWidth(line));
        const before = sliceVisible(line, 0, cursorCol);
        const rest = sliceVisible(line, cursorCol);
        const cell = [...rest][0] || ' ';
        const after = rest.slice(cell.length);
        content = `${before}${s.inverse(cell)}${after}`;
      } else {
        content = s.fg(this.running ? 'text' : 'text', line);
      }
      lines.push(`${s.fg('accent', '│')} ${padEndVisible(content, textWidth)} ${s.fg('accent', '│')}`);
    });
    lines.push(`${s.fg('accent', '╰')}${s.fg('border', '─'.repeat(inner))}${s.fg('accent', '╯')}`);
    return lines;
  }

  renderConversation(rows, width) {
    const s = this.styler;
    if (!this.messages.length && !this.stream.active && !this.running) {
      return this.renderEmpty(rows, width);
    }
    const transcript = this.buildTranscript(Math.max(8, width - 2));
    this.transcriptLineCount = transcript.length;
    this.conversationHeight = rows;
    const maxOffset = Math.max(0, transcript.length - rows);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
    const start = Math.max(0, transcript.length - rows - this.scrollOffset);
    this.conversationStart = start;
    const view = transcript.slice(start, start + rows);
    const output = view.map((line) => padEndVisible(truncateVisible(line, width), width));
    while (output.length < rows) output.unshift(' '.repeat(width));
    if (this.scrollOffset > 0) {
      const indicator = s.fg('warning', ` ${GLYPHS.scrollUp} ${this.scrollOffset} `);
      const last = output[output.length - 1] || '';
      output[output.length - 1] = `${sliceVisible(last, 0, Math.max(0, width - visibleWidth(indicator)))}${indicator}`;
    }
    return output;
  }

  renderEmpty(rows, width) {
    const s = this.styler;
    const content = [
      '',
      centerVisible(s.fg('accent', GLYPHS.cat), Math.max(8, width)),
      centerVisible(s.bold(s.fg('text', 'G A T I T A   S T U D I O')), Math.max(8, width)),
      centerVisible(s.fg('muted', 'Your terminal. Her territory.'), Math.max(8, width)),
      '',
      centerVisible(s.fg('faint', `new chat in ${basenameForDisplay(this.cwd)}`), Math.max(8, width)),
      '',
      centerVisible(s.fg('muted', 'type a message to start'), Math.max(8, width)),
      centerVisible(s.fg('faint', '/model · /sessions · /help'), Math.max(8, width)),
    ];
    const top = Math.max(0, Math.floor((rows - content.length) / 2));
    const output = [];
    for (let index = 0; index < rows; index += 1) {
      const contentIndex = index - top;
      output.push(contentIndex >= 0 && contentIndex < content.length ? padEndVisible(content[contentIndex], width) : ' '.repeat(width));
    }
    return output;
  }

  renderSidebar(rows, width, hits = []) {
    const s = this.styler;
    const lines = [];
    const label = (text) => s.fg('faint', text.toUpperCase());
    const push = (line, hitList = null) => {
      lines.push(line);
      hits[lines.length - 1] = hitList ? (Array.isArray(hitList) ? hitList : [hitList]) : null;
    };
    const remainingRoom = () => Math.max(0, rows - lines.length);

    const cardWidth = Math.max(11, Math.floor((Math.max(20, width) - 2) / 2));
    const card = ({ glyph, label: text, type, active = false }, startCol) => {
      const border = active ? 'accent' : 'border';
      const shadowBg = 'surface2';
      const innerWidth = cardWidth - 2;
      const plain = `▎ ${glyph} ${text}`;
      const content = padEndVisible(truncateVisible(plain, innerWidth), innerWidth);
      const face = `${s.fg(border, '│')}${s.bg(shadowBg, s.fg(active ? 'accent' : 'text', content))}${s.fg(border, '│')}`;
      const top = `${s.fg(border, `╭${'─'.repeat(cardWidth - 2)}╮`)}`;
      const bottom = `${s.fg(border, `╰${'─'.repeat(cardWidth - 2)}╯`)}`;
      return [
        { line: top, hit: [{ type, col: startCol, width: cardWidth }] },
        { line: face, hit: [{ type, col: startCol, width: cardWidth }] },
        { line: bottom, hit: [{ type, col: startCol, width: cardWidth }] },
      ];
    };
    const wideCard = ({ glyph, label: text, type, active = true }) => {
      const innerWidth = Math.max(4, width - 2);
      const plain = `▎ ${glyph} ${text}`;
      const content = padEndVisible(truncateVisible(plain, innerWidth), innerWidth);
      const face = `${s.bg('surface2', s.fg('accent', content))}`;
      const border = 'accent';
      return [
        { line: s.fg(border, `╭${'─'.repeat(innerWidth)}╮`), hit: [{ type, col: 0, width }] },
        { line: `${s.fg(border, '│')}${face}${s.fg(border, '│')}`, hit: [{ type, col: 0, width }] },
        { line: s.fg(border, `╰${'─'.repeat(innerWidth)}╯`), hit: [{ type, col: 0, width }] },
      ];
    };
    const buttons = [
      { glyph: '+', label: 'new chat', type: 'new-chat' },
      { glyph: '▤', label: 'folders', type: 'open-folders' },
      { glyph: '◔', label: 'usage', type: 'open-usage', active: (this.mostRestrictiveWindow()?.percent || 0) >= 80 },
      { glyph: '⚙', label: 'settings', type: 'open-settings' },
    ];
    for (let index = 0; index < buttons.length; index += 2) {
      const left = card(buttons[index], 1);
      const right = card(buttons[index + 1], 2 + cardWidth);
      for (let offset = 0; offset < 3; offset += 1) {
        push(`${left[offset].line} ${right[offset].line}`, [...left[offset].hit, ...right[offset].hit]);
      }
      if (index + 2 < buttons.length) push('');
    }
    const planBlock = this.planDraft
      ? wideCard({ glyph: '▸', label: `use plan · ${this.planQuestionsAsked || 0} q`, type: 'use-plan' })
      : null;
    if (planBlock) {
      push('');
      for (const row of planBlock) push(row.line, row.hit);
    }

    push('');
    push(` ${label('folders')}`);
    const activeFolder = this.folders.find((folder) => folder.id === this.config.lastFolderId);
    push(`  ${s.fg(activeFolder ? 'accent' : 'muted', '▸')} ${s.fg(activeFolder ? 'text' : 'muted', truncate(activeFolder?.name || 'all chats', width - 5))}`, { type: 'folder', id: activeFolder?.id ?? null });
    for (const folder of this.folders.slice(0, 2)) {
      if (folder.id === activeFolder?.id) continue;
      push(`    ${s.fg('muted', truncate(folder.name, Math.max(4, width - 8)))} ${s.fg('faint', String(folder.chatCount))}`, { type: 'folder', id: folder.id });
    }
    {
      const plusContent = padEndVisible(truncateVisible('▎ + new folder', Math.max(4, width - 4)), Math.max(4, width - 4));
      push(`  ${s.bg('surface2', s.fg('accent', plusContent))}`, [{ type: 'new-folder', col: 0, width }]);
    }

    push('');
    push(` ${label('usage')}`);
    const normalizePercent = (value) => {
      const number = Number(value);
      if (!Number.isFinite(number)) return 0;
      return Math.max(0, Math.min(100, number));
    };
    const formatPercent = (percent) => (percent < 10 && !Number.isInteger(percent)
      ? `${percent.toFixed(1)}%`
      : `${Math.round(percent)}%`);
    const windows = this.quota?.windows || [];
    if (windows.length) {
      for (const window of windows) {
        const percent = normalizePercent(window.percent);
        const color = percent >= 95 ? 'danger' : percent >= 80 ? 'warning' : 'accent';
        const barWidth = Math.max(4, width - 15);
        push(`  ${s.fg('muted', String(window.shortLabel || '').padEnd(4))} ${progressBar(percent, barWidth, s, color)} ${s.fg('faint', formatPercent(percent))}`);
        const reset = window.resetAt ? `resets in ${formatDuration(Math.max(0, window.resetAt - Date.now()), { compact: true })}` : 'no reset scheduled';
        push(`    ${s.fg('faint', truncate(`${formatTokens(window.used)} / ${formatTokens(window.limit)} · ${reset}`, Math.max(4, width - 6)))}`);
      }
    } else {
      push(`  ${s.fg('faint', 'no quota data')}`);
    }

    if (remainingRoom() >= 3) {
      push('');
      push(` ${label('recent')}`);
      const chats = this.recentChats.slice(0, Math.max(1, Math.min(8, remainingRoom() - 2)));
      if (!chats.length) push(`  ${s.fg('faint', 'no chats yet')}`);
      for (const chat of chats) {
        const active = this.chat?.id === chat.id;
        const marker = active ? s.fg('accent', '›') : ' ';
        push(`${marker} ${s.fg(active ? 'text' : 'muted', truncate(chat.title, width - 4))}`, { type: 'resume', id: chat.id });
      }
    }
    if (remainingRoom() >= 4 && this.todos.length) {
      push('');
      push(` ${label('tasks')}`);
      for (const todo of this.todos.slice(0, Math.max(1, Math.min(5, remainingRoom() - 2)))) {
        const glyph = todo.status === 'completed' ? s.fg('success', '✓')
          : todo.status === 'in_progress' ? s.fg('accent', '◐')
            : s.fg('faint', '○');
        push(`  ${glyph} ${s.fg(todo.status === 'completed' ? 'faint' : 'muted', truncate(todo.content, width - 5))}`);
      }
    }
    if (remainingRoom() >= 4) {
      push('');
      push(` ${label('workspace')}`);
      push(`  ${s.fg('muted', truncate(basenameForDisplay(this.cwd), width - 4))}`);
      push(`  ${s.fg('faint', truncate(this.cwd, width - 4))}`);
    }
    const output = [];
    for (let index = 0; index < rows; index += 1) {
      output.push(padEndVisible(truncateVisible(lines[index] || '', width), width));
    }
    return output;
  }

  isFinalAssistant(message) {
    return message?.role === 'assistant'
      && String(message.content || '').trim()
      && !(Array.isArray(message.toolCalls) && message.toolCalls.length);
  }

  groupTurns(messages) {
    const turns = [];
    let current = null;
    for (const message of messages) {
      if (message.role === 'user') {
        if (current) turns.push(current);
        current = { user: message, messages: [message], final: null, workMessages: [], tools: 0, errorCount: 0 };
        continue;
      }
      if (!current) {
        current = { user: null, messages: [], final: null, workMessages: [], tools: 0, errorCount: 0 };
      }
      const last = current.messages[current.messages.length - 1];
      if (message.role === 'assistant' && current.user === null && last && this.isFinalAssistant(last)) {
        // A sequence of standalone replies with no user turns is several
        // separate answers, not one hidden work block.
        turns.push(current);
        current = { user: null, messages: [message], final: null, workMessages: [], tools: 0, errorCount: 0 };
        continue;
      }
      current.messages.push(message);
    }
    if (current) turns.push(current);
    for (const [index, turn] of turns.entries()) {
      const final = [...turn.messages].reverse().find((message) => this.isFinalAssistant(message)) || null;
      turn.final = final;
      const toolCallIds = new Set();
      for (const message of turn.messages) {
        if (Array.isArray(message.toolCalls)) {
          for (const call of message.toolCalls) {
            if (call?.id) toolCallIds.add(call.id);
          }
        }
        if (message.role === 'tool' && message.toolCallId) toolCallIds.add(message.toolCallId);
      }
      turn.tools = toolCallIds.size;
      turn.errorCount = turn.messages.filter((message) => message.role === 'tool' && message.meta?.isError).length;
      turn.workMessages = turn.messages.filter((message) => message.role === 'tool'
        || (message.role === 'assistant' && message !== final));
      turn.active = Boolean(this.running) && index === turns.length - 1;
    }
    return turns;
  }

  indentTranscript(lines, prefix) {
    return lines.map((line) => (line ? `${prefix}${line}` : line));
  }

  renderWorkBlock(turn, width, toolResults, { active = false } = {}) {
    const s = this.styler;
    const shown = this.showWork || active;
    const toolCount = Math.max(turn.tools, turn.workMessages.reduce((sum, message) => {
      if (message.role !== 'assistant') return sum;
      return sum + (Array.isArray(message.toolCalls) ? message.toolCalls.length : 0);
    }, 0));
    if (!shown) {
      const errorBits = turn.errorCount ? ` · ${turn.errorCount} error${turn.errorCount === 1 ? '' : 's'}` : '';
      const line = `  ${s.fg('faint', '▸')} ${s.fg('muted', `work hidden · ${toolCount} tool${toolCount === 1 ? '' : 's'}${errorBits}`)} ${s.fg('faint', 'ctrl+t shows')}`;
      return [line];
    }
    const lines = [];
    const errorBits = turn.errorCount ? ` · ${turn.errorCount} error${turn.errorCount === 1 ? '' : 's'}` : '';
    if (!active) {
      lines.push(`  ${s.fg('accent', '▸')} ${s.fg('muted', `work · ${toolCount} tool${toolCount === 1 ? '' : 's'}${errorBits}`)} ${s.fg('faint', 'ctrl+t hides')}`);
    }
    for (const message of turn.workMessages) {
      if (message.role === 'assistant') {
        if (message.reasoning && (this.config.showReasoning || this.expandedReasoning.has(message.id))) {
          const reasoning = renderMarkdown(message.reasoning, Math.max(8, width - 6), s, { base: 'faint' });
          for (const line of reasoning.slice(0, 12)) lines.push(`  ${s.fg('faint', '│ ')}${s.fg('faint', truncateToWidth(line, width - 4))}`);
        }
        if (message.content) {
          lines.push(...this.indentTranscript(renderMarkdown(message.content, Math.max(8, width - 2), s, { base: 'text' }), '  '));
        }
        if (Array.isArray(message.toolCalls)) {
          for (const call of message.toolCalls) {
            const result = toolResults.get(call.id);
            lines.push(...this.indentTranscript(this.toolLines(call, result, Math.max(8, width - 2)), '  '));
          }
        }
        continue;
      }
      if (!this.isAssociatedTool(message)) {
        const call = { id: message.toolCallId, function: { name: message.name, arguments: '{}' } };
        lines.push(...this.indentTranscript(this.toolLines(call, message, Math.max(8, width - 2)), '  '));
      }
    }
    return lines;
  }

  renderActiveTurn(turn, width, toolResults) {
    const s = this.styler;
    const startedAt = this.stream.startedAt || Date.now();
    const elapsed = Date.now() - startedAt;
    const modelName = this.model()?.name || this.modelId;
    const lines = [];
    if (this.stream.text) {
      lines.push(`${s.fg('accent', GLYPHS.cat)} ${s.bold(s.fg('accent', 'gatita'))} ${s.fg('faint', modelName)} ${s.fg('faint', formatClock(startedAt))}`);
      if (turn.workMessages.length) lines.push(...this.renderWorkBlock(turn, width, toolResults, { active: true }));
      if (this.config.showReasoning && this.stream.reasoning) {
        lines.push(`  ${s.fg('faint', `▸ thinking · ${formatTokens(Math.max(1, Math.round(this.stream.reasoning.length / 4)))} tokens · m to expand`)}`);
      }
      const content = renderMarkdown(this.stream.text, Math.max(8, width - 2), s, { base: 'text', indent: '  ' });
      if (content.length) {
        const last = content[content.length - 1];
        content[content.length - 1] = `${last}${s.fg('accent', GLYPHS.cursor)}`;
        lines.push(...content);
      } else {
        lines.push(`  ${s.fg('accent', GLYPHS.cursor)}`);
      }
    } else if (this.stream.reasoning) {
      const elapsedText = s.fg('faint', formatDuration(elapsed, { compact: true }));
      lines.push(`${s.fg('accent', GLYPHS.cat)} ${s.bold(s.fg('accent', 'gatita'))} ${this.shimmer('thinking', this.animationTick)} ${elapsedText}`);
      if (turn.workMessages.length) lines.push(...this.renderWorkBlock(turn, width, toolResults, { active: true }));
      if (this.config.showReasoning) {
        lines.push(`  ${s.fg('faint', `▸ thinking · ${formatTokens(Math.max(1, Math.round(this.stream.reasoning.length / 4)))} tokens`)}`);
      }
    } else {
      const elapsedText = s.fg('faint', formatDuration(elapsed, { compact: true }));
      lines.push(`${s.fg('accent', GLYPHS.cat)} ${s.bold(s.fg('accent', 'gatita'))} ${this.shimmer(selectGlyph(THINKING, this.animationTick).trim() || 'thinking', this.animationTick)} ${s.fg('faint', 'thinking')} ${elapsedText}`);
      if (turn.workMessages.length) lines.push(...this.renderWorkBlock(turn, width, toolResults, { active: true }));
    }
    if (this.activeTool) {
      const toolElapsed = Date.now() - this.activeTool.startedAt;
      lines.push(`  ${s.fg('accent', selectGlyph(SPINNER, this.animationTick))} ${s.fg('text', this.activeTool.name)} ${s.fg('muted', truncate(this.activeTool.summary || '', Math.max(8, width - 24)))} ${s.fg('faint', formatDuration(toolElapsed, { compact: true }))}`);
    }
    if (this.steeringQueue.length) {
      for (const queued of this.steeringQueue) {
        lines.push(`  ${s.fg('faint', '› queued: ')}${s.fg('muted', truncateVisible(queued, Math.max(8, width - 12)))}`);
      }
    }
    return lines;
  }

  messageBlock(message, width, toolResults) {
    const s = this.styler;
    const lines = [];
    if (message.role === 'user') {
      if (message.meta?.kind === 'tool_image') {
        lines.push(`  ${s.fg('info', '▣ screenshot from computer use')}`);
        return lines;
      }
      const clock = message.createdAt ? s.fg('faint', formatClock(message.createdAt)) : '';
      lines.push(`${s.fg('accent2', '▌')} ${s.bold(s.fg('accent2', 'you'))} ${clock}`);
      const innerWidth = Math.max(4, width - 4);
      const content = renderMarkdown(message.content || '', innerWidth, s, { base: 'text' });
      for (const line of content) {
        lines.push(`  ${s.bg('surface2', ` ${padEndVisible(line, innerWidth)} `)}`);
      }
      if (Array.isArray(message.meta?.images) && message.meta.images.length) {
        lines.push(`  ${s.fg('info', `▣ ${message.meta.images.length} image${message.meta.images.length === 1 ? '' : 's'}`)}`);
      }
      return lines;
    }
    if (message.role === 'assistant') {
      const modelName = message.meta?.model || this.modelId;
      const clock = message.createdAt ? s.fg('faint', formatClock(message.createdAt)) : '';
      lines.push(`${s.fg('accent', GLYPHS.cat)} ${s.bold(s.fg('accent', 'gatita'))} ${s.fg('faint', modelName)} ${clock}`);
      if (message.reasoning) {
        const expanded = this.expandedReasoning.has(message.id);
        if (expanded) {
          const reasoning = renderMarkdown(message.reasoning, Math.max(8, width - 4), s, { base: 'faint', indent: '' });
          const shown = reasoning.slice(0, 12);
          for (const line of shown) lines.push(`  ${s.fg('faint', '│ ')}${s.fg('faint', truncateToWidth(line, width - 5))}`);
          if (reasoning.length > shown.length) lines.push(`  ${s.fg('faint', `│ … ${reasoning.length - shown.length} more lines · m to minimize`)}`);
          else lines.push(`  ${s.fg('faint', '│ m to minimize')}`);
        } else {
          const approx = Math.max(1, Math.round((message.reasoning.length || 0) / 4));
          lines.push(`  ${s.fg('faint', `▸ thought for ${formatTokens(approx)} tokens · m to expand · /thinking`)}`);
        }
      }
      if (message.content) {
        lines.push(...renderMarkdown(message.content, Math.max(8, width - 2), s, { base: 'text', indent: '  ' }));
      }
      if (Array.isArray(message.toolCalls)) {
        for (const call of message.toolCalls) {
          const result = toolResults.get(call.id);
          lines.push(...this.toolLines(call, result, width));
        }
      }
      return lines;
    }
    if (message.role === 'tool') {
      if (this.isAssociatedTool(message)) return [];
      return this.toolLines({ id: message.toolCallId, function: { name: message.name, arguments: '{}' } }, message, width);
    }
    return lines;
  }

  isAssociatedTool(toolMessage) {
    if (!toolMessage.toolCallId) return false;
    return this.messages.some((message) => message.role === 'assistant'
      && Array.isArray(message.toolCalls)
      && message.toolCalls.some((call) => call.id === toolMessage.toolCallId));
  }

  toolLines(call, result, width) {
    const s = this.styler;
    let args = {};
    try {
      args = JSON.parse(call.function?.arguments || '{}');
    } catch {
      args = {};
    }
    const name = call.function?.name || 'tool';
    const summary = this.describeTool(name, args);
    const running = !result && this.activeTool?.callId === call.id;
    let statusGlyph;
    if (running) statusGlyph = s.fg('accent', selectGlyph(SPINNER, this.animationTick));
    else if (!result) statusGlyph = s.fg('faint', '○');
    else if (result.meta?.isError) statusGlyph = s.fg('danger', GLYPHS.failed);
    else statusGlyph = s.fg('success', GLYPHS.checked);
    const duration = result?.meta?.durationMs ? s.fg('faint', ` ${formatDuration(result.meta.durationMs, { compact: true })}`) : '';
    const icon = s.fg(result?.meta?.isError ? 'danger' : 'muted', toolIcon(name));
    const line = `  ${icon} ${s.fg('text', name)}${summary ? ` ${s.fg('muted', truncate(summary, Math.max(8, width - name.length - 12)))}` : ''} ${statusGlyph}${duration}`;
    const lines = [line];
    if (result) {
      const raw = String(result.content || '').split('\n').filter((entry, index, array) => entry !== '' || array[index - 1] !== '');
      const expanded = this.expandedTools.has(result.toolCallId || result.id);
      if (expanded) {
        const shown = raw.slice(0, 24);
        for (const entry of shown) {
          lines.push(`    ${s.fg(result.meta?.isError ? 'danger' : 'faint', truncateToWidth(entry, Math.max(8, width - 6)))}`);
        }
        if (raw.length > shown.length) lines.push(`    ${s.fg('faint', `… ${raw.length - shown.length} more lines · ctrl+o to collapse`)}`);
        else lines.push(`    ${s.fg('faint', 'ctrl+o to collapse')}`);
      } else {
        const first = raw[0] || '';
        lines.push(`    ${s.fg(result.meta?.isError ? 'danger' : 'faint', truncateToWidth(first, Math.max(8, width - 6)))}`);
        const hidden = Math.max(0, raw.length - 1);
        if (hidden) {
          lines.push(`    ${s.fg('faint', `… ${hidden} more line${hidden === 1 ? '' : 's'} · ctrl+o to expand`)}`);
        }
      }
    }
    return lines;
  }

  describeTool(name, args) {
    if (name === 'bash') return truncateToWidth(String(args.command || '').split(/\r?\n/)[0], 60);
    if (name === 'read' || name === 'write' || name === 'edit') return truncateToWidth(String(args.path || ''), 60);
    if (name === 'grep' || name === 'glob') return truncateToWidth(`${args.pattern || ''}${args.path ? ` in ${args.path}` : ''}`, 60);
    if (name === 'webfetch') return truncateToWidth(String(args.url || ''), 60);
    if (name === 'websearch') return truncateToWidth(String(args.query || ''), 60);
    if (name === 'computer') return truncateToWidth(`${args.action || ''}${args.keys ? ` ${args.keys}` : ''}${args.x != null ? ` ${args.x},${args.y}` : ''}`, 60);
    if (name === 'todo') return Array.isArray(args.todos) ? `${args.todos.length} tasks` : 'read list';
    if (name === 'skill') return truncateToWidth(String(args.name || 'list'), 60);
    try {
      return truncateToWidth(JSON.stringify(args), 60);
    } catch {
      return '';
    }
  }

  buildTranscript(width) {
    const toolResults = new Map();
    for (const message of this.messages) {
      if (message.role === 'tool' && message.toolCallId) toolResults.set(message.toolCallId, message);
    }
    this.transcriptHits = new Map();
    const lines = [];
    const pushBlock = (block, { toggleWork = false } = {}) => {
      if (!block.length) return;
      if (lines.length) lines.push('');
      const start = lines.length;
      lines.push(...block);
      if (toggleWork) {
        this.transcriptHits.set(start, [{ type: 'toggle-work', col: 0, width: visibleWidth(lines[start]) }]);
      }
    };
    const turns = this.groupTurns(this.messages);
    for (const turn of turns) {
      if (turn.active) {
        const userBlock = turn.user ? this.messageBlock(turn.user, width, toolResults) : [];
        const activeBlock = [...userBlock, ...this.renderActiveTurn(turn, width, toolResults)];
        pushBlock(activeBlock);
        continue;
      }
      if (turn.user) pushBlock(this.messageBlock(turn.user, width, toolResults));
      if (turn.workMessages.length || turn.tools) {
        const workBlock = this.renderWorkBlock(turn, width, toolResults);
        const hidden = !this.showWork && workBlock.length === 1 && workBlock[0].includes('work hidden');
        pushBlock(workBlock, { toggleWork: hidden });
      }
      if (turn.final) pushBlock(this.messageBlock(turn.final, width, toolResults));
    }
    if (this.lastError) {
      const s = this.styler;
      pushBlock([`  ${s.fg('danger', '✗')} ${s.fg('danger', 'gatita could not finish')} ${s.fg('faint', truncateVisible(String(this.lastError).replace(/\s+/g, ' '), Math.max(8, width - 18)))}`]);
    }
    return lines;
  }

  streamingLines(width) {
    const s = this.styler;
    const lines = [];
    const elapsed = this.stream.startedAt ? Date.now() - this.stream.startedAt : 0;
    if (this.stream.text) {
      lines.push(`${s.fg('accent', GLYPHS.cat)} ${s.bold(s.fg('accent', 'gatita'))} ${s.fg('faint', this.model()?.name || this.modelId)} ${s.fg('faint', formatClock(this.stream.startedAt))}`);
      if (this.config.showReasoning && this.stream.reasoning) {
        lines.push(`  ${s.fg('faint', `thought ${formatTokens(Math.round(this.stream.reasoning.length / 4))} tokens`)}`);
      }
      const content = renderMarkdown(this.stream.text, Math.max(8, width - 2), s, { base: 'text', indent: '  ' });
      if (content.length) {
        const last = content[content.length - 1];
        content[content.length - 1] = `${last}${s.fg('accent', GLYPHS.cursor)}`;
        lines.push(...content);
      } else {
        lines.push(`  ${s.fg('accent', GLYPHS.cursor)}`);
      }
    } else if (this.stream.reasoning) {
      const thought = this.config.showReasoning
        ? ` ${s.fg('faint', `${formatTokens(Math.max(1, Math.round(this.stream.reasoning.length / 4)))} thought tokens`)}`
        : '';
      lines.push(`${s.fg('accent', GLYPHS.cat)} ${s.bold(s.fg('accent', 'gatita'))} ${this.shimmer('thinking', this.animationTick)}${thought} ${s.fg('faint', formatDuration(elapsed, { compact: true }))}`);
    } else {
      lines.push(`${s.fg('accent', GLYPHS.cat)} ${s.bold(s.fg('accent', 'gatita'))} ${this.shimmer(selectGlyph(THINKING, this.animationTick).trim() || 'thinking', this.animationTick)} ${s.fg('faint', 'thinking')} ${s.fg('faint', formatDuration(elapsed, { compact: true }))}`);
    }
    if (this.activeTool) {
      const elapsedTool = Date.now() - this.activeTool.startedAt;
      lines.push(`  ${s.fg('accent', selectGlyph(SPINNER, this.animationTick))} ${s.fg('text', this.activeTool.name)} ${s.fg('muted', truncate(this.activeTool.summary || '', Math.max(8, width - 24)))} ${s.fg('faint', formatDuration(elapsedTool, { compact: true }))}`);
    }
    return lines;
  }

  renderApproval(rows, cols) {
    const s = this.styler;
    const request = this.approval;
    const width = Math.min(cols - 4, 78);
    const body = [];
    body.push(`${s.fg('warning', 'Gatita wants to run a tool.')}`);
    body.push('');
    body.push(`  ${s.fg('accent', toolIcon(request.tool))} ${s.bold(s.fg('text', request.tool))}  ${s.fg('muted', truncate(request.summary || '', width - 20))}`);
    body.push(`  ${s.fg('faint', `group: ${request.group}`)}`);
    body.push('');
    if (request.args && Object.keys(request.args).length) {
      const pretty = JSON.stringify(request.args, null, 2).split('\n').slice(0, 10);
      for (const line of pretty) body.push(`  ${s.fg('muted', truncateVisible(line, width - 6))}`);
      const total = JSON.stringify(request.args, null, 2).split('\n').length;
      if (total > 10) body.push(`  ${s.fg('faint', `… ${total - 10} more lines`)}`);
      body.push('');
    }
    if (request.group === 'computer') {
      body.push(`${s.fg('danger', 'This controls your real mouse and keyboard.')}`);
      body.push('');
    }
    body.push(`${s.fg('success', '[y]')} allow once   ${s.fg('warning', '[a]')} always allow ${request.group}   ${s.fg('danger', '[n]')} deny`);
    body.push(`${s.fg('faint', 'esc denies and stops the turn')}`);
    return renderDialogBand({
      columns: cols,
      rows,
      title: 'approval',
      body,
      footer: '',
      styler: s,
    });
  }

  renderDialog(rows, cols, recordHit) {
    const s = this.styler;
    const dialog = this.dialog;
    if (!dialog) return this.renderApproval(rows, cols);
    const band = ({ body, title, hits }) => {
      this.dialogHits = hits || new Map();
      return renderDialogBand({
        columns: cols,
        rows,
        title,
        body,
        footer: '',
        styler: s,
        recordHit: hits ? (rowsIndex, bodyLine) => {
          const hit = this.dialogHits.get(bodyLine);
          if (hit) recordHit?.(rowsIndex, hit);
        } : undefined,
      });
    };
    if (dialog.type === 'plan') {
      const plan = this.planDraft || String(dialog.plan || '').trim();
      const body = [];
      body.push(s.fg('faint', `${this.planQuestionsAsked || 0} clarifying question${(this.planQuestionsAsked || 0) === 1 ? '' : 's'} asked while planning`));
      body.push('');
      const planLines = plan ? plan.split(/\r?\n/) : ['(the plan is missing)'];
      const maxLines = Math.max(8, rows - 6);
      const start = Math.max(0, Math.min(dialog.scroll || 0, Math.max(0, planLines.length - maxLines)));
      for (const line of planLines.slice(start, start + maxLines)) {
        body.push(truncateToWidth(line, Math.max(8, Math.min(cols, 96) - 6)));
      }
      body.push('');
      body.push(`${s.fg('accent', 'enter build')} · ${s.fg('faint', 'esc keep planning')}`);
      return band({ title: 'build this plan', body });
    }
    if (dialog.type === 'confirm') {
      const hits = new Map([[2, { type: 'confirm' }]]);
      return band({
        title: 'confirm',
        body: [dialog.message, '', `${s.fg('success', '[y]')} yes   ${s.fg('danger', '[n]')} no`],
        hits,
      });
    }
    if (dialog.type === 'ask') {
      const state = this.askDialogState();
      if (!state) return band({ title: 'gatita is asking…', body: ['Preparing your question…'] });
      const { entry } = state;
      if (dialog.expired) {
        return band({
          title: 'gatita is asking…',
          body: [
            s.fg('warning', 'This question timed out after 5 minutes.'),
            '',
            s.fg('muted', 'Gatita is cancelling the task and cleaning up.'),
            s.fg('faint', 'Press enter or esc to close this box.'),
          ],
        });
      }
      const current = entry.questions[dialog.index] || entry.questions[0];
      const hits = new Map();
      const body = [];
      const remaining = Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
      const mm = Math.floor(remaining / 60);
      const ss = String(remaining % 60).padStart(2, '0');
      body.push(s.fg('muted', `question ${dialog.index + 1} of ${entry.questions.length} · ${mm}:${ss} left`));
      body.push('');
      body.push(s.bold(s.fg('accent', current.question)));
      if (current.multiSelect) body.push(s.fg('faint', 'choose any number — enter toggles a check, tab moves on'));
      body.push('');
      for (let index = 0; index < current.options.length; index += 1) {
        const option = current.options[index];
        const selected = index === (dialog.cursor || 0);
        const checked = current.multiSelect && dialog.selected.has(`${current.id}:${option.id}`);
        const statusGlyph = current.multiSelect ? (checked ? '✓' : '○') : '○';
        const marker = selected ? s.fg('accent', '›') : ' ';
        body.push(`${marker} ${s.fg(selected ? 'text' : 'muted', statusGlyph)} ${s.fg(selected ? 'accent' : 'text', option.label)}`);
        hits.set(body.length - 1, { type: 'ask-option', index });
        if (option.description) body.push(`    ${s.fg('faint', truncateToWidth(option.description, Math.max(8, cols - 24)))}`);
      }
      const otherIndex = current.options.length;
      const otherSelected = (dialog.cursor || 0) === otherIndex;
      const otherMarker = otherSelected ? s.fg('accent', '›') : ' ';
      body.push(`${otherMarker} ${s.fg(otherSelected ? 'accent' : 'faint', '✦')} ${s.fg(otherSelected ? 'text' : 'muted', 'Other — type your own answer')}`);
      hits.set(body.length - 1, { type: 'ask-other' });
      if (dialog.otherOpen) {
        const text = dialog.otherText || '';
        const cur = Math.min(dialog.otherCursor || 0, text.length);
        const cellEnd = codePointAfter(text, cur);
        const cell = text.slice(cur, cellEnd) || ' ';
        const rendered = text ? `${text.slice(0, cur)}${s.inverse(cell)}${text.slice(cellEnd)}` : s.inverse(' ');
        body.push('');
        body.push(`  ${rendered}`);
        body.push(s.fg('faint', 'type above · enter to submit · esc to go back'));
      } else {
        body.push('');
        body.push(s.fg('faint', current.multiSelect
          ? '↑↓ select · enter toggle · tab next question · esc cancel'
          : '↑↓ select · enter pick · esc cancel'));
      }
      return band({ title: 'gatita is asking…', body, hits });
    }
    if (dialog.type === 'input') {
      const value = dialog.value || '';
      const cellEnd = codePointAfter(value, Math.min(dialog.cursor, value.length));
      const cell = value.slice(dialog.cursor, cellEnd) || ' ';
      const rendered = value ? `${value.slice(0, dialog.cursor)}${s.inverse(cell)}${value.slice(cellEnd)}` : s.inverse(' ');
      return band({
        title: dialog.title,
        body: [rendered, '', s.fg('faint', dialog.hint || 'enter to confirm · esc to cancel')],
      });
    }
    if (dialog.type === 'settings') {
      const entries = this.settingsEntries();
      const body = [
        s.fg('faint', 'plan mode blocks writes and shell until the plan is built.'),
        s.fg('faint', 'thinking and work details change what the transcript shows.'),
        '',
      ];
      for (const [index, entry] of entries.entries()) {
        const selected = index === (dialog.index || 0);
        const marker = selected ? s.fg('accent', '›') : ' ';
        body.push(`${marker} ${s.fg(selected ? 'text' : 'muted', entry.label.padEnd(18))} ${s.fg(entry.value === 'off' ? 'warning' : 'success', entry.value)}`);
      }
      body.push('');
      body.push(s.fg('faint', '↑↓ select · enter change · esc close'));
      const hits = new Map(entries.map((entry, index) => [3 + index, { type: 'setting', key: entry.key }]));
      return band({ title: 'settings', body, hits });
    }
    if (dialog.type === 'permissions') {
      const keys = this.dialogItems(dialog);
      const body = [
        s.fg('faint', 'Read, search and todo are always allowed.'),
        '',
        ...keys.map((key, index) => {
          const selected = index === (dialog.index || 0);
          const enabled = Boolean(this.config.autoApprove[key]);
          const marker = selected ? s.fg('accent', '›') : ' ';
          const state = enabled ? s.fg('success', 'allowed') : s.fg('warning', 'ask first');
          return `${marker} ${s.fg(selected ? 'text' : 'muted', key.padEnd(10))} ${state}`;
        }),
        '',
        s.fg('faint', 'space or enter toggles · esc closes'),
      ];
      const hits = new Map(keys.map((key, index) => [2 + index, { type: 'permission', key }]));
      return band({ title: 'permissions', body, hits });
    }
    if (dialog.type === 'usage') {
      const data = dialog.data;
      const body = [];
      for (const window of data.windows || []) {
        body.push(`${s.fg('text', window.label.padEnd(8))} ${progressBar(window.percent, 24, s, window.percent >= 90 ? 'danger' : 'accent')} ${s.fg('muted', `${formatTokens(window.used)} / ${formatTokens(window.limit)}`)}`);
        if (window.resetAt) body.push(`  ${s.fg('faint', `resets in ${formatDuration(Math.max(0, window.resetAt - Date.now()), { compact: true })}`)}`);
      }
      const banked = data.bankedResets;
      if (banked) {
        body.push('');
        if (banked.count > 0) {
          const expiry = banked.nextExpiresAt
            ? `oldest expires in ${formatDuration(Math.max(0, banked.nextExpiresAt - Date.now()), { compact: true })}`
            : '';
          body.push(`${s.fg('accent', '◆')} ${s.fg('text', `banked resets: ${banked.count}`)}  ${s.fg('faint', expiry)}`);
          body.push(`  ${s.fg('faint', '/reset uses one now')}`);
        } else {
          body.push(`${s.fg('faint', 'no banked resets')}`);
        }
      }
      body.push('');
      body.push(`${s.fg('muted', `Last 30 days: ${formatTokens(data.totals.tokens)} tokens across ${plural(data.totals.requests, 'request')}`)}`);
      body.push('');
      for (const model of (data.models || []).slice(0, 6)) {
        body.push(`  ${s.fg('text', model.modelId.padEnd(18))} ${s.fg('muted', formatTokens(model.tokens).padStart(8))}  ${s.fg('faint', plural(model.requests, 'request'))}`);
      }
      body.push('');
      body.push(s.fg('faint', 'esc closes · /reset uses a banked reset'));
      const start = Math.max(0, Math.min(dialog.scroll || 0, Math.max(0, body.length - (rows - 2))));
      return band({
        title: 'usage',
        body: body.slice(start),
      });
    }
    if (dialog.type === 'text') {
      const body = Array.isArray(dialog.body) ? dialog.body : [];
      const start = Math.max(0, Math.min(dialog.scroll || 0, Math.max(0, body.length - (rows - 2))));
      return band({
        title: dialog.title || 'gatita',
        body: body.slice(start),
      });
    }
    if (dialog.type === 'help') {
      const body = [];
      body.push(s.fg('accent', 'keys'));
      for (const line of [
        'enter send · shift+enter (or ctrl+j) newline',
        'ctrl+t toggle work details · ctrl+r toggle thinking · m expand/minimize all thoughts',
        'type while gatita works and press enter — your message steers her after the next tool finishes',
        'tab complete · up/down move in the suggestion list · enter accepts it',
        'esc interrupt · ctrl+c cancel or quit',
        'terminal bell plus a synthesized chime: once when gatita needs you and twice when done · /sound toggles',
        'drag with the left mouse button to select text — release to copy',
        'selections stay inside one section: sidebar, conversation, or composer',
        'gatita can ask multiple-choice questions (with an "other" option) — she keeps preparing safely while you answer',
        'multi-line selections are copied inside a markdown code fence',
        'double-click selects a word · triple-click selects a line',
        'right click pastes the clipboard',
        'pageup/pagedown or mouse wheel scrolls · ctrl+o expand tool · m minimize/expand thoughts',
        'left click folders · recent chats · model/chat pickers · suggestion rows',
        'up/down history · ctrl+a/e line start/end',
        '@skill-name mentions an installed skill · @ + tab autocompletes',
        'skills live globally in ~/.gatita-studio/skills/<name>/SKILL.md (see the premade example folder)',
      ]) body.push(`  ${s.fg('muted', line)}`);
      body.push('');
      body.push(s.fg('accent', 'commands'));
      for (const command of SLASH_COMMANDS) {
        body.push(`  ${s.fg('text', `/${command.name}`.padEnd(13))} ${s.fg('faint', command.description)}`);
      }
      body.push('');
      body.push(s.fg('faint', '  /admin commands work only for admin accounts.'));
      const start = Math.max(0, Math.min(dialog.scroll || 0, Math.max(0, body.length - (rows - 2))));
      return band({ title: 'help', body: body.slice(start) });
    }
    if (dialog.type === 'models') {
      const items = this.dialogItems(dialog);
      const body = [];
      const filter = dialog.filter ? `filter: ${dialog.filter}` : 'type to filter';
      body.push(s.fg('faint', filter));
      body.push('');
      if (!items.length) body.push(s.fg('faint', 'No models match.'));
      items.slice(0, Math.max(1, rows - 6)).forEach((model, index) => {
        const selected = index === (dialog.index || 0);
        const marker = selected ? s.fg('accent', '›') : ' ';
        const name = model.id === this.modelId ? s.fg('accent', model.name) : s.fg(selected ? 'text' : 'muted', model.name);
        const badges = [
          model.tools ? s.fg('muted', 'tools') : s.fg('faint', 'chat'),
          model.vision ? s.fg('info', 'vision') : '',
          model.reasoningLevels.length ? s.fg('accent2', `think ${model.reasoningLevels.join('/')}`) : '',
          model.available ? '' : s.fg('warning', `needs ${model.requiredPlan}`),
        ].filter(Boolean).join(' ');
        body.push(`${marker} ${name.padEnd ? name : name} ${s.fg('faint', formatTokens(model.contextWindow).padStart(6))} ${badges}`);
      });
      body.push('');
      body.push(s.fg('faint', '↑↓ select · enter choose · esc close'));
      const hits = new Map();
      items.slice(0, Math.max(1, rows - 6)).forEach((model, index) => {
        hits.set(2 + index, { type: 'model', id: model.id });
      });
      return band({ title: 'model', body, hits });
    }
    if (dialog.type === 'sessions') {
      const items = this.dialogItems(dialog);
      const body = [];
      body.push(s.fg('faint', dialog.filter ? `filter: ${dialog.filter}` : 'type to filter · tab new chat'));
      body.push('');
      if (!items.length) body.push(s.fg('faint', 'No chats match.'));
      items.slice(0, Math.max(1, rows - 6)).forEach((chat, index) => {
        const selected = index === (dialog.index || 0);
        const marker = selected ? s.fg('accent', '›') : ' ';
        const title = chat.id === this.chat?.id ? s.fg('accent', chat.title) : s.fg(selected ? 'text' : 'muted', chat.title);
        const meta = s.fg('faint', `${chat.messageCount} msg · ${formatDuration(Date.now() - chat.updatedAt, { compact: true })} ago`);
        body.push(`${marker} ${title}`);
        body.push(`    ${meta}`);
      });
      body.push('');
      body.push(s.fg('faint', '↑↓ select · enter resume · tab new · esc close'));
      const hits = new Map();
      items.slice(0, Math.max(1, rows - 6)).forEach((chat, index) => {
        hits.set(2 + index * 2, { type: 'session', id: chat.id });
      });
      return band({ title: 'sessions', body, hits });
    }
    if (dialog.type === 'folders') {
      const body = [];
      const selectedIndex = dialog.index || 0;
      const allMarker = selectedIndex === 0 ? s.fg('accent', '›') : ' ';
      body.push(`${allMarker} ${s.fg(selectedIndex === 0 ? 'text' : 'muted', 'all chats')} ${s.fg('faint', 'no folder')}`);
      this.folders.forEach((folder, index) => {
        const selected = index + 1 === selectedIndex;
        body.push(`${selected ? s.fg('accent', '›') : ' '} ${s.fg(selected ? 'text' : 'muted', folder.name)} ${s.fg('faint', `${folder.chatCount} chats`)}`);
      });
      body.push('');
      body.push(s.fg('faint', 'enter use folder · n new folder · esc close'));
      const hits = new Map([[0, { type: 'folder', id: null }]]);
      this.folders.forEach((folder, index) => {
        hits.set(1 + index, { type: 'folder', id: folder.id });
      });
      return band({ title: 'folders', body, hits });
    }
    return band({ title: 'gatita', body: [s.fg('muted', 'Nothing here. esc closes.')] });
  }
}

export async function runTui({ args = [] } = {}) {
  const config = loadConfig();
  let auth;
  try {
    auth = await ensureLogin({ config });
  } catch (error) {
    console.error(`gatita-studio: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const { client } = auth;
  let me;
  let models;
  try {
    [me, models] = await Promise.all([
      client.me({ timeoutMs: 15_000 }),
      client.models({ timeoutMs: 15_000 }),
    ]);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : String(error?.message || error);
    console.error(`gatita-studio: ${message}`);
    if (error instanceof ApiError && error.status === 401) {
      console.error('Session expired. Run gatita-studio login.');
    }
    process.exitCode = 1;
    return;
  }
  if (args.includes('--model')) {
    const index = args.indexOf('--model');
    if (args[index + 1]) config.defaultModel = args[index + 1];
  }
  const store = openLocalStore(config.paths.db);
  const app = new App({ config, client, me, models, store, args });
  try {
    await app.run();
  } finally {
    if (!app.closed) app.quit();
    try {
      store.close();
    } catch {
      // Already closed.
    }
  }
}
