import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from './config.js';
import { saveStoredAuth } from './authStore.js';
import { createApiClient, ApiError } from './api.js';
import { openLocalStore } from './store.js';
import { ensureLogin } from './commands.js';
import { loadSkills } from '../skills/index.js';
import { loadPlugins } from '../plugins/index.js';
import { createMcpManager, loadMcpConfig } from '../mcp/index.js';
import { createComputerController } from '../computer/index.js';
import { createToolRegistry } from '../tools/index.js';
import {
  runAgent,
  compactConversation,
  computeContextMetrics,
  isCompactionCheckpoint,
  AUTO_COMPACT_RATIO,
} from './agent.js';
import { checkForUpdate, formatUpdateNotice } from './update.js';
import { readClipboard, writeClipboard, readClipboardImage } from './clipboard.js';
import { createTaskManager } from './tasks.js';
import { playChime } from './sound.js';
import { Terminal } from './tui/terminal.js';
import { LoginView } from './tui/login.js';
import {
  renderMarkdown,
  wrapPlain,
  roundedBox,
  progressBar,
  renderDialogBand,
  paintRow,
  paintSurface,
  badge,
  button,
  placeSegments,
} from './tui/render.js';
import { openExternalUrl, PLAN_URL } from './openUrl.js';
import {
  createStyler,
  GLYPHS,
  SPINNER,
  THINKING,
  THEME_NAMES,
  THEME_LABELS,
  selectGlyph,
  truncateVisible,
  padEndVisible,
  visibleWidth,
  sliceVisible,
  stripAnsi,
  centerVisible,
} from './theme.js';
import { CLIENT_VERSION } from '../shared/protocol.js';
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

const MAX_COMPOSER_IMAGES = 32;
const COMPOSER_TOKEN_RE = /\u0001([a-z]+):([a-zA-Z0-9]+)\u0001/g;

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
  goal: '◎',
  task_status: '◐',
  stop_task: '■',
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

