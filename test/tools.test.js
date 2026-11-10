import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLocalStore } from '../src/cli/store.js';
import { createToolRegistry } from '../src/tools/index.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatita-studio-tools-'));
  const store = openLocalStore(':memory:');
  const chat = store.createChat({ title: 'tools', cwd: dir });
  const config = {
    autoApprove: { read: true, search: true, todo: true, edit: false, write: false, shell: false, web: true, computer: false },
    shellTimeoutMs: 15_000,
    computerUse: false,
  };
  const registry = createToolRegistry({ cwd: dir, config, store, chatId: chat.id });
  return {
    dir,
    store,
    chat,
    registry,
    cleanup() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('file tools write, read, edit, glob, grep and ls inside the workspace', async () => {
  const f = fixture();
  try {
    let result = await f.registry.execute('write', { path: 'src/a.js', content: 'const x = 1;\nconsole.log(x);\n' });
    assert.equal(result.ok, true, result.output);
    assert.equal(fs.readFileSync(path.join(f.dir, 'src', 'a.js'), 'utf8').includes('const x = 1;'), true);

    result = await f.registry.execute('read', { path: 'src/a.js' });
    assert.equal(result.ok, true);
    assert.match(result.output, /1\| const x = 1;/);

    result = await f.registry.execute('edit', { path: 'src/a.js', oldString: 'const x = 1;', newString: 'const x = 2;' });
    assert.equal(result.ok, true, result.output);
    assert.match(fs.readFileSync(path.join(f.dir, 'src', 'a.js'), 'utf8'), /const x = 2;/);

    result = await f.registry.execute('edit', { path: 'src/a.js', oldString: 'missing', newString: 'x' });
    assert.equal(result.ok, false);
    assert.match(result.output, /not found/i);

    result = await f.registry.execute('glob', { pattern: '**/*.js' });
    assert.equal(result.ok, true);
    assert.match(result.output, /src\/a\.js/);

    result = await f.registry.execute('grep', { pattern: 'console\\.log', include: '**/*.js' });
    assert.equal(result.ok, true);
    assert.match(result.output, /a\.js:2/);

    result = await f.registry.execute('ls', { path: 'src' });
    assert.equal(result.ok, true);
    assert.match(result.output, /a\.js/);
  } finally {
    f.cleanup();
  }
});

test('write requires approval metadata and todos persist', async () => {
  const f = fixture();
  try {
    const writeTool = f.registry.get('write');
    assert.equal(f.registry.needsApproval(writeTool), true);
    assert.equal(f.registry.needsApproval(f.registry.get('read')), false);

    const result = await f.registry.execute('todo', {
      todos: [
        { content: 'Read the code', status: 'completed' },
        { content: 'Write the test', status: 'in_progress', priority: 'high' },
      ],
    });
    assert.equal(result.ok, true);
    assert.match(result.output, /\[x\] Read the code/);
    assert.equal(f.store.listTodos(f.chat.id).length, 2);
  } finally {
    f.cleanup();
  }
});

test('bash runs commands and reports the exit code', async () => {
  const f = fixture();
  try {
    let result = await f.registry.execute('bash', { command: 'echo hello-gatita' });
    assert.equal(result.ok, true, result.output);
    assert.match(result.output, /hello-gatita/);
    assert.match(result.output, /exit 0/);

    result = await f.registry.execute('bash', { command: 'exit 3' });
    assert.equal(result.ok, false);
    assert.match(result.output, /exit 3/);
  } finally {
    f.cleanup();
  }
});

test('credential files are blocked from the agent', async () => {
  const f = fixture();
  try {
    const fake = path.join(f.dir, '.gatita-studio', 'auth.json');
    fs.mkdirSync(path.dirname(fake), { recursive: true });
    fs.writeFileSync(fake, '{"token":"secret"}');
    const result = await f.registry.execute('read', { path: '.gatita-studio/auth.json' });
    assert.equal(result.ok, false);
    assert.match(result.output, /credentials/i);
  } finally {
    f.cleanup();
  }
});
