#!/usr/bin/env node
/**
 * 将 data/tickets.json 幂等迁移到 data/tickets.db
 * - 迁移前自动备份 tickets.json 为 tickets.json.bak
 * - 支持重复执行，按 id upsert 不重复导入
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const JSON_PATH = process.env.TICKETS_JSON_PATH || path.join(DATA_DIR, 'tickets.json');
const DB_PATH = process.env.TICKETS_DB_PATH || path.join(DATA_DIR, 'tickets.db');
const BAK_PATH = JSON_PATH + '.bak';

function backupJson() {
  if (!fs.existsSync(JSON_PATH)) {
    console.log('[migrate] tickets.json 不存在，跳过备份');
    return;
  }
  fs.copyFileSync(JSON_PATH, BAK_PATH);
  console.log(`[migrate] 已备份至 ${BAK_PATH}`);
}

function loadJson() {
  if (!fs.existsSync(JSON_PATH)) {
    return [];
  }
  const raw = fs.readFileSync(JSON_PATH, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error('tickets.json 格式错误：应为数组');
  }
  return data;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY,
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
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS ticket_comments (
      id INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL,
      author TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      content TEXT NOT NULL,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_assigned_agent ON tickets(assigned_agent);
    CREATE INDEX IF NOT EXISTS idx_tickets_last_update ON tickets(last_update);
    CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket_id ON ticket_comments(ticket_id);
  `);
}

function migrate() {
  const tickets = loadJson();
  if (tickets.length === 0) {
    console.log('[migrate] tickets.json 为空，无需迁移');
    return;
  }

  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);

  const insertTicket = db.prepare(`
    INSERT INTO tickets (id, title, description, status, assigned_agent, priority, session_key, run_id, created, last_update, result_summary, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, description=excluded.description, status=excluded.status,
      assigned_agent=excluded.assigned_agent, priority=excluded.priority,
      session_key=excluded.session_key, run_id=excluded.run_id,
      created=excluded.created, last_update=excluded.last_update,
      result_summary=excluded.result_summary, error=excluded.error
  `);

  const insertComment = db.prepare(`
    INSERT INTO ticket_comments (id, ticket_id, author, timestamp, content)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);

  const deleteComments = db.prepare('DELETE FROM ticket_comments WHERE ticket_id = ?');

  const run = db.transaction(() => {
    for (const t of tickets) {
      insertTicket.run(
        t.id,
        t.title ?? '',
        t.description ?? '',
        t.status ?? 'queued',
        t.assigned_agent ?? null,
        t.priority ?? 'medium',
        t.session_key ?? null,
        t.run_id ?? null,
        t.created ?? new Date().toISOString(),
        t.last_update ?? new Date().toISOString(),
        t.result_summary ?? null,
        t.error ?? null
      );
      deleteComments.run(t.id);
      for (const c of t.comments || []) {
        insertComment.run(
          c.id,
          t.id,
          c.author ?? '',
          c.timestamp ?? '',
          c.content ?? ''
        );
      }
    }
  });

  run();
  db.close();
  console.log(`[migrate] 已迁移 ${tickets.length} 条工单至 ${DB_PATH}`);
}

function main() {
  try {
    backupJson();
    migrate();
  } catch (err) {
    console.error('[migrate] 失败:', err.message);
    process.exit(1);
  }
}

main();
