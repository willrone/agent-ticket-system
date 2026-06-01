/**
 * Dispatch 和 Notification 事件管理
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import * as store from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DISPATCH_RECEIPT_TIMEOUT_MS = parsePositiveInt(process.env.TICKET_DISPATCH_RECEIPT_TIMEOUT_MS, 10 * 60 * 1000);
const DEFAULT_DISPATCH_DELIVERY_RETRY_BASE_MS = parsePositiveInt(process.env.TICKET_DISPATCH_DELIVERY_RETRY_BASE_MS, 30 * 1000);
const DEFAULT_DISPATCH_DELIVERY_RETRY_MAX_MS = parsePositiveInt(process.env.TICKET_DISPATCH_DELIVERY_RETRY_MAX_MS, 15 * 60 * 1000);

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toIsoAfter(ms, base = Date.now()) {
  return new Date(base + ms).toISOString();
}

function computeDispatchDeliveryRetryDelayMs(nextRetryCount) {
  const normalizedRetryCount = Math.max(1, Number.parseInt(String(nextRetryCount ?? 1), 10) || 1);
  const exponent = Math.max(0, normalizedRetryCount - 1);
  return Math.min(DEFAULT_DISPATCH_DELIVERY_RETRY_BASE_MS * (2 ** exponent), DEFAULT_DISPATCH_DELIVERY_RETRY_MAX_MS);
}

function ensureColumn(database, tableName, columnName, definitionSql) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
  }
}

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
      acked_at TEXT,
      awaiting_receipt_from TEXT,
      ack_deadline_at TEXT,
      retry_count INTEGER DEFAULT 0,
      next_retry_at TEXT,
      receipt_received_at TEXT,
      receipt_decision TEXT,
      receipt_message TEXT,
      receipt_payload_json TEXT
    );
    CREATE TABLE IF NOT EXISTS notification_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL,
      target_actor TEXT,
      reason TEXT,
      dedupe_key TEXT,
      escalation_tier TEXT,
      created_at TEXT NOT NULL,
      acked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS delivery_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_kind TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      ticket_id INTEGER,
      target_gateway_id TEXT,
      transport TEXT,
      target_session_key TEXT,
      ok INTEGER NOT NULL,
      error TEXT,
      result TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_forwards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_kind TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      ticket_id INTEGER,
      channel TEXT NOT NULL DEFAULT 'telegram',
      target_gateway_id TEXT,
      transport TEXT,
      target_session_key TEXT,
      dedupe_key TEXT,
      last_error TEXT,
      first_failed_at TEXT NOT NULL,
      last_failed_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(event_kind, event_id, channel)
    );
    CREATE TABLE IF NOT EXISTS audit_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_id INTEGER NOT NULL UNIQUE,
      ticket_id INTEGER NOT NULL,
      audit_type TEXT NOT NULL,
      status_snapshot TEXT,
      stale_minutes INTEGER,
      conclusion TEXT NOT NULL,
      suggested_status TEXT,
      suggested_actor TEXT,
      suggested_action TEXT,
      reason TEXT,
      confidence TEXT,
      summary TEXT,
      comment_id TEXT,
      raw_payload_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (audit_id) REFERENCES audit_events(id) ON DELETE CASCADE
    );
  `);
  ensureColumn(db, 'dispatch_events', 'awaiting_receipt_from', 'TEXT');
  ensureColumn(db, 'dispatch_events', 'ack_deadline_at', 'TEXT');
  ensureColumn(db, 'dispatch_events', 'retry_count', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'dispatch_events', 'next_retry_at', 'TEXT');
  ensureColumn(db, 'dispatch_events', 'receipt_received_at', 'TEXT');
  ensureColumn(db, 'dispatch_events', 'receipt_decision', 'TEXT');
  ensureColumn(db, 'dispatch_events', 'receipt_message', 'TEXT');
  ensureColumn(db, 'dispatch_events', 'receipt_payload_json', 'TEXT');
  ensureColumn(db, 'notification_events', 'target_actor', 'TEXT');
  ensureColumn(db, 'notification_events', 'reason', 'TEXT');
  ensureColumn(db, 'notification_events', 'dedupe_key', 'TEXT');
  ensureColumn(db, 'notification_events', 'escalation_tier', 'TEXT');
  ensureColumn(db, 'pending_forwards', 'dedupe_key', 'TEXT');
  ensureColumn(db, 'pending_forwards', 'metadata_json', 'TEXT');
  ensureColumn(db, 'pending_forwards', 'resolved_at', 'TEXT');
  ensureColumn(db, 'pending_forwards', 'resolution', 'TEXT');
  ensureColumn(db, 'audit_results', 'stale_minutes', 'INTEGER');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pending_forwards_ticket ON pending_forwards(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_pending_forwards_open ON pending_forwards(channel, resolved_at, updated_at);
  `);
  return db;
}

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function dispatchEventRowToShape(row) {
  if (!row) return null;
  const now = Date.now();
  const deadlineTs = row.ack_deadline_at ? Date.parse(row.ack_deadline_at) : null;
  const nextRetryTs = row.next_retry_at ? Date.parse(row.next_retry_at) : null;
  const receiptDecision = row.receipt_decision ?? null;
  let dispatchState = 'pending_delivery';
  let suppressReady = false;
  let shouldRetry = false;

  if (row.receipt_received_at) {
    dispatchState = receiptDecision === 'accepted'
      ? 'receipt_accepted'
      : receiptDecision === 'declined'
        ? 'receipt_declined'
        : 'receipt_received';
    suppressReady = receiptDecision === 'accepted';
  } else if (row.acked_at) {
    const isOverdue = Number.isFinite(deadlineTs) && deadlineTs <= now;
    dispatchState = isOverdue ? 'receipt_overdue' : 'awaiting_receipt';
    suppressReady = !isOverdue;
    shouldRetry = isOverdue;
  } else if (Number.isFinite(nextRetryTs) && nextRetryTs > now) {
    suppressReady = true;
  }

  return {
    id: row.id,
    ticket_id: row.ticket_id,
    agent: row.agent,
    status: row.status,
    created_at: row.created_at,
    acked_at: row.acked_at ?? null,
    awaiting_receipt_from: row.awaiting_receipt_from ?? null,
    dispatch_ack_deadline_at: row.ack_deadline_at ?? null,
    dispatch_retry_count: Number(row.retry_count ?? 0),
    next_dispatch_retry_at: row.next_retry_at ?? row.ack_deadline_at ?? null,
    receipt_received_at: row.receipt_received_at ?? null,
    receipt_decision: receiptDecision,
    receipt_message: row.receipt_message ?? null,
    receipt_payload: parseJsonObject(row.receipt_payload_json),
    dispatch_state: dispatchState,
    suppress_ready: suppressReady,
    should_retry: shouldRetry,
  };
}

function auditEventRowToShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    audit_type: row.audit_type,
    status_snapshot: row.status_snapshot,
    created_at: row.created_at,
    acked_at: row.acked_at ?? null,
  };
}

function auditResultRowToShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    audit_id: row.audit_id,
    ticket_id: row.ticket_id,
    audit_type: row.audit_type,
    status_snapshot: row.status_snapshot ?? null,
    stale_minutes: row.stale_minutes == null ? null : Number(row.stale_minutes),
    conclusion: row.conclusion,
    suggested_status: row.suggested_status ?? null,
    suggested_actor: row.suggested_actor ?? null,
    suggested_action: row.suggested_action ?? null,
    reason: row.reason ?? null,
    confidence: row.confidence ?? null,
    summary: row.summary ?? null,
    comment_id: row.comment_id ?? null,
    raw_payload: parseJsonObject(row.raw_payload_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
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
 * 双写：发布 assignment.delivery_requested 到 domain_events（由 app 在创建 assignment 后调用）
 */