function formatCwdForDisplay(rawPath, maxWidth = 36) {
  const full = String(rawPath || '').trim();
  if (!full) return '.';
  const home = os.homedir?.() || '';
  let display = full;
  if (home && full.toLowerCase().startsWith(home.toLowerCase())) {
    const rest = full.slice(home.length);
    if (!rest || rest.startsWith(path.sep) || rest.startsWith('/') || rest.startsWith('\\')) {
      display = `~${rest}`;
    }
  }
  if (visibleWidth(display) <= maxWidth) return display;
  const sep = display.includes('\\') ? '\\' : '/';
  const parts = display.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) return truncateVisible(display, maxWidth);
  const root = display.startsWith('~')
    ? '~'
    : /^[A-Za-z]:/.test(display)
      ? parts[0]
      : '';
  const tail = parts[parts.length - 1];
  const parent = parts.length >= 3 ? parts[parts.length - 2] : '';
  const withParent = `${root}${sep}…${sep}${parent}${sep}${tail}`;
  if (parent && visibleWidth(withParent) <= maxWidth) return withParent;
  const compact = `${root}${sep}…${sep}${tail}`;
  if (visibleWidth(compact) <= maxWidth) return compact;
  return truncateVisible(tail, maxWidth);
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
    this.openTabIds = [];
    this.tabsInitialized = false;
    this.hoverHit = null;
    this.headerHeight = 3;
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
    this.composerAttachments = new Map();
    this.composerTokenSeq = 0;
    this.goal = null;
    this.tasks = createTaskManager();
    this.online = true;
    this.sessionTokens = 0;
    this.lastTurnUsage = null;
    this.lastPromptTokens = 0;
    this.compacting = false;
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
    this.clipboard = { read: readClipboard, write: writeClipboard, readImage: readClipboardImage };
    // Injectable for tests; defaults to opening URLs in the OS default browser.
    this.openUrl = openExternalUrl;
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
      goalManager: {
        get: () => this.goal,
        complete: (summary) => this.completeGoal(summary),
        block: (reason) => this.blockGoal(reason),
      },
      taskManager: this.tasks,
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
    this.syncOpenTabs();
  }

  syncOpenTabs() {
    if (!this.closedTabIds) this.closedTabIds = new Set();
    const known = new Map((this.recentChats || []).map((chat) => [chat.id, chat]));
    if (this.chat && !known.has(this.chat.id)) known.set(this.chat.id, this.chat);
    // Prune deleted chats from open tabs.
    this.openTabIds = (this.openTabIds || []).filter((id) => known.has(id));
    // Seed initial tabs with recent chats that weren't explicitly closed.
    if (!this.tabsInitialized) {
      for (const chat of (this.recentChats || []).slice(0, 6)) {
        if (!this.closedTabIds.has(chat.id) && !this.openTabIds.includes(chat.id)) {
          this.openTabIds.push(chat.id);
        }
      }
      this.tabsInitialized = true;
    } else {
      // Include any newly created chats that haven't been closed.
      for (const chat of (this.recentChats || []).slice(0, 6)) {
        if (!this.closedTabIds.has(chat.id) && !this.openTabIds.includes(chat.id) && this.openTabIds.length < 8) {
          this.openTabIds.push(chat.id);
        }
      }
    }
    if (this.chat && !this.openTabIds.includes(this.chat.id)) {
      this.closedTabIds.delete(this.chat.id);
      this.openTabIds.unshift(this.chat.id);
    }
  }

  ensureTabOpen(chatId) {
    if (!chatId) return;
    if (!this.closedTabIds) this.closedTabIds = new Set();
    this.closedTabIds.delete(chatId);
    if (!this.openTabIds.includes(chatId)) {
      this.openTabIds.push(chatId);
    }
  }

  openTabs() {
    if (!this.tabsInitialized && this.store) {
      this.recentChats = this.store.recentChats(30);
      this.syncOpenTabs();
    }
    const byId = new Map((this.recentChats || []).map((chat) => [chat.id, chat]));
    if (this.chat) byId.set(this.chat.id, this.chat);
    const tabs = [];
    for (const id of this.openTabIds || []) {
      const chat = byId.get(id);
      if (chat) tabs.push(chat);
    }
    if (this.chat && !tabs.some((tab) => tab.id === this.chat.id)) {
      tabs.unshift(this.chat);
    }
    return tabs;
  }

  closeTab(chatId) {
    if (this.running) {
      this.setFlash('Wait for the current turn to finish.', 'warning');
      return false;
    }
    if (!this.closedTabIds) this.closedTabIds = new Set();
    const index = (this.openTabIds || []).indexOf(chatId);
    if (index === -1 && this.chat?.id !== chatId) return false;
    this.closedTabIds.add(chatId);
    this.openTabIds = (this.openTabIds || []).filter((id) => id !== chatId);
    if (this.chat?.id === chatId) {
      const nextId = this.openTabIds[Math.min(Math.max(0, index), this.openTabIds.length - 1)] || null;
      if (nextId) {
        this.loadChat(nextId, { silent: true });
      } else {
        this.chat = null;
        this.messages = [];
        this.todos = [];
        this.goal = null;
        this.registry?.setChat(null);
        this.transcriptCache.clear();
        this.scrollOffset = 0;
        this.followBottom = true;
      }
    }
    this.setToast('Tab closed · /chats to reopen', 'accent');
    this.requestRender();
    return true;
  }

  switchTabByDelta(delta) {
    if (this.running) {
      this.setFlash('Wait for the current turn to finish.', 'warning');
      return false;
    }
    const tabs = this.openTabs();
    if (tabs.length < 2) return false;
    const currentIndex = Math.max(0, tabs.findIndex((tab) => tab.id === this.chat?.id));
    const next = tabs[(currentIndex + delta + tabs.length) % tabs.length];
    if (!next || next.id === this.chat?.id) return false;
    this.loadChat(next.id, { silent: true });
    return true;
  }

  switchTabByIndex(zeroBasedIndex) {
    if (this.running) {
      this.setFlash('Wait for the current turn to finish.', 'warning');
      return false;
    }
    const tabs = this.openTabs();
    const target = tabs[zeroBasedIndex];
    if (!target || target.id === this.chat?.id) return false;
    this.loadChat(target.id, { silent: true });
    return true;
  }

  deleteChatById(chatId) {
    if (this.running) {
      this.setFlash('Wait for the current turn to finish.', 'warning');
      return;
    }
    const target = this.store.findChat(chatId);
    if (!target) return;
    this.confirm(`Delete "${truncate(target.title, 50)}" and its messages?`, () => {
      const goalKey = this.goalStoreKey(target.id);
      if (goalKey) this.store.setSetting(goalKey, '');
      this.store.deleteChat(target.id);
      this.openTabIds = (this.openTabIds || []).filter((id) => id !== target.id);
      this.closedTabIds?.delete(target.id);
      if (this.chat?.id === target.id) {
        this.chat = null;
        this.messages = [];
        this.todos = [];
        this.goal = null;
        this.registry?.setChat(null);
        const nextId = this.openTabIds[0] || this.store.recentChats(1)[0]?.id || null;
        if (nextId) this.loadChat(nextId, { silent: true });
      }
      this.refreshSidebar();
      this.transcriptCache.clear();
      this.requestRender();
      this.setToast('Chat deleted.', 'success');
    });
  }

  hoverKeyFor(hit) {
    if (!hit || !hit.type) return '';
    return `${hit.type}:${hit.id ?? hit.key ?? hit.tab ?? hit.index ?? hit.text ?? hit.command ?? ''}`;
  }

  isHovered(key) {
    return Boolean(key && this.hoverHit?.key === key);
  }

  openPlanPage() {
    this.setToast('Opening gatita.tech/api#plan…', 'accent');
    Promise.resolve()
      .then(() => this.openUrl(PLAN_URL))
      .catch(() => {
        this.setFlash(`Open ${PLAN_URL} in your browser.`, 'info');
      });
  }

  cycleReasoning() {
    const model = this.model();
    const levels = model?.reasoningLevels || [];
    if (!levels.length) {
      this.setFlash(`${model?.name || 'This model'} has no reasoning levels.`, 'warning');
      return false;
    }
    const idx = levels.indexOf(this.reasoning);
    const next = levels[(idx + 1) % levels.length];
    return this.setReasoning(next);
  }

  goalStoreKey(chatId = this.chat?.id) {
    return chatId ? `goal:${chatId}` : null;
  }

  loadGoal(chatId = this.chat?.id) {
    this.goal = null;
    const key = this.goalStoreKey(chatId);
    if (!key) return;
    try {
      const value = JSON.parse(this.store.getSetting(key, 'null'));
      if (value?.text && ['active', 'complete', 'blocked'].includes(value.status)) this.goal = value;
    } catch {
      this.goal = null;
    }
  }

  persistGoal() {
    const key = this.goalStoreKey();
    if (!key || !this.store) return;
    this.store.setSetting(key, this.goal ? JSON.stringify(this.goal) : '');
  }

  setGoal(text) {
    const value = String(text || '').trim().slice(0, 4_000);
    if (!value) return null;
    this.goal = { text: value, status: 'active', startedAt: Date.now(), summary: '' };
    this.persistGoal();
    this.setFlash('Goal set. Gatita will keep working until it is complete.', 'success');
    this.requestRender();
    return this.goal;
  }

  completeGoal(summary = '') {
    if (!this.goal || this.goal.status !== 'active') return false;
    if ((this.todos || []).some((item) => item.status === 'pending' || item.status === 'in_progress')) {
      this.setFlash('Finish or cancel unfinished todo items before completing the goal.', 'warning');
      return false;
    }
    this.goal.status = 'complete';
    this.goal.summary = String(summary || '').trim().slice(0, 4_000);
    this.goal.completedAt = Date.now();
    this.persistGoal();
    this.setFlash('Goal complete.', 'success');
    this.requestRender();
    return true;
  }

  blockGoal(reason = '') {
    if (!this.goal || this.goal.status !== 'active') return false;
    this.goal.status = 'blocked';
    this.goal.summary = String(reason || '').trim().slice(0, 4_000);
    this.goal.blockedAt = Date.now();
    this.persistGoal();
    this.setFlash('Goal blocked. Gatita needs your input.', 'warning');
    this.requestRender();
    return true;
  }

  clearGoal({ persist = true } = {}) {
    this.goal = null;
    if (persist) this.persistGoal();
    this.requestRender();
  }

  loadChat(id, { silent = false } = {}) {
    const chat = this.store.findChat(id);
    if (!chat) {
      if (!silent) this.setFlash('That chat no longer exists.', 'danger');
      return false;
    }
    this.chat = chat;
    this.ensureTabOpen(chat.id);
    this.messages = this.store.listMessages(chat.id);
    this.lastPromptTokens = 0;
    this.todos = this.store.listTodos(chat.id);
    this.loadGoal(chat.id);
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
    this.ensureTabOpen(chat.id);
    this.messages = [];
    this.lastPromptTokens = 0;
    this.todos = [];
    this.goal = null;
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

  composerTokens(text = this.input) {
    const source = String(text ?? '');
    const tokens = [];
    for (const match of source.matchAll(COMPOSER_TOKEN_RE)) {
      const entry = this.composerAttachments.get(match[2]);
      if (!entry || entry.kind !== match[1]) continue;
      tokens.push({
        ...entry,
        id: match[2],
        kind: match[1],
        marker: match[0],
        start: match.index,
        end: match.index + match[0].length,
      });
    }
    return tokens;
  }

  composerTokenLabel(entry, imageNumber = 1) {
    if (entry.kind === 'image') return `[Image ${imageNumber}]`;
    const count = Math.max(1, Number(entry.lines) || 1);
    return count === 1 ? '[1 Pasted Line]' : `[${count} Pasted Lines]`;
  }

  composerTokenLabels(text = this.input) {
    const labels = new Map();
    let imageNumber = 0;
    for (const token of this.composerTokens(text)) {
      if (token.kind === 'image') imageNumber += 1;
      labels.set(token.id, this.composerTokenLabel(token, imageNumber));
    }
    return labels;
  }

  expandComposerText(text = this.input) {
    const source = String(text ?? '');
    const labels = this.composerTokenLabels(source);
    const tokens = this.composerTokens(source);
    let output = '';
    let cursor = 0;
    for (const token of tokens) {
      output += source.slice(cursor, token.start);
      output += token.kind === 'image' ? labels.get(token.id) || '' : token.text || '';
      cursor = token.end;
    }
    return output + source.slice(cursor);
  }

  composerImages(text = this.input) {
    return this.composerTokens(text)
      .filter((token) => token.kind === 'image' && token.dataUrl)
      .map((token) => ({
        path: token.path || '',
        mediaType: token.mediaType || 'image/png',
        dataUrl: token.dataUrl,
      }));
  }

  addComposerToken(token) {
    const id = `t${this.composerTokenSeq + 1}`;
    this.composerTokenSeq += 1;
    const entry = { ...token, id };
    this.composerAttachments.set(id, entry);
    const marker = `\u0001${entry.kind}:${id}\u0001`;
    const start = this.cursor;
    this.input = this.input.slice(0, this.cursor) + marker + this.input.slice(this.cursor);
    this.cursor += marker.length;
    this.suggestionIndex = 0;
    this.followBottom = true;
    this.requestRender();
    return { ...entry, start, end: this.cursor };
  }

  attachImage({ path: file = '', name = '', mediaType = 'image/png', dataUrl = '' } = {}) {
    if (!dataUrl || !String(dataUrl).startsWith('data:image/')) {
      this.setFlash('That image could not be read.', 'danger');
      return null;
    }
    if (this.composerImages().length >= MAX_COMPOSER_IMAGES) {
      this.setFlash(`You can attach up to ${MAX_COMPOSER_IMAGES} images at a time.`, 'warning');
      return null;
    }
    const entry = this.addComposerToken({ kind: 'image', path: file, name, mediaType, dataUrl });
    const model = this.model();
    if (model && !model.vision) {
      this.setFlash(`Attached ${name || 'image'}. ${model.name} cannot read images; switch with /model.`, 'warning');
    } else {
      this.setFlash(`Attached ${name || 'image'}.`, 'success');
    }
    return entry;
  }

  insertPastedText(rawText) {
    const text = String(rawText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').slice(0, 100_000);
    if (!text) return false;
    if (!text.includes('\n')) {
      this.insertText(text);
      return true;
    }
    this.addComposerToken({ kind: 'paste', text, lines: text.split('\n').length });
    return true;
  }

  removeComposerToken(token) {
    if (!token) return;
    this.input = this.input.slice(0, token.start) + this.input.slice(token.end);
    this.composerAttachments.delete(token.id);
    if (this.cursor >= token.end) this.cursor -= token.end - token.start;
    else if (this.cursor > token.start) this.cursor = token.start;
    this.suggestionIndex = 0;
  }

  clearComposerImages() {
    let removed = 0;
    for (const token of [...this.composerTokens()].reverse()) {
      if (token.kind !== 'image') continue;
      this.removeComposerToken(token);
      removed += 1;
    }
    this.pruneComposerAttachments();
    this.requestRender();
    return removed;
  }

  pruneComposerAttachments() {
    const present = new Set([...this.input.matchAll(COMPOSER_TOKEN_RE)].map((match) => match[2]));
    for (const id of [...this.composerAttachments.keys()]) {
      if (!present.has(id)) this.composerAttachments.delete(id);
    }
  }

  composerPreviousIndex(index) {
    const token = this.composerTokens().find((entry) => entry.end === index || (index > entry.start && index < entry.end));
    if (token) return token.start;
    return codePointBefore(this.input, index);
  }

  composerNextIndex(index) {
    const token = this.composerTokens().find((entry) => entry.start === index || (index > entry.start && index < entry.end));
    if (token) return token.end;
    return codePointAfter(this.input, index);
  }

  composerTokenAtStart(index) {
    return this.composerTokens().find((entry) => entry.start === index) || null;
  }

  composerTokenAtEnd(index) {
    return this.composerTokens().find((entry) => entry.end === index) || null;
  }

  styleComposerLine(line, labels, cursor = null, lineStart = 0) {
    const s = this.styler;
    return String(line).replace(COMPOSER_TOKEN_RE, (marker, kind, id, offset) => {
      const label = labels.get(id);
      if (!label) return '';
      const foreground = kind === 'image' ? 'image' : 'paste';
      const background = kind === 'image' ? 'imageBg' : 'pasteBg';
      const labelAtCursor = cursor !== null && lineStart + offset === cursor;
      const styledLabel = labelAtCursor ? `${s.inverse(label[0])}${label.slice(1)}` : label;
      return s.bg(background, s.bold(s.fg(foreground, styledLabel)));
    });
  }

  layoutInput(text, cursor, width) {
    const source = String(text ?? '');
    const tokens = this.composerTokens(source);
    const tokensByStart = new Map(tokens.map((token) => [token.start, token]));
    const labels = this.composerTokenLabels(source);
    const lines = [];
    const lineStarts = [];
    let line = '';
    let col = 0;
    let cursorLine = 0;
    let cursorCol = 0;
    let index = 0;
    let lineStartIndex = 0;
    const maxWidth = Math.max(1, width);
    const pushLine = () => {
      lines.push(line);
      lineStarts.push(lineStartIndex);
      line = '';
      col = 0;
    };
    while (index < source.length) {
      if (index === cursor) {
        cursorLine = lines.length;
        cursorCol = col;
      }
      const token = tokensByStart.get(index);
      if (token) {
        const tokenWidth = visibleWidth(labels.get(token.id) || '');
        if (col > 0 && col + tokenWidth > maxWidth) {
          pushLine();
          lineStartIndex = index;
        }
        line += token.marker;
        col += tokenWidth;
        index = token.end;
        if (cursor > token.start && cursor < token.end) {
          cursorLine = lines.length;
          cursorCol = Math.max(0, col - tokenWidth);
        }
        continue;
      }
      const char = String.fromCodePoint(source.codePointAt(index));
      if (char === '\n') {
        pushLine();
        lineStartIndex = index + 1;
        index += 1;
        continue;
      }
      if (col > 0 && col + visibleWidth(char) > maxWidth) {
        pushLine();
        lineStartIndex = index;
      }
      line += char;
      col += visibleWidth(char);
      index += char.length;
    }
    if (cursor === source.length) {
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

  async sendPrompt(rawText, { images: attachedImages = null } = {}) {
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
    const images = Array.isArray(attachedImages)
      ? attachedImages.filter((image) => image?.dataUrl).slice(0, MAX_COMPOSER_IMAGES)
      : [];
    if (images.length && !model.vision) {
      this.setFlash(`${model.name} cannot read images. Switch to Gatita Aura.`, 'warning');
      return;
    }

    this.pushHistory(text);
    this.input = '';
    this.cursor = 0;
    this.composerAttachments.clear();
    this.composerScroll = 0;
    if (!this.chat) {
      this.newChat({ title: makeTitle(text), folderId: this.config.lastFolderId || null, cwd: this.cwd, startFresh: false });
    } else if (this.chat.title === 'New chat') {
      this.store.renameChat(this.chat.id, makeTitle(text));
      this.chat.title = makeTitle(text);
      this.refreshSidebar();
    }
    if (this.goal?.status === 'active') this.persistGoal();
    const imageUrls = images.map((image) => image.dataUrl);
    this.store.addMessage(this.chat.id, {
      role: 'user',
      content: text,
      meta: imageUrls.length ? { images: imageUrls } : null,
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
        goal: this.goal?.status === 'active' ? this.goal : null,
        tasks: this.tasks,
        takeSteering: () => this.drainSteering(),
        initialPromptTokens: this.lastPromptTokens,
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
      this.compacting = false;
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
      if (leftover.length) {
        const leftoverText = leftover.map((item) => item?.text ?? item ?? '').filter(Boolean).join('\n\n');
        const leftoverImages = leftover.flatMap((item) => (Array.isArray(item?.images) ? item.images : []));
        if (leftoverText.trim()) await this.sendPrompt(leftoverText, { images: leftoverImages });
      }
      const pending = this.pendingBuildPlan;
      this.pendingBuildPlan = null;
      if (pending && !failed) await this.sendPrompt(`Build this plan:\n\n${pending}`);
    }
  }

  queueSteering(rawText, { images = [] } = {}) {
    const text = String(rawText || '').trim();
    if (!text || !this.running) return false;
    this.steeringQueue.push({ text, images: Array.isArray(images) ? images : [] });
    this.input = '';
    this.cursor = 0;
    this.composerAttachments.clear();
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
      case 'tool_backgrounded':
        this.activeTool = null;
        this.setFlash(`${event.tool || 'tool'} is still running · ${event.taskId || 'background task'} · use stop_task to cancel`, 'info');
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
        if (Number(event.usage?.promptTokens) > 0) {
          this.lastPromptTokens = Number(event.usage.promptTokens);
        }
        break;
      case 'compacting':
        this.compacting = true;
        break;
      case 'compacted':
        this.compacting = false;
        this.lastPromptTokens = 0;
        if (this.chat) {
          this.messages = this.store.listMessages(this.chat.id);
          this.transcriptCache.clear();
        }
        this.setToast(`Compacted · ${event.compactedCount || 0} earlier messages summarized`, 'accent');
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
    const current = this.config.theme || 'dark';
    const index = THEME_NAMES.indexOf(current);
    const next = THEME_NAMES[(index + 1 + THEME_NAMES.length) % THEME_NAMES.length];
    this.config.theme = next;
    saveConfig(this.config);
    this.styler = createStyler(next, { enabled: true });
    this.transcriptCache.clear();
    this.setFlash(`Theme: ${next} (${THEME_LABELS[next] || next}).`, 'success');
  }

  toggleAnimations() {
    const next = this.config.animations === false;
    this.config.animations = next;
    saveConfig(this.config);
    this.requestRender();
    this.setFlash(`Animations ${next ? 'on' : 'off'}.`, 'success');
  }

  paletteTabs() {
    return [
      { id: 'quick', label: 'Quick' },
      { id: 'commands', label: 'Commands' },
      { id: 'models', label: 'Models' },
      { id: 'themes', label: 'Themes' },
      { id: 'chats', label: 'Chats' },
    ];
  }

  openPalette(tab = 'quick') {
    if (this.approval) return;
    this.openDialog({ type: 'palette', filter: '', index: 0, tab });
  }

  paletteItems(filter = '', tab = 'quick') {
    const term = String(filter || '').trim().toLowerCase();
    const commandItems = SLASH_COMMANDS
      .filter((cmd) => cmd.name !== 'palette')
      .map((cmd) => ({
        kind: 'command',
        section: 'COMMANDS',
        id: cmd.name,
        label: `/${cmd.name}`,
        detail: cmd.description,
        hint: cmd.aliases?.length ? `/${cmd.aliases[0]}` : '',
        search: `${cmd.name} ${(cmd.aliases || []).join(' ')} ${cmd.description}`.toLowerCase(),
      }));
    const modelItems = (this.models || []).map((model) => ({
      kind: 'model',
      section: 'MODELS',
      id: model.id,
      label: `model: ${model.name}`,
      displayLabel: model.name,
      active: model.id === this.modelId,
      detail: model.available
        ? (model.description || `${formatTokens(model.contextWindow)} ctx`)
        : `locked (${model.requiredPlan})`,
      hint: model.id === this.modelId ? 'active' : formatTokens(model.contextWindow),
      search: `model ${model.id} ${model.name} ${model.description || ''}`.toLowerCase(),
    }));
    const themeItems = THEME_NAMES.map((theme) => ({
      kind: 'theme',
      section: 'THEMES',
      id: theme,
      label: `theme: ${theme}`,
      displayLabel: theme,
      active: (this.config.theme || 'dark') === theme,
      detail: THEME_LABELS[theme] || theme,
      hint: (this.config.theme || 'dark') === theme ? 'active' : '',
      search: `theme ${theme} ${THEME_LABELS[theme] || ''}`.toLowerCase(),
    }));
    const chatItems = (this.recentChats || []).slice(0, 12).map((chat) => ({
      kind: 'session',
      section: 'CHATS',
      id: chat.id,
      label: `chat: ${truncate(chat.title, 36)}`,
      displayLabel: truncate(chat.title, 36),
      active: chat.id === this.chat?.id,
      detail: `${chat.messageCount || 0} msg`,
      hint: chat.updatedAt ? `${formatDuration(Math.max(0, Date.now() - chat.updatedAt), { compact: true })} ago` : '',
      search: `chat session resume ${chat.title}`.toLowerCase(),
    }));

    if (term) {
      const all = [...commandItems, ...modelItems, ...themeItems, ...chatItems];
      return all
        .filter((item) => item.search.includes(term))
        .sort((a, b) => {
          const rank = (item) => {
            const id = String(item.id || '').toLowerCase();
            const lbl = String(item.label || '').toLowerCase();
            if (id === term || lbl === term || lbl === `/${term}`) return 0;
            if (id.startsWith(term) || lbl.startsWith(term) || lbl.startsWith(`/${term}`)) return 1;
            if (lbl.includes(term)) return 2;
            return 3;
          };
          return rank(a) - rank(b);
        });
    }

    if (tab === 'commands') return commandItems;
    if (tab === 'models') return modelItems;
    if (tab === 'themes') return themeItems;
    if (tab === 'chats') return chatItems;

    // Default 'quick' tab: focused, uncluttered high-frequency actions + top recent chats.
    const quickActions = [
      {
        kind: 'command',
        section: 'ACTIONS',
        id: 'new',
        label: 'New chat tab',
        displayLabel: 'New chat tab',
        detail: 'Start a fresh conversation',
        hint: '/new',
      },
      {
        kind: 'command',
        section: 'ACTIONS',
        id: 'chats',
        label: 'Browse all chats',
        displayLabel: 'Browse all chats',
        detail: `${(this.recentChats || []).length} saved`,
        hint: '/chats',
      },
      {
        kind: 'command',
        section: 'ACTIONS',
        id: 'model',
        label: 'Switch model',
        displayLabel: 'Switch model',
        detail: this.model()?.name || this.modelId,
        hint: '/model',
      },
      {
        kind: 'action',
        section: 'ACTIONS',
        id: 'toggle-plan',
        label: this.mode === 'plan' ? 'Switch to Build mode' : 'Switch to Plan mode',
        displayLabel: this.mode === 'plan' ? 'Switch to Build mode' : 'Switch to Plan mode',
        detail: this.mode === 'plan' ? 'Allow edits and shell tools' : 'Ask clarifying questions first',
        hint: this.mode === 'plan' ? '/build' : '/plan',
      },
      {
        kind: 'command',
        section: 'ACTIONS',
        id: 'usage',
        label: 'Usage & quota',
        displayLabel: 'Usage & quota',
        detail: 'Inspect limits and recent usage',
        hint: '/usage',
      },
      {
        kind: 'action',
        section: 'ACTIONS',
        id: 'open-plan',
        label: 'Manage plan online',
        displayLabel: 'Manage plan online',
        detail: 'gatita.tech/api#plan',
        hint: '↗',
      },
      {
        kind: 'command',
        section: 'ACTIONS',
        id: 'cwd',
        label: 'Working directory',
        displayLabel: 'Working directory',
        detail: formatCwdForDisplay(this.cwd, 28),
        hint: '/cwd',
      },
      {
        kind: 'command',
        section: 'ACTIONS',
        id: 'settings',
        label: 'Settings',
        displayLabel: 'Settings',
        detail: `Theme: ${this.config.theme || 'dark'}`,
        hint: '/settings',
      },
    ];
    const recentQuick = chatItems
      .filter((item) => item.id !== this.chat?.id)
      .slice(0, 3)
      .map((item) => ({ ...item, section: 'RECENT CHATS' }));
    return [...quickActions, ...recentQuick];
  }

  executePaletteItem(item) {
    if (!item) return;
    this.closeDialog();
    if (item.kind === 'action') {
      if (item.id === 'toggle-plan') this.togglePlanMode();
      else if (item.id === 'open-plan') this.openPlanPage();
      return;
    }
    if (item.kind === 'command') {
      void this.executeSlash(`/${item.id}`);
      return;
    }
    if (item.kind === 'model') {
      this.setModel(item.id);
      return;
    }
    if (item.kind === 'theme') {
      this.config.theme = item.id;
      saveConfig(this.config);
      this.styler = createStyler(item.id, { enabled: true });
      this.transcriptCache.clear();
      this.requestRender();
      this.setFlash(`Theme: ${item.id}.`, 'success');
      return;
    }
    if (item.kind === 'session') {
      if (this.running) {
        this.setFlash('Wait for the current turn to finish.', 'warning');
        return;
      }
      const title = item.displayLabel || item.label.replace(/^chat:\s*/, '');
      if (this.loadChat(item.id)) this.setFlash(`Resumed ${truncate(title, 40)}.`, 'success');
    }
  }

  openLoginDialog({ mode = 'credentials' } = {}) {
    if (this.running) {
      this.setFlash('Wait for the current turn to finish before switching accounts.', 'warning');
      return;
    }
    const currentEmail = this.me?.user?.email || '';
    const view = new LoginView({
      serverUrl: this.config.serverUrl,
      theme: this.config.theme || 'dark',
      animations: this.config.animations !== false,
      initialEmail: currentEmail,
      initialMode: mode === 'token' ? 'token' : 'credentials',
      readClipboard: () => this.clipboard.read(),
      onCancel: () => {
        this.stopAnimation();
        this.closeDialog();
      },
      onComplete: () => {
        this.stopAnimation();
        this.closeDialog();
      },
      onSubmit: async (data, signal) => {
        this.startAnimation();
        this.requestRender();
        try {
          let nextClient;
          let payload;
          if (data.mode === 'token') {
            nextClient = createApiClient({ serverUrl: this.config.serverUrl, token: data.token });
            const me = await nextClient.me({ timeoutMs: 15_000, signal });
            payload = { ...me, token: data.token, expiresAt: null };
            saveStoredAuth(this.config.serverUrl, {
              token: data.token,
              expiresAt: null,
              email: me?.user?.email || '',
              displayName: me?.user?.displayName || '',
              plan: me?.plan?.id || me?.user?.plan || 'free',
            });
          } else {
            nextClient = createApiClient({ serverUrl: this.config.serverUrl, token: '' });
            payload = await nextClient.login(data.email, data.password, { signal });
            saveStoredAuth(this.config.serverUrl, {
              token: payload.token,
              expiresAt: payload.expiresAt,
              email: payload.user?.email || data.email,
              displayName: payload.user?.displayName || '',
              plan: payload.plan?.id || payload.user?.plan || 'free',
            });
          }
          const [me, models] = await Promise.all([
            data.mode === 'token' ? payload : nextClient.me({ timeoutMs: 15_000, signal }).catch(() => payload),
            nextClient.models({ timeoutMs: 15_000, signal }).catch(() => ({ data: this.models, defaultModel: this.defaultModel })),
          ]);
          this.client = nextClient;
          this.me = me;
          this.plan = me?.plan || this.plan;
          this.quota = me?.quota || this.quota;
          this.models = models?.data || this.models;
          this.defaultModel = models?.defaultModel || this.defaultModel;
          this.online = true;
          this.ensureValidModel();
          this.stopAnimation();
          this.closeDialog();
          const who = me?.user?.displayName || me?.user?.email || 'account';
          const planLabel = me?.plan?.displayName || 'Free';
          this.setToast(`Signed in as ${who} (${planLabel})`, 'success');
          this.requestRender();
        } catch (error) {
          if (signal.aborted) return;
          view.submitting = false;
          const status = Number(error?.status || 0);
          const message = error instanceof ApiError
            ? error.message
            : 'Could not reach the Gatita server. Check your connection.';
          if (status === 401 && data.mode === 'credentials') {
            view.password = '';
            view.passwordCursor = 0;
            view.focus = 'password';
          }
          view.setError(message, {
            tone: status === 429 ? 'warning' : 'danger',
            retryAfter: error?.retryAfter || 0,
          });
          this.requestRender();
        }
      },
    });
    view.setServerStatus(this.online ? 'online' : 'offline');
    this.openDialog({ type: 'login', view });
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
      if (this.dialog?.type === 'login' && !this.approval) {
        this.dialog.view.handleKey(key);
        this.requestRender();
        return;
      }
      const askOpen = this.dialog?.type === 'ask' && this.dialog.otherOpen && !this.approval;
      if (this.approval) return;
      if (this.dialog && !askOpen) return;
      const pasted = String(key.text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (askOpen) {
        const dialog = this.dialog;
        const text = dialog.otherText || '';
        const cur = Math.min(dialog.otherCursor || 0, text.length);
        dialog.otherText = (text.slice(0, cur) + pasted.split('\n')[0] + text.slice(cur)).slice(0, 2_000);
        dialog.otherCursor = Math.min(dialog.otherText.length, cur + pasted.split('\n')[0].length);
        this.requestRender();
      } else if (pasted) {
        this.insertPastedText(pasted);
      } else {
        this.pasteFromClipboard({ preferImage: true });
      }
      return;
    }
    if (key.name === 'mouse') {
      if (this.dialog?.type === 'login') {
        const offsetRow = Number(key.row) - (this.headerHeight || 3);
        if (offsetRow >= 1) {
          this.dialog.view.handleKey({ ...key, row: offsetRow });
          this.requestRender();
        }
        return;
      }
      this.handleMouse(key);
      return;
    }
    if (key.ctrl && key.text === 'c') {
      if (this.dialog?.type === 'login') {
        this.dialog.view.handleKey(key);
        this.requestRender();
        return;
      }
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
        this.clearComposer();
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
    if (key.ctrl && key.text === 'p' && !this.approval) {
      if (this.dialog?.type === 'palette') this.closeDialog();
      else if (!this.dialog) this.openPalette();
      return;
    }
    if (key.ctrl && key.text === 'v') {
      if (this.dialog?.type === 'login') {
        this.dialog.view.handleKey(key);
        this.requestRender();
        return;
      }
      if (!this.approval) this.pasteFromClipboard();
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
        this.clearComposer();
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
    if (key.alt && key.name === 'left') {
      this.switchTabByDelta(-1);
      return;
    }
    if (key.alt && key.name === 'right') {
      this.switchTabByDelta(1);
      return;
    }
    if (key.alt && key.name === 'char' && /^[1-9]$/.test(String(key.text || ''))) {
      this.switchTabByIndex(Number(key.text) - 1);
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
      const token = this.composerTokenAtEnd(this.cursor);
      if (token) {
        this.removeComposerToken(token);
      } else {
        const before = codePointBefore(this.input, this.cursor);
        this.input = this.input.slice(0, before) + this.input.slice(this.cursor);
        this.cursor = before;
      }
      this.pruneComposerAttachments();
      this.suggestionIndex = 0;
      this.requestRender();
      return;
    }
    if (key.name === 'delete') {
      const token = this.composerTokenAtStart(this.cursor);
      if (token) {
        this.removeComposerToken(token);
      } else {
        const after = codePointAfter(this.input, this.cursor);
        this.input = this.input.slice(0, this.cursor) + this.input.slice(after);
      }
      this.pruneComposerAttachments();
      this.suggestionIndex = 0;
      this.requestRender();
      return;
    }
    if (key.name === 'left') {
      if (key.ctrl) this.cursor = this.lineStart(this.cursor);
      else this.cursor = this.composerPreviousIndex(this.cursor);
      this.requestRender();
      return;
    }
    if (key.name === 'right') {
      if (key.ctrl) this.cursor = this.lineEnd(this.cursor);
      else this.cursor = this.composerNextIndex(this.cursor);
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
      this.pruneComposerAttachments();
      this.suggestionIndex = 0;
      this.requestRender();
      return;
    }
    if (key.ctrl && key.text === 'k') {
      const end = this.lineEnd(this.cursor);
      this.input = this.input.slice(0, this.cursor) + this.input.slice(end);
      this.pruneComposerAttachments();
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

  clearComposer() {
    this.input = '';
    this.cursor = 0;
    this.suggestionIndex = 0;
    this.composerScroll = 0;
    this.composerAttachments.clear();
    this.requestRender();
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
    return Math.max(4, inner - 4);
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
    const tokens = new Map(this.composerTokens().map((token) => [token.start, token]));
    const labels = this.composerTokenLabels();
    let index = targetStart;
    let visible = 0;
    while (index < targetLimit) {
      if (this.input[index] === '\n') break;
      const token = tokens.get(index);
      if (token) {
        const width = visibleWidth(labels.get(token.id) || '');
        if (visible + width > column) break;
        visible += width;
        index = token.end;
        continue;
      }
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
    const tokens = this.composerTokens();
    const tokenBefore = (position) => tokens.find((token) => token.end === position || (position > token.start && position < token.end));
    while (index > 0) {
      const token = tokenBefore(index);
      if (token) {
        index = token.start;
        break;
      }
      const before = codePointBefore(this.input, index);
      if (!/\s/.test(this.input[before])) break;
      index = before;
    }
    while (index > 0) {
      const token = tokenBefore(index);
      if (token) {
        index = token.start;
        break;
      }
      const before = codePointBefore(this.input, index);
      if (/\s/.test(this.input[before])) break;
      index = before;
    }
    this.input = this.input.slice(0, index) + this.input.slice(this.cursor);
    this.cursor = index;
    this.pruneComposerAttachments();
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
    if (!value.trim()) return;
    const images = this.composerImages(value);
    const text = this.expandComposerText(value);
    this.cursor = 0;
    this.suggestionIndex = 0;
    this.composerScroll = 0;
    // While gatita is working, everything you submit becomes steering text.
    if (this.running) {
      this.queueSteering(text, { images });
      return;
    }
    // A pasted multi-line snippet that merely starts with / is not a command.
    if (!value.includes('\n') && !this.composerTokens(value).length && value.trim().startsWith('/')) {
      this.clearComposer();
      this.executeSlash(value.trim());
      return;
    }
    this.sendPrompt(text, { images });
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
      { key: 'animations', label: 'animations', value: onOff(this.config.animations !== false), toggle: () => this.toggleAnimations() },
      { key: 'theme', label: 'theme', value: this.config.theme || 'dark', detail: THEME_LABELS[this.config.theme || 'dark'] || '', toggle: () => this.toggleTheme() },
      { key: 'permissions', label: 'tool approvals', value: 'open', toggle: () => this.openDialog({ type: 'permissions', index: 0 }) },
      { key: 'account', label: 'switch account', value: this.me?.user?.email || 'sign in', toggle: () => this.openLoginDialog() },
    ];
  }

  openSettings() {
    this.openDialog({ type: 'settings', index: 0 });
  }

  openWorkspaceDialog() {
    this.openDialog({ type: 'workspace' });
  }

  openContextDialog() {
    this.openDialog({ type: 'context' });
  }

  contextMetrics() {
    return computeContextMetrics({
      history: this.messages || [],
      model: this.model(),
      lastPromptTokens: this.lastPromptTokens,
    });
  }

  async compactCurrentChat() {
    if (!this.chat) {
      this.setFlash('No chat is open. Send a message or run /new.', 'warning');
      return false;
    }
    if (this.running) {
      this.setFlash('Wait for Gatita to finish first.', 'warning');
      return false;
    }
    const model = this.model();
    this.running = true;
    this.compacting = true;
    this.abortController = new AbortController();
    this.startAnimation();
    this.setFlash('Compacting conversation…', 'info');
    this.requestRender();
    try {
      const result = await compactConversation({
        api: this.client,
        store: this.store,
        chat: this.chat,
        cwd: this.cwd,
        model,
        plan: this.plan?.id || 'free',
        registry: this.registry,
        auto: false,
        signal: this.abortController.signal,
      });
      if (result.skipped) {
        this.setFlash('This conversation is already short.', 'muted');
        return false;
      }
      this.lastPromptTokens = 0;
      this.messages = this.store.listMessages(this.chat.id);
      this.todos = this.store.listTodos(this.chat.id);
      this.transcriptCache.clear();
      this.followBottom = true;
      this.scrollOffset = 0;
      this.refreshSidebar();
      this.setFlash(`Compacted ${result.compactedCount} earlier messages. Full history remains visible above.`, 'success');
      this.requestRender();
      return true;
    } catch (error) {
      if (error?.code === 'aborted' || this.abortController?.signal?.aborted) {
        this.setFlash('Compaction cancelled.', 'warning');
        return false;
      }
      this.setFlash(error?.message || 'Could not compact conversation.', 'danger');
      return false;
    } finally {
      this.running = false;
      this.compacting = false;
      this.abortController = null;
      this.stopAnimation();
      this.requestRender();
    }
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
    // Hover motion without a button held (reported as button 35 with SGR 1003).
    if (button === 35) {
      const index = Number(row) - 1;
      const hit = this.hitAtColumn(this.hitRegions?.[index], column);
      const nextKey = hit ? this.hoverKeyFor(hit) : '';
      const prevKey = this.hoverHit?.key || '';
      if (nextKey !== prevKey) {
        this.hoverHit = nextKey ? { row: index, key: nextKey } : null;
        this.requestRender();
      }
      return;
    }
    if (button === 64 || button === 65) {
      const direction = button === 64 ? 1 : -1;
      if (this.dialog) {
        // List dialogs move selection; scrollable dialogs scroll their body
        if (['models', 'sessions', 'permissions', 'folders', 'settings', 'palette'].includes(this.dialog.type)) {
          this.dialog.index = Math.max(0, (this.dialog.index || 0) - direction * 1);
          const count = this.dialogItemCount(this.dialog);
          this.dialog.index = Math.min(Math.max(0, count - 1), this.dialog.index);
        } else if (['usage', 'text', 'help', 'plan', 'tasks'].includes(this.dialog.type)) {
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
        if (this.dialog?.type === 'folders') this.closeDialog();
        this.setFlash(hit.id ? 'Folder selected.' : 'Showing all chats.', 'success');
        return;
      }
      case 'new-chat':
        if (this.dialog) this.closeDialog();
        this.newChat({ folderId: this.config.lastFolderId || null, cwd: this.cwd });
        return;
      case 'close-tab':
        this.closeTab(hit.id);
        return;
      case 'open-chats':
        this.openDialog({ type: 'sessions', index: 0, filter: '' });
        return;
      case 'delete-chat':
        this.deleteChatById(hit.id);
        return;
      case 'open-plan':
        this.openPlanPage();
        return;
      case 'open-update':
        void this.executeSlash('/update');
        return;
      case 'open-help':
        this.openDialog({ type: 'help', scroll: 0 });
        return;
      case 'open-tasks':
        this.openDialog({ type: 'tasks', scroll: 0 });
        return;
      case 'open-workspace':
        this.openWorkspaceDialog();
        return;
      case 'open-context':
        this.openContextDialog();
        return;
      case 'run-compact':
        this.closeDialog();
        void this.compactCurrentChat();
        return;
      case 'change-cwd':
        this.closeDialog();
        this.promptInput({
          title: 'change working directory',
          value: this.cwd,
          hint: 'enter path · esc cancel',
          onSubmit: (nextDir) => {
            if (nextDir) void this.setCwd(nextDir);
          },
        });
        return;
      case 'copy-cwd':
        Promise.resolve()
          .then(() => this.clipboard.write(this.cwd))
          .then(() => this.setToast('Working directory copied.', 'success'))
          .catch((error) => this.setFlash(`Clipboard failed: ${error?.message || error}`, 'danger'));
        return;
      case 'cycle-reasoning':
        this.cycleReasoning();
        return;
      case 'send-or-stop':
        if (this.running) {
          this.abortController?.abort();
          this.setFlash('Stopping…', 'warning');
        } else if (this.input.trim()) {
          this.submitInput();
        }
        return;
      case 'close-dialog':
        if (this.approval) this.finishApproval(false, { abort: true });
        else this.closeDialog();
        return;
      case 'approval-allow':
        this.finishApproval(true);
        return;
      case 'approval-always':
        this.finishApproval(true, { remember: true });
        return;
      case 'approval-deny':
        this.finishApproval(false);
        return;
      case 'confirm-yes': {
        const current = this.dialog;
        if (current?.type === 'confirm') {
          this.dialog = null;
          this.requestRender();
          current.resolve?.(true);
        }
        return;
      }
      case 'confirm-no': {
        const current = this.dialog;
        if (current?.type === 'confirm') {
          this.dialog = null;
          this.requestRender();
          current.resolve?.(false);
        }
        return;
      }
      case 'plan-build':
        this.acceptPlan();
        return;
      case 'plan-keep':
        if (this.dialog?.type === 'plan') {
          this.dialog = null;
          this.requestRender();
        }
        return;
      case 'use-banked-reset':
        this.closeDialog();
        void this.useBankedReset();
        return;
      case 'palette-tab':
        if (this.dialog?.type === 'palette') {
          this.dialog.tab = hit.tab || 'quick';
          this.dialog.filter = '';
          this.dialog.index = 0;
          this.requestRender();
        }
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
      case 'open-models':
        this.openDialog({ type: 'models', index: 0, filter: '' });
        return;
      case 'open-login':
        this.openLoginDialog();
        return;
      case 'open-palette':
        this.openPalette();
        return;
      case 'palette-item':
        this.executePaletteItem(hit.item);
        return;
      case 'scroll-bottom':
        this.scrollOffset = 0;
        this.followBottom = true;
        this.requestRender();
        return;
      case 'starter-prompt':
        if (hit.command) {
          void this.executeSlash(hit.command);
        } else if (hit.text) {
          this.input = hit.text;
          this.cursor = this.input.length;
          this.requestRender();
        }
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

  async pasteFromClipboard({ preferImage = false } = {}) {
    let readError = null;
    try {
      const readImage = this.clipboard.readImage;
      if (preferImage && typeof readImage === 'function') {
        const image = await readImage();
        if (image?.dataUrl) {
          if (this.approval || this.dialog) {
            this.setToast('Close the dialog first.', 'warning');
            return;
          }
          this.attachImage({ ...image, name: 'pasted image' });
          return;
        }
      }
      let raw = '';
      try {
        raw = await this.clipboard.read();
      } catch (error) {
        readError = error;
      }
      const text = String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (text) {
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
        this.insertPastedText(text);
        return;
      }
      if (!preferImage && typeof readImage === 'function') {
        const image = await readImage();
        if (image?.dataUrl) {
          if (this.approval || this.dialog) {
            this.setToast('Close the dialog first.', 'warning');
            return;
          }
          this.attachImage({ ...image, name: 'pasted image' });
          return;
        }
      }
      if (readError) throw readError;
      this.setToast('Clipboard is empty.', 'warning');
    } catch (error) {
      this.setToast(`Clipboard failed: ${error?.message || error}`, 'danger');
    }
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
    if (dialog.type === 'palette') {
      return this.paletteItems(dialog.filter || '', dialog.tab || 'quick');
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
    if (dialog.type === 'login') {
      dialog.view.handleKey(key);
      this.requestRender();
      return;
    }
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
    if (dialog.type === 'context') {
      const letter = (key.name === 'char' || key.name === 'text') ? String(key.text || '').toLowerCase() : '';
      if (key.name === 'escape' || key.name === 'enter') {
        this.closeDialog();
      } else if (letter === 'c') {
        this.closeDialog();
        void this.compactCurrentChat();
      }
      return;
    }
    if (dialog.type === 'workspace') {
      const letter = (key.name === 'char' || key.name === 'text') ? String(key.text || '').toLowerCase() : '';
      if (key.name === 'escape' || key.name === 'enter') {
        this.closeDialog();
      } else if (letter === 'c') {
        this.invokeHitRegion({ type: 'change-cwd' }, 1);
      } else if (letter === 'y') {
        this.invokeHitRegion({ type: 'copy-cwd' }, 1);
      }
      return;
    }
    if (dialog.type === 'help' || dialog.type === 'usage' || dialog.type === 'text' || dialog.type === 'tasks') {
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
    if (dialog.type === 'models' || dialog.type === 'sessions' || dialog.type === 'palette') {
      if (dialog.type === 'palette' && (key.name === 'tab' || ((!dialog.filter) && (key.name === 'left' || key.name === 'right')))) {
        const tabs = this.paletteTabs();
        const cur = Math.max(0, tabs.findIndex((t) => t.id === (dialog.tab || 'quick')));
        const delta = key.name === 'left' || key.shift ? -1 : 1;
        dialog.tab = tabs[(cur + delta + tabs.length) % tabs.length].id;
        dialog.index = 0;
        this.requestRender();
        return;
      }
      if (dialog.type === 'sessions' && !dialog.filter && (key.name === 'delete' || ((key.name === 'char' || key.name === 'text') && String(key.text || '').toLowerCase() === 'd'))) {
        const items = this.dialogItems(dialog);
        const item = items[dialog.index || 0];
        if (item) this.deleteChatById(item.id);
        return;
      }
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
        if (dialog.type === 'palette') {
          this.executePaletteItem(item);
        } else if (dialog.type === 'models') {
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
    this.tasks?.cleanup?.();
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
    if (this.dialog?.type === 'login' && this.dialog.view) {
      this.dialog.view.tick = this.animationTick;
    }
    const statusHits = [];
    const status = this.renderStatus(cols, statusHits);
    const headerHits = [];
    const tabHits = [];
    const headerRow = this.renderHeader(cols, headerHits);
    const tabBarRows = this.renderTabBar(cols, tabHits);
    const header = [headerRow, ...tabBarRows];
    this.headerHeight = header.length;
    if (headerHits.length) this.addHit(0, headerHits);
    if (tabHits.length) this.addHit(1, tabHits);
    const composerHits = [];
    const composer = this.renderComposer(cols, composerHits, rows);
    let middleRows = rows - header.length - composer.length - 1;
    if (middleRows < 3) {
      middleRows = Math.max(1, rows - header.length - 1 - 1);
    }
    const composerStartRow = header.length + middleRows;
    for (let index = 0; index < composerHits.length; index += 1) {
      if (composerHits[index]) this.addHit(composerStartRow + index, composerHits[index]);
    }
    const middle = [];
    const baseRow = header.length;
    const rowRegions = [];
    const tag = (count, regions) => {
      for (let index = 0; index < count; index += 1) rowRegions.push(regions);
    };
    rowRegions.push([{ kind: 'header', col: 0, width: cols }]);
    for (let index = 0; index < tabBarRows.length; index += 1) {
      rowRegions.push([{ kind: 'tabs', col: 0, width: cols }]);
    }
    if (this.dialog || this.approval) {
      const dialogRows = this.approval
        ? this.renderApproval(middleRows, cols, (index, hit) => {
          if (hit) this.addHit(baseRow + index, hit);
        })
        : (this.dialog ? this.renderDialog(middleRows, cols, (index, hit) => {
          if (hit) this.addHit(baseRow + index, hit);
        }) : []);
      middle.push(...dialogRows);
      tag(dialogRows.length, [{ kind: 'dialog', col: 0, width: cols }]);
    } else {
      const convHits = [];
      const conversation = this.renderConversation(middleRows, cols, convHits);
      middle.push(...conversation);
      for (let index = 0; index < middleRows; index += 1) {
        const rowHits = [];
        if (convHits[index]) rowHits.push(...this.sameRowHits(convHits[index]));
        const transcriptHit = this.transcriptHits?.get((this.conversationStart || 0) + index);
        if (transcriptHit) rowHits.push(...this.sameRowHits(transcriptHit));
        if (rowHits.length) this.addHit(baseRow + index, rowHits);
      }
      tag(middle.length, [{ kind: 'conversation', col: 0, width: cols }]);

      // Floating command/skill suggestions overlay directly over the bottom of the
      // conversation so typing "/" or "@" never shifts the chat text.
      const suggestionSet = this.visibleSuggestions();
      if (suggestionSet?.items?.length && middle.length >= 3) {
        const overlay = this.renderSuggestionsOverlay(cols, middle.length, suggestionSet);
        const startIdx = Math.max(0, middle.length - overlay.lines.length);
        for (let i = 0; i < overlay.lines.length; i += 1) {
          const targetIdx = startIdx + i;
          if (targetIdx < 0 || targetIdx >= middle.length) continue;
          const baseLine = padEndVisible(truncateVisible(middle[targetIdx] || '', cols), cols);
          const before = sliceVisible(baseLine, 0, overlay.left);
          const after = sliceVisible(baseLine, overlay.left + overlay.width);
          middle[targetIdx] = `${before}${overlay.lines[i]}${after}`;
          const screenRow = baseRow + targetIdx;
          const existing = this.sameRowHits(this.hitRegions[screenRow]).filter((entry) => {
            const start = Number(entry?.col ?? 0);
            const end = start + (Number.isFinite(Number(entry?.width)) ? Number(entry.width) : cols);
            return end <= overlay.left || start >= overlay.left + overlay.width;
          });
          if (overlay.hits[i]) {
            existing.unshift({ ...overlay.hits[i], col: overlay.left, width: overlay.width });
          }
          this.hitRegions[screenRow] = existing.length === 0 ? null : (existing.length === 1 ? existing[0] : existing);
        }
      }
    }
    tag(composer.length, [{ kind: 'composer', col: 0, width: cols }]);
    const frame = [...header, ...middle, ...composer];
    while (frame.length < rows - 1) frame.push('');
    frame.push(status);
    if (statusHits.length) this.addHit(Math.min(rows - 1, frame.length - 1), statusHits);
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
      const rowIndex = Math.min(this.headerHeight, view.length - 1);
      const line = view[rowIndex] || '';
      const tone = toast.color || 'success';
      const bgTone = tone === 'warning' ? 'warningBg' : tone === 'danger' ? 'dangerBg' : tone === 'accent' ? 'accentBg' : 'successBg';
      view[rowIndex] = `${sliceVisible(line, 0, col)}${this.styler.bg(bgTone, this.styler.bold(this.styler.fg(tone, text)))}${sliceVisible(line, col + width)}`;
    }
    this.lastFramePlain = view.map((line) => stripAnsi(line));
    return view.map((line) => paintRow(line, this.styler));
  }

  renderHeader(cols, hits = []) {
    const s = this.styler;
    const catGlyph = (this.approval || this.lastError)
      ? s.fg('warning', GLYPHS.catAlert)
      : s.fg('accent', GLYPHS.cat);

    // Build clickable right-hand app action buttons first so we know their exact width.
    const planName = (this.plan?.displayName || 'Free').replace(/^Gatita\s+/i, '').toUpperCase();
    const planId = String(this.plan?.id || 'free').toLowerCase();
    const planVariant = planId === 'pro' ? 'plan-pro' : planId === 'plus' ? 'plan-plus' : 'plan-free';
    const planBtnText = button(s, planName, {
      variant: planVariant,
      icon: planId === 'free' ? '' : '✦',
      trailing: '↗',
      hovered: this.isHovered('open-plan:'),
    });

    const usage = this.mostRestrictiveWindow();
    const usagePct = Number(usage?.percent || 0);
    const usageVariant = usagePct >= 90 ? 'danger' : usagePct >= 75 ? 'warning' : 'secondary';
    const usageBtnText = usage
      ? button(s, formatTokens(usage.remaining), {
        variant: usageVariant,
        icon: '◔',
        hovered: this.isHovered('open-usage:'),
      })
      : '';

    const modelName = this.model()?.name || this.modelId;
    const modelBtnText = button(s, truncateVisible(modelName, cols >= 96 ? 18 : 13), {
      variant: 'secondary',
      icon: '◆',
      trailing: '▾',
      hovered: this.isHovered('open-models:'),
    });

    const settingsBtnText = button(s, cols >= 116 ? 'Settings' : '', {
      variant: 'subtle',
      icon: '◈',
      hovered: this.isHovered('open-settings:'),
    });

    const accountLabel = cols >= 128 && this.me?.user
      ? truncateVisible(this.me.user.displayName || this.me.user.email || '', 14)
      : '';
    const accountBtnText = button(s, accountLabel, {
      variant: 'subtle',
      icon: this.online ? s.fg('success', '●') : s.fg('danger', '○'),
      hovered: this.isHovered('open-login:'),
    });

    const rightSegments = [];
    if (this.running) {
      const elapsed = this.stream.startedAt ? Date.now() - this.stream.startedAt : 0;
      const spin = this.config.animations !== false ? selectGlyph(SPINNER, this.animationTick) : GLYPHS.running;
      rightSegments.push({
        text: button(s, formatDuration(elapsed, { compact: true }), { variant: 'accent', icon: spin }),
      });
    }
    if (this.updateNotice) {
      rightSegments.push({
        text: button(s, `update: ${this.updateNotice.latest}`, {
          variant: 'warning',
          hovered: this.isHovered('open-update:'),
        }),
        hit: { type: 'open-update' },
      });
    }
    rightSegments.push({
      text: planBtnText,
      hit: { type: 'open-plan' },
    });
    if (usageBtnText && cols >= 82) {
      rightSegments.push({
        text: usageBtnText,
        hit: { type: 'open-usage' },
      });
    }
    rightSegments.push({
      text: modelBtnText,
      hit: { type: 'open-models' },
    });
    if (cols >= 74) {
      rightSegments.push({
        text: settingsBtnText,
        hit: { type: 'open-settings' },
      });
    }
    if (cols >= 66) {
      rightSegments.push({
        text: accountBtnText,
        hit: { type: 'open-login' },
      });
    }

    const rightLayout = placeSegments(rightSegments, { startCol: 0, gap: 1 });
    const rightCol = Math.max(0, cols - rightLayout.width - 1);

    // Build left-hand brand + obvious clickable working directory + mode badges.
    const leftSegments = [
      { text: `${catGlyph} ${s.bold(s.fg('text', cols >= 106 ? 'GATITA STUDIO' : 'GATITA'))}` },
    ];
    if (cols >= 122) {
      leftSegments.push({ text: s.fg('faint', `v${CLIENT_VERSION}`) });
    }
    const maxLeftRoom = Math.max(10, rightCol - 2);
    const modeReserve = (this.mode === 'plan' ? 7 : 0) + (this.goal?.status === 'active' ? 7 : 0);
    const baseLeftWidth = placeSegments(leftSegments, { startCol: 1, gap: 1 }).width;
    const cwdRoom = maxLeftRoom - baseLeftWidth - modeReserve - 7;
    if (cwdRoom >= 6) {
      const cwdLabel = formatCwdForDisplay(this.cwd, Math.min(38, cwdRoom));
      leftSegments.push({
        text: button(s, cwdLabel, {
          variant: 'secondary',
          icon: '▤',
          trailing: '▾',
          hovered: this.isHovered('open-workspace:'),
        }),
        hit: { type: 'open-workspace' },
      });
    }
    if (this.mode === 'plan') {
      leftSegments.push({
        text: button(s, 'PLAN', {
          variant: 'warning',
          hovered: this.isHovered('toggle-plan:'),
        }),
        hit: { type: 'toggle-plan' },
      });
    }
    if (this.goal?.status === 'active') {
      leftSegments.push({
        text: badge(s, 'GOAL', { fg: 'accent', bg: 'accentBg', bold: true }),
      });
    }

    const leftLayout = placeSegments(leftSegments, { startCol: 1, gap: 1 });
    const leftStr = truncateVisible(leftLayout.text, Math.max(0, rightCol - 2));
    const leftFinalWidth = visibleWidth(leftStr);
    const gapWidth = Math.max(1, rightCol - 1 - leftFinalWidth);
    const fullLine = ` ${leftStr}${' '.repeat(gapWidth)}${rightLayout.text} `;

    if (hits) {
      for (const h of leftLayout.hits) {
        if (h.col + h.width <= 1 + leftFinalWidth) hits.push(h);
      }
      for (const h of rightLayout.hits) {
        hits.push({ ...h, col: rightCol + h.col });
      }
    }

    return paintSurface(padEndVisible(truncateVisible(fullLine, cols), cols), s, 'surface');
  }

  renderTabBar(cols, hits = []) {
    const s = this.styler;
    const tabs = this.openTabs();
    const totalChats = Math.max(tabs.length, (this.recentChats || []).length);

    const newTabBtn = button(s, '+', {
      variant: 'subtle',
      hovered: this.isHovered('new-chat:'),
    });
    const newTabWidth = visibleWidth(newTabBtn);

    const chatsLabel = totalChats > 0 && cols >= 70 ? `Chats (${totalChats})` : 'Chats';
    const chatsBtn = button(s, chatsLabel, {
      variant: 'secondary',
      icon: '▤',
      hovered: this.isHovered('open-chats:'),
    });
    const chatsWidth = visibleWidth(chatsBtn);

    // Reserve space for: 1 left pad + tabs + 1 gap + [+] + gap + [Chats] + 1 right pad.
    const reservedRight = newTabWidth + chatsWidth + 4;
    const availForTabs = Math.max(14, cols - 1 - reservedRight);

    let tabStrip = ' ';
    let col = 1;
    let activeSpan = null;

    if (!tabs.length) {
      // No open tabs yet: show a clean active "New chat" chrome tab connected to the welcome screen.
      const tabW = Math.min(20, availForTabs);
      const innerW = Math.max(4, tabW - 4);
      const titleStr = padEndVisible(truncateVisible('New chat', innerW), innerW);
      const tabFace = `${s.fg('accent', '●')} ${s.bold(s.fg('text', titleStr))}`;
      tabStrip += `${s.fg('border', '╭')}${paintSurface(` ${tabFace} `, s, 'ink')}${s.fg('border', '╮')}`;
      activeSpan = { start: col, width: tabW };
      col += tabW;
    } else {
      const minTabW = cols >= 80 ? 15 : 12;
      const maxTabW = 24;
      const maxFit = Math.max(1, Math.floor(availForTabs / minTabW));
      let activeIndex = tabs.findIndex((t) => t.id === this.chat?.id);
      if (activeIndex < 0) activeIndex = 0;

      // Window around active tab so it is always visible.
      let sliceStart = 0;
      if (tabs.length > maxFit) {
        sliceStart = Math.max(0, Math.min(tabs.length - maxFit, activeIndex - Math.floor(maxFit / 2)));
      }
      const visible = tabs.slice(sliceStart, sliceStart + maxFit);
      const hiddenCount = Math.max(0, tabs.length - visible.length);
      const overflowBtn = hiddenCount > 0
        ? button(s, `+${hiddenCount}`, { variant: 'subtle', hovered: this.isHovered('open-chats:') })
        : '';
      const overflowWidth = overflowBtn ? visibleWidth(overflowBtn) + 1 : 0;
      const tabBudget = Math.max(12, availForTabs - overflowWidth);
      const tabWidth = Math.max(minTabW, Math.min(maxTabW, Math.floor(tabBudget / visible.length)));

      for (let i = 0; i < visible.length; i += 1) {
        const tab = visible[i];
        const isActive = tab.id === this.chat?.id;
        const tabHovered = this.isHovered(`resume:${tab.id}`);
        const closeHovered = this.isHovered(`close-tab:${tab.id}`);
        const isBusy = isActive && this.running;
        const dot = isBusy
          ? s.fg('accent', this.config.animations !== false ? selectGlyph(SPINNER, this.animationTick) : GLYPHS.running)
          : isActive
            ? s.fg('accent', '●')
            : s.fg(tabHovered ? 'accent' : 'faint', '○');

        // Active:   ╭ [dot] [title] [×] ╮   -> overhead = 1+1+1+1+1+1+1+1 = 8
        // Inactive:  [dot] [title] [×] │    -> overhead = 1+1+1+1+1+1+1 = 7
        const titleBudget = Math.max(3, tabWidth - (isActive ? 8 : 7));
        const cleanTitle = padEndVisible(truncateVisible(tab.title || 'New chat', titleBudget), titleBudget);
        const closeGlyph = closeHovered
          ? paintSurface(s.bold(s.fg('danger', '×')), s, 'dangerBg')
          : s.fg(isActive ? 'muted' : 'faint', '×');

        if (isActive) {
          const inner = ` ${dot} ${s.bold(s.fg('text', cleanTitle))} ${closeGlyph} `;
          const painted = paintSurface(inner, s, 'ink');
          tabStrip += `${s.fg('accent', '╭')}${painted}${s.fg('accent', '╮')}`;
          activeSpan = { start: col, width: tabWidth };
          hits.push({ type: 'resume', id: tab.id, col, width: Math.max(1, tabWidth - 3) });
          hits.push({ type: 'close-tab', id: tab.id, col: col + tabWidth - 3, width: 2 });
        } else {
          const bg = tabHovered ? 'surface3' : 'surface2';
          const titleStyled = s.fg(tabHovered ? 'text' : 'muted', cleanTitle);
          const inner = ` ${dot} ${titleStyled} ${closeGlyph} `;
          const sep = (i + 1 < visible.length && visible[i + 1].id === this.chat?.id)
            ? ' '
            : s.fg('border', '│');
          tabStrip += `${paintSurface(inner, s, bg)}${sep}`;
          hits.push({ type: 'resume', id: tab.id, col, width: Math.max(1, tabWidth - 3) });
          hits.push({ type: 'close-tab', id: tab.id, col: col + tabWidth - 3, width: 2 });
        }
        col += tabWidth;
      }

      if (overflowBtn) {
        tabStrip += ` ${overflowBtn}`;
        hits.push({ type: 'open-chats', col: col + 1, width: visibleWidth(overflowBtn) });
        col += 1 + visibleWidth(overflowBtn);
      }
    }

    // Add "+" new tab button right after tabs.
    tabStrip += ` ${newTabBtn}`;
    hits.push({ type: 'new-chat', col: col + 1, width: newTabWidth });
    col += 1 + newTabWidth;

    // Right-align the "Chats" button on the tab strip.
    const chatsCol = Math.max(col + 1, cols - chatsWidth - 1);
    const padMiddle = Math.max(0, chatsCol - col);
    if (chatsCol + chatsWidth <= cols) {
      tabStrip += `${' '.repeat(padMiddle)}${chatsBtn}`;
      hits.push({ type: 'open-chats', col: chatsCol, width: chatsWidth });
    }

    const row0 = paintSurface(padEndVisible(truncateVisible(tabStrip, cols), cols), s, 'surface2');

    // Bottom chrome rail: continuous hairline that opens seamlessly under the active tab.
    let rail;
    if (activeSpan && activeSpan.start + activeSpan.width <= cols && activeSpan.width >= 3) {
      const leftLen = activeSpan.start;
      const openLen = Math.max(0, activeSpan.width - 2);
      const rightLen = Math.max(0, cols - activeSpan.start - activeSpan.width);
      rail = `${s.fg('border', '─'.repeat(leftLen))}${s.fg('accent', '╯')}${' '.repeat(openLen)}${s.fg('accent', '╰')}${s.fg('border', '─'.repeat(rightLen))}`;
    } else {
      rail = s.fg('border', '─'.repeat(cols));
    }

    return [row0, rail];
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

  renderStatus(cols, hits = []) {
    const s = this.styler;
    let left;
    const flash = this.visibleFlash();
    if (flash) {
      const icon = flash.color === 'success' ? `${GLYPHS.checked} ` : flash.color === 'danger' ? `${GLYPHS.failed} ` : flash.color === 'warning' ? '! ' : '';
      left = s.fg(flash.color, `${icon}${flash.text}`);
    } else if (this.approval) {
      left = s.fg('warning', 'approval needed · click a button or press y / a / n / esc');
    } else if (this.dialog?.type === 'login') {
      left = s.fg('faint', 'tab next · enter sign in · ctrl+r reveal · esc close');
    } else if (this.dialog?.type === 'palette') {
      left = s.fg('faint', 'tab switch section · ↑↓ select · enter run · esc close');
    } else if (this.dialog) {
      left = s.fg('faint', '↑↓ select · enter confirm · esc close');
    } else if (this.compacting) {
      left = s.fg('accent', 'compacting conversation…');
    } else if (this.running) {
      left = s.fg('warning', 'working · type to steer · esc interrupt · ctrl+c cancel');
    } else if (this.mode === 'plan') {
      left = s.fg('warning', 'plan mode · enter send · /build starts · /chats switch');
    } else {
      left = s.fg('faint', 'enter send · shift+enter newline · alt+←/→ tabs · /chats');
    }

    const ctx = this.contextMetrics();
    const ctxPct = ctx.percent < 10 && ctx.percent > 0 && !Number.isInteger(ctx.percent)
      ? `${ctx.percent.toFixed(1)}%`
      : `${Math.round(ctx.percent)}%`;
    const ctxVariant = ctx.percent >= 85 ? 'danger' : ctx.percent >= 65 ? 'warning' : 'subtle';
    const ctxLabel = cols >= 102
      ? `ctx ${ctxPct} · ${formatTokens(ctx.usedTokens)}/${formatTokens(ctx.contextWindow)}`
      : `ctx ${ctxPct}`;

    const rightSegments = [];
    if (this.scrollOffset > 0) {
      rightSegments.push({
        text: button(s, `${GLYPHS.scrollUp} ${this.scrollOffset}`, {
          variant: 'warning',
          hovered: this.isHovered('scroll-bottom:'),
          compact: false,
        }),
        hit: { type: 'scroll-bottom' },
      });
    }
    rightSegments.push({
      text: button(s, ctxLabel, {
        variant: ctxVariant,
        icon: '◔',
        hovered: this.isHovered('open-context:'),
      }),
      hit: { type: 'open-context' },
    });
    if (cols >= 78) {
      rightSegments.push({
        text: button(s, 'Palette', {
          variant: 'subtle',
          icon: '⌕',
          shortcut: cols >= 114 ? '^P' : '',
          hovered: this.isHovered('open-palette:'),
        }),
        hit: { type: 'open-palette' },
      });
      rightSegments.push({
        text: button(s, 'Help', {
          variant: 'subtle',
          icon: '?',
          hovered: this.isHovered('open-help:'),
        }),
        hit: { type: 'open-help' },
      });
    }

    const rightLayout = placeSegments(rightSegments, { startCol: 0, gap: 1 });
    const rightCol = Math.max(0, cols - rightLayout.width - 1);
    const leftFitted = truncateVisible(left, Math.max(0, rightCol - 2));
    const gap = Math.max(1, rightCol - 1 - visibleWidth(leftFitted));
    const content = ` ${leftFitted}${' '.repeat(gap)}${rightLayout.text} `;
    if (hits) {
      for (const h of rightLayout.hits) {
        hits.push({ ...h, col: rightCol + h.col });
      }
    }
    return paintSurface(padEndVisible(truncateVisible(content, cols), cols), s, 'surface');
  }

  renderSuggestionsOverlay(cols, maxRows, suggestionSet) {
    const s = this.styler;
    const kind = suggestionSet?.kind || 'command';
    const items = (suggestionSet?.items || []).slice(0, Math.max(1, maxRows - 2));
    const selectedIndex = items.length ? this.suggestionSelection(items).index : -1;
    const left = Math.min(2, Math.max(0, cols - 28));
    const width = Math.max(24, Math.min(cols - left - 2, 68));
    const inner = Math.max(8, width - 2);
    const label = kind === 'skill' ? 'skills' : 'commands';
    const hint = inner >= 44 ? '↑↓ select · tab accept' : 'tab';
    const headLeft = ` ${label} `;
    const headRight = ` ${hint} `;
    const fill = Math.max(0, inner - 1 - visibleWidth(headLeft) - visibleWidth(headRight));

    const lines = [];
    const hits = [];
    lines.push(`${s.fg('accent', '╭─')}${s.bold(s.fg('accent', headLeft))}${s.fg('border', '─'.repeat(fill))}${s.fg('faint', headRight)}${s.fg('accent', '╮')}`);
    hits.push(null);

    for (let index = 0; index < items.length; index += 1) {
      const suggestion = items[index];
      const verb = kind === 'skill' ? '@' : '/';
      const hitText = `${verb}${suggestion.name} `;
      const hovered = this.isHovered(`suggestion:${hitText}`);
      const selected = index === selectedIndex || hovered;
      const marker = selected ? s.fg('accent', '▎') : ' ';
      const nameCol = padEndVisible(`${verb}${suggestion.name}`, 13);
      const name = selected ? s.bold(s.fg('accent', nameCol)) : s.fg('text', nameCol);
      const descWidth = Math.max(6, inner - 18);
      const description = s.fg(selected ? 'muted' : 'faint', truncate(suggestion.description || '', descWidth));
      const rowBody = `${marker} ${name} ${description}`;
      const painted = paintSurface(padEndVisible(truncateVisible(rowBody, inner), inner), s, selected ? 'surface3' : 'surface2');
      lines.push(`${s.fg('accent', '│')}${painted}${s.fg('accent', '│')}`);
      hits.push({ type: 'suggestion', text: hitText });
    }

    lines.push(`${s.fg('accent', '╰')}${s.fg('border', '─'.repeat(inner))}${s.fg('accent', '╯')}`);
    hits.push(null);
    return { left, width, lines, hits };
  }

  renderComposer(cols, hits = []) {
    const s = this.styler;
    const lines = [];
    const inner = Math.max(8, cols - 2);

    const borderColor = this.approval ? 'warning'
      : this.running ? 'info'
        : this.mode === 'plan' ? 'warning'
          : 'border';
    const textWidth = Math.max(4, inner - 4);
    const inputLayout = this.layoutInput(this.input, this.cursor, textWidth);
    const tokenLabels = this.composerTokenLabels(this.input);
    const maxLines = 5;
    const totalLines = inputLayout.lines.length;
    let top = this.composerScroll || 0;
    if (inputLayout.cursorLine < top) top = inputLayout.cursorLine;
    else if (inputLayout.cursorLine >= top + maxLines) top = Math.max(0, inputLayout.cursorLine - maxLines + 1);
    top = Math.max(0, Math.min(top, Math.max(0, totalLines - maxLines)));
    this.composerScroll = top;
    let visibleLines = inputLayout.lines.slice(top, top + maxLines);
    let cursorLine = inputLayout.cursorLine - top;

    // Minimal top border: only shows a quiet label during special states or scroll.
    const stateLabel = this.approval ? 'approval required'
      : this.running ? (this.steeringQueue.length ? `steering (${this.steeringQueue.length} queued)` : 'working')
        : this.mode === 'plan' ? 'plan mode'
          : '';
    const scrollHint = totalLines > maxLines ? `${top + 1}-${top + visibleLines.length}/${totalLines}` : '';
    const topLabel = [stateLabel, scrollHint].filter(Boolean).join(' · ');
    if (topLabel && visibleWidth(topLabel) + 4 <= inner) {
      const topFill = Math.max(0, inner - visibleWidth(topLabel) - 3);
      const labelColor = borderColor === 'border' ? 'muted' : borderColor;
      lines.push(`${s.fg(borderColor, '╭─')} ${s.bold(s.fg(labelColor, topLabel))} ${s.fg(borderColor, `${'─'.repeat(topFill)}╮`)}`);
    } else {
      lines.push(`${s.fg(borderColor, '╭')}${s.fg(borderColor, '─'.repeat(inner))}${s.fg(borderColor, '╮')}`);
    }

    if (!visibleLines.length) visibleLines = [''];
    const promptChevronColor = this.mode === 'plan' ? 'warning' : this.running ? 'info' : 'accent';
    visibleLines.forEach((line, index) => {
      let content;
      const lineStart = inputLayout.lineStarts[top + index] ?? 0;
      const cursorInLine = index === cursorLine ? this.cursor : null;
      const styledLine = truncateVisible(this.styleComposerLine(line, tokenLabels, cursorInLine, lineStart), textWidth);
      const styledWidth = visibleWidth(styledLine);
      const tokenAtCursor = index === cursorLine ? this.composerTokenAtStart(this.cursor) : null;
      const tokenInLine = tokenAtCursor
        && tokenAtCursor.start >= lineStart
        && tokenAtCursor.start < lineStart + line.length;
      if (this.input === '' && index === 0) {
        const placeholder = this.running
          ? 'Type to steer…'
          : this.mode === 'plan'
            ? 'Describe what to plan…'
            : 'Ask Gatita…';
        content = `${s.inverse(' ')} ${s.fg('faint', truncateVisible(placeholder, Math.max(0, textWidth - 2)))}`;
      } else if (tokenInLine) {
        content = styledLine;
      } else if (index === cursorLine && !this.dialog) {
        const cursorCol = Math.min(inputLayout.cursorCol, styledWidth);
        if (cursorCol >= textWidth && textWidth > 0) {
          const before = sliceVisible(styledLine, 0, textWidth - 1);
          const cell = stripAnsi(sliceVisible(styledLine, textWidth - 1, 1)) || ' ';
          content = `${before}${s.inverse(cell)}`;
        } else {
          const before = sliceVisible(styledLine, 0, cursorCol);
          const cell = stripAnsi(sliceVisible(styledLine, cursorCol, 1)) || ' ';
          const after = sliceVisible(styledLine, cursorCol + 1);
          content = `${before}${s.inverse(cell)}${after}`;
        }
      } else {
        content = s.fg('text', styledLine);
      }
      const lead = index === 0 ? `${s.bold(s.fg(promptChevronColor, '›'))} ` : '  ';
      const interior = paintSurface(` ${lead}${padEndVisible(content, textWidth)} `, s, 'surface');
      lines.push(`${s.fg(borderColor, '│')}${interior}${s.fg(borderColor, '│')}`);
    });

    // Clean bottom border with just the essential clickable mode toggle and Send/Stop button.
    const showBottomControls = !this.dialog && !this.approval && inner >= 30;
    if (showBottomControls) {
      const leftSegs = [
        {
          text: button(s, this.mode === 'plan' ? 'Plan' : 'Build', {
            variant: this.mode === 'plan' ? 'warning' : 'subtle',
            icon: this.mode === 'plan' ? '◇' : '▸',
            active: this.mode === 'plan',
            hovered: this.isHovered('toggle-plan:'),
          }),
          hit: { type: 'toggle-plan' },
        },
      ];
      if (this.planDraft && inner >= 48) {
        leftSegs.push({
          text: button(s, 'Build Plan', {
            variant: 'primary',
            icon: '▸',
            hovered: this.isHovered('use-plan:'),
          }),
          hit: { type: 'use-plan' },
        });
      }
      if (this.todos.length && inner >= 56) {
        const done = this.todos.filter((t) => t.status === 'completed').length;
        leftSegs.push({
          text: button(s, `${done}/${this.todos.length}`, {
            variant: done === this.todos.length ? 'success' : 'subtle',
            icon: '✓',
            hovered: this.isHovered('open-tasks:'),
          }),
          hit: { type: 'open-tasks' },
        });
      }
      const hasInput = Boolean(this.input.trim());
      const actionSeg = this.running
        ? {
          text: button(s, 'Stop', {
            variant: 'danger',
            icon: '■',
            hovered: this.isHovered('send-or-stop:'),
          }),
          hit: { type: 'send-or-stop' },
        }
        : {
          text: button(s, 'Send', {
            variant: hasInput ? 'primary' : 'subtle',
            icon: '↵',
            disabled: !hasInput,
            hovered: hasInput && this.isHovered('send-or-stop:'),
          }),
          hit: { type: 'send-or-stop' },
        };

      const leftLayout = placeSegments(leftSegs, { startCol: 2, gap: 1 });
      const actionW = visibleWidth(actionSeg.text);
      const fillLen = inner - 2 - leftLayout.width - actionW;
      if (fillLen >= 1) {
        const actionCol = 2 + leftLayout.width + fillLen;
        lines.push(`${s.fg(borderColor, '╰─')}${leftLayout.text}${s.fg(borderColor, '─'.repeat(fillLen))}${actionSeg.text}${s.fg(borderColor, '─╯')}`);
        hits[lines.length - 1] = [
          ...leftLayout.hits,
          { ...actionSeg.hit, col: actionCol, width: actionW },
        ];
      } else {
        lines.push(`${s.fg(borderColor, '╰')}${s.fg(borderColor, '─'.repeat(inner))}${s.fg(borderColor, '╯')}`);
      }
    } else {
      lines.push(`${s.fg(borderColor, '╰')}${s.fg(borderColor, '─'.repeat(inner))}${s.fg(borderColor, '╯')}`);
    }
    return lines;
  }

  renderConversation(rows, width, hits = []) {
    const s = this.styler;
    if (!this.messages.length && !this.stream.active && !this.running) {
      return this.renderEmpty(rows, width, hits);
    }
    const transcript = this.buildTranscript(Math.max(8, width - 3));
    this.transcriptLineCount = transcript.length;
    this.conversationHeight = rows;
    const maxOffset = Math.max(0, transcript.length - rows);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
    const start = Math.max(0, transcript.length - rows - this.scrollOffset);
    this.conversationStart = start;
    const showScrollbar = transcript.length > rows && width >= 20;
    const contentWidth = showScrollbar ? width - 1 : width;
    const view = transcript.slice(start, start + rows);
    const output = view.map((line) => padEndVisible(truncateVisible(line, contentWidth), contentWidth));
    while (output.length < rows) output.unshift(' '.repeat(contentWidth));

    if (showScrollbar) {
      const thumbSize = Math.max(1, Math.round((rows / transcript.length) * rows));
      const scrollRatio = maxOffset > 0 ? 1 - (this.scrollOffset / maxOffset) : 1;
      const thumbStart = Math.max(0, Math.min(rows - thumbSize, Math.round(scrollRatio * (rows - thumbSize))));
      for (let i = 0; i < rows; i += 1) {
        const isThumb = i >= thumbStart && i < thumbStart + thumbSize;
        output[i] = `${output[i]}${isThumb ? s.fg(this.scrollOffset > 0 ? 'accent' : 'faint', '┃') : s.fg('border', '│')}`;
      }
    }

    if (this.scrollOffset > 0) {
      const indicator = button(s, `${GLYPHS.scrollUp} ${this.scrollOffset} · latest`, {
        variant: 'warning',
        hovered: this.isHovered('scroll-bottom:'),
      });
      const indWidth = visibleWidth(indicator);
      const last = output[output.length - 1] || '';
      const targetCol = Math.max(0, width - indWidth - (showScrollbar ? 2 : 1));
      output[output.length - 1] = `${sliceVisible(last, 0, targetCol)}${indicator}${showScrollbar ? ' ' : ''}`;
      if (hits) hits[output.length - 1] = { type: 'scroll-bottom', col: targetCol, width: indWidth };
    }
    return output;
  }

  renderEmpty(rows, width, hits = []) {
    const s = this.styler;
    const safeWidth = Math.max(8, width);
    const content = [];
    const contentHits = [];
    const pushLine = (line, rowHits = null) => {
      content.push(line);
      contentHits.push(rowHits);
    };

    const ruleLen = Math.min(28, Math.max(8, safeWidth - 16));
    pushLine(centerVisible(s.fg('accent', GLYPHS.cat), safeWidth));
    pushLine(centerVisible(s.bold(s.fg('text', 'G A T I T A   S T U D I O')), safeWidth));
    pushLine(centerVisible(`${s.fg('muted', 'Your terminal. Her territory.')}  ${s.fg('faint', `v${CLIENT_VERSION}`)}`, safeWidth));
    pushLine(centerVisible(s.fg('border', '─'.repeat(ruleLen)), safeWidth));

    const model = this.model();
    const cardWidth = Math.min(60, safeWidth - 4);
    if (rows >= 14 && cardWidth >= 42) {
      pushLine('');
      const caps = [
        model?.tools ? s.fg('muted', 'tools') : s.fg('faint', 'chat'),
        model?.vision ? s.fg('info', 'vision') : '',
        model?.reasoningLevels?.length ? s.fg('accent2', `think ${reasoningLabel(this.reasoning)}`) : '',
      ].filter(Boolean).join(s.fg('faint', ' · '));
      const usage = this.mostRestrictiveWindow();
      const cardLines = [
        `${s.fg('faint', 'workspace')}  ${s.fg('text', truncateVisible(basenameForDisplay(this.cwd), Math.max(8, cardWidth - 18)))}`,
        `${s.fg('faint', 'model    ')}  ${s.fg('accent', model?.name || this.modelId)}  ${caps}`,
      ];
      if (usage) {
        const pct = Math.max(0, Math.min(100, Number(usage.percent) || 0));
        const barW = Math.max(8, Math.min(16, cardWidth - 34));
        const color = pct >= 90 ? 'danger' : pct >= 75 ? 'warning' : 'accent';
        cardLines.push(`${s.fg('faint', 'quota    ')}  ${progressBar(pct, barW, s, color)}  ${s.fg('muted', `${formatTokens(usage.remaining)} left`)}`);
      }
      const mcpCount = this.mcp?.status?.()?.servers?.length || 0;
      const skillCount = (this.skills || []).length;
      const extParts = [
        `${skillCount} ${skillCount === 1 ? 'skill' : 'skills'}`,
        `${mcpCount} mcp`,
        this.mode === 'plan' ? s.fg('warning', 'plan mode') : 'build mode',
      ].join(' · ');
      cardLines.push(`${s.fg('faint', 'ready    ')}  ${s.fg('muted', extParts)}`);

      const box = roundedBox({
        width: cardWidth,
        styler: s,
        title: 'session',
        subtitle: (this.plan?.displayName || 'Free').replace(/^Gatita\s+/i, '').toLowerCase(),
        borderColor: 'border',
        titleColor: 'muted',
        lines: cardLines,
      });
      const padLeftCol = Math.max(0, Math.floor((safeWidth - cardWidth) / 2));
      const padLeft = ' '.repeat(padLeftCol);
      box.forEach((boxLine, boxIdx) => {
        let rowHit = null;
        if (boxIdx === 1) rowHit = [{ type: 'open-workspace', col: padLeftCol, width: cardWidth }];
        else if (boxIdx === 2) rowHit = [{ type: 'open-models', col: padLeftCol, width: cardWidth }];
        else if (boxIdx === 3 && usage) rowHit = [{ type: 'open-usage', col: padLeftCol, width: cardWidth }];
        pushLine(`${padLeft}${boxLine}`, rowHit);
      });
    } else {
      pushLine('');
      pushLine(centerVisible(s.fg('faint', `new chat in ${basenameForDisplay(this.cwd)}`), safeWidth));
    }

    if (rows >= 12 && safeWidth >= 50) {
      pushLine('');
      const chips = [
        { icon: GLYPHS.spark, label: 'explain codebase', text: 'Explain the architecture and key files of this project.' },
        { icon: '▸', label: 'run tests', text: 'Run the test suite and report any issues.' },
        { icon: '◆', label: 'switch model', command: '/model' },
      ];
      if ((this.recentChats || []).length > 0 && safeWidth >= 78) {
        chips.push({ icon: '▤', label: 'browse chats', command: '/chats' });
      }
      const segments = chips.map((chip) => {
        const hit = { type: 'starter-prompt', text: chip.text, command: chip.command };
        return {
          text: button(s, chip.label, {
            variant: 'secondary',
            icon: chip.icon,
            hovered: this.isHovered(this.hoverKeyFor(hit)),
          }),
          hit,
        };
      });
      const laid = placeSegments(segments, { startCol: 0, gap: 2 });
      if (laid.width <= safeWidth - 2) {
        const startCol = Math.max(0, Math.floor((safeWidth - laid.width) / 2));
        const placed = placeSegments(segments, { startCol, gap: 2 });
        pushLine(`${' '.repeat(startCol)}${placed.text}`, placed.hits);
      }
    }

    pushLine('');
    pushLine(centerVisible(s.fg('faint', '/chats · /model · /plan · /login · ctrl+p palette · /help'), safeWidth));

    const top = Math.max(0, Math.floor((rows - content.length) / 2));
    const output = [];
    for (let index = 0; index < rows; index += 1) {
      const contentIndex = index - top;
      if (contentIndex >= 0 && contentIndex < content.length) {
        output.push(padEndVisible(truncateVisible(content[contentIndex], safeWidth), safeWidth));
        if (hits && contentHits[contentIndex]) hits[index] = contentHits[contentIndex];
      } else {
        output.push(' '.repeat(safeWidth));
      }
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
      if (isCompactionCheckpoint(message)) {
        if (current) turns.push(current);
        current = null;
        turns.push({ compaction: message, user: null, messages: [message], final: null, workMessages: [], tools: 0, errorCount: 0 });
        continue;
      }
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
      turn.active = Boolean(this.running && !this.compacting) && !turn.compaction && index === turns.length - 1;
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
        const text = String(queued?.text ?? queued ?? '');
        const imageCount = Array.isArray(queued?.images) ? queued.images.length : 0;
        const suffix = imageCount ? ` · ${imageCount} image${imageCount === 1 ? '' : 's'}` : '';
        lines.push(`  ${s.fg('faint', '› queued: ')}${s.fg('muted', truncateVisible(`${text}${suffix}`, Math.max(8, width - 12)))}`);
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
      lines.push(`${s.fg('accent2', GLYPHS.thickBar)} ${s.bold(s.fg('accent2', 'you'))} ${clock}`);
      const innerWidth = Math.max(4, width - 5);
      const content = renderMarkdown(message.content || '', innerWidth, s, { base: 'text' });
      for (const line of content) {
        const body = ` ${padEndVisible(truncateVisible(line, innerWidth), innerWidth)} `;
        lines.push(`${s.fg('accent2', GLYPHS.thickBar)} ${paintSurface(body, s, 'surface2')}`);
      }
      if (Array.isArray(message.meta?.images) && message.meta.images.length) {
        const boxes = message.meta.images.map((_image, index) => s.bg('imageBg', s.bold(s.fg('image', `[Image ${index + 1}]`)))).join(' ');
        lines.push(`  ${boxes}`);
      }
      return lines;
    }
    if (message.role === 'assistant') {
      const modelName = message.meta?.model || this.modelId;
      const clock = message.createdAt ? s.fg('faint', formatClock(message.createdAt)) : '';
      const modelChip = s.pill('muted', 'surface2', modelName);
      lines.push(`${s.fg('accent', GLYPHS.cat)} ${s.bold(s.fg('accent', 'gatita'))} ${modelChip} ${clock}`);
      if (message.reasoning) {
        const expanded = this.expandedReasoning.has(message.id);
        if (expanded) {
          const reasoning = renderMarkdown(message.reasoning, Math.max(8, width - 5), s, { base: 'faint', indent: '' });
          const shown = reasoning.slice(0, 12);
          for (const line of shown) lines.push(`  ${s.fg('border', '│ ')}${s.fg('faint', truncateToWidth(line, width - 5))}`);
          if (reasoning.length > shown.length) lines.push(`  ${s.fg('border', '╰ ')}${s.fg('faint', `… ${reasoning.length - shown.length} more lines · m to minimize`)}`);
          else lines.push(`  ${s.fg('border', '╰ ')}${s.fg('faint', 'm to minimize')}`);
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
    const icon = s.fg(result?.meta?.isError ? 'danger' : running ? 'accent' : 'muted', toolIcon(name));
    const rail = s.fg(result?.meta?.isError ? 'danger' : running ? 'accent' : 'border', '╭');
    const line = `  ${rail} ${icon} ${s.bold(s.fg('text', name))}${summary ? ` ${s.fg('muted', truncate(summary, Math.max(8, width - name.length - 16)))}` : ''} ${statusGlyph}${duration}`;
    const lines = [line];
    if (result) {
      const raw = String(result.content || '').split('\n').filter((entry, index, array) => entry !== '' || array[index - 1] !== '');
      const expanded = this.expandedTools.has(result.toolCallId || result.id);
      const lineRail = s.fg(result.meta?.isError ? 'danger' : 'border', '│');
      const endRail = s.fg(result.meta?.isError ? 'danger' : 'border', '╰');
      if (expanded) {
        const shown = raw.slice(0, 24);
        for (const entry of shown) {
          lines.push(`  ${lineRail} ${s.fg(result.meta?.isError ? 'danger' : 'faint', truncateToWidth(entry, Math.max(8, width - 6)))}`);
        }
        if (raw.length > shown.length) lines.push(`  ${endRail} ${s.fg('faint', `… ${raw.length - shown.length} more lines · ctrl+o to collapse`)}`);
        else lines.push(`  ${endRail} ${s.fg('faint', 'ctrl+o to collapse')}`);
      } else {
        const first = raw[0] || '';
        const hidden = Math.max(0, raw.length - 1);
        lines.push(`  ${hidden ? lineRail : endRail} ${s.fg(result.meta?.isError ? 'danger' : 'faint', truncateToWidth(first, Math.max(8, width - 6)))}`);
        if (hidden) {
          lines.push(`  ${endRail} ${s.fg('faint', `… ${hidden} more line${hidden === 1 ? '' : 's'} · ctrl+o to expand`)}`);
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
    if (name === 'goal') return truncateToWidth(String(args.action || 'status'), 60);
    if (name === 'task_status') return args.task_id ? `check ${args.task_id}` : 'list background tasks';
    if (name === 'stop_task') return `stop ${args.task_id || 'background task'}`;
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
      if (turn.compaction) {
        const s = this.styler;
        const count = Number(turn.compaction.meta?.compactedCount || 0);
        const tag = count > 0
          ? ` ✦ compacted · ${count} earlier ${count === 1 ? 'message' : 'messages'} summarized `
          : ' ✦ conversation compacted ';
        const ruleW = Math.max(4, Math.floor((Math.max(12, width - visibleWidth(tag))) / 2));
        const divider = `${s.fg('border', '─'.repeat(ruleW))}${s.fg('accent', tag)}${s.fg('border', '─'.repeat(ruleW))}`;
        pushBlock([centerVisible(truncateVisible(divider, width), width)]);
        continue;
      }
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

  renderApproval(rows, cols, recordHit) {
    const s = this.styler;
    const request = this.approval;
    const width = Math.min(cols - 4, 80);
    const highRisk = request.group === 'computer' || request.group === 'shell';
    const medRisk = request.group === 'write' || request.group === 'edit' || request.group === 'mcp';
    const riskPill = highRisk
      ? badge(s, 'HIGH RISK', { fg: 'danger', bg: 'dangerBg', bold: true })
      : medRisk
        ? badge(s, 'MODIFY', { fg: 'warning', bg: 'warningBg', bold: true })
        : badge(s, 'ACTION', { fg: 'info', bg: 'infoBg', bold: true });
    const body = [];
    body.push(`${riskPill}  ${s.fg('text', 'Gatita wants to run a tool.')}`);
    body.push('');
    body.push(`  ${s.fg('accent', toolIcon(request.tool))} ${s.bold(s.fg('text', request.tool))}  ${s.fg('muted', truncate(request.summary || '', Math.max(10, width - 22)))}`);
    body.push(`  ${s.fg('faint', `group: ${request.group}`)}`);
    body.push('');
    if (request.args && Object.keys(request.args).length) {
      const allLines = JSON.stringify(request.args, null, 2).split('\n');
      const pretty = allLines.slice(0, 10);
      for (const line of pretty) body.push(`  ${paintSurface(` ${padEndVisible(truncateVisible(s.fg('muted', line), Math.max(8, width - 10)), Math.max(8, width - 10))} `, s, 'surface2')}`);
      if (allLines.length > 10) body.push(`  ${s.fg('faint', `… ${allLines.length - 10} more lines`)}`);
      body.push('');
    }
    if (request.group === 'computer') {
      body.push(paintSurface(` ${s.bold(s.fg('danger', '! This controls your real mouse and keyboard.'))} `, s, 'dangerBg'));
      body.push('');
    }
    const actionLayout = placeSegments([
      {
        text: button(s, 'Allow once', {
          variant: 'success',
          icon: '✓',
          shortcut: 'y',
          hovered: this.isHovered('approval-allow:'),
        }),
        hit: { type: 'approval-allow' },
      },
      {
        text: button(s, `Always ${request.group}`, {
          variant: 'warning',
          icon: '✦',
          shortcut: 'a',
          hovered: this.isHovered('approval-always:'),
        }),
        hit: { type: 'approval-always' },
      },
      {
        text: button(s, 'Deny', {
          variant: 'danger',
          icon: '✗',
          shortcut: 'n',
          hovered: this.isHovered('approval-deny:'),
        }),
        hit: { type: 'approval-deny' },
      },
    ], { startCol: 0, gap: 2 });
    const btnLineIndex = body.length;
    body.push(actionLayout.text);

    return renderDialogBand({
      columns: cols,
      rows,
      title: 'approval',
      subtitle: request.group,
      body,
      footer: 'click a button or press y allow · a always · n deny · esc stop',
      borderColor: highRisk ? 'danger' : 'warning',
      styler: s,
      closable: true,
      closeHovered: this.isHovered('close-dialog:'),
      recordCloseHit: recordHit ? (rowIndex, closeCol, closeWidth) => {
        recordHit(rowIndex, { type: 'close-dialog', col: closeCol, width: closeWidth });
      } : undefined,
      recordHit: recordHit ? (rowIndex, bodyLine, contentCol) => {
        if (bodyLine !== btnLineIndex) return;
        recordHit(rowIndex, actionLayout.hits.map((h) => ({ ...h, col: contentCol + h.col })));
      } : undefined,
    });
  }

  renderDialog(rows, cols, recordHit) {
    const s = this.styler;
    const dialog = this.dialog;
    if (!dialog) return this.renderApproval(rows, cols, recordHit);
    if (dialog.type === 'login' && dialog.view) {
      return dialog.view.render(cols, rows);
    }
    const maxDialogWidth = dialog.type === 'palette' ? 74 : 84;
    const dialogInnerWidth = Math.max(20, Math.min(cols - 4, maxDialogWidth) - 4);
    const band = ({ body, title, subtitle = '', footer = '', hits, borderColor = 'accent', maxWidth = maxDialogWidth }) => {
      this.dialogHits = hits || new Map();
      return renderDialogBand({
        columns: cols,
        rows,
        title,
        subtitle,
        body,
        footer,
        borderColor,
        maxWidth,
        styler: s,
        closable: true,
        closeHovered: this.isHovered('close-dialog:'),
        recordCloseHit: recordHit ? (rowIndex, closeCol, closeWidth) => {
          recordHit(rowIndex, { type: 'close-dialog', col: closeCol, width: closeWidth });
        } : undefined,
        recordHit: hits ? (rowsIndex, bodyLine, contentCol, contentWidth) => {
          const hit = this.dialogHits.get(bodyLine);
          if (!hit) return;
          const entries = Array.isArray(hit) ? hit : [hit];
          const shifted = entries.map((entry) => (
            entry.col != null
              ? { ...entry, col: contentCol + entry.col }
              : { ...entry, col: contentCol, width: contentWidth }
          ));
          recordHit?.(rowsIndex, shifted.length === 1 ? shifted[0] : shifted);
        } : undefined,
      });
    };
    const highlightRow = (content, selected) => {
      const fitted = padEndVisible(truncateVisible(content, dialogInnerWidth), dialogInnerWidth);
      return selected ? paintSurface(fitted, s, 'surface2') : content;
    };

    if (dialog.type === 'palette') {
      const activeTab = dialog.tab || 'quick';
      const filtering = Boolean(String(dialog.filter || '').trim());
      const items = this.dialogItems(dialog);
      const body = [];
      const hits = new Map();

      // Search input field (clean elevated surface box).
      const searchInner = dialog.filter
        ? `${s.fg('accent', '⌕')}  ${s.fg('text', dialog.filter)}${s.inverse(' ')}`
        : `${s.fg('accent', '⌕')}  ${s.fg('faint', 'Search commands, models, themes, chats…')}`;
      body.push(paintSurface(` ${padEndVisible(truncateVisible(searchInner, dialogInnerWidth - 2), dialogInnerWidth - 2)} `, s, 'surface2'));

      // Category filter tabs (clickable & switchable via Tab / ← →).
      const tabSegments = this.paletteTabs().map((tab) => {
        const isCurrent = !filtering && activeTab === tab.id;
        return {
          text: button(s, tab.label, {
            variant: isCurrent ? 'primary' : 'subtle',
            hovered: this.isHovered(`palette-tab:${tab.id}`),
            active: isCurrent,
          }),
          hit: { type: 'palette-tab', tab: tab.id },
        };
      });
      const tabLayout = placeSegments(tabSegments, { startCol: 0, gap: 1 });
      body.push(tabLayout.text);
      hits.set(body.length - 1, tabLayout.hits);
      body.push(s.fg('border', '─'.repeat(dialogInnerWidth)));

      const maxBody = Math.max(4, rows - 4);
      const headerReserve = (!filtering && activeTab === 'quick') ? 5 : 3;
      const maxVisible = Math.max(1, Math.min(9, maxBody - headerReserve));
      const selectedIdx = Math.max(0, Math.min(items.length - 1, dialog.index || 0));
      const windowStart = Math.max(0, Math.min(items.length - maxVisible, selectedIdx - Math.floor(maxVisible / 2)));
      const visible = items.slice(Math.max(0, windowStart), Math.max(0, windowStart) + maxVisible);

      if (!visible.length) {
        body.push(s.fg('faint', '  No matching items. Try another keyword or switch tabs.'));
      } else {
        let lastSection = '';
        for (let offset = 0; offset < visible.length; offset += 1) {
          const item = visible[offset];
          const idx = Math.max(0, windowStart) + offset;
          const selected = idx === selectedIdx;
          const needsSection = !filtering && activeTab === 'quick' && item.section && item.section !== lastSection;
          const extraLines = needsSection ? (lastSection ? 2 : 1) : 0;
          if (body.length + extraLines + 1 > maxBody) break;
          if (needsSection) {
            if (lastSection) body.push('');
            body.push(s.bold(s.fg('faint', `  ${item.section}`)));
            lastSection = item.section;
          }
          const marker = selected ? s.fg('accent', '▎') : ' ';
          const icon = item.kind === 'command' ? s.fg('accent', '›')
            : item.kind === 'action' ? s.fg('accent', '✦')
              : item.kind === 'model' ? s.fg('info', '◆')
                : item.kind === 'theme' ? s.fg('accent2', '●')
                  : s.fg('muted', '▤');
          const rawLabel = filtering ? item.label : (item.displayLabel || item.label);
          const hintText = filtering
            ? (item.kind === 'command' ? 'cmd' : item.kind === 'session' ? 'chat' : item.kind)
            : (item.hint || '');
          const rightBadge = hintText ? s.fg(item.active ? 'success' : 'faint', hintText) : '';
          const rightW = visibleWidth(rightBadge);
          const labelW = Math.min(24, Math.max(14, Math.floor(dialogInnerWidth * 0.36)));
          const labelCol = padEndVisible(truncateVisible(rawLabel, labelW), labelW);
          const styledLabel = selected ? s.bold(s.fg('accent', labelCol)) : s.fg('text', labelCol);
          const detailRoom = Math.max(6, dialogInnerWidth - labelW - rightW - 8);
          const detailStr = truncate(item.detail || '', detailRoom);
          const leftRow = `${marker} ${icon} ${styledLabel} ${s.fg(selected ? 'muted' : 'faint', detailStr)}`;
          const rowGap = Math.max(1, dialogInnerWidth - visibleWidth(leftRow) - rightW - 1);
          const fullRow = rightBadge ? `${leftRow}${' '.repeat(rowGap)}${rightBadge} ` : leftRow;
          body.push(highlightRow(fullRow, selected));
          hits.set(body.length - 1, { type: 'palette-item', item });
        }
      }

      const subtitle = filtering
        ? `${items.length} ${items.length === 1 ? 'match' : 'matches'}`
        : `${activeTab} · ${items.length}`;
      return band({
        title: 'command palette',
        subtitle,
        body,
        footer: 'tab section · ↑↓ select · enter run · type to search · esc close',
        hits,
      });
    }
    if (dialog.type === 'plan') {
      const plan = this.planDraft || String(dialog.plan || '').trim();
      const body = [];
      const hits = new Map();
      body.push(s.fg('faint', `${this.planQuestionsAsked || 0} clarifying question${(this.planQuestionsAsked || 0) === 1 ? '' : 's'} asked while planning`));
      body.push('');
      const planLines = plan ? plan.split(/\r?\n/) : ['(the plan is missing)'];
      const maxLines = Math.max(6, rows - 11);
      const start = Math.max(0, Math.min(dialog.scroll || 0, Math.max(0, planLines.length - maxLines)));
      for (const line of planLines.slice(start, start + maxLines)) {
        body.push(truncateToWidth(line, Math.max(8, dialogInnerWidth)));
      }
      body.push('');
      const planActions = placeSegments([
        {
          text: button(s, 'Build plan', {
            variant: 'primary',
            icon: '▸',
            shortcut: '↵',
            hovered: this.isHovered('plan-build:'),
          }),
          hit: { type: 'plan-build' },
        },
        {
          text: button(s, 'Keep planning', {
            variant: 'secondary',
            shortcut: 'esc',
            hovered: this.isHovered('plan-keep:'),
          }),
          hit: { type: 'plan-keep' },
        },
      ], { startCol: 0, gap: 2 });
      body.push(planActions.text);
      hits.set(body.length - 1, planActions.hits);
      return band({
        title: 'build this plan',
        subtitle: planLines.length > maxLines ? `${start + 1}-${Math.min(planLines.length, start + maxLines)}/${planLines.length}` : '',
        body,
        footer: 'enter build · ↑↓ scroll · esc keep planning',
        hits,
      });
    }
    if (dialog.type === 'confirm') {
      const actions = placeSegments([
        {
          text: button(s, 'Yes', {
            variant: 'success',
            icon: '✓',
            shortcut: 'y',
            hovered: this.isHovered('confirm-yes:'),
          }),
          hit: { type: 'confirm-yes' },
        },
        {
          text: button(s, 'No', {
            variant: 'danger',
            icon: '✗',
            shortcut: 'n',
            hovered: this.isHovered('confirm-no:'),
          }),
          hit: { type: 'confirm-no' },
        },
      ], { startCol: 0, gap: 2 });
      const hits = new Map([[2, actions.hits]]);
      return band({
        title: 'confirm',
        body: [dialog.message, '', actions.text],
        footer: 'click a button or press y confirm · n / esc cancel',
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
          borderColor: 'warning',
          body: [
            s.fg('warning', 'This question timed out after 5 minutes.'),
            '',
            s.fg('muted', 'Gatita is cancelling the task and cleaning up.'),
            s.fg('faint', 'Press enter or esc to close this box.'),
          ],
          footer: 'enter / esc close',
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
      if (current.multiSelect) body.push(s.fg('faint', 'choose any number: enter toggles a check, tab moves on'));
      body.push('');
      for (let index = 0; index < current.options.length; index += 1) {
        const option = current.options[index];
        const selected = index === (dialog.cursor || 0);
        const checked = current.multiSelect && dialog.selected.has(`${current.id}:${option.id}`);
        const statusGlyph = current.multiSelect ? (checked ? '✓' : '○') : (selected ? '●' : '○');
        const marker = selected ? s.fg('accent', '▎') : ' ';
        const rowLine = `${marker} ${s.fg(checked ? 'success' : selected ? 'accent' : 'muted', statusGlyph)} ${s.fg(selected ? 'accent' : 'text', option.label)}`;
        body.push(highlightRow(rowLine, selected));
        hits.set(body.length - 1, { type: 'ask-option', index });
        if (option.description) body.push(`    ${s.fg('faint', truncateToWidth(option.description, Math.max(8, cols - 24)))}`);
      }
      const otherIndex = current.options.length;
      const otherSelected = (dialog.cursor || 0) === otherIndex;
      const otherMarker = otherSelected ? s.fg('accent', '▎') : ' ';
      body.push(highlightRow(`${otherMarker} ${s.fg(otherSelected ? 'accent' : 'faint', '✦')} ${s.fg(otherSelected ? 'text' : 'muted', 'Other: type your own answer')}`, otherSelected));
      hits.set(body.length - 1, { type: 'ask-other' });
      if (dialog.otherOpen) {
        const text = dialog.otherText || '';
        const cur = Math.min(dialog.otherCursor || 0, text.length);
        const cellEnd = codePointAfter(text, cur);
        const cell = text.slice(cur, cellEnd) || ' ';
        const rendered = text ? `${text.slice(0, cur)}${s.inverse(cell)}${text.slice(cellEnd)}` : s.inverse(' ');
        body.push('');
        body.push(`  ${paintSurface(` ${padEndVisible(rendered, Math.max(8, dialogInnerWidth - 6))} `, s, 'surface2')}`);
      }
      const footer = dialog.otherOpen
        ? 'type answer · enter submit · esc cancel'
        : (current.multiSelect
          ? '↑↓ select · enter toggle · tab next question · esc cancel'
          : '↑↓ select · enter pick · esc cancel');
      return band({ title: 'gatita is asking…', body, footer, hits });
    }
    if (dialog.type === 'input') {
      const value = dialog.value || '';
      const cellEnd = codePointAfter(value, Math.min(dialog.cursor, value.length));
      const cell = value.slice(dialog.cursor, cellEnd) || ' ';
      const rendered = value ? `${value.slice(0, dialog.cursor)}${s.inverse(cell)}${value.slice(cellEnd)}` : s.inverse(' ');
      const fieldBox = paintSurface(` ${padEndVisible(rendered, Math.max(8, dialogInnerWidth - 2))} `, s, 'surface2');
      return band({
        title: dialog.title,
        body: [fieldBox],
        footer: dialog.hint || 'enter confirm · esc cancel',
      });
    }
    if (dialog.type === 'context') {
      const ctx = this.contextMetrics();
      const pctLabel = ctx.percent < 10 && ctx.percent > 0 && !Number.isInteger(ctx.percent)
        ? `${ctx.percent.toFixed(1)}%`
        : `${Math.round(ctx.percent)}%`;
      const barColor = ctx.percent >= 85 ? 'danger' : ctx.percent >= 65 ? 'warning' : 'accent';
      const barW = Math.max(12, Math.min(32, dialogInnerWidth - 28));
      const body = [
        `${s.bold(s.fg('text', 'Context'))}  ${progressBar(ctx.percent, barW, s, barColor)}  ${s.bold(s.fg(barColor, pctLabel))}`,
        `  ${s.fg('muted', `${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.contextWindow)} tokens`)}`,
        '',
        `${s.fg('faint', 'Active in context')}  ${s.fg('text', `${ctx.activeCount} ${plural(ctx.activeCount, 'message')}`)}`,
        `${s.fg('faint', 'Saved in chat    ')}  ${s.fg('text', `${ctx.totalCount} ${plural(ctx.totalCount, 'message')}`)}`,
        `${s.fg('faint', 'Auto-compaction  ')}  ${s.fg('muted', `triggers at ${Math.round(AUTO_COMPACT_RATIO * 100)}% · earlier messages stay visible`)}`,
        '',
      ];
      const actionLayout = placeSegments([
        {
          text: button(s, 'Compact now', {
            variant: 'primary',
            icon: '✦',
            shortcut: 'c',
            hovered: this.isHovered('run-compact:'),
          }),
          hit: { type: 'run-compact' },
        },
      ], { startCol: 0, gap: 2 });
      const hits = new Map([[body.length, actionLayout.hits]]);
      body.push(actionLayout.text);
      return band({
        title: 'context window',
        subtitle: this.model()?.name || this.modelId,
        body,
        footer: 'c compact now · /compact · esc close',
        hits,
      });
    }
    if (dialog.type === 'workspace') {
      const pathText = String(this.cwd || process.cwd());
      const pathBoxWidth = Math.max(12, dialogInnerWidth - 2);
      const wrappedPath = wrapPlain(pathText, pathBoxWidth);
      const skillCount = (this.skills || []).length;
      const mcpCount = this.mcp?.status?.()?.servers?.length || 0;
      const body = [
        s.fg('faint', 'Current working directory for tools, shell commands, and files:'),
        '',
        ...wrappedPath.map((line) => paintSurface(` ${padEndVisible(s.bold(s.fg('accent', line)), pathBoxWidth)} `, s, 'surface2')),
        '',
        s.fg('muted', `${basenameForDisplay(pathText)}  ·  ${skillCount} ${skillCount === 1 ? 'skill' : 'skills'}  ·  ${mcpCount} mcp`),
        '',
      ];
      const actionLayout = placeSegments([
        {
          text: button(s, 'Change directory', {
            variant: 'primary',
            icon: '✎',
            shortcut: 'c',
            hovered: this.isHovered('change-cwd:'),
          }),
          hit: { type: 'change-cwd' },
        },
        {
          text: button(s, 'Copy path', {
            variant: 'secondary',
            icon: '▤',
            shortcut: 'y',
            hovered: this.isHovered('copy-cwd:'),
          }),
          hit: { type: 'copy-cwd' },
        },
      ], { startCol: 0, gap: 2 });
      const hits = new Map([[body.length, actionLayout.hits]]);
      body.push(actionLayout.text);
      return band({
        title: 'working directory',
        subtitle: basenameForDisplay(pathText),
        body,
        footer: 'c change directory · y copy path · /cwd <path> · esc close',
        hits,
      });
    }
    if (dialog.type === 'tasks') {
      const body = [];
      const done = this.todos.filter((t) => t.status === 'completed').length;
      if (!this.todos.length) {
        body.push(s.fg('faint', 'No tasks tracked in this chat yet.'));
      } else {
        for (const todo of this.todos) {
          const glyph = todo.status === 'completed' ? s.fg('success', '✓')
            : todo.status === 'in_progress' ? s.fg('accent', '◐')
              : s.fg('faint', '○');
          const tone = todo.status === 'completed' ? 'faint' : 'text';
          body.push(`  ${glyph} ${s.fg(tone, truncateToWidth(todo.content, Math.max(10, dialogInnerWidth - 6)))}`);
        }
      }
      const maxVisible = Math.max(1, rows - 6);
      const start = Math.max(0, Math.min(dialog.scroll || 0, Math.max(0, body.length - maxVisible)));
      return band({
        title: 'tasks',
        subtitle: `${done}/${this.todos.length} done`,
        body: body.slice(start),
        footer: '↑↓ scroll · enter / esc close',
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
        const marker = selected ? s.fg('accent', '▎') : ' ';
        const isOff = entry.value === 'off';
        const isOn = entry.value === 'on';
        const valPill = isOn
          ? badge(s, '● on', { fg: 'success', bg: 'successBg' })
          : isOff
            ? badge(s, '○ off', { fg: 'warning', bg: 'warningBg' })
            : badge(s, truncateVisible(entry.value, 22), { fg: 'accent', bg: 'accentBg' });
        const detail = entry.detail ? `  ${s.fg('faint', entry.detail)}` : '';
        body.push(highlightRow(`${marker} ${s.fg(selected ? 'text' : 'muted', entry.label.padEnd(18))} ${valPill}${detail}`, selected));
      }
      const hits = new Map(entries.map((entry, index) => [3 + index, { type: 'setting', key: entry.key }]));
      return band({
        title: 'settings',
        subtitle: `theme: ${this.config.theme || 'dark'}`,
        body,
        footer: '↑↓ select · click or enter / space toggle · esc close',
        hits,
      });
    }
    if (dialog.type === 'permissions') {
      const keys = this.dialogItems(dialog);
      const body = [
        s.fg('faint', 'Read, search and todo are always allowed.'),
        '',
        ...keys.map((key, index) => {
          const selected = index === (dialog.index || 0);
          const enabled = Boolean(this.config.autoApprove[key]);
          const marker = selected ? s.fg('accent', '▎') : ' ';
          const state = enabled
            ? badge(s, '● allowed', { fg: 'success', bg: 'successBg' })
            : badge(s, '○ ask first', { fg: 'warning', bg: 'warningBg' });
          return highlightRow(`${marker} ${s.fg(selected ? 'text' : 'muted', key.padEnd(12))} ${state}`, selected);
        }),
      ];
      const hits = new Map(keys.map((key, index) => [2 + index, { type: 'permission', key }]));
      return band({
        title: 'permissions',
        body,
        footer: '↑↓ select · click or space / enter toggle · esc close',
        hits,
      });
    }
    if (dialog.type === 'usage') {
      const data = dialog.data;
      const body = [];
      const hits = new Map();
      for (const window of data.windows || []) {
        const pct = Math.max(0, Math.min(100, Number(window.percent) || 0));
        const barColor = pct >= 90 ? 'danger' : pct >= 75 ? 'warning' : 'accent';
        body.push(`${s.bold(s.fg('text', window.label.padEnd(8)))} ${progressBar(pct, 24, s, barColor)} ${s.fg('muted', `${formatTokens(window.used)} / ${formatTokens(window.limit)}`)}`);
        if (window.resetAt) body.push(`  ${s.fg('faint', `${pct.toFixed(pct < 10 ? 1 : 0)}% used · resets in ${formatDuration(Math.max(0, window.resetAt - Date.now()), { compact: true })}`)}`);
      }
      const banked = data.bankedResets;
      if (banked) {
        body.push('');
        if (banked.count > 0) {
          const expiry = banked.nextExpiresAt
            ? `oldest expires in ${formatDuration(Math.max(0, banked.nextExpiresAt - Date.now()), { compact: true })}`
            : '';
          body.push(`${s.fg('accent', '◆')} ${s.fg('text', `banked resets: ${banked.count}`)}  ${s.fg('faint', expiry)}`);
        } else {
          body.push(`${s.fg('faint', 'no banked resets')}`);
        }
      }
      body.push('');
      body.push(`${s.fg('muted', `Last 30 days: ${formatTokens(data.totals.tokens)} tokens across ${plural(data.totals.requests, 'request')}`)}`);
      const usageModels = (data.models || []).slice(0, 6);
      if (usageModels.length) {
        body.push('');
        const maxTok = Math.max(1, ...usageModels.map((m) => Number(m.tokens) || 0));
        for (const model of usageModels) {
          const share = Math.round(((Number(model.tokens) || 0) / maxTok) * 100);
          body.push(`  ${s.fg('text', model.modelId.padEnd(16))} ${progressBar(share, 12, s, 'info')} ${s.fg('muted', formatTokens(model.tokens).padStart(7))}  ${s.fg('faint', plural(model.requests, 'request'))}`);
        }
      }
      body.push('');
      const usageButtons = [
        {
          text: button(s, 'Manage Plan', {
            variant: 'primary',
            icon: '✦',
            trailing: '↗',
            hovered: this.isHovered('open-plan:'),
          }),
          hit: { type: 'open-plan' },
        },
      ];
      if (banked?.count > 0) {
        usageButtons.push({
          text: button(s, 'Use Banked Reset', {
            variant: 'secondary',
            icon: '↻',
            hovered: this.isHovered('use-banked-reset:'),
          }),
          hit: { type: 'use-banked-reset' },
        });
      }
      const actionLayout = placeSegments(usageButtons, { startCol: 0, gap: 2 });
      const actionLineIdx = body.length;
      body.push(actionLayout.text);

      const maxVisible = Math.max(1, rows - 5);
      const start = Math.max(0, Math.min(dialog.scroll || 0, Math.max(0, body.length - maxVisible)));
      if (actionLineIdx >= start && actionLineIdx < start + maxVisible) {
        hits.set(actionLineIdx - start, actionLayout.hits);
      }
      return band({
        title: 'usage',
        subtitle: (data.plan?.displayName || this.plan?.displayName || 'Free').replace(/^Gatita\s+/i, '').toLowerCase(),
        body: body.slice(start),
        footer: '/reset uses a banked reset · ↑↓ scroll · esc close',
        hits,
      });
    }
    if (dialog.type === 'text') {
      const body = Array.isArray(dialog.body) ? dialog.body : [];
      const maxVisible = Math.max(1, rows - 5);
      const start = Math.max(0, Math.min(dialog.scroll || 0, Math.max(0, body.length - maxVisible)));
      return band({
        title: dialog.title || 'gatita',
        subtitle: body.length > maxVisible ? `${start + 1}-${Math.min(body.length, start + maxVisible)}/${body.length}` : '',
        body: body.slice(start),
        footer: '↑↓ scroll · enter / esc close',
      });
    }
    if (dialog.type === 'help') {
      const body = [];
      body.push(s.bold(s.fg('accent', 'KEYS & NAVIGATION')));
      for (const line of [
        'enter send · shift+enter (or ctrl+j) newline',
        'ctrl+p open command palette (tab switches Quick / Commands / Models / Themes / Chats)',
        'alt+← / alt+→ cycle chat tabs · alt+1..9 jump to tab · /chats browse all chats',
        'ctrl+t toggle work details · ctrl+r toggle thinking · m expand/minimize all thoughts',
        'type while gatita works and press enter to steer her after the next tool finishes',
        'tab complete · up/down move in the suggestion list · enter accepts it',
        'ctrl+v or right click pastes text or an image · multi-line text collapses into a chip',
        'esc interrupt · ctrl+c cancel or quit',
        'drag with the left mouse button to select text and release to copy',
        'click tabs, × close, + new tab, plan badge (opens gatita.tech/api#plan), and toolbar buttons',
        'pageup/pagedown or mouse wheel scrolls · ctrl+o expand tool output',
        '@skill-name mentions an installed skill · @ + tab autocompletes',
      ]) body.push(`  ${s.fg('muted', line)}`);
      body.push('');
      body.push(s.bold(s.fg('accent', 'COMMANDS')));
      for (const command of SLASH_COMMANDS) {
        body.push(`  ${s.fg('text', `/${command.name}`.padEnd(13))} ${s.fg('faint', command.description)}`);
      }
      body.push('');
      body.push(s.fg('faint', '  /admin commands work only for admin accounts.'));
      const maxVisible = Math.max(1, rows - 5);
      const start = Math.max(0, Math.min(dialog.scroll || 0, Math.max(0, body.length - maxVisible)));
      return band({
        title: 'help',
        subtitle: `v${CLIENT_VERSION} · ${start + 1}-${Math.min(body.length, start + maxVisible)}/${body.length}`,
        body: body.slice(start),
        footer: '↑↓ / pageup / pagedown scroll · esc close',
      });
    }
    if (dialog.type === 'models') {
      const items = this.dialogItems(dialog);
      const body = [];
      const filterInner = dialog.filter
        ? `${s.fg('accent', '⌕')}  ${s.fg('text', dialog.filter)}${s.inverse(' ')}`
        : `${s.fg('accent', '⌕')}  ${s.fg('faint', 'Type to filter Gatita models…')}`;
      body.push(paintSurface(` ${padEndVisible(truncateVisible(filterInner, dialogInnerWidth - 2), dialogInnerWidth - 2)} `, s, 'surface2'));
      body.push('');
      const maxVisible = Math.max(1, rows - 10);
      const visible = items.slice(0, maxVisible);
      if (!visible.length) body.push(s.fg('faint', 'No Gatita models match.'));
      const selectedIdx = Math.max(0, Math.min(visible.length - 1, dialog.index || 0));
      visible.forEach((model, index) => {
        const selected = index === selectedIdx;
        const active = model.id === this.modelId;
        const marker = selected ? s.fg('accent', '▎') : active ? s.fg('success', '●') : ' ';
        const nameCol = padEndVisible(model.name, 14);
        const name = active ? s.bold(s.fg('accent', nameCol)) : s.fg(selected ? 'text' : 'muted', nameCol);
        const badges = [
          model.tools ? s.pill('muted', 'surface3', 'tools') : s.pill('faint', 'surface2', 'chat'),
          model.vision ? s.pill('info', 'infoBg', 'vision') : '',
          model.reasoningLevels.length ? s.pill('accent2', 'accent2Bg', `think ${model.reasoningLevels.join('/')}`) : '',
          model.available ? '' : s.pill('warning', 'warningBg', `needs ${model.requiredPlan}`),
        ].filter(Boolean).join(' ');
        body.push(highlightRow(`${marker} ${name} ${s.fg('faint', formatTokens(model.contextWindow).padStart(6))} ${badges}`, selected));
      });
      const focusedModel = visible[selectedIdx];
      if (focusedModel?.description) {
        body.push('');
        body.push(s.fg('muted', truncateVisible(focusedModel.description, dialogInnerWidth)));
      }
      const hits = new Map();
      visible.forEach((model, index) => {
        hits.set(2 + index, { type: 'model', id: model.id });
      });
      return band({
        title: 'gatita models',
        subtitle: (this.plan?.displayName || 'Free').replace(/^Gatita\s+/i, '').toLowerCase(),
        body,
        footer: '↑↓ select · click or enter choose · type to filter · esc close',
        hits,
      });
    }
    if (dialog.type === 'sessions') {
      const items = this.dialogItems(dialog);
      const openSet = new Set(this.openTabIds || []);
      const body = [];
      const hits = new Map();

      const newChatBtn = button(s, 'New chat', {
        variant: 'primary',
        icon: '+',
        hovered: this.isHovered('new-chat:'),
      });
      const newBtnW = visibleWidth(newChatBtn);
      const searchW = Math.max(12, dialogInnerWidth - newBtnW - 2);
      const searchInner = dialog.filter
        ? `${s.fg('accent', '⌕')} ${s.fg('text', dialog.filter)}${s.inverse(' ')}`
        : `${s.fg('accent', '⌕')} ${s.fg('faint', 'Filter chats…')}`;
      const searchBox = paintSurface(` ${padEndVisible(truncateVisible(searchInner, searchW - 2), searchW - 2)} `, s, 'surface2');
      body.push(`${searchBox}  ${newChatBtn}`);
      hits.set(0, [{ type: 'new-chat', col: searchW + 2, width: newBtnW }]);
      body.push(s.fg('border', '─'.repeat(dialogInnerWidth)));

      const maxVisible = Math.max(1, Math.min(10, rows - 10));
      const selectedIdx = Math.max(0, Math.min(items.length - 1, dialog.index || 0));
      const windowStart = Math.max(0, Math.min(items.length - maxVisible, selectedIdx - Math.floor(maxVisible / 2)));
      const visible = items.slice(Math.max(0, windowStart), Math.max(0, windowStart) + maxVisible);

      if (!visible.length) {
        body.push(s.fg('faint', '  No chats match. Click "+ New chat" or press tab to start one.'));
      } else {
        visible.forEach((chat, offset) => {
          const idx = Math.max(0, windowStart) + offset;
          const selected = idx === selectedIdx;
          const active = chat.id === this.chat?.id;
          const isOpen = openSet.has(chat.id);
          const marker = selected ? s.fg('accent', '▎') : ' ';
          const statusDot = active ? s.fg('accent', '●') : isOpen ? s.fg('info', '○') : s.fg('faint', '·');
          const delHovered = this.isHovered(`delete-chat:${chat.id}`);
          const delBtn = delHovered
            ? paintSurface(s.bold(s.fg('danger', ' × ')), s, 'dangerBg')
            : s.fg('faint', ' × ');
          const delW = visibleWidth(delBtn);
          const age = chat.updatedAt ? `${formatDuration(Math.max(0, Date.now() - chat.updatedAt), { compact: true })} ago` : '';
          const metaStr = `${chat.messageCount || 0} msg${age ? ` · ${age}` : ''}`;
          const metaStyled = s.fg('faint', metaStr);
          const metaW = visibleWidth(metaStr);
          const titleBudget = Math.max(8, dialogInnerWidth - metaW - delW - 8);
          const titleRaw = truncateVisible(chat.title || 'New chat', titleBudget);
          const titleStyled = active ? s.bold(s.fg('accent', titleRaw)) : s.fg(selected ? 'text' : 'muted', titleRaw);
          const leftPart = `${marker} ${statusDot} ${titleStyled}`;
          const gap = Math.max(1, dialogInnerWidth - visibleWidth(leftPart) - metaW - delW - 1);
          const rowText = `${leftPart}${' '.repeat(gap)}${metaStyled} ${delBtn}`;
          body.push(highlightRow(rowText, selected));
          const rowIdx = body.length - 1;
          hits.set(rowIdx, [
            { type: 'session', id: chat.id, col: 0, width: Math.max(1, dialogInnerWidth - delW) },
            { type: 'delete-chat', id: chat.id, col: Math.max(0, dialogInnerWidth - delW), width: delW },
          ]);
        });
      }
      const openCount = this.openTabs().length;
      return band({
        title: 'chats',
        subtitle: `${items.length} total · ${openCount} ${openCount === 1 ? 'tab' : 'tabs'}`,
        body,
        footer: '↑↓ select · enter open tab · tab new · d delete · esc close',
        hits,
      });
    }
    if (dialog.type === 'folders') {
      const body = [];
      const hits = new Map();
      const selectedIndex = dialog.index || 0;
      const allMarker = selectedIndex === 0 ? s.fg('accent', '▎') : ' ';
      body.push(highlightRow(`${allMarker} ${s.fg(selectedIndex === 0 ? 'text' : 'muted', 'all chats')} ${s.fg('faint', 'no folder')}`, selectedIndex === 0));
      hits.set(0, { type: 'folder', id: null });
      this.folders.forEach((folder, index) => {
        const selected = index + 1 === selectedIndex;
        body.push(highlightRow(`${selected ? s.fg('accent', '▎') : ' '} ${s.fg(selected ? 'text' : 'muted', folder.name)} ${s.fg('faint', `${folder.chatCount} chats`)}`, selected));
        hits.set(1 + index, { type: 'folder', id: folder.id });
      });
      body.push('');
      const newFolderLayout = placeSegments([
        {
          text: button(s, 'New folder', {
            variant: 'secondary',
            icon: '+',
            shortcut: 'n',
            hovered: this.isHovered('new-folder:'),
          }),
          hit: { type: 'new-folder' },
        },
      ], { startCol: 0, gap: 1 });
      body.push(newFolderLayout.text);
      hits.set(body.length - 1, newFolderLayout.hits);
      return band({
        title: 'folders',
        body,
        footer: 'enter use folder · n new folder · esc close',
        hits,
      });
    }
    return band({ title: 'gatita', body: [s.fg('muted', 'Nothing here.')], footer: 'esc close' });
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
      // ensureLogin already fetched the account when a saved session was
      // valid. Reuse it so startup doesn't make the same request twice.
      auth.source === 'login' ? client.me({ timeoutMs: 15_000 }) : auth.me,
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
