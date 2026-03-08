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
      triage_owner TEXT,
      assigned_agent TEXT,
      next_actor TEXT,
      priority TEXT DEFAULT 'medium',
      platform TEXT,
      request_type TEXT,
      triage_summary TEXT,
      implementation_scope TEXT,
      constraints_text TEXT,
      deliverables TEXT,
      acceptance_criteria TEXT,
      parent_ticket_id INTEGER,
      session_key TEXT,
      run_id TEXT,
      created TEXT NOT NULL,
      last_update TEXT NOT NULL,
      result_summary TEXT,
      error TEXT,
      watchers_json TEXT DEFAULT '[]',
      FOREIGN KEY (parent_ticket_id) REFERENCES tickets(id) ON DELETE SET NULL
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
    CREATE TABLE IF NOT EXISTS ticket_dependencies (
      ticket_id INTEGER NOT NULL,
      depends_on_ticket_id INTEGER NOT NULL,
      dependency_type TEXT NOT NULL DEFAULT 'blocks',
      created_at TEXT NOT NULL,
      PRIMARY KEY (ticket_id, depends_on_ticket_id),
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (depends_on_ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );
  `);

  // 向后兼容老 schema：先补列，再建依赖这些列的索引
  ensureColumn(database, 'tickets', 'watchers_json', "TEXT DEFAULT '[]'");
  ensureColumn(database, 'tickets', 'triage_owner', 'TEXT');
  ensureColumn(database, 'tickets', 'review_owner', 'TEXT');
  ensureColumn(database, 'tickets', 'next_actor', 'TEXT');
  ensureColumn(database, 'tickets', 'platform', 'TEXT');
  ensureColumn(database, 'tickets', 'request_type', 'TEXT');
  ensureColumn(database, 'tickets', 'triage_summary', 'TEXT');
  ensureColumn(database, 'tickets', 'implementation_scope', 'TEXT');
  ensureColumn(database, 'tickets', 'constraints_text', 'TEXT');
  ensureColumn(database, 'tickets', 'deliverables', 'TEXT');
  ensureColumn(database, 'tickets', 'acceptance_criteria', 'TEXT');
  ensureColumn(database, 'tickets', 'parent_ticket_id', 'INTEGER');
  ensureColumn(database, 'tickets', 'decision_owner', 'TEXT');
  ensureColumn(database, 'tickets', 'decision_summary', 'TEXT');
  ensureColumn(database, 'tickets', 'decision_context', 'TEXT');
  ensureColumn(database, 'ticket_comments', 'type', "TEXT DEFAULT 'progress'");
  ensureColumn(database, 'ticket_comments', 'visibility', "TEXT DEFAULT 'internal'");
  ensureColumn(database, 'ticket_comments', 'thread_id', 'TEXT');
  ensureColumn(database, 'ticket_comments', 'mentions_json', "TEXT DEFAULT '[]'");
  ensureColumn(database, 'ticket_comments', 'notify_targets_json', "TEXT DEFAULT '[]'");

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_triage_owner ON tickets(triage_owner);
    CREATE INDEX IF NOT EXISTS idx_tickets_assigned_agent ON tickets(assigned_agent);
    CREATE INDEX IF NOT EXISTS idx_tickets_next_actor ON tickets(next_actor);
    CREATE INDEX IF NOT EXISTS idx_tickets_last_update ON tickets(last_update);
    CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket_id ON ticket_comments(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_deps_ticket_id ON ticket_dependencies(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_deps_depends_on ON ticket_dependencies(depends_on_ticket_id);
  `);
}

function summarizeTicketRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    assigned_agent: row.assigned_agent,
  };
}

function rowToTicket(row, comments = [], relations = {}) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    status: row.status,
    triage_owner: row.triage_owner ?? null,
    review_owner: row.review_owner ?? null,
    decision_owner: row.decision_owner ?? null,
    decision_summary: row.decision_summary ?? null,
    decision_context: row.decision_context ?? null,
    assigned_agent: row.assigned_agent,
    next_actor: row.next_actor ?? null,
    priority: row.priority ?? 'medium',
    platform: row.platform ?? null,
    request_type: row.request_type ?? null,
    triage_summary: row.triage_summary ?? '',
    implementation_scope: row.implementation_scope ?? '',
    constraints: row.constraints_text ?? '',
    deliverables: row.deliverables ?? '',
    acceptance_criteria: row.acceptance_criteria ?? '',
    parent_ticket_id: row.parent_ticket_id ?? null,
    parent_ticket: relations.parent_ticket ?? null,
    child_tickets: Array.isArray(relations.child_tickets) ? relations.child_tickets : [],
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
  const parentRow = row.parent_ticket_id
    ? database.prepare('SELECT id, title, status, assigned_agent FROM tickets WHERE id = ?').get(row.parent_ticket_id)
    : null;
  const childRows = database.prepare(
    'SELECT id, title, status, assigned_agent FROM tickets WHERE parent_ticket_id = ? ORDER BY id'
  ).all(row.id);
  return rowToTicket(row, comments, {
    parent_ticket: summarizeTicketRow(parentRow),
    child_tickets: childRows.map((child) => summarizeTicketRow(child)),
  });
}

