import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { App } from '../src/cli/tui.js';
import { Terminal } from '../src/cli/tui/terminal.js';
import { openLocalStore } from '../src/cli/store.js';
import { commandSuggestions } from '../src/cli/tui/commands.js';
import { renderMarkdown, wrapPlain } from '../src/cli/tui/render.js';
import { createStyler, visibleWidth, stripAnsi } from '../src/cli/theme.js';

const MODEL = {
  id: 'gatita-fast',
  name: 'Gatita Fast',
  description: 'fast model',
  available: true,
  tools: true,
  vision: false,
  reasoningLevels: ['off', 'low', 'max'],
  reasoningLocked: false,
  contextWindow: 131072,
  maxOutputTokens: 8192,
  requiredPlan: 'free',
  default: true,
};

function makeApp(cols = 80, rows = 24) {
  const store = openLocalStore(':memory:');
  const chat = store.createChat({ title: 'Refactor auth', cwd: process.cwd() });
  store.addMessage(chat.id, { role: 'user', content: 'Please look at the **auth** code and run the tests.' });
  store.addMessage(chat.id, {
    role: 'assistant',
    reasoning: 'I should read the file first, then run the test suite to see what fails.',
    content: 'Done.\n\n```js\nconsole.log("hi")\n```\n\n- one\n- two',
    toolCalls: [{
      id: 'call_1',
      type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) },
    }],
    meta: { model: 'gatita-fast' },
  });
  store.addMessage(chat.id, {
    role: 'tool',
    content: 'all tests pass\nsecond line',
    toolCallId: 'call_1',
    name: 'bash',
    meta: { isError: false, title: 'Ran npm test', durationMs: 1200 },
  });
  const app = new App({
    config: {
      showReasoning: true,
      showWork: true,
      mode: 'build',
      theme: 'dark',
      animations: true,
      computerUse: false,
      autoApprove: { edit: false, write: false, shell: false },
      defaultModel: 'gatita-fast',
      lastChatId: chat.id,
      serverUrl: 'https://example.invalid',
      paths: { home: path.join(os.tmpdir(), 'gatita-studio-test-home') },
    },
    client: {},
    me: {
      plan: { id: 'pro', displayName: 'Gatita Pro' },
      quota: {
        windows: [{
          label: 'Weekly',
          shortLabel: 'week',
          used: 10_000,
          limit: 720_000_000,
          remaining: 719_990_000,
          percent: 0.01,
          resetAt: Date.now() + 3_600_000,
        }],
      },
    },
    models: { data: [MODEL], defaultModel: 'gatita-fast' },
    store,
    args: ['--new'],
  });
  app.chat = chat;
  app.showWork = true;
  app.messages = store.listMessages(chat.id);
  app.todos = [{ id: 't1', content: 'Read the auth code', status: 'completed', priority: 'medium' }];
  app.terminal = {
    columns: cols,
    rows,
    requestRender() {},
    start() {},
    enter() {},
    leave() {},
  };
  return { app, store, chat };
}

test('slash command suggestions filter by name and alias', () => {
  const models = commandSuggestions('/mod');
  assert.equal(models[0].name, 'model');
  const think = commandSuggestions('/think');
  assert.ok(think.some((command) => command.name === 'reasoning'));
  assert.ok(think.some((command) => command.name === 'thinking'));
  const none = commandSuggestions('/zzz');
  assert.equal(none.length, 0);
  const plugin = commandSuggestions('/deploy', [{ name: 'deploy', description: 'Ship it', plugin: 'ship' }]);
  assert.equal(plugin[0].name, 'deploy');
});

test('the header shows an available update without exposing server details', () => {
  const { app, store } = makeApp(120, 30);
  try {
    app.updateNotice = { latest: '9.9.9', current: '0.1.1' };
    const header = app.renderHeader(120);
    assert.match(header, /update: 9\.9\.9/);
    assert.doesNotMatch(header, /provider|model mapping|private/i);
  } finally {
    store.close();
  }
});

test('thinking is compact until the user expands it', () => {
  const { app, store } = makeApp();
  try {
    app.config.showReasoning = true;
    const message = {
      id: 'thought_1',
      role: 'assistant',
      reasoning: 'A long private chain of thought that should stay folded by default.',
      content: '',
      createdAt: Date.now(),
      meta: { model: 'gatita-fast' },
    };
    const collapsed = app.messageBlock(message, 80, new Map()).join('\n');
    assert.match(collapsed, /thought for \d+ tokens/);
    assert.doesNotMatch(collapsed, /long private chain of thought/);

    app.expandedReasoning.add(message.id);
    const expanded = app.messageBlock(message, 80, new Map()).join('\n');
    assert.match(expanded, /long private chain of thought/);
    assert.match(expanded, /m to minimize/);
  } finally {
    store.close();
  }
});

