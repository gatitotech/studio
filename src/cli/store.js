import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomId } from '../shared/util.js';

export const LOCAL_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  folder_id TEXT,
  title TEXT NOT NULL DEFAULT 'New chat',
  model TEXT NOT NULL DEFAULT 'gatita-fast',
  reasoning TEXT NOT NULL DEFAULT 'off',
  cwd TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,
  FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_folder ON chats(folder_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  reasoning TEXT,
  tool_calls_json TEXT,
  tool_call_id TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  meta_json TEXT,
  FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, seq);

CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','cancelled')),
  priority TEXT NOT NULL DEFAULT 'medium',
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_todos_chat ON todos(chat_id, seq);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_snapshots_chat ON snapshots(chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export const LIMITS = {
  title: 80,
  folderName: 60,
  messageChars: 2_000_000,
  snapshotsPerChat: 200,
  messagesPerChat: 2000,
};

export function openLocalStore(filePath) {
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    db.exec('PRAGMA journal_mode = WAL');
  } catch {
    // Fall back to the default journal.
  }
  db.exec('PRAGMA synchronous = NORMAL');
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (version < LOCAL_SCHEMA_VERSION) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${LOCAL_SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore.
      }
      throw error;
    }
  }
  return createStore(db);
}

export function createStore(db) {
  let lastTick = 0;
  const now = () => {
    const time = Date.now();
    lastTick = time > lastTick ? time : lastTick + 1;
    return lastTick;
  };

  const store = {
    db,

    close() {
      try {
        db.close();
      } catch {
        // Already closed.
      }
    },

    getSetting(key, fallback = null) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : fallback;
    },

    setSetting(key, value) {
      db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(String(key), String(value), now());
    },

    createFolder({ name, folderPath = '' }) {
      const id = randomId('fld');
      const time = now();
      const order = Number(db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM folders').get()?.n || 1);
      db.prepare(`
        INSERT INTO folders (id, name, path, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, String(name || 'Folder').slice(0, LIMITS.folderName), String(folderPath || ''), order, time, time);
      return store.getFolder(id);
    },

    getFolder(id) {
      const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(String(id));
      return row ? mapFolder(row) : null;
    },

    listFolders() {
      return db.prepare(`
        SELECT f.*, (SELECT COUNT(*) FROM chats c WHERE c.folder_id = f.id AND c.archived = 0) AS chat_count
        FROM folders f ORDER BY f.sort_order ASC, f.created_at ASC
      `).all().map(mapFolder);
    },

    renameFolder(id, name) {
      db.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?')
        .run(String(name || 'Folder').slice(0, LIMITS.folderName), now(), String(id));
      return store.getFolder(id);
    },

    deleteFolder(id) {
      db.prepare('DELETE FROM folders WHERE id = ?').run(String(id));
      return true;
    },

    createChat({ folderId = null, title = 'New chat', model = 'gatita-fast', reasoning = 'off', cwd = '' }) {
      const id = randomId('chat');
      const time = now();
      db.prepare(`
        INSERT INTO chats (id, folder_id, title, model, reasoning, cwd, created_at, updated_at, archived, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
      `).run(id, folderId || null, String(title).slice(0, LIMITS.title), String(model), String(reasoning), String(cwd || ''), time, time);
      return store.getChat(id);
    },

    getChat(id) {
      const row = db.prepare('SELECT * FROM chats WHERE id = ?').get(String(id));
      return row ? mapChat(row) : null;
    },

    findChat(idOrPrefix) {
      const text = String(idOrPrefix || '').trim();
      if (!text) return null;
      const exact = store.getChat(text);
      if (exact) return exact;
      if (text.length < 3) return null;
      const rows = db.prepare('SELECT * FROM chats WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 2').all(`${text}%`);
      return rows.length === 1 ? mapChat(rows[0]) : null;
    },

    listChats({ folderId, search = '', limit = 50, includeArchived = false } = {}) {
      const clauses = [];
      const params = [];
      if (!includeArchived) clauses.push('archived = 0');
      if (folderId === null) clauses.push('folder_id IS NULL');
      else if (folderId !== undefined) {
        clauses.push('folder_id = ?');
        params.push(String(folderId));
      }
      const query = String(search || '').trim().toLowerCase();
      if (query) {
        clauses.push('lower(title) LIKE ?');
        params.push(`%${query.replace(/[%_]/g, '')}%`);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return db.prepare(`
        SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count
        FROM chats c ${where}
        ORDER BY c.updated_at DESC LIMIT ?
      `).all(...params, Math.max(1, Math.min(500, Number(limit) || 50))).map(mapChat);
    },

    recentChats(limit = 20) {
      return db.prepare(`
        SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count
        FROM chats c WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?
      `).all(Math.max(1, Number(limit) || 20)).map(mapChat);
    },

    renameChat(id, title) {
      db.prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?')
        .run(String(title || 'New chat').slice(0, LIMITS.title), now(), String(id));
      return store.getChat(id);
    },

    updateChat(id, patch = {}) {
      const chat = store.getChat(id);
      if (!chat) return null;
      const model = patch.model !== undefined ? String(patch.model) : chat.model;
      const reasoning = patch.reasoning !== undefined ? String(patch.reasoning) : chat.reasoning;
      const folderId = patch.folderId !== undefined ? patch.folderId : chat.folderId;
      const cwd = patch.cwd !== undefined ? String(patch.cwd) : chat.cwd;
      const archived = patch.archived !== undefined ? (patch.archived ? 1 : 0) : (chat.archived ? 1 : 0);
      db.prepare(`
        UPDATE chats SET model = ?, reasoning = ?, folder_id = ?, cwd = ?, archived = ?, updated_at = ? WHERE id = ?
      `).run(model, reasoning, folderId || null, cwd, archived, now(), String(id));
      return store.getChat(id);
    },

    touchChat(id) {
      db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now(), String(id));
    },

    deleteChat(id) {
      db.prepare('DELETE FROM chats WHERE id = ?').run(String(id));
      return true;
    },

    addMessage(chatId, message) {
      const seq = Number(db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE chat_id = ?').get(String(chatId))?.n || 1);
      const id = message.id || randomId('msg');
      db.prepare(`
        INSERT INTO messages (id, chat_id, role, content, reasoning, tool_calls_json, tool_call_id, name, created_at, seq, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        String(chatId),
        String(message.role),
        message.content == null ? null : String(message.content).slice(0, LIMITS.messageChars),
        message.reasoning == null ? null : String(message.reasoning),
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.toolCallId || null,
        message.name || null,
        Number(message.createdAt) || now(),
        seq,
        message.meta ? JSON.stringify(message.meta) : null,
      );
      db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now(), String(chatId));
      return { ...message, id, seq };
    },

    listMessages(chatId, { limit = LIMITS.messagesPerChat } = {}) {
      return db.prepare(`
        SELECT * FROM messages WHERE chat_id = ? ORDER BY seq ASC LIMIT ?
      `).all(String(chatId), Math.max(1, Number(limit) || LIMITS.messagesPerChat)).map(mapMessage);
    },

    deleteMessages(chatId) {
      db.prepare('DELETE FROM messages WHERE chat_id = ?').run(String(chatId));
      db.prepare('DELETE FROM todos WHERE chat_id = ?').run(String(chatId));
      db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now(), String(chatId));
    },

    replaceTodos(chatId, items) {
      const time = now();
      db.prepare('DELETE FROM todos WHERE chat_id = ?').run(String(chatId));
      const insert = db.prepare(`
        INSERT INTO todos (id, chat_id, content, status, priority, seq, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      items.forEach((item, index) => {
        const status = ['pending', 'in_progress', 'completed', 'cancelled'].includes(item.status) ? item.status : 'pending';
        insert.run(
          randomId('todo'),
          String(chatId),
          String(item.content || '').slice(0, 500),
          status,
          String(item.priority || 'medium'),
          index + 1,
          time,
          time,
        );
      });
      return store.listTodos(chatId);
    },

    listTodos(chatId) {
      return db.prepare('SELECT * FROM todos WHERE chat_id = ? ORDER BY seq ASC').all(String(chatId)).map((row) => ({
        id: row.id,
        content: row.content,
        status: row.status,
        priority: row.priority,
      }));
    },

    saveSnapshot(chatId, filePath, content) {
      const id = randomId('snap');
      db.prepare(`
        INSERT INTO snapshots (id, chat_id, file_path, content, created_at) VALUES (?, ?, ?, ?, ?)
      `).run(id, String(chatId), String(filePath), String(content), now());
      const count = Number(db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE chat_id = ?').get(String(chatId))?.n || 0);
      if (count > LIMITS.snapshotsPerChat) {
        db.prepare(`
          DELETE FROM snapshots WHERE id IN (
            SELECT id FROM snapshots WHERE chat_id = ? ORDER BY created_at ASC LIMIT ?
          )
        `).run(String(chatId), count - LIMITS.snapshotsPerChat);
      }
      return id;
    },

    latestSnapshot(chatId, filePath) {
      const row = db.prepare(`
        SELECT * FROM snapshots WHERE chat_id = ? AND file_path = ? ORDER BY created_at DESC LIMIT 1
      `).get(String(chatId), String(filePath));
      return row ? { id: row.id, filePath: row.file_path, content: row.content, createdAt: Number(row.created_at) } : null;
    },
  };

  return store;
}

function mapFolder(row) {
  return {
    id: row.id,
    name: row.name,
    path: row.path || '',
    sortOrder: Number(row.sort_order || 0),
    chatCount: Number(row.chat_count || 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapChat(row) {
  return {
    id: row.id,
    folderId: row.folder_id || null,
    title: row.title,
    model: row.model,
    reasoning: row.reasoning,
    cwd: row.cwd || '',
    archived: Boolean(row.archived),
    messageCount: Number(row.message_count || 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    meta: row.meta_json ? JSON.parse(row.meta_json) : null,
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    content: row.content,
    reasoning: row.reasoning || '',
    toolCalls: row.tool_calls_json ? JSON.parse(row.tool_calls_json) : null,
    toolCallId: row.tool_call_id || null,
    name: row.name || null,
    createdAt: Number(row.created_at),
    seq: Number(row.seq),
    meta: row.meta_json ? JSON.parse(row.meta_json) : null,
  };
}