export function createTicket(ticket) {
  const database = getDb();
  const now = new Date().toISOString();
  const stmt = database.prepare(`
    INSERT INTO tickets (
      title,
      description,
      status,
      triage_owner,
      review_owner,
      decision_owner,
      decision_summary,
      decision_context,
      assigned_agent,
      next_actor,
      priority,
      platform,
      request_type,
      triage_summary,
      implementation_scope,
      constraints_text,
      deliverables,
      acceptance_criteria,
      parent_ticket_id,
      session_key,
      run_id,
      created,
      last_update,
      result_summary,
      error,
      watchers_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    ticket.title ?? '',
    ticket.description ?? '',
    ticket.status ?? 'queued',
    ticket.triage_owner ?? null,
    ticket.review_owner ?? null,
    ticket.decision_owner ?? null,
    ticket.decision_summary ?? null,
    ticket.decision_context ?? null,
    ticket.assigned_agent ?? null,
    ticket.next_actor ?? null,
    ticket.priority ?? 'medium',
    ticket.platform ?? null,
    ticket.request_type ?? null,
    ticket.triage_summary ?? '',
    ticket.implementation_scope ?? '',
    ticket.constraints ?? '',
    ticket.deliverables ?? '',
    ticket.acceptance_criteria ?? '',
    ticket.parent_ticket_id ?? null,
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
  const directAllowed = [
    'title', 'description', 'status', 'triage_owner', 'review_owner', 'decision_owner', 'decision_summary', 'decision_context', 'assigned_agent', 'next_actor', 'priority',
    'platform', 'request_type', 'triage_summary', 'implementation_scope',
    'deliverables', 'acceptance_criteria', 'parent_ticket_id',
    'session_key', 'run_id', 'result_summary', 'error', 'last_update'
  ];
  const mappedAllowed = {
    constraints: 'constraints_text',
  };
  const setParts = [];
  const values = [];
  for (const key of directAllowed) {
    if (updates[key] !== undefined) {
      setParts.push(`${key} = ?`);
      values.push(updates[key]);
    }
  }
  for (const [inputKey, columnName] of Object.entries(mappedAllowed)) {
    if (updates[inputKey] !== undefined) {
      setParts.push(`${columnName} = ?`);
      values.push(updates[inputKey]);
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

export function deleteTicket(id) {
  const database = getDb();
  const ticket = database.prepare('SELECT id FROM tickets WHERE id = ?').get(Number(id));
  if (!ticket) return false;
  database.prepare('DELETE FROM tickets WHERE id = ?').run(Number(id));
  return true;
}

export function deleteTickets(ids) {
  const database = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const stmt = database.prepare(`DELETE FROM tickets WHERE id IN (${placeholders})`);
  const info = stmt.run(...ids.map(Number));
  return info.changes;
}

// 依赖关系管理
export function addDependency(ticketId, dependsOnTicketId, dependencyType = 'blocks') {
  const database = getDb();
  const now = new Date().toISOString();
  
  try {
    database.prepare(`
      INSERT INTO ticket_dependencies (ticket_id, depends_on_ticket_id, dependency_type, created_at)
      VALUES (?, ?, ?, ?)
    `).run(ticketId, dependsOnTicketId, dependencyType, now);
    return true;
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return false; // 依赖关系已存在
    }
    throw err;
  }
}

export function removeDependency(ticketId, dependsOnTicketId) {
  const database = getDb();
  const info = database.prepare(`
    DELETE FROM ticket_dependencies 
    WHERE ticket_id = ? AND depends_on_ticket_id = ?
  `).run(ticketId, dependsOnTicketId);
  return info.changes > 0;
}

export function getDependencies(ticketId) {
  const database = getDb();
  return database.prepare(`
    SELECT d.*, t.title, t.status 
    FROM ticket_dependencies d
    JOIN tickets t ON d.depends_on_ticket_id = t.id
    WHERE d.ticket_id = ?
  `).all(ticketId);
}

export function getDependents(ticketId) {
  const database = getDb();
  return database.prepare(`
    SELECT d.*, t.title, t.status 
    FROM ticket_dependencies d
    JOIN tickets t ON d.ticket_id = t.id
    WHERE d.depends_on_ticket_id = ?
  `).all(ticketId);
}

export function hasUnmetDependencies(ticketId) {
  const database = getDb();
  const deps = database.prepare(`
    SELECT COUNT(*) as count
    FROM ticket_dependencies d
    JOIN tickets t ON d.depends_on_ticket_id = t.id
    WHERE d.ticket_id = ? AND t.status NOT IN ('complete', 'done')
  `).get(ticketId);
  return deps.count > 0;
}
