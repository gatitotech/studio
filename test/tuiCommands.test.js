import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { App } from '../src/cli/tui.js';
import { openLocalStore } from '../src/cli/store.js';
import { executeSlashCommand } from '../src/cli/tui/commands.js';

const MODEL = {
  id: 'gatita-fast',
  name: 'Gatita Fast',
  description: 'fast model',
  available: true,
  tools: true,
  vision: true,
  reasoningLevels: ['off', 'low', 'max'],
  reasoningLocked: false,
  contextWindow: 131072,
  maxOutputTokens: 8192,
  requiredPlan: 'free',
  default: true,
};

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gatita-commands-'));
  const previous = process.env.GATITA_STUDIO_HOME;
  process.env.GATITA_STUDIO_HOME = home;
  return Promise.resolve()
    .then(() => fn(home))
    .finally(() => {
      if (previous === undefined) delete process.env.GATITA_STUDIO_HOME;
      else process.env.GATITA_STUDIO_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    });
}

function makeApp(home) {
  const store = openLocalStore(':memory:');
  const chat = store.createChat({ title: 'New chat', cwd: home, model: MODEL.id });
  const app = new App({
    config: {
      showReasoning: true,
      theme: 'dark',
      animations: false,
      computerUse: false,
      autoApprove: { edit: false, write: false, shell: false, web: true, computer: false },
      defaultModel: 'gatita-fast',
      lastChatId: chat.id,
      lastFolderId: null,
      serverUrl: 'https://example.invalid',
      maxSteps: 8,
      paths: { home },
    },
    client: {},
    me: { plan: { id: 'pro', displayName: 'Gatita Pro' }, quota: { windows: [] } },
    models: { data: [MODEL], defaultModel: 'gatita-fast' },
    store,
    args: ['--new'],
  });
  app.chat = chat;
  app.messages = store.listMessages(chat.id);
  app.terminal = { columns: 80, rows: 24, requestRender() {} };
  app.refreshSidebar = () => {};
  return { app, store, chat };
}

test('/reset with no banked resets warns instead of opening a dialog', async () => {
  await withHome(async (home) => {
    const { app, store } = makeApp(home);
    try {
      app.client = {
        usageResets: async () => ({ count: 0, nextExpiresAt: null, resets: [] }),
      };
      await executeSlashCommand(app, 'reset');
      assert.equal(app.dialog, null);
      assert.match(app.flash?.text || '', /no banked resets/i);
    } finally {
      store.close();
    }
  });
});

test('/reset consumes a banked reset after confirmation', async () => {
  await withHome(async (home) => {
    const { app, store } = makeApp(home);
    try {
      let consumed = 0;
      app.client = {
        usageResets: async () => ({ count: 2, nextExpiresAt: Date.now() + 86_400_000, resets: [{ id: 'b1' }, { id: 'b2' }] }),
        consumeReset: async () => { consumed += 1; return { bankedResets: { count: 1, nextExpiresAt: Date.now() + 86_400_000, resets: [{ id: 'b2' }] }, quota: { windows: [] } }; },
        me: async () => ({ plan: { id: 'pro', displayName: 'Gatita Pro' }, quota: { windows: [] } }),
      };
      await executeSlashCommand(app, 'reset');
      assert.equal(app.dialog?.type, 'confirm');
      app.handleKey({ name: 'text', text: 'y' });
      for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(consumed, 1);
      assert.match(app.flash?.text || '', /usage limits reset/i);
    } finally {
      store.close();
    }
  });
});

test('/admin reset all requires confirmation and posts the audience', async () => {
  await withHome(async (home) => {
    const { app, store } = makeApp(home);
    try {
      const posted = [];
      app.client = {
        adminCreateReset: async (body) => { posted.push(body); return { audience: body.audience, id: 'r1', createdAt: Date.now() }; },
      };
      await executeSlashCommand(app, 'admin', 'reset all quarterly refill');
      assert.equal(app.dialog?.type, 'confirm');
      app.handleKey({ name: 'text', text: 'y' });
      for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(posted, [{ audience: 'all', reason: 'quarterly refill' }]);
      assert.match(app.flash?.text || '', /usage reset/i);
    } finally {
      store.close();
    }
  });
});

test('/admin rejects a bare target instead of emailing the void', async () => {
  await withHome(async (home) => {
    const { app, store } = makeApp(home);
    try {
      app.client = {};
      await executeSlashCommand(app, 'admin', 'grant-reset notanemail');
      assert.match(app.flash?.text || '', /email/i);
    } finally {
      store.close();
    }
  });
});

