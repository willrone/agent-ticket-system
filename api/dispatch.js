/**
 * Dispatch 和 Notification 事件管理
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getDbPath() {
  return process.env.TICKETS_DB_PATH || path.join(__dirname, '..', 'data', 'tickets.db');
}

let db = null;
function getDb() {
  if (db) return db;
  db = new Database(getDbPath());
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      agent TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      acked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS notification_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      acked_at TEXT
    );
  `);
  return db;
}

/**
 * 测试用：关闭连接，便于下次 getDb 时重建（配合 store _resetDbForTesting 使用）
 */
export function _resetDbForTesting() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * 记录派单事件
 */
export function recordDispatchEvent(ticketId, agent, status) {
  const database = getDb();
  const now = new Date().toISOString();
  const stmt = database.prepare(`
    INSERT INTO dispatch_events (ticket_id, agent, status, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const info = stmt.run(ticketId, agent, status, now);
  return info.lastInsertRowid;
}

/**
 * 确认派单事件
 */
export function ackDispatchEvent(dispatchId) {
  const database = getDb();
  const now = new Date().toISOString();
  const stmt = database.prepare(`
    UPDATE dispatch_events SET acked_at = ? WHERE id = ?
  `);
  const info = stmt.run(now, dispatchId);
  return info.changes > 0;
}

/**
 * 检查工单是否已派发给指定 agent（仅检查已 ack 的事件）
 * 去重键：ticket_id + agent + status（不同状态不互相抑制）
 * 未 ack 的事件不做去重，允许重新进入 ready
 */
export function hasRecentDispatch(ticketId, agent, status, withinMinutes = 60) {
  const database = getDb();
  const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
  const row = database.prepare(`
    SELECT id FROM dispatch_events
    WHERE ticket_id = ? AND agent = ? AND status = ? 
      AND acked_at IS NOT NULL
      AND datetime(created_at) > datetime(?)
    ORDER BY created_at DESC LIMIT 1
  `).get(ticketId, agent, status, cutoff);
  return Boolean(row);
}

/**
 * 获取未 ack 的派单事件（用于复用）
 */
export function getUnackedDispatchEvent(ticketId, agent, status) {
  const database = getDb();
  const row = database.prepare(`
    SELECT id FROM dispatch_events
    WHERE ticket_id = ? AND agent = ? AND status = ? AND acked_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(ticketId, agent, status);
  return row ? row.id : null;
}

/**
 * 记录通知事件
 */
export function recordNotificationEvent(ticketId, eventType, status) {
  const database = getDb();
  const now = new Date().toISOString();
  const stmt = database.prepare(`
    INSERT INTO notification_events (ticket_id, event_type, status, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const info = stmt.run(ticketId, eventType, status, now);
  return info.lastInsertRowid;
}

/**
 * 获取未 ack 的通知事件（用于复用）
 */
export function getUnackedNotificationEvent(ticketId, eventType, status) {
  const database = getDb();
  const row = database.prepare(`
    SELECT id FROM notification_events
    WHERE ticket_id = ? AND event_type = ? AND status = ? AND acked_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(ticketId, eventType, status);
  return row ? row.id : null;
}

/**
 * 确认通知事件
 */
export function ackNotificationEvent(eventId) {
  const database = getDb();
  const now = new Date().toISOString();
  const stmt = database.prepare(`
    UPDATE notification_events SET acked_at = ? WHERE id = ?
  `);
  const info = stmt.run(now, eventId);
  return info.changes > 0;
}

/**
 * 检查工单是否已通知（仅检查已 ack 的事件）
 * 未 ack 的事件不做去重，允许重新进入 ready
 */
export function hasRecentNotification(ticketId, eventType, withinMinutes = 60) {
  const database = getDb();
  const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
  const row = database.prepare(`
    SELECT id FROM notification_events
    WHERE ticket_id = ? AND event_type = ? 
      AND acked_at IS NOT NULL
      AND datetime(created_at) > datetime(?)
    ORDER BY created_at DESC LIMIT 1
  `).get(ticketId, eventType, cutoff);
  return Boolean(row);
}
