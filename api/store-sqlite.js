/**
 * 工单 SQLite 持久化
 * 与 store-json 接口兼容：getAllTickets/getTicketById/createTicket/updateTicket/addComment
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { normalizeCommentShape, buildCommentId, parseJsonArray } from './comment-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db = null;

function getDbPath() {
  return process.env.TICKETS_DB_PATH || path.join(__dirname, '..', 'data', 'tickets.db');
}

function getDb() {
  if (db) return db;
  const dbPath = getDbPath();
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function ensureColumn(database, tableName, columnName, columnDef) {
  const cols = database.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!cols.some((c) => c.name === columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
  }
}

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      assigned_agent TEXT,
      priority TEXT DEFAULT 'medium',
      session_key TEXT,
      run_id TEXT,
      created TEXT NOT NULL,
      last_update TEXT NOT NULL,
      result_summary TEXT,
      error TEXT,
      watchers_json TEXT DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS ticket_comments (
      id INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL,
      author TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'progress',
      visibility TEXT DEFAULT 'internal',
      thread_id TEXT,
      mentions_json TEXT DEFAULT '[]',
      notify_targets_json TEXT DEFAULT '[]',
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_assigned_agent ON tickets(assigned_agent);
    CREATE INDEX IF NOT EXISTS idx_tickets_last_update ON tickets(last_update);
    CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket_id ON ticket_comments(ticket_id);
  `);

  // 向后兼容老 schema
  ensureColumn(database, 'tickets', 'watchers_json', "TEXT DEFAULT '[]'");
  ensureColumn(database, 'ticket_comments', 'type', "TEXT DEFAULT 'progress'");
  ensureColumn(database, 'ticket_comments', 'visibility', "TEXT DEFAULT 'internal'");
  ensureColumn(database, 'ticket_comments', 'thread_id', 'TEXT');
  ensureColumn(database, 'ticket_comments', 'mentions_json', "TEXT DEFAULT '[]'");
  ensureColumn(database, 'ticket_comments', 'notify_targets_json', "TEXT DEFAULT '[]'");
}

function rowToTicket(row, comments = []) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    status: row.status,
    assigned_agent: row.assigned_agent,
    priority: row.priority ?? 'medium',
    session_key: row.session_key,
    run_id: row.run_id,
    created: row.created,
    last_update: row.last_update,
    result_summary: row.result_summary,
    error: row.error,
    watchers: parseJsonArray(row.watchers_json),
    comments: comments.map((c) => normalizeCommentShape(c)),
  };
}

function commentSelectSql() {
  return `SELECT id, author, timestamp, content, type, visibility, thread_id, mentions_json, notify_targets_json
          FROM ticket_comments WHERE ticket_id = ? ORDER BY id`;
}

export function getAllTickets() {
  const database = getDb();
  const rows = database.prepare('SELECT * FROM tickets ORDER BY id').all();
  const tickets = [];
  for (const row of rows) {
    const comments = database.prepare(commentSelectSql()).all(row.id);
    tickets.push(rowToTicket(row, comments));
  }
  return tickets;
}

export function getTicketById(id) {
  const database = getDb();
  const row = database.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(id));
  if (!row) return null;
  const comments = database.prepare(commentSelectSql()).all(row.id);
  return rowToTicket(row, comments);
}

export function createTicket(ticket) {
  const database = getDb();
  const now = new Date().toISOString();
  const stmt = database.prepare(`
    INSERT INTO tickets (title, description, status, assigned_agent, priority, session_key, run_id, created, last_update, result_summary, error, watchers_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    ticket.title ?? '',
    ticket.description ?? '',
    ticket.status ?? 'queued',
    ticket.assigned_agent ?? null,
    ticket.priority ?? 'medium',
    ticket.session_key ?? null,
    ticket.run_id ?? null,
    ticket.created ?? now,
    ticket.last_update ?? now,
    ticket.result_summary ?? null,
    ticket.error ?? null,
    JSON.stringify(Array.isArray(ticket.watchers) ? ticket.watchers : [])
  );
  const id = info.lastInsertRowid;
  const comments = ticket.comments || [];
  if (comments.length > 0) {
    const insertComment = database.prepare(
      `INSERT INTO ticket_comments
      (id, ticket_id, author, timestamp, content, type, visibility, thread_id, mentions_json, notify_targets_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertMany = database.transaction((items) => {
      for (const c of items) {
        insertComment.run(
          c.id ?? Date.now(),
          id,
          c.author ?? '',
          c.timestamp ?? now,
          c.content ?? '',
          c.type ?? 'progress',
          c.visibility ?? 'internal',
          c.thread_id ?? null,
          JSON.stringify(Array.isArray(c.mentions) ? c.mentions : []),
          JSON.stringify(Array.isArray(c.notify_targets) ? c.notify_targets : [])
        );
      }
    });
    insertMany(comments);
  }
  return getTicketById(id);
}

export function updateTicket(id, updates) {
  const database = getDb();
  const existing = database.prepare('SELECT id FROM tickets WHERE id = ?').get(Number(id));
  if (!existing) return null;
  const now = new Date().toISOString();
  const allowed = [
    'title', 'description', 'status', 'assigned_agent', 'priority',
    'session_key', 'run_id', 'result_summary', 'error', 'last_update'
  ];
  const setParts = [];
  const values = [];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      setParts.push(`${key} = ?`);
      values.push(updates[key]);
    }
  }
  if (updates.watchers !== undefined) {
    setParts.push('watchers_json = ?');
    values.push(JSON.stringify(Array.isArray(updates.watchers) ? updates.watchers : []));
  }
  if (setParts.length === 0) return getTicketById(id);
  if (!setParts.includes('last_update = ?')) {
    setParts.push('last_update = ?');
    values.push(now);
  }
  values.push(Number(id));
  database.prepare(`UPDATE tickets SET ${setParts.join(', ')} WHERE id = ?`).run(...values);
  return getTicketById(id);
}

/** 仅用于测试：清空所有数据 */
export function clearAllForTesting() {
  const database = getDb();
  database.exec('DELETE FROM ticket_comments; DELETE FROM tickets;');
}

/** 仅用于测试：关闭并重置 db，下次 getDb 将按当前 TICKETS_DB_PATH 重建 */
export function _resetDbForTesting() {
  if (db) {
    db.close();
    db = null;
  }
}

export function addComment(ticketId, comment) {
  const database = getDb();
  const ticket = database.prepare('SELECT id FROM tickets WHERE id = ?').get(Number(ticketId));
  if (!ticket) return null;

  const normalized = normalizeCommentShape(comment);
  const now = new Date().toISOString();

  const insert = database.prepare(
    `INSERT INTO ticket_comments
    (id, ticket_id, author, timestamp, content, type, visibility, thread_id, mentions_json, notify_targets_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    const nextId = i === 0 && normalized.id ? normalized.id : buildCommentId();
    try {
      insert.run(
        nextId,
        ticket.id,
        normalized.author,
        normalized.timestamp || now,
        normalized.content,
        normalized.type,
        normalized.visibility,
        normalized.thread_id,
        JSON.stringify(normalized.mentions),
        JSON.stringify(normalized.notify_targets)
      );
      database.prepare('UPDATE tickets SET last_update = ? WHERE id = ?').run(now, ticket.id);
      return getTicketById(ticketId);
    } catch (err) {
      lastErr = err;
      const message = String(err?.message || '');
      if (!message.includes('UNIQUE constraint failed: ticket_comments.id')) {
        throw err;
      }
    }
  }

  throw lastErr || new Error('failed to insert comment');
}