test('streaming thoughts stay on one line', () => {
  const { app, store } = makeApp();
  try {
    app.config.showReasoning = true;
    app.stream.active = true;
    app.stream.startedAt = Date.now();
    app.stream.reasoning = 'line one\nline two\nline three\nline four';
    const lines = app.streamingLines(80);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /thought tokens/);
    assert.doesNotMatch(lines.join('\n'), /line four/);
  } finally {
    store.close();
  }
});

test('long tool output is folded and only expands on request', () => {
  const { app, store } = makeApp();
  try {
    const call = {
      id: 'call_bash',
      type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) },
    };
    const result = {
      toolCallId: 'call_bash',
      name: 'bash',
      content: 'first line\nsecond line\nthird line',
      meta: { isError: true },
    };
    const collapsed = app.toolLines(call, result, 80).join('\n');
    assert.match(collapsed, /first line/);
    assert.doesNotMatch(collapsed, /third line/);
    assert.match(collapsed, /2 more lines · ctrl\+o to expand/);

    app.expandedTools.add('call_bash');
    const expanded = app.toolLines(call, result, 80).join('\n');
    assert.match(expanded, /third line/);
    assert.match(expanded, /ctrl\+o to collapse/);
  } finally {
    store.close();
  }
});

test('mouse wheel scrolls the transcript', () => {
  const { app, store } = makeApp();
  try {
    app.render();
    app.scrollOffset = 0;
    app.followBottom = true;
    app.handleKey({ name: 'mouse', button: 65, row: 5, column: 5, press: true, release: false });
    assert.equal(app.scrollOffset, 0, 'wheel down from the bottom is a no-op');
    app.handleKey({ name: 'mouse', button: 64, row: 5, column: 5, press: true, release: false });
    assert.ok(app.scrollOffset >= 0, 'wheel up at most reaches zero lines in a short transcript');
  } finally {
    store.close();
  }
});

test('mouse wheel scrolls when the transcript is taller than the viewport', () => {
  const { app, store } = makeApp();
  try {
    for (let index = 0; index < 80; index += 1) {
      store.addMessage(app.chat.id, {
        role: 'assistant',
        content: `message ${index}\n` + 'y'.repeat(300),
      });
    }
    app.messages = store.listMessages(app.chat.id);
    app.render();
    assert.ok(app.transcriptLineCount > app.conversationHeight, 'expected overflowing transcript');
    app.handleKey({ name: 'mouse', button: 64, row: 3, column: 3, press: true, release: false });
    assert.ok(app.scrollOffset > 0, `expected scroll offset > 0 after wheel up, got ${app.scrollOffset}`);
  } finally {
    store.close();
  }
});

test('mouse click on a sidebar recent chat resumes it', () => {
  const { app, store, chat } = makeApp(120, 30);
  try {
    const other = store.createChat({ title: 'Other chat', cwd: process.cwd() });
    store.addMessage(other.id, { role: 'user', content: 'hi' });
    store.renameChat(other.id, 'Mentioned chat');
    app.refreshSidebar();
    app.render();
    const targetIndex = app.hitRegions.findIndex((hit) => hit?.type === 'resume' && hit.id === other.id);
    assert.ok(targetIndex >= 0, 'expected a resume hit region for the other chat');
    app.handleKey({ name: 'mouse', button: 0, row: targetIndex + 1, column: 10, press: true, release: false });
    assert.equal(app.chat?.id, other.id);
  } finally {
    store.close();
  }
});

test('mouse click on a slash suggestion applies the command', () => {
  const { app, store } = makeApp();
  try {
    app.input = '/mod';
    app.cursor = 4;
    app.render();
    const hitIndex = app.hitRegions.findIndex((hit) => hit?.type === 'suggestion' && hit.text === '/model ');
    assert.ok(hitIndex >= 0, 'expected a suggestion hit for /model');
    app.handleKey({ name: 'mouse', button: 0, row: hitIndex + 1, column: 5, press: true, release: false });
    assert.equal(app.input, '/model ');
  } finally {
    store.close();
  }
});

test('mouse click outside any hit region is a no-op', () => {
  const { app, store, chat } = makeApp();
  try {
    app.render();
    const originalChat = app.chat;
    app.handleKey({ name: 'mouse', button: 0, row: 2, column: 40, press: true, release: false });
    assert.equal(app.chat, originalChat);
  } finally {
    store.close();
  }
});