test('/admin grant-reset by email grants the requested count', async () => {
  await withHome(async (home) => {
    const { app, store } = makeApp(home);
    try {
      const posted = [];
      app.client = {
        adminGrantResets: async (body) => { posted.push(body); return { granted: body.count, recipients: 1 }; },
      };
      await executeSlashCommand(app, 'admin', 'grant-reset pro@example.com 2 thanks');
      assert.deepEqual(posted, [{ email: 'pro@example.com', count: 2, reason: 'thanks' }]);
      assert.match(app.flash?.text || '', /granted 2/i);
    } finally {
      store.close();
    }
  });
});

test('slash commands switch model, reasoning, thinking and theme', async () => {
  await withHome(async (home) => {
    const { app, store } = makeApp(home);
    try {
      await executeSlashCommand(app, 'model', 'gatita-fast');
      assert.equal(app.modelId, 'gatita-fast');
      await executeSlashCommand(app, 'reasoning', 'max');
      assert.equal(app.reasoning, 'max');
      await executeSlashCommand(app, 'thinking', 'off');
      assert.equal(app.config.showReasoning, false);
      app.showWork = false;
      app.config.showWork = false;
      await executeSlashCommand(app, 'plan', '');
      assert.equal(app.mode, 'plan');
      assert.equal(app.config.mode, 'plan');
      await executeSlashCommand(app, 'build', '');
      assert.equal(app.mode, 'build');
      await executeSlashCommand(app, 'details', '');
      assert.equal(app.showWork, true);
      await executeSlashCommand(app, 'details', '');
      assert.equal(app.showWork, false);
      await executeSlashCommand(app, 'theme', 'paper');
      assert.equal(app.config.theme, 'paper');
      await executeSlashCommand(app, 'help', '');
      assert.equal(app.dialog.type, 'help');
      app.closeDialog();
    } finally {
      store.close();
    }
  });
});

test('slash commands create, rename and compact chats', async () => {
  await withHome(async (home) => {
    const { app, store } = makeApp(home);
    try {
      await executeSlashCommand(app, 'new', 'Fresh work');
      assert.equal(app.chat.title, 'Fresh work');
      assert.ok(store.recentChats(5).some((chat) => chat.title === 'Fresh work'));

      await executeSlashCommand(app, 'rename', 'Renamed work');
      assert.equal(app.chat.title, 'Renamed work');

      for (let index = 0; index < 14; index += 1) {
        store.addMessage(app.chat.id, {
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `message ${index}`,
        });
      }
      store.replaceTodos(app.chat.id, [{ content: 'keep me', status: 'pending', priority: 'high' }]);
      app.messages = store.listMessages(app.chat.id);
      const before = app.messages.length;
      await executeSlashCommand(app, 'compact', '');
      const after = store.listMessages(app.chat.id);
      assert.ok(after.length < before, 'compaction should remove messages');
      assert.equal(after[0].role, 'system');
      assert.match(after[0].content, /Summary of earlier conversation/);
      assert.equal(store.listTodos(app.chat.id)[0].content, 'keep me');
      assert.equal(app.messages.length, after.length);
    } finally {
      store.close();
    }
  });
});

test('slash commands attach images, move folders and open permissions', async () => {
  await withHome(async (home) => {
    const { app, store } = makeApp(home);
    try {
      const png = path.join(home, 'shot.png');
      fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
      await executeSlashCommand(app, 'image', png);
      assert.equal(app.pendingImages.length, 1);
      assert.match(app.pendingImages[0].dataUrl, /^data:image\/png;base64,/);
      await executeSlashCommand(app, 'image', 'clear');
      assert.equal(app.pendingImages.length, 0);

      const folder = store.createFolder({ name: 'Work', folderPath: home });
      app.folders = store.listFolders();
      await executeSlashCommand(app, 'folder', 'Work');
      assert.equal(store.getChat(app.chat.id).folderId, folder.id);

      await executeSlashCommand(app, 'permissions', '');
      assert.equal(app.dialog.type, 'permissions');
      app.closeDialog();

      await executeSlashCommand(app, 'computer', 'off');
      assert.equal(app.config.computerUse, false);
      await executeSlashCommand(app, 'cwd', home);
      assert.equal(app.cwd, path.resolve(home));
    } finally {
      store.close();
    }
  });
});

test('unknown commands leave a helpful warning', async () => {
  await withHome(async (home) => {
    const { app, store } = makeApp(home);
    try {
      await executeSlashCommand(app, 'modl', '');
      assert.match(app.flash.text, /Unknown command \/modl/);
      assert.match(app.flash.text, /\/help/);
    } finally {
      store.close();
    }
  });
});