function appendAssignmentDeliveryRequested(assignmentId, ticketId, dispatchId, options = {}) {
  const correlationId = options.correlation_id || `asg_${assignmentId}`;
  const idempotencyKey = `assignment-delivery-requested-${assignmentId}`;
  const version = store.getAggregateVersion('assignment', String(assignmentId)) + 1;
  store.appendDomainEvent({
    event_type: 'assignment.delivery_requested',
    aggregate_type: 'assignment',
    aggregate_id: String(assignmentId),
    aggregate_version: version,
    producer: 'dispatch',
    correlation_id: correlationId,
    causation_id: options.causation_id || null,
    idempotency_key: idempotencyKey,
    payload: {
      assignment_id: assignmentId,
      ticket_id: ticketId,
      dispatch_id: dispatchId,
      target_gateway_id: options.target_gateway_id ?? null,
      transport: options.transport ?? null,
      target_session_key: options.target_session_key ?? null,
    },
    occurred_at: new Date().toISOString(),
  });
}

export function emitAssignmentDeliveryRequested(assignmentId, ticketId, dispatchId, options = {}) {
  appendAssignmentDeliveryRequested(assignmentId, ticketId, dispatchId, options);
}

/**
 * 记录派单事件
 */
export function recordDispatchEvent(ticketId, agent, status, options = {}) {
  const database = getDb();
  const now = new Date().toISOString();
  const retryCount = Number(options.retry_count ?? options.retryCount ?? 0) || 0;
  const nextRetryAt = options.next_retry_at ?? options.nextRetryAt ?? null;
  const stmt = database.prepare(`
    INSERT INTO dispatch_events (ticket_id, agent, status, created_at, retry_count, next_retry_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(ticketId, agent, status, now, retryCount, nextRetryAt);
  return info.lastInsertRowid;
}

export function getDispatchEventById(dispatchId) {
  const database = getDb();
  const row = database.prepare('SELECT * FROM dispatch_events WHERE id = ?').get(Number(dispatchId));
  return dispatchEventRowToShape(row);
}

export function getLatestDispatchEvent(ticketId, agent, status) {
  const database = getDb();
  const row = database.prepare(`
    SELECT * FROM dispatch_events
    WHERE ticket_id = ? AND agent = ? AND status = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(ticketId, agent, status);
  return dispatchEventRowToShape(row);
}

export function listPendingDispatchEventsByStatusPrefix(statusPrefix, options = {}) {
  const prefix = String(statusPrefix || '').trim();
  if (!prefix) return [];
  const limit = Number(options.limit ?? 200);
  const database = getDb();
  const rows = database.prepare(`
    SELECT * FROM dispatch_events
    WHERE status LIKE ?
      AND acked_at IS NULL
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(`${prefix}%`, Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200);
  return rows.map(dispatchEventRowToShape);
}

/**
 * 确认派单事件已成功投递，并进入 awaiting_receipt。
 * 双写：发布 assignment.delivered 到 domain_events。
 */
export function ackDispatchEvent(dispatchId, options = {}) {
  const database = getDb();
  const event = getDispatchEventById(dispatchId);
  if (!event) return false;
  const now = new Date().toISOString();
  const ackDeadlineAt = options.ack_deadline_at
    ?? options.ackDeadlineAt
    ?? toIsoAfter(DEFAULT_DISPATCH_RECEIPT_TIMEOUT_MS);
  const awaitingReceiptFrom = options.awaiting_receipt_from
    ?? options.awaitingReceiptFrom
    ?? event.awaiting_receipt_from
    ?? event.agent;
  const nextRetryAt = options.next_retry_at ?? options.nextRetryAt ?? ackDeadlineAt;
  const stmt = database.prepare(`
    UPDATE dispatch_events
    SET acked_at = ?,
        awaiting_receipt_from = ?,
        ack_deadline_at = ?,
        next_retry_at = ?,
        receipt_received_at = NULL,
        receipt_decision = NULL,
        receipt_message = NULL,
        receipt_payload_json = NULL
    WHERE id = ?
  `);
  const info = stmt.run(now, awaitingReceiptFrom, ackDeadlineAt, nextRetryAt, dispatchId);
  if (info.changes > 0) {
    try {
      const assignment = store.getAssignmentByDispatchEventId(dispatchId);
      if (assignment) {
        const version = store.getAggregateVersion('assignment', assignment.assignment_id) + 1;
        store.appendDomainEvent({
          event_type: 'assignment.delivered',
          aggregate_type: 'assignment',
          aggregate_id: assignment.assignment_id,
          aggregate_version: version,
          producer: 'dispatch',
          correlation_id: `asg_${assignment.assignment_id}`,
          causation_id: null,
          idempotency_key: `assignment-delivered-${dispatchId}`,
          payload: {
            assignment_id: assignment.assignment_id,
            dispatch_id: dispatchId,
            delivery_state: 'delivered',
            awaiting_receipt_from: awaitingReceiptFrom,
            ack_deadline_at: ackDeadlineAt,
          },
          occurred_at: now,
        });
      }
    } catch (err) {
      console.warn('[dispatch] ackDispatchEvent append event failed:', err?.message);
    }
  }
  return info.changes > 0;
}

export function markDispatchReceipt(dispatchId, options = {}) {
  const database = getDb();
  const now = new Date().toISOString();
  const decision = String(options.decision || 'accepted').trim() || 'accepted';
  const message = options.message ? String(options.message).trim() : null;
  const payload = options.payload && typeof options.payload === 'object' ? options.payload : null;
  const info = database.prepare(`
    UPDATE dispatch_events
    SET receipt_received_at = ?,
        receipt_decision = ?,
        receipt_message = ?,
        receipt_payload_json = ?,
        next_retry_at = NULL
    WHERE id = ?
  `).run(now, decision, message, payload ? JSON.stringify(payload) : null, Number(dispatchId));
  if (info.changes > 0) {
    try {
      const assignment = store.getAssignmentByDispatchEventId(dispatchId);
      if (assignment) {
        const eventType = decision === 'accepted' ? 'assignment.receipt_accepted' : 'assignment.receipt_declined';
        const version = store.getAggregateVersion('assignment', assignment.assignment_id) + 1;
        store.appendDomainEvent({
          event_type: eventType,
          aggregate_type: 'assignment',
          aggregate_id: assignment.assignment_id,
          aggregate_version: version,
          producer: 'dispatch',
          correlation_id: `asg_${assignment.assignment_id}`,
          causation_id: null,
          idempotency_key: `assignment-receipt-${dispatchId}-${decision}`,
          payload: {
            assignment_id: assignment.assignment_id,
            dispatch_id: dispatchId,
            agent: assignment.agent_id,
            stage: payload?.stage ?? assignment.stage ?? null,
            decision,
            message,
          },
          occurred_at: now,
        });
      }
    } catch (err) {
      console.warn('[dispatch] markDispatchReceipt append event failed:', err?.message);
    }
  }
  return info.changes > 0 ? getDispatchEventById(dispatchId) : null;
}

/**
 * 检查工单是否已派发给指定 agent。
 * - pending_delivery 且 next_retry_at 未到：抑制重复 ready
 * - awaiting_receipt 且 deadline 未超时：抑制重复 ready
 * - receipt 已接受：抑制重复 ready（直到状态变化清空事件）
 * - receipt 超时：不再抑制，允许平台重试/重派
 */
export function hasRecentDispatch(ticketId, agent, status, withinMinutes = 60) {
  const latest = getLatestDispatchEvent(ticketId, agent, status);
  if (!latest) return false;
  const createdTs = Date.parse(latest.created_at || '');
  if (Number.isFinite(createdTs) && createdTs < (Date.now() - withinMinutes * 60 * 1000)) {
    return false;
  }
  return latest.suppress_ready === true;
}

/**
 * 获取未 ack 的派单事件（用于复用）
 */
export function getUnackedDispatchEvent(ticketId, agent, status) {
  const database = getDb();
  const row = database.prepare(`
    SELECT * FROM dispatch_events
    WHERE ticket_id = ? AND agent = ? AND status = ? AND acked_at IS NULL
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(ticketId, agent, status);
  const event = dispatchEventRowToShape(row);
  return event ? event.id : null;
}

export function getLatestDispatchHandshakeState(ticketId, agent, status) {
  return getLatestDispatchEvent(ticketId, agent, status);
}

export function markDispatchDeliveryFailed(dispatchId, options = {}) {
  const database = getDb();
  const row = database.prepare('SELECT * FROM dispatch_events WHERE id = ?').get(Number(dispatchId));
  if (!row) return null;
  if (row.acked_at || row.receipt_received_at) {
    return dispatchEventRowToShape(row);
  }

  const hasExplicitRetryCount = options.retry_count !== undefined || options.retryCount !== undefined;
  const retryCount = hasExplicitRetryCount
    ? Math.max(0, Number.parseInt(String(options.retry_count ?? options.retryCount ?? 0), 10) || 0)
    : Math.max(0, Number(row.retry_count ?? 0)) + 1;
  const nextRetryAt = options.next_retry_at
    ?? options.nextRetryAt
    ?? toIsoAfter(computeDispatchDeliveryRetryDelayMs(retryCount));

  const info = database.prepare(`
    UPDATE dispatch_events
    SET retry_count = ?,
        next_retry_at = ?
    WHERE id = ?
      AND acked_at IS NULL
      AND receipt_received_at IS NULL
  `).run(retryCount, nextRetryAt, Number(dispatchId));

  if (info.changes <= 0) {
    return getDispatchEventById(dispatchId);
  }
  return getDispatchEventById(dispatchId);
}

/**
 * 记录通知事件
 */
export function recordNotificationEvent(ticketId, eventType, status, options = {}) {
  const database = getDb();
  const now = new Date().toISOString();
  const targetActor = options.target_actor ?? options.targetActor ?? null;
  const reason = options.reason ?? null;
  const dedupeKey = options.dedupe_key ?? options.dedupeKey ?? null;
  const escalationTier = options.escalation_tier ?? options.escalationTier ?? null;
  const stmt = database.prepare(`
    INSERT INTO notification_events (
      ticket_id,
      event_type,
      status,
      target_actor,
      reason,
      dedupe_key,
      escalation_tier,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(ticketId, eventType, status, targetActor, reason, dedupeKey, escalationTier, now);
  return info.lastInsertRowid;
}

/**
 * 获取未 ack 的通知事件（用于复用）
 */
export function getUnackedNotificationEvent(ticketId, eventType, status, options = {}) {
  const database = getDb();
  const targetActor = options.target_actor ?? options.targetActor ?? null;
  const reason = options.reason ?? null;
  const row = database.prepare(`
    SELECT id FROM notification_events
    WHERE ticket_id = ?
      AND event_type = ?
      AND status = ?
      AND COALESCE(target_actor, '') = COALESCE(?, '')
      AND COALESCE(reason, '') = COALESCE(?, '')
      AND acked_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(ticketId, eventType, status, targetActor, reason);
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
 * 检查工单是否已通知（检查任意已 ack 的事件）
 *
 * 设计说明：
 * - 一旦某 ticket 在某 event_type 上已 ack，默认视为“该状态版本已通知过”。
 * - 若状态后续发生变化，需要由业务层调用 clearNotificationEvents(ticketId)
 *   来重置该 ticket 的通知历史，使其在新状态版本可再次通知。
 */
export function hasRecentNotification(ticketId, eventType, options = {}) {
  const database = getDb();
  const targetActor = options.target_actor ?? options.targetActor ?? null;
  const reason = options.reason ?? null;
  const row = database.prepare(`
    SELECT id FROM notification_events
    WHERE ticket_id = ?
      AND event_type = ?
      AND COALESCE(target_actor, '') = COALESCE(?, '')
      AND COALESCE(reason, '') = COALESCE(?, '')
      AND acked_at IS NOT NULL
    ORDER BY acked_at DESC, id DESC LIMIT 1
  `).get(ticketId, eventType, targetActor, reason);
  return Boolean(row);
}

/**
 * 清理某工单的通知事件历史（状态切换时调用）
 */
export function clearNotificationEvents(ticketId) {
  const database = getDb();
  const info = database.prepare(`
    DELETE FROM notification_events WHERE ticket_id = ?
  `).run(ticketId);
  return info.changes;
}

/**
 * 清理某工单的派单事件历史（状态切换时调用）
 */
export function clearDispatchEvents(ticketId) {
  const database = getDb();
  const info = database.prepare(`
    DELETE FROM dispatch_events WHERE ticket_id = ?
  `).run(ticketId);
  return info.changes;
}

export function recordDeliveryAttempt({
  eventKind,
  eventId,
  ticketId = null,
  targetGatewayId = null,
  transport = null,
  targetSessionKey = null,
  ok,
  error = null,
  result = null,
}) {
  const database = getDb();
  const now = new Date().toISOString();
  const info = database.prepare(`
    INSERT INTO delivery_attempts (
      event_kind,
      event_id,
      ticket_id,
      target_gateway_id,
      transport,
      target_session_key,
      ok,
      error,
      result,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventKind,
    eventId,
    ticketId,
    targetGatewayId,
    transport,
    targetSessionKey,
    ok ? 1 : 0,
    error,
    result ? JSON.stringify(result) : null,
    now,
  );
  return info.lastInsertRowid;
}

export function listDeliveryAttempts({ eventKind = null, eventId = null, ticketId = null, limit = 50 } = {}) {
  const database = getDb();
  const clauses = [];
  const params = [];
  if (eventKind) {
    clauses.push('event_kind = ?');
    params.push(eventKind);
  }
  if (eventId) {
    clauses.push('event_id = ?');
    params.push(eventId);
  }
  if (ticketId) {
    clauses.push('ticket_id = ?');
    params.push(ticketId);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return database.prepare(`
    SELECT * FROM delivery_attempts
    ${where}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params, Number(limit) || 50);
}

function parsePendingForwardRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    event_kind: row.event_kind,
    event_id: row.event_id,
    ticket_id: row.ticket_id ?? null,
    channel: row.channel,
    target_gateway_id: row.target_gateway_id ?? null,
    transport: row.transport ?? null,
    target_session_key: row.target_session_key ?? null,
    dedupe_key: row.dedupe_key ?? null,
    last_error: row.last_error ?? null,
    first_failed_at: row.first_failed_at,
    last_failed_at: row.last_failed_at,
    resolved_at: row.resolved_at ?? null,
    resolution: row.resolution ?? null,
    metadata: parseJsonObject(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function upsertPendingForward({
  eventKind,
  eventId,
  ticketId = null,
  channel = 'telegram',
  targetGatewayId = null,
  transport = null,
  targetSessionKey = null,
  dedupeKey = null,
  lastError = null,
  metadata = null,
}) {
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO pending_forwards (
      event_kind,
      event_id,
      ticket_id,
      channel,
      target_gateway_id,
      transport,
      target_session_key,
      dedupe_key,
      last_error,
      first_failed_at,
      last_failed_at,
      metadata_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_kind, event_id, channel)
    DO UPDATE SET
      ticket_id = excluded.ticket_id,
      target_gateway_id = excluded.target_gateway_id,
      transport = excluded.transport,
      target_session_key = excluded.target_session_key,
      dedupe_key = excluded.dedupe_key,
      last_error = excluded.last_error,
      last_failed_at = excluded.last_failed_at,
      metadata_json = excluded.metadata_json,
      resolved_at = NULL,
      resolution = NULL,
      updated_at = excluded.updated_at
  `).run(
    eventKind,
    eventId,
    ticketId,
    channel,
    targetGatewayId,
    transport,
    targetSessionKey,
    dedupeKey,
    lastError,
    now,
    now,
    metadata ? JSON.stringify(metadata) : null,
    now,
    now,
  );

  return getPendingForward(eventKind, eventId, { channel });
}

export function resolvePendingForward(eventKind, eventId, { channel = 'telegram', resolution = 'delivered' } = {}) {
  const database = getDb();
  const now = new Date().toISOString();
  const info = database.prepare(`
    UPDATE pending_forwards
    SET resolved_at = ?, resolution = ?, updated_at = ?
    WHERE event_kind = ? AND event_id = ? AND channel = ? AND resolved_at IS NULL
  `).run(now, resolution, now, eventKind, eventId, channel);
  return info.changes > 0;
}

export function getPendingForward(eventKind, eventId, { channel = 'telegram' } = {}) {
  const database = getDb();
  const row = database.prepare(`
    SELECT * FROM pending_forwards
    WHERE event_kind = ? AND event_id = ? AND channel = ?
    LIMIT 1
  `).get(eventKind, eventId, channel);
  return parsePendingForwardRow(row);
}

export function listPendingForwards({ channel = null, unresolvedOnly = false, ticketId = null, limit = 50 } = {}) {
  const database = getDb();
  const clauses = [];
  const params = [];
  if (channel) {
    clauses.push('channel = ?');
    params.push(channel);
  }
  if (unresolvedOnly) {
    clauses.push('resolved_at IS NULL');
  }
  if (ticketId) {
    clauses.push('ticket_id = ?');
    params.push(ticketId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = database.prepare(`
    SELECT * FROM pending_forwards
    ${where}
    ORDER BY resolved_at IS NULL DESC, updated_at DESC, id DESC
    LIMIT ?
  `).all(...params, Number(limit) || 50);
  return rows.map(parsePendingForwardRow);
}

// ── Audit Events ──

function ensureAuditTable() {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      audit_type TEXT NOT NULL,
      status_snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL,
      acked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_id INTEGER NOT NULL UNIQUE,
      ticket_id INTEGER NOT NULL,
      audit_type TEXT NOT NULL,
      status_snapshot TEXT,
      stale_minutes INTEGER,
      conclusion TEXT NOT NULL,
      suggested_status TEXT,
      suggested_actor TEXT,
      suggested_action TEXT,
      reason TEXT,
      confidence TEXT,
      summary TEXT,
      comment_id TEXT,
      raw_payload_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (audit_id) REFERENCES audit_events(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_audit_events_ticket_type ON audit_events(ticket_id, audit_type);
    CREATE INDEX IF NOT EXISTS idx_audit_results_ticket_type ON audit_results(ticket_id, audit_type);
  `);
  ensureColumn(database, 'audit_results', 'stale_minutes', 'INTEGER');
}

export function recordAuditEvent(ticketId, auditType, statusSnapshot) {
  ensureAuditTable();
  const database = getDb();
  const now = new Date().toISOString();
  const info = database.prepare(`
    INSERT INTO audit_events (ticket_id, audit_type, status_snapshot, created_at)
    VALUES (?, ?, ?, ?)
  `).run(ticketId, auditType, statusSnapshot, now);
  return info.lastInsertRowid;
}

export function ackAuditEvent(auditId) {
  ensureAuditTable();
  const database = getDb();
  const now = new Date().toISOString();
  const info = database.prepare(`
    UPDATE audit_events SET acked_at = ? WHERE id = ?
  `).run(now, auditId);
  return info.changes > 0;
}

/**
 * 去重：同一 ticket + audit_type 如果已有 acked 事件，不再重复生成。
 * 只在状态发生变化后（通过 clearAuditEvents）允许重新审计。
 */
export function hasRecentAudit(ticketId, auditType) {
  ensureAuditTable();
  const database = getDb();
  const row = database.prepare(`
    SELECT id FROM audit_events
    WHERE ticket_id = ? AND audit_type = ? AND acked_at IS NOT NULL
    ORDER BY acked_at DESC LIMIT 1
  `).get(ticketId, auditType);
  return Boolean(row);
}

export function getUnackedAuditEvent(ticketId, auditType) {
  ensureAuditTable();
  const database = getDb();
  const row = database.prepare(`
    SELECT id FROM audit_events
    WHERE ticket_id = ? AND audit_type = ? AND acked_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(ticketId, auditType);
  return row ? row.id : null;
}

export function clearAuditEvents(ticketId) {
  ensureAuditTable();
  const database = getDb();
  database.prepare(`
    DELETE FROM audit_results WHERE ticket_id = ?
  `).run(ticketId);
  const info = database.prepare(`
    DELETE FROM audit_events WHERE ticket_id = ?
  `).run(ticketId);
  return info.changes;
}

export function getAuditEventById(auditId) {
  ensureAuditTable();
  const database = getDb();
  const row = database.prepare(`
    SELECT * FROM audit_events WHERE id = ?
  `).get(Number(auditId));
  return auditEventRowToShape(row);
}

export function getPendingAuditEvent(ticketId, auditType) {
  ensureAuditTable();
  const database = getDb();
  const row = database.prepare(`
    SELECT ae.*
    FROM audit_events ae
    LEFT JOIN audit_results ar ON ar.audit_id = ae.id
    WHERE ae.ticket_id = ? AND ae.audit_type = ? AND ar.audit_id IS NULL
    ORDER BY ae.created_at DESC, ae.id DESC
    LIMIT 1
  `).get(ticketId, auditType);
  return auditEventRowToShape(row);
}

export function hasResolvedAudit(ticketId, auditType) {
  ensureAuditTable();
  const database = getDb();
  const row = database.prepare(`
    SELECT ar.id
    FROM audit_results ar
    INNER JOIN audit_events ae ON ae.id = ar.audit_id
    WHERE ae.ticket_id = ? AND ae.audit_type = ?
    ORDER BY ar.created_at DESC, ar.id DESC
    LIMIT 1
  `).get(ticketId, auditType);
  return Boolean(row);
}

export function getLatestResolvedAudit(ticketId, auditType) {
  ensureAuditTable();
  const database = getDb();
  const row = database.prepare(`
    SELECT ar.*
    FROM audit_results ar
    INNER JOIN audit_events ae ON ae.id = ar.audit_id
    WHERE ae.ticket_id = ? AND ae.audit_type = ?
    ORDER BY ar.created_at DESC, ar.id DESC
    LIMIT 1
  `).get(ticketId, auditType);
  return auditResultRowToShape(row);
}

export function getAuditResultByAuditId(auditId) {
  ensureAuditTable();
  const database = getDb();
  const row = database.prepare(`
    SELECT * FROM audit_results WHERE audit_id = ?
  `).get(Number(auditId));
  return auditResultRowToShape(row);
}

export function listAuditResults({ ticketId = null, limit = 100 } = {}) {
  ensureAuditTable();
  const database = getDb();
  const params = [];
  let where = '';
  if (ticketId) {
    where = 'WHERE ticket_id = ?';
    params.push(Number(ticketId));
  }
  const rows = database.prepare(`
    SELECT * FROM audit_results
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...params, Number(limit) || 100);
  return rows.map(auditResultRowToShape);
}

export function recordAuditResult({
  auditId,
  ticketId,
  auditType,
  statusSnapshot = null,
  staleMinutes = null,
  conclusion,
  suggestedStatus = null,
  suggestedActor = null,
  suggestedAction = null,
  reason = null,
  confidence = null,
  summary = null,
  commentId = null,
  rawPayload = null,
} = {}) {
  ensureAuditTable();
  const database = getDb();
  const existing = getAuditResultByAuditId(auditId);
  if (existing) return existing;

  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO audit_results (
      audit_id,
      ticket_id,
      audit_type,
      status_snapshot,
      stale_minutes,
      conclusion,
      suggested_status,
      suggested_actor,
      suggested_action,
      reason,
      confidence,
      summary,
      comment_id,
      raw_payload_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(auditId),
    Number(ticketId),
    auditType,
    statusSnapshot,
    staleMinutes == null ? null : Math.round(Number(staleMinutes)),
    conclusion,
    suggestedStatus,
    suggestedActor,
    suggestedAction,
    reason,
    confidence,
    summary,
    commentId,
    rawPayload ? JSON.stringify(rawPayload) : null,
    now,
    now,
  );

  return getAuditResultByAuditId(auditId);
}