test('wide wrapped prose lines never exceed the requested width', () => {
  const styler = createStyler('dark');
  const samples = [
    '**bold** '.repeat(80),
    'word '.repeat(60),
    '日本語テスト😀 '.repeat(30),
    'plain ' + 'longword'.repeat(40) + ' tail',
    '`' + 'x'.repeat(300) + '`',
  ];
  for (const width of [40, 78, 104]) {
    for (const sample of samples) {
      for (const line of renderMarkdown(sample, width, styler)) {
        assert.ok(visibleWidth(line) <= width, `line too wide at ${width}: ${visibleWidth(line)}`);
      }
    }
  }
});

test('skill suggestions filter by prefix and mid-substring', async () => {
  const skills = [
    { name: 'deploy-app', description: 'Ship the app', content: 'body' },
    { name: 'deploy-api', description: 'Ship the API', content: 'body' },
    { name: 'review-pr', description: 'Review a PR', content: 'body' },
  ];
  const { skillSuggestions, extractSkillMentions } = await import('../src/skills/index.js');
  const hits = skillSuggestions('@depl', skills);
  assert.equal(hits.length, 2);
  assert.ok(hits.every((item) => item.name.startsWith('deploy-')));
  assert.equal(skillSuggestions('@review', skills)[0].name, 'review-pr');
  assert.equal(skillSuggestions('@unknown', skills).length, 0);
  const mentioned = extractSkillMentions('please use @deploy-app and @review-pr and @deploy-app again', skills);
  assert.deepEqual(mentioned.map((entry) => entry.name), ['deploy-app', 'review-pr']);
});

test('typing @ in the composer surfaces skill suggestions with a verb prefix', () => {
  const { app, store } = makeApp();
  app.skills = [
    { name: 'deploy-app', description: 'Ship the app', content: 'x' },
    { name: 'deploy-api', description: 'Ship the API', content: 'x' },
  ];
  try {
    for (const char of '@depl') app.handleKey({ name: 'text', text: char });
    const frame = app.render();
    const joined = frame.join('\n');
    assert.ok(joined.includes('@deploy-api'));
    assert.ok(joined.includes('@deploy-app'));
    app.handleTab();
    assert.equal(app.input, '@deploy-api ');
  } finally {
    store.close();
  }
});

test('typing @ in the composer shows skill suggestions and tab completes', () => {
  const { app, store } = makeApp();
  app.skills = [
    { name: 'review-pr', description: 'Review a PR', content: 'body' },
    { name: 'deploy-app', description: 'Ship the app', content: 'body' },
  ];
  try {
    for (const char of '@depl') app.handleKey({ name: 'text', text: char });
    assert.equal(app.input, '@depl');
    app.handleTab();
    assert.equal(app.input, '@deploy-app ');
  } finally {
    store.close();
  }
});

test('a long word that exceeds the composer width does not overflow the frame', () => {
  const { app, store } = makeApp(78, 24);
  app.input = `prefix${'x'.repeat(500)}suffix`;
  app.cursor = 10;
  try {
    const frame = app.render();
    for (const line of frame) assert.ok(visibleWidth(line) <= 78, `frame line too wide: ${visibleWidth(line)}`);
  } finally {
    store.close();
  }
});

test('markdown and wrapping handle code, lists and wide text without overflowing', () => {
  const styler = createStyler('dark');
  const lines = renderMarkdown('# Title\n\nSome **bold** text and `code`.\n\n```js\nconsole.log("hello");\n```\n\n- one\n- two', 32, styler);
  assert.ok(lines.length >= 6);
  for (const line of lines) assert.ok(visibleWidth(line) <= 32, `line too wide: ${visibleWidth(line)}`);
  const wrapped = wrapPlain('a '.repeat(40), 20);
  assert.ok(wrapped.every((line) => visibleWidth(line) <= 20));
});

test('the TUI renders stable frames at narrow and wide sizes', () => {
  for (const [cols, rows] of [[60, 20], [80, 24], [120, 32]]) {
    const { app, store } = makeApp(cols, rows);
    try {
      const frame = app.render();
      assert.ok(frame.length <= rows, 'frame is too tall');
      assert.equal(visibleWidth(frame[frame.length - 1]), cols, 'status bar should fill the width');
      for (const line of frame) {
        assert.ok(visibleWidth(line) <= cols + 1, `line overflows at ${cols}: ${visibleWidth(line)}`);
      }
      app.input = '/hel';
      app.cursor = 4;
      const withSuggestions = app.render();
      assert.ok(withSuggestions.length <= rows);
      app.input = '';
      app.cursor = 0;
      app.openDialog({ type: 'text', title: 'skills', body: ['one', 'two', 'three'], scroll: 0 });
      const dialogFrame = app.render();
      assert.equal(dialogFrame.length <= rows, true);
    } finally {
      store.close();
    }
  }
});

test('approval and confirm dialogs accept plain text keys', () => {
  const { app, store } = makeApp();
  try {
    let approved = null;
    app.approval = { tool: 'bash', group: 'shell', summary: 'npm test', args: {}, resolve: (value) => { approved = value; } };
    app.handleKey({ name: 'text', text: 'y' });
    assert.equal(approved, true);
    assert.equal(app.approval, null);

    let confirmed = null;
    app.openDialog({
      type: 'confirm',
      message: 'Clear?',
      resolve: (value) => {
        confirmed = value;
        app.dialog = null;
      },
    });
    app.handleKey({ name: 'text', text: 'n' });
    assert.equal(confirmed, false);
  } finally {
    store.close();
  }
});

test('typing, editing and history work through the key handler', () => {
  const { app, store } = makeApp();
  try {
    app.handleKey({ name: 'text', text: 'hello' });
    assert.equal(app.input, 'hello');
    app.handleKey({ name: 'left' });
    app.handleKey({ name: 'text', text: 'X' });
    assert.equal(app.input, 'hellXo');
    assert.equal(app.cursor, 5);
    app.handleKey({ name: 'backspace' });
    assert.equal(app.input, 'hello');
    assert.equal(app.cursor, 4);
  } finally {
    store.close();
  }
});

test('leaving the terminal releases a piped stdin handle', () => {
  const calls = [];
  const stdin = {
    isTTY: false,
    on() {},
    removeListener() {},
    setRawMode() {},
    setEncoding() {},
    resume() {},
    pause() { calls.push('pause'); },
    unref() { calls.push('unref'); },
  };
  const stdout = {
    on() {},
    removeListener() {},
    write() { calls.push('write'); },
  };
  const terminal = new Terminal({ stdin, stdout });
  terminal.enter();
  terminal.leave();
  assert.ok(calls.includes('pause'));
  assert.ok(calls.includes('unref'), 'a paused pipe still needs unref before the process can exit');
});

test('enter accepts the first command suggestion, then runs the command', () => {
  const { app, store } = makeApp();
  try {
    for (const char of '/mod') app.handleKey({ name: 'text', text: char });
    app.handleKey({ name: 'enter' });
    assert.equal(app.input, '/model ');
    app.handleKey({ name: 'enter' });
    assert.equal(app.dialog?.type, 'models');
  } finally {
    store.close();
  }
});

test('arrow keys move the highlight inside the command selector', () => {
  const { app, store } = makeApp();
  try {
    for (const char of '/th') app.handleKey({ name: 'text', text: char });
    const before = app.render().map((line) => stripAnsi(line)).join('\n');
    assert.ok(before.includes('/theme'), 'expected suggestions to render');
    assert.equal(app.suggestionIndex, 0);
    app.handleKey({ name: 'down' });
    assert.equal(app.suggestionIndex, 1);
    app.handleKey({ name: 'down' });
    assert.equal(app.suggestionIndex, 2);
    app.handleKey({ name: 'down' });
    assert.equal(app.suggestionIndex, 2, 'highlight is clamped to the filtered list');
    app.handleKey({ name: 'enter' });
    assert.equal(app.input, '/reasoning ');
    app.handleKey({ name: 'up' });
    assert.equal(app.suggestionIndex, 0, 'arrow keys keep working after accepting a suggestion');
  } finally {
    store.close();
  }
});

test('tab accepts the highlighted (not just the first) command suggestion', () => {
  const { app, store } = makeApp();
  try {
    for (const char of '/th') app.handleKey({ name: 'text', text: char });
    app.handleKey({ name: 'down' });
    app.handleTab();
    assert.equal(app.input, '/thinking ');
  } finally {
    store.close();
  }
});

test('shift+enter inserts a newline instead of sending', () => {
  const { app, store } = makeApp();
  try {
    for (const char of 'hello') app.handleKey({ name: 'text', text: char });
    app.handleKey({ name: 'enter', shift: true });
    for (const char of 'world') app.handleKey({ name: 'text', text: char });
    assert.equal(app.input, 'hello\nworld');
  } finally {
    store.close();
  }
});

test('a multi-line prompt that starts with a slash is sent as a prompt, not a command', () => {
  const { app, store } = makeApp();
  try {
    const sent = [];
    app.sendPrompt = (text) => { sent.push(text); };
    app.input = '/tmp/notes\nsummarize this file';
    app.cursor = app.input.length;
    app.handleKey({ name: 'enter' });
    assert.deepEqual(sent, ['/tmp/notes\nsummarize this file']);
  } finally {
    store.close();
  }
});

test('mouse drag selects text, copies it on release and shows a toast', async () => {
  const { app, store } = makeApp();
  try {
    const copied = [];
    app.clipboard = { read: async () => 'clip', write: async (text) => { copied.push(text); } };
    app.render();
    const plain = app.lastFramePlain;
    const row = plain.findIndex((line) => line.includes('Please look'));
    assert.ok(row >= 0, 'expected the user message on screen');
    const start = plain[row].indexOf('Please');
    app.handleKey({ name: 'mouse', button: 0, press: true, release: false, row: row + 1, column: start + 1 });
    app.handleKey({ name: 'mouse', button: 32, press: true, release: false, row: row + 1, column: start + 12 });
    app.handleKey({ name: 'mouse', button: 0, press: false, release: true, row: row + 1, column: start + 12 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(copied.length, 1);
    assert.match(copied[0], /Please look/);
    assert.match(app.toast?.text || '', /Copied/);
  } finally {
    store.close();
  }
});

test('right-click pastes the clipboard into the composer', async () => {
  const { app, store } = makeApp();
  try {
    app.clipboard = { read: async () => 'pasted from clipboard', write: async () => {} };
    app.handleKey({ name: 'mouse', button: 2, press: true, release: false, row: 5, column: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(app.input, 'pasted from clipboard');
  } finally {
    store.close();
  }
});

test('double click selects a word and copies it', async () => {
  const { app, store } = makeApp();
  try {
    const copied = [];
    app.clipboard = { read: async () => '', write: async (text) => { copied.push(text); } };
    app.render();
    const plain = app.lastFramePlain;
    const row = plain.findIndex((line) => line.includes('Please look'));
    assert.ok(row >= 0);
    const col = plain[row].indexOf('look');
    app.handleKey({ name: 'mouse', button: 0, press: true, release: false, row: row + 1, column: col + 2 });
    app.handleKey({ name: 'mouse', button: 0, press: false, release: true, row: row + 1, column: col + 2 });
    app.handleKey({ name: 'mouse', button: 0, press: true, release: false, row: row + 1, column: col + 2 });
    app.handleKey({ name: 'mouse', button: 0, press: false, release: true, row: row + 1, column: col + 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(copied, ['look']);
  } finally {
    store.close();
  }
});

test('the composer cursor cell does not duplicate characters', () => {
  const { app, store } = makeApp();
  try {
    app.input = 'second line here';
    app.cursor = 1;
    const frame = app.render().map((line) => stripAnsi(line));
    const line = frame.find((entry) => entry.includes('second'));
    assert.ok(line, 'expected the composer line');
    assert.ok(line.includes('second line here'), `expected the plain text intact, got: ${JSON.stringify(line)}`);
    assert.ok(!line.includes('seccond'), 'the character under the cursor must not be duplicated');
  } finally {
    store.close();
  }
});

test('multi-line selection is copied inside a code fence', async () => {
  const { app, store } = makeApp();
  try {
    const copied = [];
    app.clipboard = { read: async () => '', write: async (text) => { copied.push(text); } };
    app.render();
    const plain = app.lastFramePlain;
    const rowStart = plain.findIndex((line) => line.includes('Please look'));
    const rowEnd = plain.findIndex((line) => line.includes('Done.'));
    assert.ok(rowStart >= 0 && rowEnd > rowStart, 'expected user and assistant rows on screen');
    const startCol = plain[rowStart].indexOf('Please');
    const endCol = plain[rowEnd].indexOf('Done.') + 'Done.'.length;
    app.handleKey({ name: 'mouse', button: 0, press: true, release: false, row: rowStart + 1, column: startCol + 1 });
    app.handleKey({ name: 'mouse', button: 32, press: true, release: false, row: rowEnd + 1, column: endCol + 1 });
    app.handleKey({ name: 'mouse', button: 0, press: false, release: true, row: rowEnd + 1, column: endCol + 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(copied.length, 1);
    const fence = String.fromCharCode(96).repeat(3);
    assert.ok(copied[0].startsWith(`${fence}\n`), 'expected the copy to open with a fence');
    assert.ok(copied[0].endsWith(`\n${fence}`), 'expected the copy to close with a fence');
    assert.ok(copied[0].includes('Please look'), 'fence keeps the raw selected text');
    assert.ok(copied[0].includes('Done.'));
  } finally {
    store.close();
  }
});

test('the fence grows past backtick runs in the copied content', async () => {
  const { app, store, chat } = makeApp();
  try {
    const tick = '`';
    const triple = tick.repeat(3);
    store.addMessage(chat.id, {
      role: 'tool',
      content: `command emitted: ${triple}npm test${triple} result\nplain second line`,
      toolCallId: 'call_fence',
      name: 'bash',
      meta: { isError: false, title: 'Run', durationMs: 10 },
    });
    app.messages = store.listMessages(chat.id);
    app.expandedTools.add('call_fence');
    const copied = [];
    app.clipboard = { read: async () => '', write: async (text) => { copied.push(text); } };
    app.render();
    const plain = app.lastFramePlain;
    const rowStart = plain.findIndex((line) => line.includes('command emitted'));
    const rowEnd = plain.findIndex((line) => line.includes('plain second line'));
    assert.ok(rowStart >= 0 && rowEnd >= rowStart, 'expected the tool output rows on screen');
    const startCol = plain[rowStart].indexOf('command emitted');
    const endCol = plain[rowEnd].indexOf('plain second line') + 'plain second line'.length;
    app.handleKey({ name: 'mouse', button: 0, press: true, release: false, row: rowStart + 1, column: startCol + 1 });
    app.handleKey({ name: 'mouse', button: 32, press: true, release: false, row: rowEnd + 1, column: endCol + 1 });
    app.handleKey({ name: 'mouse', button: 0, press: false, release: true, row: rowEnd + 1, column: endCol + 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(copied.length, 1);
    assert.match(copied[0], /^````\n/, 'expected a fence longer than the backtick run in the content');
    assert.match(copied[0], /\n````$/);
    assert.ok(copied[0].includes(`${triple}npm test${triple}`));
  } finally {
    store.close();
  }
});

test('single-line selection is copied without a fence', async () => {
  const { app, store } = makeApp();
  try {
    const copied = [];
    app.clipboard = { read: async () => '', write: async (text) => { copied.push(text); } };
    app.render();
    const plain = app.lastFramePlain;
    const row = plain.findIndex((line) => line.includes('Please look'));
    assert.ok(row >= 0);
    const col = plain[row].indexOf('Please');
    app.handleKey({ name: 'mouse', button: 0, press: true, release: false, row: row + 1, column: col + 1 });
    app.handleKey({ name: 'mouse', button: 32, press: true, release: false, row: row + 1, column: col + 7 });
    app.handleKey({ name: 'mouse', button: 0, press: false, release: true, row: row + 1, column: col + 7 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(copied, ['Please']);
  } finally {
    store.close();
  }
});

test('a selection started in the conversation cannot grow into the sidebar', async () => {
  const { app, store } = makeApp(120, 30);
  try {
    const copied = [];
    app.clipboard = { read: async () => '', write: async (text) => { copied.push(text); } };
    app.render();
    const plain = app.lastFramePlain;
    const convRow = plain.findIndex((line) => line.includes('Please look'));
    // Buttons make the sidebar taller than the short transcript; drag to one of
    // its button rows so the clamp direction is into the sidebar again.
    const sidebarRow = plain.findIndex((line) => line.includes('new chat'));
    assert.ok(convRow >= 0, 'expected the user message on screen');
    assert.ok(sidebarRow >= 0, 'expected sidebar buttons on a wide terminal');
    const col = plain[convRow].indexOf('tests') + 'tests'.length - 1;
    app.handleKey({ name: 'mouse', button: 0, press: true, release: false, row: convRow + 1, column: col + 1 });
    // Sweep up and far left into the sidebar; the selection must clamp.
    app.handleKey({ name: 'mouse', button: 32, press: true, release: false, row: sidebarRow + 1, column: 1 });
    app.handleKey({ name: 'mouse', button: 0, press: false, release: true, row: sidebarRow + 1, column: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(app.selection === null, 'release copies and clears the highlight');
    assert.equal(copied.length, 1, 'expected one copied payload');
    assert.ok(copied[0].includes('Please look'), 'conversation text is copied');
    for (const label of ['RECENT', 'FOLDERS', 'USAGE', 'WORKSPACE', 'all chats']) {
      assert.ok(!copied[0].includes(label), 'sidebar text must not be copied: ' + label);
    }
  } finally {
    store.close();
  }
});

test('a selection started in the sidebar cannot grow into the conversation', async () => {
  const { app, store } = makeApp(120, 30);
  try {
    const copied = [];
    app.clipboard = { read: async () => '', write: async (text) => { copied.push(text); } };
    app.render();
    const plain = app.lastFramePlain;
    const sidebarRow = plain.findIndex((line) => line.includes('RECENT'));
    const convRow = plain.findIndex((line) => line.includes('Please look'));
    assert.ok(sidebarRow >= 0 && convRow >= 0);
    app.handleKey({ name: 'mouse', button: 0, press: true, release: false, row: sidebarRow + 1, column: 2 });
    // Sweep down-right, all the way into the conversation area.
    app.handleKey({ name: 'mouse', button: 32, press: true, release: false, row: convRow + 1, column: 80 });
    app.handleKey({ name: 'mouse', button: 0, press: false, release: true, row: convRow + 1, column: 80 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(copied.length, 1);
    assert.ok(!copied[0].includes('Please look'), 'conversation text must not be copied');
  } finally {
    store.close();
  }
});

test('dragging across the divider clamps the selection to the conversation', async () => {
  const { app, store } = makeApp(120, 30);
  try {
    const copied = [];
    app.clipboard = { read: async () => '', write: async (text) => { copied.push(text); } };
    app.render();
    const plain = app.lastFramePlain;
    const convRow = plain.findIndex((line) => line.includes('Please look'));
    assert.ok(convRow >= 0);
    const col = plain[convRow].indexOf('Please');
    app.handleKey({ name: 'mouse', button: 0, press: true, release: false, row: convRow + 1, column: col + 1 });
    // Drag left into the sidebar zone on the same row.
    app.handleKey({ name: 'mouse', button: 32, press: true, release: false, row: convRow + 1, column: 2 });
    assert.ok(app.selection, 'expected a selection');
    assert.equal(app.selection.bounds.colStart, 32, 'selection stops at the conversation edge');
    assert.ok(app.selection.start.col >= 32);
    app.handleKey({ name: 'mouse', button: 0, press: false, release: true, row: convRow + 1, column: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(copied[0] === undefined || !copied[0].includes('�'), 'the divider glyph is not copied');
    assert.ok(!copied[0] || !copied[0].includes('RECENT'));
  } finally {
    store.close();
  }
});

test('gatita plays a chime once when she needs the user and twice when done', () => {
  const { app, store } = makeApp();
  try {
    const sounds = [];
    app.soundPlayer = (kind, custom) => { sounds.push({ kind, custom }); };
    app.requestApproval({ tool: 'bash', group: 'shell', summary: 'npm test', args: {}, callId: 'call_bell' });
    assert.deepEqual(sounds.map((s) => s.kind), ['prompt'], 'an approval prompt plays the prompt chime once');
    app.finishApproval(true);
    app.onAgentEvent({ type: 'done', text: 'done', reasoning: '', usage: { totalTokens: 3 }, steps: 1 });
    assert.deepEqual(sounds.map((s) => s.kind), ['prompt', 'done', 'done'], 'done plays twice');
    app.config.sounds = false;
    app.onAgentEvent({ type: 'done', text: 'done again', reasoning: '', usage: { totalTokens: 3 }, steps: 1 });
    assert.equal(sounds.length, 3, 'no sound when sounds are off');
    app.config.sounds = true;
    process.env.GATITA_NO_BELL = '1';
    app.onAgentEvent({ type: 'done', text: 'done again', reasoning: '', usage: { totalTokens: 3 }, steps: 1 });
    assert.equal(sounds.length, 3, 'GATITA_NO_BELL silences the sound');
  } finally {
    delete process.env.GATITA_NO_BELL;
    store.close();
  }
});

test('a custom sound file can be passed through to the player', () => {
  const { app, store } = makeApp();
  try {
    const sounds = [];
    app.soundPlayer = (kind, custom) => { sounds.push({ kind, custom }); };
    process.env.GATITA_STUDIO_SOUND = '/path/to/my-chime.wav';
    app.playSound('prompt');
    assert.deepEqual(sounds, [{ kind: 'prompt', custom: '/path/to/my-chime.wav' }]);
    delete process.env.GATITA_STUDIO_SOUND;
    app.config.soundFile = '/config/my-sound.wav';
    app.playSound('done');
    assert.equal(sounds.at(-1).custom, '/config/my-sound.wav');
  } finally {
    delete process.env.GATITA_STUDIO_SOUND;
    store.close();
  }
});

test('the ask dialog renders options, an other row, and a countdown', () => {
  const { app, store } = makeApp();
  try {
    const questions = [{
      id: 'route',
      question: 'How should this ship?',
      options: [
        { id: 'now', label: 'Ship now', description: 'Deploy today.' },
        { id: 'later', label: 'Ship later' },
      ],
    }];
    const opened = app.presentQuestion({ questions, timeoutMs: 300_000 });
    assert.ok(opened.questionId);
    assert.equal(app.dialog?.type, 'ask');
    const frame = app.render().map((line) => line.replace(/\u001b\[[0-9;]*m/g, '')).join('\n');
    assert.ok(frame.includes('How should this ship?'));
    assert.ok(frame.includes('Ship now'));
    assert.ok(frame.includes('Deploy today.'));
    assert.ok(frame.includes('Other'));
    assert.ok(frame.includes('of 1'));
    app.handleKey({ name: 'escape' });
    assert.equal(app.dialog, null, 'esc closes the dialog');
    assert.equal(app.questionStatus(opened.questionId).status, 'cancelled');
  } finally {
    store.close();
  }
});

test('picking a single choice answers and closes the question', async () => {
  const { app, store } = makeApp();
  try {
    const questions = [{
      id: 'route',
      question: 'How should this ship?',
      options: [
        { id: 'now', label: 'Ship now', description: 'Deploy today.' },
        { id: 'later', label: 'Ship later' },
      ],
    }];
    const opened = app.presentQuestion({ questions, timeoutMs: 300_000 });
    app.handleKey({ name: 'down' });
    app.handleKey({ name: 'up' });
    app.handleKey({ name: 'enter' });
    assert.equal(app.dialog, null, 'after one question is answered the dialog closes');
    const status = app.questionStatus(opened.questionId);
    assert.equal(status.status, 'answered');
    assert.equal(status.results[0].selectedOptions[0], 'now');
    assert.equal(status.results[0].selectedLabels[0], 'Ship now');
  } finally {
    store.close();
  }
});

test('the other option opens free-text input and submits it', async () => {
  const { app, store } = makeApp();
  try {
    const questions = [{
      id: 'route',
      question: 'How should this ship?',
      options: [{ id: 'now', label: 'Ship now' }],
    }];
    const opened = app.presentQuestion({ questions, timeoutMs: 300_000 });
    // Move to other row and open the editor.
    app.handleKey({ name: 'down' });
    app.handleKey({ name: 'enter' });
    assert.equal(app.dialog.otherOpen, true);
    for (const char of 'ship friday') app.handleKey({ name: 'text', text: char });
    app.handleKey({ name: 'enter' });
    const status = app.questionStatus(opened.questionId);
    assert.equal(status.status, 'answered');
    assert.equal(status.results[0].other, 'ship friday');
  } finally {
    store.close();
  }
});

test('a question that times out keeps the box visible with cleanup wording', () => {
  const { app, store } = makeApp();
  try {
    const questions = [{
      id: 'route',
      question: 'How should this ship?',
      options: [{ id: 'now', label: 'Ship now' }],
    }];
    const opened = app.presentQuestion({ questions, timeoutMs: 300_000 });
    app.expireQuestion(opened.questionId);
    const status = app.questionStatus(opened.questionId);
    assert.equal(status.status, 'timedOut');
    assert.equal(status.timedOut, true);
    assert.equal(app.dialog?.expired, true, 'the question box stays visible after timeout');
    const frame = app.render().map((line) => line.replace(/\u001b\[[0-9;]*m/g, '')).join('\n');
    assert.ok(frame.includes('timed out'));
    assert.ok(frame.includes('cancelling the task'));
    app.handleKey({ name: 'enter' });
    assert.equal(app.dialog, null, 'enter closes the expired box');
  } finally {
    store.close();
  }
});

test('a second question queues behind an open dialog and opens after it closes', () => {
  const { app, store } = makeApp();
  try {
    const q1 = app.presentQuestion({
      questions: [{ id: 'one', question: 'First?', options: [{ id: 'a', label: 'A' }] }],
      timeoutMs: 300_000,
    });
    const q2 = app.presentQuestion({
      questions: [{ id: 'two', question: 'Second?', options: [{ id: 'b', label: 'B' }] }],
      timeoutMs: 300_000,
    });
    assert.equal(app.dialog.questionId, q1.questionId);
    app.handleKey({ name: 'escape' });
    assert.equal(app.dialog.questionId, q2.questionId, 'queued question opens next');
    app.handleKey({ name: 'enter' });
    assert.equal(app.dialog, null);
    assert.equal(app.questionStatus(q2.questionId).status, 'answered');
  } finally {
    store.close();
  }
});

test('/version reports the current client version', () => {
  const { app, store } = makeApp();
  try {
    app.executeSlash('/version');
    assert.ok(app.dialog?.type === 'text');
    const body = app.dialog?.body?.join('') || '';
    assert.match(body, /0\.2\.0/);
  } finally {
    store.close();
  }
});
