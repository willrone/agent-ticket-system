/**
 * 工单 SQLite 持久化
 * 与 store-json 接口兼容：getAllTickets/getTicketById/createTicket/updateTicket/addComment
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { randomBytes } from 'crypto';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { normalizeCommentShape, buildCommentId, parseJsonArray } from './comment-utils.js';
import {
  resolveExecutionPolicy,
  normalizeExecutionMode,
  normalizeMaxActiveWorkers,
  normalizeWorkerStatus,
  isExecutionWorkerActiveStatus,
  validateWorkerTypeForMode,
} from '../execution-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db = null;

export const TICKET_RELATION_TYPES = {
  validation_of: '补充验证',
  smoke_of: 'Smoke 验证',
  review_sample_of: 'Review 样本',
};

export function isSupportedTicketRelationType(value) {
  return Object.prototype.hasOwnProperty.call(TICKET_RELATION_TYPES, String(value || '').trim());
}

function getTicketRelationLabel(relationType) {
  return TICKET_RELATION_TYPES[String(relationType || '').trim()] || String(relationType || '').trim() || '关联';
}

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

function ensureCounterTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS id_counters (
      name TEXT PRIMARY KEY,
      next_value INTEGER NOT NULL
    );
  `);
}

function ensureCounter(database, name, tableName) {
  ensureCounterTable(database);
  const maxId = database.prepare(`SELECT COALESCE(MAX(id), 0) AS max_id FROM ${tableName}`).get()?.max_id ?? 0;
  const existing = database.prepare('SELECT next_value FROM id_counters WHERE name = ?').get(name);
  if (!existing) {
    database.prepare('INSERT INTO id_counters (name, next_value) VALUES (?, ?)').run(name, maxId + 1);
    return;
  }
  if (Number(existing.next_value) <= maxId) {
    database.prepare('UPDATE id_counters SET next_value = ? WHERE name = ?').run(maxId + 1, name);
  }
}

function allocateId(database, name, tableName) {
  ensureCounter(database, name, tableName);
  const tx = database.transaction(() => {
    const row = database.prepare('SELECT next_value FROM id_counters WHERE name = ?').get(name);
    const id = Number(row?.next_value ?? 1);
    database.prepare('UPDATE id_counters SET next_value = ? WHERE name = ?').run(id + 1, name);
    return id;
  });
  return tx();
}

function isCommentEarlierThanTicket(commentTimestamp, ticketCreated) {
  const commentMs = Date.parse(commentTimestamp);
  const ticketMs = Date.parse(ticketCreated);
  if (Number.isNaN(commentMs) || Number.isNaN(ticketMs)) {
    return false;
  }
  return commentMs < ticketMs;
}

function purgeStaleCommentsForReusedTicketIds(database) {
  const rows = database.prepare(`
    SELECT c.id
    FROM ticket_comments c
    JOIN tickets t ON t.id = c.ticket_id
    WHERE c.timestamp < t.created
  `).all();

  if (rows.length === 0) return 0;

  const del = database.prepare('DELETE FROM ticket_comments WHERE id = ?');
  const run = database.transaction((items) => {
    for (const row of items) del.run(row.id);
  });
  run(rows);
  return rows.length;
}

function parseJsonObject(value, fallback = {}) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseReviewPlanReviewState(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    const p = JSON.parse(value);
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

function makeStoreError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function buildExecutionPersistence(input = {}, options = {}) {
  const policy = resolveExecutionPolicy(input, { forcePolicy: options.forcePolicy !== false });
  return {
    execution_mode: policy.execution_mode,
    execution_mode_source: policy.execution_mode_source,
    execution_rule_key: policy.execution_rule_key,
    execution_matched_signals_json: JSON.stringify(Array.isArray(policy.matched_signals) ? policy.matched_signals : []),
    max_active_workers: normalizeMaxActiveWorkers(policy.max_active_workers, policy.execution_mode),
  };
}

function workerRowToShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    worker_key: row.worker_key,
    worker_type: row.worker_type,
    status: row.status,
    session_key: row.session_key ?? null,
    run_id: row.run_id ?? null,
    label: row.label ?? null,
    summary: row.summary ?? null,
    started_at: row.started_at ?? null,
    last_heartbeat_at: row.last_heartbeat_at ?? null,
    finished_at: row.finished_at ?? null,
    metadata: parseJsonObject(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function buildAssignmentId(ticketId, agentId) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const agentPart = String(agentId || 'agent').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
  return `asg_${stamp}_${Number(ticketId)}_${agentPart}_${Math.random().toString(36).slice(2, 6)}`;
}

function buildReportId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `rpt_${stamp}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildAssignmentToken() {
  return randomBytes(24).toString('base64url');
}

function executionReservationRowToShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    lane_key: row.lane_key,
    agent_id: row.agent_id,
    ticket_id: row.ticket_id,
    assignment_id: row.assignment_id ?? null,
    dispatch_event_id: row.dispatch_event_id ?? null,
    state: row.state,
    holder_kind: row.holder_kind ?? null,
    holder_key: row.holder_key ?? null,
    release_reason: row.release_reason ?? null,
    released_at: row.released_at ?? null,
    expires_at: row.expires_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function assignmentRowToShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    assignment_id: row.assignment_id,
    ticket_id: row.ticket_id,
    dispatch_event_id: row.dispatch_event_id ?? null,
    agent_id: row.agent_id,
    gateway_id: row.gateway_id ?? null,
    execution_mode: row.execution_mode ?? null,
    assignment_status: row.assignment_status,
    intent: row.intent,
    role: row.role ?? 'execute',
    stage: row.stage ?? null,
    assignment_token: row.assignment_token,
    target_session_key: row.target_session_key ?? null,
    transport: row.transport ?? null,
    last_heartbeat_at: row.last_heartbeat_at ?? null,
    last_reported_at: row.last_reported_at ?? null,
    latest_progress: parseJsonObject(row.latest_progress_json, {}),
    last_error: row.last_error ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at ?? null,
  };
}

function heartbeatRowToShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    assignment_id: row.assignment_id,
    idempotency_key: row.idempotency_key,
    progress: parseJsonObject(row.progress_json, {}),
    created_at: row.created_at,
  };
}

function reportRowToShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    report_id: row.report_id,
    assignment_id: row.assignment_id,
    ticket_id: row.ticket_id,
    report_type: row.report_type,
    idempotency_key: row.idempotency_key,
    payload: parseJsonObject(row.payload_json, {}),
    interpreter_result: parseJsonObject(row.interpreter_result_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getAssignmentRowById(database, assignmentId) {
  return database.prepare('SELECT * FROM ticket_assignments WHERE assignment_id = ?').get(String(assignmentId));
}

function getAssignmentRowByDispatchEventId(database, dispatchEventId) {
  return database.prepare('SELECT * FROM ticket_assignments WHERE dispatch_event_id = ?').get(Number(dispatchEventId));
}

function getHeartbeatRowByIdempotency(database, assignmentId, idempotencyKey) {
  return database.prepare(`
    SELECT * FROM ticket_assignment_heartbeats WHERE assignment_id = ? AND idempotency_key = ?
  `).get(String(assignmentId), String(idempotencyKey));
}

function getReportRowByIdempotency(database, assignmentId, idempotencyKey) {
  return database.prepare(`
    SELECT * FROM ticket_assignment_reports WHERE assignment_id = ? AND idempotency_key = ?
  `).get(String(assignmentId), String(idempotencyKey));
}

/** starting 无 session_key/run_id 且无新鲜 heartbeat 的视为 stale，不计入 active，避免长期压制 done/review dispatch */
const STALE_STARTING_HEARTBEAT_MINUTES = 5;

function getTicketWorkerStats(database, ticketId) {
  const totalRow = database.prepare(`
    SELECT COUNT(*) AS total_workers FROM ticket_execution_workers WHERE ticket_id = ?
  `).get(Number(ticketId));

  const activeRow = database.prepare(`
    SELECT
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_workers,
      SUM(CASE
        WHEN status = 'running' THEN 1
        WHEN status = 'starting'
          AND (TRIM(COALESCE(session_key, '')) != '' OR TRIM(COALESCE(run_id, '')) != '')
          AND last_heartbeat_at IS NOT NULL
          AND datetime(last_heartbeat_at) >= datetime('now', ?)
        THEN 1
        ELSE 0
      END) AS active_workers
    FROM ticket_execution_workers
    WHERE ticket_id = ? AND status IN ('starting', 'running')
  `).get(`-${STALE_STARTING_HEARTBEAT_MINUTES} minutes`, Number(ticketId));

  return {
    total_workers: Number(totalRow?.total_workers ?? 0),
    active_workers: Number(activeRow?.active_workers ?? 0),
    running_workers: Number(activeRow?.running_workers ?? 0),
  };
}

function getCurrentWorkersForTicket(database, ticketId) {
  const rows = database.prepare(`
    SELECT * FROM ticket_execution_workers
    WHERE ticket_id = ? AND status IN ('starting', 'running')
    ORDER BY updated_at DESC, id DESC
  `).all(Number(ticketId));
  const cutoff = new Date(Date.now() - STALE_STARTING_HEARTBEAT_MINUTES * 60 * 1000).toISOString();
  return rows
    .filter((row) => {
      if (row.status === 'running') return true;
      const hasIdentity = (row.session_key && String(row.session_key).trim()) || (row.run_id && String(row.run_id).trim());
      const freshHeartbeat = row.last_heartbeat_at && row.last_heartbeat_at >= cutoff;
      return hasIdentity && freshHeartbeat;
    })
    .map(workerRowToShape);
}

function getAllWorkersForTicket(database, ticketId) {
  return database.prepare(`
    SELECT * FROM ticket_execution_workers
    WHERE ticket_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(Number(ticketId)).map(workerRowToShape);
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
      next_actor_override TEXT,
      priority TEXT DEFAULT 'medium',
      platform TEXT,
      request_type TEXT,
      triage_summary TEXT,
      implementation_scope TEXT,
      constraints_text TEXT,
      deliverables TEXT,
      acceptance_criteria TEXT,
      review_plan_json TEXT,
      review_state_json TEXT,
      parent_ticket_id INTEGER,
      session_key TEXT,
      run_id TEXT,
      created TEXT NOT NULL,
      last_update TEXT NOT NULL,
      result_summary TEXT,
      error TEXT,
      watchers_json TEXT DEFAULT '[]',
      locked_by TEXT,
      locked_at TEXT,
      paused_from_status TEXT,
      paused_by TEXT,
      paused_at TEXT,
      pause_reason TEXT,
      execution_mode TEXT,
      execution_mode_source TEXT,
      execution_rule_key TEXT,
      execution_matched_signals_json TEXT DEFAULT '[]',
      max_active_workers INTEGER DEFAULT 0,
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
      metadata_json TEXT DEFAULT '{}',
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
    CREATE TABLE IF NOT EXISTS ticket_relations (
      source_ticket_id INTEGER NOT NULL,
      target_ticket_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (source_ticket_id, target_ticket_id, relation_type),
      FOREIGN KEY (source_ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (target_ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ticket_execution_workers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      worker_key TEXT NOT NULL,
      worker_type TEXT NOT NULL,
      status TEXT NOT NULL,
      session_key TEXT,
      run_id TEXT,
      label TEXT,
      summary TEXT,
      started_at TEXT NOT NULL,
      last_heartbeat_at TEXT,
      finished_at TEXT,
      metadata_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(ticket_id, worker_key),
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ticket_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id TEXT NOT NULL UNIQUE,
      ticket_id INTEGER NOT NULL,
      dispatch_event_id INTEGER,
      agent_id TEXT NOT NULL,
      gateway_id TEXT,
      execution_mode TEXT,
      assignment_status TEXT NOT NULL,
      intent TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'execute',
      stage TEXT,
      assignment_token TEXT NOT NULL,
      target_session_key TEXT,
      transport TEXT,
      last_heartbeat_at TEXT,
      last_reported_at TEXT,
      latest_progress_json TEXT DEFAULT '{}',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      UNIQUE(dispatch_event_id),
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS execution_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lane_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      ticket_id INTEGER NOT NULL,
      assignment_id TEXT,
      dispatch_event_id INTEGER,
      state TEXT NOT NULL,
      holder_kind TEXT,
      holder_key TEXT,
      release_reason TEXT,
      released_at TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(lane_key, agent_id),
      UNIQUE(ticket_id),
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (assignment_id) REFERENCES ticket_assignments(assignment_id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS ticket_assignment_heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      progress_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(assignment_id, idempotency_key),
      FOREIGN KEY (assignment_id) REFERENCES ticket_assignments(assignment_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ticket_assignment_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id TEXT NOT NULL UNIQUE,
      assignment_id TEXT NOT NULL,
      ticket_id INTEGER NOT NULL,
      report_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      interpreter_result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(assignment_id, idempotency_key),
      FOREIGN KEY (assignment_id) REFERENCES ticket_assignments(assignment_id) ON DELETE CASCADE,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS domain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      aggregate_version INTEGER NOT NULL,
      producer TEXT NOT NULL,
      correlation_id TEXT,
      causation_id TEXT,
      idempotency_key TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id TEXT NOT NULL UNIQUE,
      command_type TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      issuer_kind TEXT,
      issuer_id TEXT,
      correlation_id TEXT,
      idempotency_key TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      result_status TEXT,
      result_error_code TEXT,
      result_error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS event_subscriptions (
      subscriber_name TEXT PRIMARY KEY,
      last_event_id TEXT,
      last_sequence INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS dispatch_ready_projection (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      dispatch_id INTEGER NOT NULL,
      assignment_id TEXT,
      agent TEXT NOT NULL,
      stage TEXT,
      target_session_key TEXT,
      target_gateway_id TEXT,
      delivery_intent TEXT,
      reason TEXT,
      dedupe_key TEXT DEFAULT '',
      escalation_tier TEXT,
      kind TEXT,
      workflow_mismatch_json TEXT,
      message TEXT,
      assignment_contract_json TEXT,
      reset_session INTEGER DEFAULT 0,
      session_reset_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(ticket_id, agent, dedupe_key)
    );
    CREATE TABLE IF NOT EXISTS ticket_projection (
      ticket_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      current_actor TEXT,
      next_actor TEXT,
      dispatch_state TEXT,
      available_actions_json TEXT DEFAULT '[]',
      worker_stats_json TEXT DEFAULT '{}',
      latest_effective_worker_key TEXT,
      aggregate_version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS audit_ready_projection (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      audit_id INTEGER NOT NULL,
      audit_type TEXT NOT NULL,
      status_snapshot TEXT,
      stale_minutes INTEGER,
      suggested_status TEXT,
      suggested_actor TEXT,
      suggested_action TEXT,
      reason TEXT,
      confidence TEXT,
      summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(ticket_id, audit_type)
    );
    CREATE TABLE IF NOT EXISTS worker_projection (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      worker_key TEXT NOT NULL,
      worker_type TEXT,
      status TEXT NOT NULL,
      session_key TEXT,
      run_id TEXT,
      started_at TEXT,
      last_heartbeat_at TEXT,
      finished_at TEXT,
      replacement_for TEXT,
      is_latest INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(ticket_id, worker_key)
    );
    CREATE TABLE IF NOT EXISTS validation_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      assignment_id TEXT,
      ticket_id INTEGER,
      passed INTEGER NOT NULL DEFAULT 1,
      errors_json TEXT DEFAULT '[]',
      codes_json TEXT DEFAULT '[]',
      stale INTEGER,
      stale_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_domain_events_aggregate ON domain_events(aggregate_type, aggregate_id);
    CREATE INDEX IF NOT EXISTS idx_domain_events_occurred ON domain_events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_domain_events_idempotency ON domain_events(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_commands_aggregate ON commands(aggregate_type, aggregate_id);
    CREATE INDEX IF NOT EXISTS idx_dispatch_ready_projection_ticket ON dispatch_ready_projection(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_worker_projection_ticket ON worker_projection(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_audit_ready_projection_ticket ON audit_ready_projection(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_validation_audit_assignment ON validation_audit(assignment_id);
    CREATE INDEX IF NOT EXISTS idx_validation_audit_ticket ON validation_audit(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_execution_reservations_agent_state ON execution_reservations(agent_id, state);
    CREATE INDEX IF NOT EXISTS idx_execution_reservations_ticket ON execution_reservations(ticket_id);
  `);
  ensureColumn(database, 'audit_ready_projection', 'stale_minutes', 'INTEGER');

  // 向后兼容老 schema：先补列，再建依赖这些列的索引
  ensureColumn(database, 'tickets', 'watchers_json', "TEXT DEFAULT '[]'");
  ensureColumn(database, 'tickets', 'triage_owner', 'TEXT');
  ensureColumn(database, 'tickets', 'review_owner', 'TEXT');
  ensureColumn(database, 'tickets', 'next_actor', 'TEXT');
  ensureColumn(database, 'tickets', 'next_actor_override', 'TEXT');
  ensureColumn(database, 'tickets', 'platform', 'TEXT');
  ensureColumn(database, 'tickets', 'locked_by', 'TEXT');
  ensureColumn(database, 'tickets', 'locked_at', 'TEXT');
  ensureColumn(database, 'tickets', 'paused_from_status', 'TEXT');
  ensureColumn(database, 'tickets', 'paused_by', 'TEXT');
  ensureColumn(database, 'tickets', 'paused_at', 'TEXT');
  ensureColumn(database, 'tickets', 'pause_reason', 'TEXT');
  ensureColumn(database, 'tickets', 'request_type', 'TEXT');
  ensureColumn(database, 'tickets', 'triage_summary', 'TEXT');
  ensureColumn(database, 'tickets', 'implementation_scope', 'TEXT');
  ensureColumn(database, 'tickets', 'constraints_text', 'TEXT');
  ensureColumn(database, 'tickets', 'deliverables', 'TEXT');
  ensureColumn(database, 'tickets', 'acceptance_criteria', 'TEXT');
  ensureColumn(database, 'tickets', 'review_plan_json', "TEXT DEFAULT '{}'" );
  ensureColumn(database, 'tickets', 'review_state_json', "TEXT DEFAULT '{}'" );
  ensureColumn(database, 'tickets', 'parent_ticket_id', 'INTEGER');
  ensureColumn(database, 'tickets', 'decision_owner', 'TEXT');
  ensureColumn(database, 'tickets', 'decision_summary', 'TEXT');
  ensureColumn(database, 'tickets', 'decision_context', 'TEXT');
  ensureColumn(database, 'tickets', 'review_plan', 'TEXT');
  ensureColumn(database, 'tickets', 'review_state', 'TEXT');
  ensureColumn(database, 'tickets', 'execution_mode', 'TEXT');
  ensureColumn(database, 'tickets', 'execution_mode_source', 'TEXT');
  ensureColumn(database, 'tickets', 'execution_rule_key', 'TEXT');
  ensureColumn(database, 'tickets', 'execution_matched_signals_json', "TEXT DEFAULT '[]'");
  ensureColumn(database, 'tickets', 'max_active_workers', 'INTEGER DEFAULT 0');
  ensureColumn(database, 'ticket_assignments', 'dispatch_event_id', 'INTEGER');
  ensureColumn(database, 'ticket_assignments', 'gateway_id', 'TEXT');
  ensureColumn(database, 'ticket_assignments', 'execution_mode', 'TEXT');
  ensureColumn(database, 'ticket_assignments', 'assignment_status', "TEXT DEFAULT 'created'");
  ensureColumn(database, 'ticket_assignments', 'intent', "TEXT DEFAULT 'dispatch'");
  ensureColumn(database, 'ticket_assignments', 'role', "TEXT DEFAULT 'execute'");
  ensureColumn(database, 'ticket_assignments', 'stage', 'TEXT');
  ensureColumn(database, 'ticket_assignments', 'assignment_token', 'TEXT');
  ensureColumn(database, 'ticket_assignments', 'target_session_key', 'TEXT');
  ensureColumn(database, 'ticket_assignments', 'transport', 'TEXT');
  ensureColumn(database, 'ticket_assignments', 'last_heartbeat_at', 'TEXT');
  ensureColumn(database, 'ticket_assignments', 'last_reported_at', 'TEXT');
  ensureColumn(database, 'ticket_assignments', 'latest_progress_json', "TEXT DEFAULT '{}'");
  ensureColumn(database, 'ticket_assignments', 'last_error', 'TEXT');
  ensureColumn(database, 'ticket_assignments', 'expires_at', 'TEXT');
  ensureColumn(database, 'ticket_comments', 'type', "TEXT DEFAULT 'progress'");
  ensureColumn(database, 'ticket_comments', 'visibility', "TEXT DEFAULT 'internal'");
  ensureColumn(database, 'ticket_comments', 'thread_id', 'TEXT');
  ensureColumn(database, 'ticket_comments', 'mentions_json', "TEXT DEFAULT '[]'");
  ensureColumn(database, 'ticket_comments', 'notify_targets_json', "TEXT DEFAULT '[]'");
  ensureColumn(database, 'ticket_comments', 'metadata_json', "TEXT DEFAULT '{}'");

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_triage_owner ON tickets(triage_owner);
    CREATE INDEX IF NOT EXISTS idx_tickets_assigned_agent ON tickets(assigned_agent);
    CREATE INDEX IF NOT EXISTS idx_tickets_next_actor ON tickets(next_actor);
    CREATE INDEX IF NOT EXISTS idx_tickets_last_update ON tickets(last_update);
    CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket_id ON ticket_comments(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_deps_ticket_id ON ticket_dependencies(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_deps_depends_on ON ticket_dependencies(depends_on_ticket_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_relations_source ON ticket_relations(source_ticket_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_relations_target ON ticket_relations(target_ticket_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_relations_type ON ticket_relations(relation_type);
    CREATE INDEX IF NOT EXISTS idx_ticket_workers_ticket_id ON ticket_execution_workers(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_workers_status ON ticket_execution_workers(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_workers_unique_key ON ticket_execution_workers(ticket_id, worker_key);
    CREATE INDEX IF NOT EXISTS idx_ticket_assignments_ticket_id ON ticket_assignments(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_assignments_agent_id ON ticket_assignments(agent_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_assignments_dispatch_event_id ON ticket_assignments(dispatch_event_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_assignment_heartbeats_assignment_id ON ticket_assignment_heartbeats(assignment_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_assignment_reports_assignment_id ON ticket_assignment_reports(assignment_id);
  `);

  ensureCounter(database, 'tickets', 'tickets');
  purgeStaleCommentsForReusedTicketIds(database);
}

function summarizeTicketRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    assigned_agent: row.assigned_agent,
    result_summary: row.result_summary ?? null,
    last_update: row.last_update ?? null,
  };
}

function mapTicketRelationRow(row, direction) {
  const ticket = {
    id: row.related_ticket_id,
    title: row.related_title,
    status: row.related_status,
    assigned_agent: row.related_assigned_agent,
    result_summary: row.related_result_summary ?? null,
    last_update: row.related_last_update ?? null,
  };
  return {
    direction,
    relation_type: row.relation_type,
    relation_label: getTicketRelationLabel(row.relation_type),
    created_at: row.created_at,
    ticket,
  };
}

function getTicketRelationsForTicket(database, ticketId) {
  const outgoingRows = database.prepare(`
    SELECT
      r.relation_type,
      r.created_at,
      t.id AS related_ticket_id,
      t.title AS related_title,
      t.status AS related_status,
      t.assigned_agent AS related_assigned_agent,
      t.result_summary AS related_result_summary,
      t.last_update AS related_last_update
    FROM ticket_relations r
    JOIN tickets t ON t.id = r.target_ticket_id
    WHERE r.source_ticket_id = ?
    ORDER BY datetime(r.created_at) ASC, t.id ASC
  `).all(Number(ticketId)).map((row) => mapTicketRelationRow(row, 'outgoing'));

  const incomingRows = database.prepare(`
    SELECT
      r.relation_type,
      r.created_at,
      t.id AS related_ticket_id,
      t.title AS related_title,
      t.status AS related_status,
      t.assigned_agent AS related_assigned_agent,
      t.result_summary AS related_result_summary,
      t.last_update AS related_last_update
    FROM ticket_relations r
    JOIN tickets t ON t.id = r.source_ticket_id
    WHERE r.target_ticket_id = ?
    ORDER BY datetime(r.created_at) ASC, t.id ASC
  `).all(Number(ticketId)).map((row) => mapTicketRelationRow(row, 'incoming'));

  const supplementalForTicket = outgoingRows.find((relation) => isSupportedTicketRelationType(relation.relation_type)) || null;
  const supplementalTickets = incomingRows.filter((relation) => isSupportedTicketRelationType(relation.relation_type));
  const supplementalSummary = supplementalTickets.reduce((summary, relation) => {
    const statusKey = String(relation.ticket?.status || 'unknown').trim() || 'unknown';
    summary.total += 1;
    summary.by_status[statusKey] = (summary.by_status[statusKey] || 0) + 1;
    if (!['complete', 'failed'].includes(statusKey)) {
      summary.open += 1;
    }
    if (statusKey === 'complete') summary.complete += 1;
    if (statusKey === 'done' || statusKey === 'review') summary.pending_review += 1;
    return summary;
  }, {
    total: 0,
    open: 0,
    complete: 0,
    pending_review: 0,
    by_status: {},
  });

  return {
    ticket_relations: [...outgoingRows, ...incomingRows],
    supplemental_for_ticket: supplementalForTicket,
    supplemental_tickets: supplementalTickets,
    supplemental_summary: supplementalSummary,
  };
}

export function getExecutionReservationForTicket(ticketId) {
  const database = getDb();
  const row = database.prepare(`
    SELECT * FROM execution_reservations WHERE ticket_id = ? LIMIT 1
  `).get(Number(ticketId));
  return executionReservationRowToShape(row);
}

export function findExecutionReservationConflict({ agentId, excludeTicketId = null } = {}) {
  const normalizedAgent = String(agentId || '').trim();
  if (!normalizedAgent) return null;

  const database = getDb();
  const row = database.prepare(`
    SELECT * FROM execution_reservations
    WHERE agent_id = ?
      AND state IN ('reserved', 'receipt_accepted', 'running')
      AND (? IS NULL OR ticket_id != ?)
    ORDER BY datetime(created_at) ASC, id ASC
    LIMIT 1
  `).get(normalizedAgent, excludeTicketId ?? null, excludeTicketId ?? null);

  if (!row) return null;
  const ticketRow = database.prepare('SELECT id, status FROM tickets WHERE id = ?').get(Number(row.ticket_id));
  if (!ticketRow || !['queued', 'running'].includes(String(ticketRow.status || '').trim())) {
    updateExecutionReservation(row.ticket_id, {
      state: 'released',
      release_reason: 'stale_ticket_state',
      released_at: new Date().toISOString(),
    });
    return null;
  }
  return executionReservationRowToShape(row);
}

export function tryAcquireExecutionReservation(input = {}) {
  const database = getDb();
  const agentId = String(input.agent_id ?? input.agentId ?? '').trim();
  const ticketId = Number(input.ticket_id ?? input.ticketId);
  const laneKey = String(input.lane_key ?? input.laneKey ?? 'default').trim() || 'default';
  if (!agentId) {
    throw makeStoreError('RESERVATION_AGENT_REQUIRED', 'reservation 需要合法 agent_id', { statusCode: 400 });
  }
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    throw makeStoreError('RESERVATION_TICKET_REQUIRED', 'reservation 需要合法 ticket_id', { statusCode: 400 });
  }

  const existingForTicket = getExecutionReservationForTicket(ticketId);
  const nextState = input.state ?? 'reserved';
  const nextAssignmentId = input.assignment_id ?? input.assignmentId ?? null;
  const nextDispatchEventId = input.dispatch_event_id ?? input.dispatchEventId ?? null;
  const nextHolderKind = input.holder_kind ?? 'dispatch';
  const nextHolderKey = input.holder_key ?? String((input.dispatch_event_id ?? input.dispatchEventId ?? '') || '');
  const nextExpiresAt = input.expires_at ?? input.expiresAt ?? null;

  if (existingForTicket) {
    if (existingForTicket.state === 'released') {
      return updateExecutionReservation(ticketId, {
        assignment_id: nextAssignmentId,
        dispatch_event_id: nextDispatchEventId,
        state: nextState,
        holder_kind: nextHolderKind,
        holder_key: nextHolderKey,
        release_reason: null,
        released_at: null,
        expires_at: nextExpiresAt,
      });
    }
    return existingForTicket;
  }

  const conflict = findExecutionReservationConflict({ agentId, excludeTicketId: ticketId });
  if (conflict) {
    throw makeStoreError('EXECUTION_RESERVATION_CONFLICT', `agent ${agentId} 已被 ticket #${conflict.ticket_id} 占用 execution reservation`, {
      statusCode: 409,
      conflict_reservation: conflict,
    });
  }

  const now = new Date().toISOString();
  try {
    const info = database.prepare(`
      INSERT INTO execution_reservations (
        lane_key, agent_id, ticket_id, assignment_id, dispatch_event_id, state, holder_kind, holder_key,
        release_reason, released_at, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      laneKey,
      agentId,
      ticketId,
      nextAssignmentId,
      nextDispatchEventId,
      nextState,
      nextHolderKind,
      nextHolderKey,
      null,
      null,
      nextExpiresAt,
      now,
      now,
    );
    const row = database.prepare('SELECT * FROM execution_reservations WHERE id = ?').get(info.lastInsertRowid);
    return executionReservationRowToShape(row);
  } catch (err) {
    const message = String(err?.message || '');
    if (message.includes('UNIQUE constraint failed: execution_reservations.ticket_id')) {
      const ticketReservation = getExecutionReservationForTicket(ticketId);
      if (ticketReservation?.state === 'released') {
        return updateExecutionReservation(ticketId, {
          assignment_id: nextAssignmentId,
          dispatch_event_id: nextDispatchEventId,
          state: nextState,
          holder_kind: nextHolderKind,
          holder_key: nextHolderKey,
          release_reason: null,
          released_at: null,
          expires_at: nextExpiresAt,
        });
      }
      return ticketReservation;
    }
    if (message.includes('UNIQUE constraint failed: execution_reservations.lane_key, execution_reservations.agent_id')) {
      const releasedLaneReservation = database.prepare(`
        SELECT * FROM execution_reservations
        WHERE lane_key = ? AND agent_id = ? AND state = 'released'
        LIMIT 1
      `).get(laneKey, agentId);
      if (releasedLaneReservation) {
        database.prepare('DELETE FROM execution_reservations WHERE id = ?').run(releasedLaneReservation.id);
        return tryAcquireExecutionReservation(input);
      }
      const holderRow = database.prepare(`
        SELECT * FROM execution_reservations WHERE lane_key = ? AND agent_id = ? LIMIT 1
      `).get(laneKey, agentId);
      throw makeStoreError('EXECUTION_RESERVATION_CONFLICT', `agent ${agentId} 已被其他 reservation 占用`, {
        statusCode: 409,
        conflict_reservation: holderRow ? executionReservationRowToShape(holderRow) : findExecutionReservationConflict({ agentId, excludeTicketId: ticketId }),
      });
    }
    throw err;
  }
}

export function updateExecutionReservation(ticketId, updates = {}) {
  const database = getDb();
  const existing = database.prepare('SELECT * FROM execution_reservations WHERE ticket_id = ?').get(Number(ticketId));
  if (!existing) return null;

  const allowed = ['assignment_id', 'dispatch_event_id', 'state', 'holder_kind', 'holder_key', 'release_reason', 'released_at', 'expires_at'];
  const setParts = [];
  const values = [];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      setParts.push(`${key} = ?`);
      values.push(updates[key]);
    }
  }
  if (setParts.length === 0) {
    return executionReservationRowToShape(existing);
  }
  setParts.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(Number(ticketId));
  database.prepare(`UPDATE execution_reservations SET ${setParts.join(', ')} WHERE ticket_id = ?`).run(...values);
  return getExecutionReservationForTicket(ticketId);
}

export function releaseExecutionReservationByTicket(ticketId, releaseReason = 'released') {
  const existing = getExecutionReservationForTicket(ticketId);
  if (!existing) return null;
  return updateExecutionReservation(ticketId, {
    state: 'released',
    release_reason: releaseReason,
    released_at: new Date().toISOString(),
  });
}

export function findRunningTicketConflict({ assignedAgent, excludeTicketId } = {}) {
  const normalizedAgent = String(assignedAgent || '').trim();
  if (!normalizedAgent) return null;

  const database = getDb();
  const row = database.prepare(`
    SELECT id, title, status, assigned_agent, execution_mode, locked_by, locked_at, last_update
    FROM tickets
    WHERE assigned_agent = ?
      AND status = 'running'
      AND (? IS NULL OR id != ?)
    ORDER BY datetime(last_update) ASC, id ASC
    LIMIT 1
  `).get(normalizedAgent, excludeTicketId ?? null, excludeTicketId ?? null);

  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    status: row.status,
    assigned_agent: row.assigned_agent,
    execution_mode: row.execution_mode ?? null,
    locked_by: row.locked_by ?? null,
    locked_at: row.locked_at ?? null,
    last_update: row.last_update ?? null,
  };
}

function rowToTicket(row, comments = [], relations = {}, options = {}) {
  if (!row) return null;
  const execution = resolveExecutionPolicy({
    ...row,
    constraints: row.constraints_text,
    execution_matched_signals: parseJsonArray(row.execution_matched_signals_json),
  }, { forcePolicy: options.forcePolicy === true });
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
    next_actor_override: row.next_actor_override ?? null,
    next_actor_legacy: row.next_actor ?? null,
    priority: row.priority ?? 'medium',
    platform: row.platform ?? null,
    request_type: row.request_type ?? null,
    triage_summary: row.triage_summary ?? '',
    implementation_scope: row.implementation_scope ?? '',
    constraints: row.constraints_text ?? '',
    deliverables: row.deliverables ?? '',
    acceptance_criteria: row.acceptance_criteria ?? '',
    review_plan: parseJsonObject(row.review_plan_json, {}),
    review_state: parseJsonObject(row.review_state_json, {}),
    parent_ticket_id: row.parent_ticket_id ?? null,
    parent_ticket: relations.parent_ticket ?? null,
    child_tickets: Array.isArray(relations.child_tickets) ? relations.child_tickets : [],
    ticket_relations: Array.isArray(relations.ticket_relations) ? relations.ticket_relations : [],
    supplemental_for_ticket: relations.supplemental_for_ticket ?? null,
    supplemental_tickets: Array.isArray(relations.supplemental_tickets) ? relations.supplemental_tickets : [],
    supplemental_summary: relations.supplemental_summary ?? { total: 0, open: 0, complete: 0, pending_review: 0, by_status: {} },
    session_key: row.session_key,
    run_id: row.run_id,
    created: row.created,
    last_update: row.last_update,
    result_summary: row.result_summary,
    error: row.error,
    watchers: parseJsonArray(row.watchers_json),
    locked_by: row.locked_by ?? null,
    locked_at: row.locked_at ?? null,
    paused_from_status: row.paused_from_status ?? null,
    paused_by: row.paused_by ?? null,
    paused_at: row.paused_at ?? null,
    pause_reason: row.pause_reason ?? null,
    execution_mode: execution.execution_mode,
    execution_mode_source: execution.execution_mode_source,
    execution_rule_key: execution.execution_rule_key,
    execution_matched_signals: execution.matched_signals,
    max_active_workers: execution.max_active_workers,
    worker_type: execution.worker_type,
    execution_allow_worker: execution.allow_worker,
    worker_stats: relations.worker_stats ?? { total_workers: 0, active_workers: 0, running_workers: 0 },
    current_workers: Array.isArray(relations.current_workers) ? relations.current_workers : [],
    execution_workers: Array.isArray(relations.execution_workers) ? relations.execution_workers : [],
    comments: comments.map((c) => normalizeCommentShape(c)),
  };
}

function commentSelectSql() {
  return `SELECT id, ticket_id, author, timestamp, content, type, visibility, thread_id, mentions_json, notify_targets_json, metadata_json
          FROM ticket_comments WHERE ticket_id = ? ORDER BY id`;
}

export function getAllTickets() {
  const database = getDb();
  const rows = database.prepare('SELECT * FROM tickets ORDER BY id').all();
  const tickets = [];
  for (const row of rows) {
    const comments = database.prepare(commentSelectSql()).all(row.id)
      .filter((comment) => !isCommentEarlierThanTicket(comment.timestamp, row.created));
    tickets.push(rowToTicket(row, comments, {
      ...getTicketRelationsForTicket(database, row.id),
      worker_stats: getTicketWorkerStats(database, row.id),
      current_workers: getCurrentWorkersForTicket(database, row.id),
    }));
  }
  return tickets;
}

export function getTicketById(id) {
  const database = getDb();
  const row = database.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(id));
  if (!row) return null;
  const comments = database.prepare(commentSelectSql()).all(row.id)
    .filter((comment) => !isCommentEarlierThanTicket(comment.timestamp, row.created));
  const parentRow = row.parent_ticket_id
    ? database.prepare('SELECT id, title, status, assigned_agent FROM tickets WHERE id = ?').get(row.parent_ticket_id)
    : null;
  const childRows = database.prepare(
    'SELECT id, title, status, assigned_agent FROM tickets WHERE parent_ticket_id = ? ORDER BY id'
  ).all(row.id);
  return rowToTicket(row, comments, {
    parent_ticket: summarizeTicketRow(parentRow),
    child_tickets: childRows.map((child) => summarizeTicketRow(child)),
    ...getTicketRelationsForTicket(database, row.id),
    worker_stats: getTicketWorkerStats(database, row.id),
    current_workers: getCurrentWorkersForTicket(database, row.id),
    execution_workers: getAllWorkersForTicket(database, row.id),
  });
}

export function createTicket(ticket) {
  const database = getDb();
  const now = new Date().toISOString();
  const execution = buildExecutionPersistence({
    ...ticket,
    created: ticket.created ?? now,
    last_update: ticket.last_update ?? now,
  }, { forcePolicy: true });
  const stmt = database.prepare(`
    INSERT INTO tickets (
      id,
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
      next_actor_override,
      priority,
      platform,
      request_type,
      triage_summary,
      implementation_scope,
      constraints_text,
      deliverables,
      acceptance_criteria,
      review_plan_json,
      review_state_json,
      parent_ticket_id,
      session_key,
      run_id,
      created,
      last_update,
      result_summary,
      error,
      watchers_json,
      locked_by,
      locked_at,
      paused_from_status,
      paused_by,
      paused_at,
      pause_reason,
      execution_mode,
      execution_mode_source,
      execution_rule_key,
      execution_matched_signals_json,
      max_active_workers
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const id = allocateId(database, 'tickets', 'tickets');
  stmt.run(
    id,
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
    ticket.next_actor_override ?? null,
    ticket.priority ?? 'medium',
    ticket.platform ?? null,
    ticket.request_type ?? null,
    ticket.triage_summary ?? '',
    ticket.implementation_scope ?? '',
    ticket.constraints ?? '',
    ticket.deliverables ?? '',
    ticket.acceptance_criteria ?? '',
    JSON.stringify(ticket.review_plan && typeof ticket.review_plan === 'object' ? ticket.review_plan : {}),
    JSON.stringify(ticket.review_state && typeof ticket.review_state === 'object' ? ticket.review_state : {}),
    ticket.parent_ticket_id ?? null,
    ticket.session_key ?? null,
    ticket.run_id ?? null,
    ticket.created ?? now,
    ticket.last_update ?? now,
    ticket.result_summary ?? null,
    ticket.error ?? null,
    JSON.stringify(Array.isArray(ticket.watchers) ? ticket.watchers : []),
    ticket.locked_by ?? null,
    ticket.locked_at ?? null,
    ticket.paused_from_status ?? null,
    ticket.paused_by ?? null,
    ticket.paused_at ?? null,
    ticket.pause_reason ?? null,
    execution.execution_mode,
    execution.execution_mode_source,
    execution.execution_rule_key,
    execution.execution_matched_signals_json,
    execution.max_active_workers,
  );
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
  const createdTicket = getTicketById(id);
  appendDomainEvent({
    event_type: 'ticket.created',
    aggregate_type: 'ticket',
    aggregate_id: String(id),
    aggregate_version: 1,
    producer: 'store',
    correlation_id: `ticket-${id}`,
    causation_id: null,
    idempotency_key: `ticket-${id}-created`,
    payload: {
      status: createdTicket?.status ?? ticket.status,
      triage_owner: createdTicket?.triage_owner ?? ticket.triage_owner,
      assigned_agent: createdTicket?.assigned_agent ?? ticket.assigned_agent,
      review_owner: createdTicket?.review_owner ?? ticket.review_owner,
    },
    occurred_at: now,
  });
  upsertTicketProjection(id, {
    status: createdTicket?.status ?? ticket.status,
    current_actor: createdTicket?.assigned_agent ?? ticket.assigned_agent ?? null,
    next_actor: createdTicket?.next_actor ?? ticket.next_actor ?? null,
    aggregate_version: 1,
  });
  return createdTicket;
}

export function updateTicket(id, updates) {
  const database = getDb();
  const existing = database.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(id));
  if (!existing) return null;
  const now = new Date().toISOString();
  const directAllowed = [
    'title', 'description', 'status', 'triage_owner', 'review_owner', 'decision_owner', 'decision_summary', 'decision_context', 'assigned_agent', 'next_actor', 'next_actor_override', 'priority',
    'platform', 'request_type', 'triage_summary', 'implementation_scope',
    'deliverables', 'acceptance_criteria', 'review_plan_json', 'review_state_json', 'parent_ticket_id',
    'session_key', 'run_id', 'result_summary', 'error', 'last_update', 'locked_by', 'locked_at',
    'paused_from_status', 'paused_by', 'paused_at', 'pause_reason',
    'review_plan', 'review_state',
  ];
  const mappedAllowed = {
    constraints: 'constraints_text',
  };
  const setParts = [];
  const values = [];
  for (const key of directAllowed) {
    if (updates[key] !== undefined) {
      setParts.push(`${key} = ?`);
      const v = updates[key];
      values.push((key === 'review_plan' || key === 'review_state') && v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
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

  const shouldRecomputeExecution = [
    'title', 'description', 'platform', 'request_type', 'triage_summary',
    'implementation_scope', 'constraints', 'deliverables', 'acceptance_criteria',
    'execution_mode', 'max_active_workers',
  ].some((key) => updates[key] !== undefined);

  if (shouldRecomputeExecution) {
    const merged = {
      ...existing,
      ...updates,
      constraints: updates.constraints !== undefined ? updates.constraints : existing.constraints_text,
      execution_matched_signals: parseJsonArray(existing.execution_matched_signals_json),
      execution_mode: updates.execution_mode !== undefined
        ? normalizeExecutionMode(updates.execution_mode)
        : existing.execution_mode,
      max_active_workers: updates.max_active_workers !== undefined
        ? updates.max_active_workers
        : existing.max_active_workers,
    };
    const execution = buildExecutionPersistence(merged, { forcePolicy: true });
    setParts.push('execution_mode = ?');
    values.push(execution.execution_mode);
    setParts.push('execution_mode_source = ?');
    values.push(execution.execution_mode_source);
    setParts.push('execution_rule_key = ?');
    values.push(execution.execution_rule_key);
    setParts.push('execution_matched_signals_json = ?');
    values.push(execution.execution_matched_signals_json);
    setParts.push('max_active_workers = ?');
    values.push(execution.max_active_workers);
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
  database.exec('DELETE FROM ticket_assignment_reports; DELETE FROM ticket_assignment_heartbeats; DELETE FROM ticket_assignments; DELETE FROM ticket_execution_workers; DELETE FROM ticket_relations; DELETE FROM ticket_comments; DELETE FROM tickets;');
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
    (id, ticket_id, author, timestamp, content, type, visibility, thread_id, mentions_json, notify_targets_json, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        JSON.stringify(normalized.notify_targets),
        JSON.stringify(normalized.metadata && typeof normalized.metadata === 'object' ? normalized.metadata : {})
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
  const run = database.transaction((ticketId) => {
    database.prepare('DELETE FROM ticket_comments WHERE ticket_id = ?').run(Number(ticketId));
    database.prepare('DELETE FROM ticket_execution_workers WHERE ticket_id = ?').run(Number(ticketId));
    database.prepare('DELETE FROM tickets WHERE id = ?').run(Number(ticketId));
  });
  run(id);
  return true;
}

export function deleteTickets(ids) {
  const database = getDb();
  const normalizedIds = ids.map(Number);
  const placeholders = normalizedIds.map(() => '?').join(',');
  const run = database.transaction((ticketIds) => {
    database.prepare(`DELETE FROM ticket_comments WHERE ticket_id IN (${placeholders})`).run(...ticketIds);
    database.prepare(`DELETE FROM ticket_execution_workers WHERE ticket_id IN (${placeholders})`).run(...ticketIds);
    const info = database.prepare(`DELETE FROM tickets WHERE id IN (${placeholders})`).run(...ticketIds);
    return info.changes;
  });
  return run(normalizedIds);
}

export function listExecutionWorkers(ticketId, options = {}) {
  const database = getDb();
  const baseSql = options.activeOnly
    ? `SELECT * FROM ticket_execution_workers WHERE ticket_id = ? AND status IN ('starting', 'running') ORDER BY updated_at DESC, id DESC`
    : `SELECT * FROM ticket_execution_workers WHERE ticket_id = ? ORDER BY created_at ASC, id ASC`;
  return database.prepare(baseSql).all(Number(ticketId)).map(workerRowToShape);
}

export function getExecutionWorker(ticketId, workerKey) {
  const database = getDb();
  const row = database.prepare(`
    SELECT * FROM ticket_execution_workers WHERE ticket_id = ? AND worker_key = ?
  `).get(Number(ticketId), String(workerKey));
  return workerRowToShape(row);
}

export function getExecutionWorkerStats(ticketId) {
  return getTicketWorkerStats(getDb(), Number(ticketId));
}

/** 将工单下所有 active (starting/running) execution workers 收为 terminal，用于 submit_for_review/执行阶段结束后恢复 reviewer dispatch */
export function terminateActiveExecutionWorkersForTicket(ticketId) {
  const database = getDb();
  const now = new Date().toISOString();
  const info = database.prepare(`
    UPDATE ticket_execution_workers
    SET status = 'succeeded', finished_at = ?, updated_at = ?
    WHERE ticket_id = ? AND status IN ('starting', 'running')
  `).run(now, now, Number(ticketId));
  if (info.changes > 0) {
    database.prepare('UPDATE tickets SET last_update = ? WHERE id = ?').run(now, Number(ticketId));
  }
  return info.changes;
}

export function registerExecutionWorker(ticketId, worker = {}) {
  const database = getDb();
  const ticket = getTicketById(ticketId);
  if (!ticket) {
    throw makeStoreError('TICKET_NOT_FOUND', '工单不存在', { statusCode: 404 });
  }

  const workerKey = String(worker.worker_key || '').trim();
  if (!workerKey) {
    throw makeStoreError('WORKER_KEY_REQUIRED', 'worker_key 不能为空', { statusCode: 400 });
  }

  const workerType = String(worker.worker_type || '').trim().toLowerCase();
  const validation = validateWorkerTypeForMode(ticket.execution_mode, workerType);
  if (!validation.ok) {
    throw makeStoreError('INVALID_WORKER_TYPE', validation.message, { statusCode: 409, expected_worker_type: validation.expected_worker_type || null });
  }

  const status = normalizeWorkerStatus(worker.status || 'starting');
  if (!status) {
    throw makeStoreError('INVALID_WORKER_STATUS', 'worker status 非法', { statusCode: 400 });
  }

  const activeStats = getTicketWorkerStats(database, ticket.id);
  if (isExecutionWorkerActiveStatus(status) && activeStats.active_workers >= ticket.max_active_workers) {
    throw makeStoreError('MAX_ACTIVE_WORKERS_EXCEEDED', `ticket #${ticket.id} 活跃 worker 已达到上限 ${ticket.max_active_workers}`, {
      statusCode: 409,
      active_workers: activeStats.active_workers,
      max_active_workers: ticket.max_active_workers,
    });
  }

  const now = new Date().toISOString();
  try {
    database.prepare(`
      INSERT INTO ticket_execution_workers (
        ticket_id, worker_key, worker_type, status, session_key, run_id, label, summary,
        started_at, last_heartbeat_at, finished_at, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ticket.id,
      workerKey,
      validation.worker_type,
      status,
      worker.session_key ?? null,
      worker.run_id ?? null,
      worker.label ?? null,
      worker.summary ?? null,
      worker.started_at ?? now,
      isExecutionWorkerActiveStatus(status) ? (worker.last_heartbeat_at ?? now) : (worker.last_heartbeat_at ?? null),
      worker.finished_at ?? null,
      JSON.stringify(worker.metadata && typeof worker.metadata === 'object' ? worker.metadata : {}),
      now,
      now,
    );
  } catch (err) {
    const message = String(err?.message || '');
    if (message.includes('UNIQUE constraint failed: ticket_execution_workers.ticket_id, ticket_execution_workers.worker_key')) {
      throw makeStoreError('WORKER_ALREADY_EXISTS', `worker_key 已存在：${workerKey}`, { statusCode: 409, worker_key: workerKey });
    }
    throw err;
  }

  database.prepare('UPDATE tickets SET last_update = ? WHERE id = ?').run(now, ticket.id);
  const aggregateId = `ticket:${ticket.id}:${workerKey}`;
  const version = getAggregateVersion('worker', aggregateId) + 1;
  appendDomainEvent({
    event_type: 'worker.started',
    aggregate_type: 'worker',
    aggregate_id: aggregateId,
    aggregate_version: version,
    producer: 'worker-registry',
    correlation_id: `ticket-${ticket.id}`,
    causation_id: null,
    idempotency_key: `worker-${ticket.id}-${workerKey}-started`,
    payload: { ticket_id: ticket.id, worker_key: workerKey, worker_type: validation.worker_type, status, session_key: worker.session_key ?? null, run_id: worker.run_id ?? null, started_at: worker.started_at ?? now },
    occurred_at: now,
  });
  upsertWorkerProjection(ticket.id, workerKey, {
    worker_type: validation.worker_type,
    status,
    session_key: worker.session_key ?? null,
    run_id: worker.run_id ?? null,
    started_at: worker.started_at ?? now,
    last_heartbeat_at: isExecutionWorkerActiveStatus(status) ? (worker.last_heartbeat_at ?? now) : null,
    finished_at: worker.finished_at ?? null,
  });
  return getExecutionWorker(ticket.id, workerKey);
}

export function updateExecutionWorker(ticketId, workerKey, updates = {}) {
  const database = getDb();
  const ticket = getTicketById(ticketId);
  if (!ticket) {
    throw makeStoreError('TICKET_NOT_FOUND', '工单不存在', { statusCode: 404 });
  }

  const existing = database.prepare(`
    SELECT * FROM ticket_execution_workers WHERE ticket_id = ? AND worker_key = ?
  `).get(Number(ticketId), String(workerKey));
  if (!existing) {
    throw makeStoreError('WORKER_NOT_FOUND', 'worker 不存在', { statusCode: 404 });
  }

  const nextType = updates.worker_type !== undefined
    ? String(updates.worker_type || '').trim().toLowerCase()
    : existing.worker_type;
  const validation = validateWorkerTypeForMode(ticket.execution_mode, nextType);
  if (!validation.ok) {
    throw makeStoreError('INVALID_WORKER_TYPE', validation.message, { statusCode: 409, expected_worker_type: validation.expected_worker_type || null });
  }

  const nextStatus = updates.status !== undefined ? normalizeWorkerStatus(updates.status) : existing.status;
  if (!nextStatus) {
    throw makeStoreError('INVALID_WORKER_STATUS', 'worker status 非法', { statusCode: 400 });
  }

  const existingActive = isExecutionWorkerActiveStatus(existing.status);
  const nextActive = isExecutionWorkerActiveStatus(nextStatus);
  if (!existingActive && nextActive) {
    const activeStats = getTicketWorkerStats(database, ticket.id);
    if (activeStats.active_workers >= ticket.max_active_workers) {
      throw makeStoreError('MAX_ACTIVE_WORKERS_EXCEEDED', `ticket #${ticket.id} 活跃 worker 已达到上限 ${ticket.max_active_workers}`, {
        statusCode: 409,
        active_workers: activeStats.active_workers,
        max_active_workers: ticket.max_active_workers,
      });
    }
  }

  const now = new Date().toISOString();
  const metadata = updates.metadata !== undefined
    ? (updates.metadata && typeof updates.metadata === 'object' ? updates.metadata : {})
    : parseJsonObject(existing.metadata_json, {});

  database.prepare(`
    UPDATE ticket_execution_workers
    SET worker_type = ?,
        status = ?,
        session_key = ?,
        run_id = ?,
        label = ?,
        summary = ?,
        last_heartbeat_at = ?,
        finished_at = ?,
        metadata_json = ?,
        updated_at = ?
    WHERE ticket_id = ? AND worker_key = ?
  `).run(
    validation.worker_type,
    nextStatus,
    updates.session_key !== undefined ? (updates.session_key ?? null) : existing.session_key,
    updates.run_id !== undefined ? (updates.run_id ?? null) : existing.run_id,
    updates.label !== undefined ? (updates.label ?? null) : existing.label,
    updates.summary !== undefined ? (updates.summary ?? null) : existing.summary,
    updates.last_heartbeat_at !== undefined
      ? (updates.last_heartbeat_at ?? null)
      : nextActive
        ? now
        : existing.last_heartbeat_at,
    updates.finished_at !== undefined
      ? (updates.finished_at ?? null)
      : nextActive
        ? null
        : existing.finished_at || now,
    JSON.stringify(metadata),
    now,
    Number(ticketId),
    String(workerKey),
  );

  database.prepare('UPDATE tickets SET last_update = ? WHERE id = ?').run(now, ticket.id);
  const aggregateId = `ticket:${ticketId}:${workerKey}`;
  const version = getAggregateVersion('worker', aggregateId) + 1;
  const eventType = nextStatus === 'finished' || nextStatus === 'failed' || nextStatus === 'cancelled'
    ? (nextStatus === 'failed' ? 'worker.failed' : 'worker.finished')
    : (updates.last_heartbeat_at !== undefined || nextActive ? 'worker.heartbeat' : null);
  if (eventType) {
    appendDomainEvent({
      event_type: eventType,
      aggregate_type: 'worker',
      aggregate_id: aggregateId,
      aggregate_version: version,
      producer: 'worker-registry',
      correlation_id: `ticket-${ticketId}`,
      causation_id: null,
      idempotency_key: `worker-${ticketId}-${workerKey}-${eventType}-${now}`,
      payload: {
        ticket_id: Number(ticketId),
        worker_key: workerKey,
        status: nextStatus,
        session_key: updates.session_key !== undefined ? updates.session_key : existing.session_key,
        run_id: updates.run_id !== undefined ? updates.run_id : existing.run_id,
        last_heartbeat_at: updates.last_heartbeat_at !== undefined ? updates.last_heartbeat_at : (nextActive ? now : existing.last_heartbeat_at),
        finished_at: updates.finished_at !== undefined ? updates.finished_at : (nextActive ? null : existing.finished_at || now),
      },
      occurred_at: now,
    });
  }
  upsertWorkerProjection(Number(ticketId), workerKey, {
    worker_type: validation.worker_type,
    status: nextStatus,
    session_key: updates.session_key !== undefined ? updates.session_key : existing.session_key,
    run_id: updates.run_id !== undefined ? updates.run_id : existing.run_id,
    started_at: existing.started_at,
    last_heartbeat_at: updates.last_heartbeat_at !== undefined ? updates.last_heartbeat_at : (nextActive ? now : existing.last_heartbeat_at),
    finished_at: updates.finished_at !== undefined ? updates.finished_at : (nextActive ? null : existing.finished_at || now),
  });
  return getExecutionWorker(ticket.id, workerKey);
}

export function getAssignmentById(assignmentId) {
  return assignmentRowToShape(getAssignmentRowById(getDb(), assignmentId));
}

export function getAssignmentByDispatchEventId(dispatchEventId) {
  return assignmentRowToShape(getAssignmentRowByDispatchEventId(getDb(), dispatchEventId));
}

export function findLatestAssignmentForTicket(ticketId, agentId = null) {
  const database = getDb();
  const params = [Number(ticketId)];
  const clauses = ['ticket_id = ?'];
  if (agentId) {
    clauses.push('agent_id = ?');
    params.push(String(agentId));
  }
  const row = database.prepare(`
    SELECT * FROM ticket_assignments
    WHERE ${clauses.join(' AND ')}
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(...params);
  return assignmentRowToShape(row);
}

export function createOrReuseAssignment(input = {}) {
  const database = getDb();
  const ticketId = Number(input.ticket_id ?? input.ticketId);
  const agentId = String(input.agent_id ?? input.agentId ?? '').trim();
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    throw makeStoreError('ASSIGNMENT_TICKET_REQUIRED', 'assignment 需要合法 ticket_id', { statusCode: 400 });
  }
  if (!agentId) {
    throw makeStoreError('ASSIGNMENT_AGENT_REQUIRED', 'assignment 需要合法 agent_id', { statusCode: 400 });
  }

  const dispatchEventId = input.dispatch_event_id ?? input.dispatchEventId ?? null;
  if (dispatchEventId !== null && dispatchEventId !== undefined) {
    const existing = getAssignmentRowByDispatchEventId(database, dispatchEventId);
    if (existing) return assignmentRowToShape(existing);
  }

  const ticket = getTicketById(ticketId);
  if (!ticket) {
    throw makeStoreError('TICKET_NOT_FOUND', '工单不存在', { statusCode: 404 });
  }

  const now = new Date().toISOString();
  const assignmentId = String(input.assignment_id ?? input.assignmentId ?? buildAssignmentId(ticketId, agentId));
  const assignmentToken = String(input.assignment_token ?? input.assignmentToken ?? buildAssignmentToken());

  try {
    database.prepare(`
      INSERT INTO ticket_assignments (
        assignment_id, ticket_id, dispatch_event_id, agent_id, gateway_id, execution_mode,
        assignment_status, intent, role, stage, assignment_token, target_session_key, transport,
        last_heartbeat_at, last_reported_at, latest_progress_json, last_error, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assignmentId,
      ticketId,
      dispatchEventId ?? null,
      agentId,
      input.gateway_id ?? input.gatewayId ?? null,
      input.execution_mode ?? input.executionMode ?? ticket.execution_mode ?? null,
      input.assignment_status ?? input.assignmentStatus ?? 'created',
      input.intent ?? 'dispatch',
      input.role ?? 'execute',
      input.stage ?? ticket.status ?? null,
      assignmentToken,
      input.target_session_key ?? input.targetSessionKey ?? null,
      input.transport ?? null,
      input.last_heartbeat_at ?? null,
      input.last_reported_at ?? null,
      JSON.stringify(input.latest_progress && typeof input.latest_progress === 'object' ? input.latest_progress : {}),
      input.last_error ?? null,
      input.created_at ?? now,
      input.updated_at ?? now,
      input.expires_at ?? null,
    );
  } catch (err) {
    const message = String(err?.message || '');
    if (dispatchEventId && message.includes('UNIQUE constraint failed: ticket_assignments.dispatch_event_id')) {
      return assignmentRowToShape(getAssignmentRowByDispatchEventId(database, dispatchEventId));
    }
    if (message.includes('UNIQUE constraint failed: ticket_assignments.assignment_id')) {
      return assignmentRowToShape(getAssignmentRowById(database, assignmentId));
    }
    throw err;
  }

  return getAssignmentById(assignmentId);
}

export function updateAssignment(assignmentId, updates = {}) {
  const database = getDb();
  const existing = getAssignmentRowById(database, assignmentId);
  if (!existing) return null;

  const directAllowed = [
    'dispatch_event_id', 'agent_id', 'gateway_id', 'execution_mode', 'assignment_status', 'intent',
    'role', 'stage', 'assignment_token', 'target_session_key', 'transport',
    'last_heartbeat_at', 'last_reported_at', 'last_error', 'expires_at',
  ];
  const setParts = [];
  const values = [];
  for (const key of directAllowed) {
    if (updates[key] !== undefined) {
      setParts.push(`${key} = ?`);
      values.push(updates[key]);
    }
  }
  if (updates.latest_progress !== undefined) {
    setParts.push('latest_progress_json = ?');
    values.push(JSON.stringify(updates.latest_progress && typeof updates.latest_progress === 'object' ? updates.latest_progress : {}));
  }

  if (setParts.length === 0) return getAssignmentById(assignmentId);
  setParts.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(String(assignmentId));
  database.prepare(`UPDATE ticket_assignments SET ${setParts.join(', ')} WHERE assignment_id = ?`).run(...values);
  return getAssignmentById(assignmentId);
}

export function markAssignmentDeliveredByDispatchEvent(dispatchEventId, updates = {}) {
  const assignment = getAssignmentByDispatchEventId(dispatchEventId);
  if (!assignment) return null;
  return updateAssignment(assignment.assignment_id, {
    assignment_status: updates.assignment_status ?? 'delivered',
    last_error: updates.last_error ?? null,
    ...(updates.stage !== undefined ? { stage: updates.stage } : {}),
    ...(updates.target_session_key !== undefined ? { target_session_key: updates.target_session_key } : {}),
    ...(updates.transport !== undefined ? { transport: updates.transport } : {}),
  });
}

export function markAssignmentDeliveryFailedByDispatchEvent(dispatchEventId, errorMessage) {
  const assignment = getAssignmentByDispatchEventId(dispatchEventId);
  if (!assignment) return null;
  return updateAssignment(assignment.assignment_id, {
    assignment_status: 'failed_delivery',
    last_error: errorMessage || null,
  });
}

export function getAssignmentHeartbeatByIdempotency(assignmentId, idempotencyKey) {
  return heartbeatRowToShape(getHeartbeatRowByIdempotency(getDb(), assignmentId, idempotencyKey));
}

export function recordAssignmentHeartbeat(assignmentId, input = {}) {
  const database = getDb();
  const assignment = getAssignmentRowById(database, assignmentId);
  if (!assignment) {
    throw makeStoreError('ASSIGNMENT_NOT_FOUND', 'assignment 不存在', { statusCode: 404 });
  }

  const idempotencyKey = String(input.idempotency_key || '').trim();
  if (!idempotencyKey) {
    throw makeStoreError('IDEMPOTENCY_KEY_REQUIRED', 'idempotency_key 不能为空', { statusCode: 400 });
  }

  const existing = getHeartbeatRowByIdempotency(database, assignment.assignment_id, idempotencyKey);
  if (existing) {
    return { heartbeat: heartbeatRowToShape(existing), idempotent: true, assignment: assignmentRowToShape(assignment) };
  }

  const now = new Date().toISOString();
  const progress = input.progress && typeof input.progress === 'object' ? input.progress : {};
  database.prepare(`
    INSERT INTO ticket_assignment_heartbeats (assignment_id, idempotency_key, progress_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(assignment.assignment_id, idempotencyKey, JSON.stringify(progress), now);

  const nextStatus = String(progress.status || '').trim() === 'in_progress'
    ? 'in_progress'
    : ['created', 'failed_delivery'].includes(assignment.assignment_status)
      ? 'acknowledged'
      : assignment.assignment_status;

  const updated = updateAssignment(assignment.assignment_id, {
    last_heartbeat_at: now,
    latest_progress: progress,
    assignment_status: nextStatus,
    last_error: null,
  });

  return {
    heartbeat: getAssignmentHeartbeatByIdempotency(assignment.assignment_id, idempotencyKey),
    idempotent: false,
    assignment: updated,
  };
}

export function getAssignmentReportByIdempotency(assignmentId, idempotencyKey) {
  return reportRowToShape(getReportRowByIdempotency(getDb(), assignmentId, idempotencyKey));
}

export function createAssignmentReport(assignmentId, input = {}) {
  const database = getDb();
  const assignment = getAssignmentRowById(database, assignmentId);
  if (!assignment) {
    throw makeStoreError('ASSIGNMENT_NOT_FOUND', 'assignment 不存在', { statusCode: 404 });
  }

  const idempotencyKey = String(input.idempotency_key || '').trim();
  if (!idempotencyKey) {
    throw makeStoreError('IDEMPOTENCY_KEY_REQUIRED', 'idempotency_key 不能为空', { statusCode: 400 });
  }

  const existing = getReportRowByIdempotency(database, assignment.assignment_id, idempotencyKey);
  if (existing) {
    return { report: reportRowToShape(existing), idempotent: true, assignment: assignmentRowToShape(assignment) };
  }

  const now = new Date().toISOString();
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const reportId = String(input.report_id || buildReportId());

  try {
    database.prepare(`
      INSERT INTO ticket_assignment_reports (
        report_id, assignment_id, ticket_id, report_type, idempotency_key, payload_json, interpreter_result_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reportId,
      assignment.assignment_id,
      assignment.ticket_id,
      input.report_type || 'progress_update',
      idempotencyKey,
      JSON.stringify(payload),
      null,
      now,
      now,
    );
  } catch (err) {
    const message = String(err?.message || '');
    if (message.includes('UNIQUE constraint failed: ticket_assignment_reports.assignment_id, ticket_assignment_reports.idempotency_key')) {
      return { report: getAssignmentReportByIdempotency(assignment.assignment_id, idempotencyKey), idempotent: true, assignment: assignmentRowToShape(assignment) };
    }
    throw err;
  }

  return { report: getAssignmentReportByIdempotency(assignment.assignment_id, idempotencyKey), idempotent: false, assignment: assignmentRowToShape(assignment) };
}

export function finalizeAssignmentReport(assignmentId, idempotencyKey, updates = {}) {
  const database = getDb();
  const existing = getReportRowByIdempotency(database, assignmentId, idempotencyKey);
  if (!existing) return null;

  const now = new Date().toISOString();
  database.prepare(`
    UPDATE ticket_assignment_reports
    SET interpreter_result_json = ?, updated_at = ?
    WHERE assignment_id = ? AND idempotency_key = ?
  `).run(
    JSON.stringify(updates.interpreter_result && typeof updates.interpreter_result === 'object' ? updates.interpreter_result : {}),
    now,
    String(assignmentId),
    String(idempotencyKey),
  );

  const assignmentUpdates = {
    last_reported_at: now,
    last_error: null,
  };
  if (updates.assignment_status !== undefined) assignmentUpdates.assignment_status = updates.assignment_status;
  if (updates.latest_progress !== undefined) assignmentUpdates.latest_progress = updates.latest_progress;
  updateAssignment(assignmentId, assignmentUpdates);

  return getAssignmentReportByIdempotency(assignmentId, idempotencyKey);
}

export function listAssignmentReports(assignmentId, { limit = 50 } = {}) {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM ticket_assignment_reports WHERE assignment_id = ? ORDER BY id DESC LIMIT ?
  `).all(String(assignmentId), Number(limit) || 50).map(reportRowToShape);
}

// ---------- 事件驱动：domain_events / commands / projections ----------

function generateEventId() {
  return `evt_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

function generateCommandId() {
  return `cmd_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

/**
 * Append a domain event. Idempotent by idempotency_key.
 * @param {object} envelope - { event_id?, event_type, aggregate_type, aggregate_id, aggregate_version, producer, correlation_id?, causation_id?, idempotency_key, payload, occurred_at? }
 * @returns {{ appended: boolean, event_id: string } | { idempotent: true, event_id: string }}
 */
export function appendDomainEvent(envelope = {}) {
  const database = getDb();
  const idempotencyKey = String(envelope.idempotency_key ?? '').trim();
  if (!idempotencyKey) {
    throw new Error('appendDomainEvent: idempotency_key is required');
  }
  const existing = database.prepare('SELECT event_id FROM domain_events WHERE idempotency_key = ?').get(idempotencyKey);
  if (existing) {
    return { idempotent: true, event_id: existing.event_id };
  }
  const eventId = envelope.event_id || generateEventId();
  const occurredAt = envelope.occurred_at || new Date().toISOString();
  const now = new Date().toISOString();
  const payloadJson = typeof envelope.payload === 'object' ? JSON.stringify(envelope.payload ?? {}) : String(envelope.payload ?? '{}');
  database.prepare(`
    INSERT INTO domain_events (event_id, event_type, aggregate_type, aggregate_id, aggregate_version, producer, correlation_id, causation_id, idempotency_key, payload_json, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    String(envelope.event_type ?? ''),
    String(envelope.aggregate_type ?? ''),
    String(envelope.aggregate_id ?? ''),
    Number(envelope.aggregate_version ?? 0),
    String(envelope.producer ?? ''),
    envelope.correlation_id != null ? String(envelope.correlation_id) : null,
    envelope.causation_id != null ? String(envelope.causation_id) : null,
    idempotencyKey,
    payloadJson,
    occurredAt,
    now,
  );
  return { appended: true, event_id: eventId };
}

/**
 * Append a command log entry. Idempotent by command_id (or idempotency_key if provided and unique).
 * @param {object} envelope - { command_id?, command_type, aggregate_type, aggregate_id, issuer_kind?, issuer_id?, correlation_id?, idempotency_key?, payload, result_status?, ... }
 * @returns {{ appended: boolean, command_id: string } | { idempotent: true, command_id: string }}
 */
export function appendCommandLog(envelope = {}) {
  const database = getDb();
  const commandId = envelope.command_id || generateCommandId();
  const existing = database.prepare('SELECT command_id FROM commands WHERE command_id = ?').get(commandId);
  if (existing) {
    return { idempotent: true, command_id: existing.command_id };
  }
  const idempotencyKey = envelope.idempotency_key != null ? String(envelope.idempotency_key) : null;
  const existingByKey = idempotencyKey ? database.prepare('SELECT command_id FROM commands WHERE idempotency_key = ?').get(idempotencyKey) : null;
  if (existingByKey) {
    return { idempotent: true, command_id: existingByKey.command_id };
  }
  const now = new Date().toISOString();
  const payloadJson = typeof envelope.payload === 'object' ? JSON.stringify(envelope.payload ?? {}) : String(envelope.payload ?? '{}');
  const issuerKind = envelope.issuer?.kind ?? envelope.issuer_kind;
  const issuerId = envelope.issuer?.id ?? envelope.issuer_id;
  database.prepare(`
    INSERT INTO commands (command_id, command_type, aggregate_type, aggregate_id, issuer_kind, issuer_id, correlation_id, idempotency_key, payload_json, result_status, result_error_code, result_error_message, created_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    commandId,
    String(envelope.command_type ?? ''),
    String(envelope.aggregate_type ?? ''),
    String(envelope.aggregate_id ?? ''),
    issuerKind != null ? String(issuerKind) : null,
    issuerId != null ? String(issuerId) : null,
    envelope.correlation_id != null ? String(envelope.correlation_id) : null,
    idempotencyKey,
    payloadJson,
    envelope.result_status ?? null,
    envelope.result_error_code ?? null,
    envelope.result_error_message ?? null,
    now,
    envelope.finished_at ?? null,
  );
  return { appended: true, command_id: commandId };
}

/**
 * 追加一条 assignment write validation 审计记录
 * @param {Object} entry - { at, kind, assignment_id, ticket_id, passed, errors, codes, stale, stale_reason }
 * @returns {string|number} 审计记录 id
 */
export function appendValidationAudit(entry = {}) {
  const database = getDb();
  const now = new Date().toISOString();
  const at = entry.at || now;
  const kind = String(entry.kind ?? 'unknown').slice(0, 64);
  const assignmentId = entry.assignment_id != null ? String(entry.assignment_id) : null;
  const ticketId = entry.ticket_id != null ? Number(entry.ticket_id) : null;
  const passed = entry.passed === true ? 1 : 0;
  const errorsJson = JSON.stringify(Array.isArray(entry.errors) ? entry.errors : []);
  const codesJson = JSON.stringify(Array.isArray(entry.codes) ? entry.codes : []);
  const stale = entry.stale === true ? 1 : entry.stale === false ? 0 : null;
  const staleReason = entry.stale_reason != null ? String(entry.stale_reason).slice(0, 255) : null;
  const info = database.prepare(`
    INSERT INTO validation_audit (at, kind, assignment_id, ticket_id, passed, errors_json, codes_json, stale, stale_reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(at, kind, assignmentId, ticketId, passed, errorsJson, codesJson, stale, staleReason, now);
  return info.lastInsertRowid;
}

/**
 * Get a command by command_id.
 */
export function getCommandById(commandId) {
  const database = getDb();
  const row = database.prepare('SELECT * FROM commands WHERE command_id = ?').get(String(commandId));
  if (!row) return null;
  return {
    command_id: row.command_id,
    command_type: row.command_type,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.aggregate_id,
    issuer_kind: row.issuer_kind,
    issuer_id: row.issuer_id,
    correlation_id: row.correlation_id,
    idempotency_key: row.idempotency_key,
    payload: parseJsonObject(row.payload_json, {}),
    result_status: row.result_status,
    result_error_code: row.result_error_code,
    result_error_message: row.result_error_message,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}

/**
 * Get pending commands (result_status IS NULL), optionally by aggregate_type, limit.
 */
export function getPendingCommands(options = {}) {
  const database = getDb();
  const limit = Number(options.limit) || 50;
  const aggregateType = options.aggregate_type;
  let sql = 'SELECT * FROM commands WHERE result_status IS NULL';
  const params = [];
  if (aggregateType) {
    sql += ' AND aggregate_type = ?';
    params.push(String(aggregateType));
  }
  sql += ' ORDER BY created_at ASC LIMIT ?';
  params.push(limit);
  return database.prepare(sql).all(...params).map((row) => ({
    command_id: row.command_id,
    command_type: row.command_type,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.aggregate_id,
    issuer_kind: row.issuer_kind,
    issuer_id: row.issuer_id,
    correlation_id: row.correlation_id,
    idempotency_key: row.idempotency_key,
    payload: parseJsonObject(row.payload_json, {}),
    result_status: row.result_status,
    created_at: row.created_at,
  }));
}

/**
 * Update command result (e.g. after handler execution).
 */
export function updateCommandResult(commandId, result = {}) {
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE commands
    SET result_status = ?, result_error_code = ?, result_error_message = ?, finished_at = ?
    WHERE command_id = ?
  `).run(
    result.result_status ?? null,
    result.result_error_code ?? null,
    result.result_error_message ?? null,
    now,
    String(commandId),
  );
}

/**
 * Get current aggregate version from domain_events for an aggregate (max aggregate_version).
 */
export function getAggregateVersion(aggregateType, aggregateId) {
  const database = getDb();
  const row = database.prepare(`
    SELECT COALESCE(MAX(aggregate_version), 0) AS v FROM domain_events WHERE aggregate_type = ? AND aggregate_id = ?
  `).get(String(aggregateType ?? ''), String(aggregateId ?? ''));
  return Number(row?.v ?? 0);
}

/**
 * Replace dispatch_ready_projection rows for a ticket (delete then insert) or insert one row.
 */
export function replaceDispatchReadyProjectionForTicket(ticketId, rows) {
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare('DELETE FROM dispatch_ready_projection WHERE ticket_id = ?').run(Number(ticketId));
  const insert = database.prepare(`
    INSERT INTO dispatch_ready_projection (ticket_id, dispatch_id, assignment_id, agent, stage, target_session_key, target_gateway_id, delivery_intent, reason, dedupe_key, escalation_tier, kind, workflow_mismatch_json, message, assignment_contract_json, reset_session, session_reset_reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of Array.isArray(rows) ? rows : []) {
    insert.run(
      Number(ticketId),
      Number(r.dispatch_id ?? 0),
      r.assignment_id != null ? String(r.assignment_id) : null,
      String(r.agent ?? ''),
      r.stage != null ? String(r.stage) : null,
      r.target_session_key != null ? String(r.target_session_key) : null,
      r.target_gateway_id != null ? String(r.target_gateway_id) : null,
      r.delivery_intent != null ? String(r.delivery_intent) : null,
      r.reason != null ? String(r.reason) : null,
      r.dedupe_key != null ? String(r.dedupe_key) : '',
      r.escalation_tier != null ? String(r.escalation_tier) : null,
      r.kind != null ? String(r.kind) : null,
      r.workflow_mismatch != null ? JSON.stringify(r.workflow_mismatch) : null,
      r.message != null ? String(r.message) : null,
      r.assignment_contract != null ? JSON.stringify(r.assignment_contract) : null,
      r.reset_session ? 1 : 0,
      r.session_reset_reason != null ? String(r.session_reset_reason) : null,
      now,
    );
  }
}

/**
 * Replace entire dispatch_ready_projection with given rows (e.g. after building legacy ready).
 */
export function replaceAllDispatchReadyProjection(rows) {
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare('DELETE FROM dispatch_ready_projection').run();
  const insert = database.prepare(`
    INSERT INTO dispatch_ready_projection (ticket_id, dispatch_id, assignment_id, agent, stage, target_session_key, target_gateway_id, delivery_intent, reason, dedupe_key, escalation_tier, kind, workflow_mismatch_json, message, assignment_contract_json, reset_session, session_reset_reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of Array.isArray(rows) ? rows : []) {
    insert.run(
      Number(r.ticket_id),
      Number(r.dispatch_id ?? 0),
      r.assignment_id != null ? String(r.assignment_id) : null,
      String(r.agent ?? ''),
      r.stage != null ? String(r.stage) : null,
      r.target_session_key != null ? String(r.target_session_key) : null,
      r.target_gateway_id != null ? String(r.target_gateway_id) : null,
      r.delivery_intent != null ? String(r.delivery_intent) : null,
      r.reason != null ? String(r.reason) : null,
      r.dedupe_key != null ? String(r.dedupe_key) : '',
      r.escalation_tier != null ? String(r.escalation_tier) : null,
      r.kind != null ? String(r.kind) : null,
      r.workflow_mismatch != null ? JSON.stringify(r.workflow_mismatch) : null,
      r.message != null ? String(r.message) : null,
      r.assignment != null ? JSON.stringify(r.assignment) : null,
      r.reset_session ? 1 : 0,
      r.session_reset_reason != null ? String(r.session_reset_reason) : null,
      now,
    );
  }
}

export function getDispatchReadyProjection() {
  const database = getDb();
  return database.prepare(`
    SELECT ticket_id, dispatch_id, assignment_id, agent, stage, target_session_key, target_gateway_id, delivery_intent, reason, dedupe_key, escalation_tier, kind, workflow_mismatch_json, message, assignment_contract_json, reset_session, session_reset_reason, created_at
    FROM dispatch_ready_projection ORDER BY created_at ASC
  `).all().map((row) => ({
    ticket_id: row.ticket_id,
    dispatch_id: row.dispatch_id,
    assignment_id: row.assignment_id,
    agent: row.agent,
    stage: row.stage,
    target_session_key: row.target_session_key,
    target_gateway_id: row.target_gateway_id,
    delivery_intent: row.delivery_intent,
    reason: row.reason,
    dedupe_key: row.dedupe_key || '',
    escalation_tier: row.escalation_tier,
    kind: row.kind,
    workflow_mismatch: row.workflow_mismatch_json ? parseJsonObject(row.workflow_mismatch_json) : null,
    message: row.message,
    assignment: row.assignment_contract_json ? parseJsonObject(row.assignment_contract_json) : null,
    reset_session: Boolean(row.reset_session),
    session_reset_reason: row.session_reset_reason,
    created_at: row.created_at,
  }));
}

export function upsertTicketProjection(ticketId, data = {}) {
  const database = getDb();
  const now = new Date().toISOString();
  const version = Number(data.aggregate_version ?? getAggregateVersion('ticket', String(ticketId)));
  const actionsJson = Array.isArray(data.available_actions) ? JSON.stringify(data.available_actions) : (typeof data.available_actions_json === 'string' ? data.available_actions_json : '[]');
  const workerStatsJson = data.worker_stats && typeof data.worker_stats === 'object' ? JSON.stringify(data.worker_stats) : (data.worker_stats_json || '{}');
  database.prepare(`
    INSERT INTO ticket_projection (ticket_id, status, current_actor, next_actor, dispatch_state, available_actions_json, worker_stats_json, latest_effective_worker_key, aggregate_version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticket_id) DO UPDATE SET
      status = excluded.status,
      current_actor = excluded.current_actor,
      next_actor = excluded.next_actor,
      dispatch_state = excluded.dispatch_state,
      available_actions_json = excluded.available_actions_json,
      worker_stats_json = excluded.worker_stats_json,
      latest_effective_worker_key = excluded.latest_effective_worker_key,
      aggregate_version = excluded.aggregate_version,
      updated_at = excluded.updated_at
  `).run(
    Number(ticketId),
    String(data.status ?? ''),
    data.current_actor != null ? String(data.current_actor) : null,
    data.next_actor != null ? String(data.next_actor) : null,
    data.dispatch_state != null ? String(data.dispatch_state) : null,
    actionsJson,
    workerStatsJson,
    data.latest_effective_worker_key != null ? String(data.latest_effective_worker_key) : null,
    version,
    now,
  );
}

export function getTicketProjection(ticketId) {
  const database = getDb();
  const row = database.prepare('SELECT * FROM ticket_projection WHERE ticket_id = ?').get(Number(ticketId));
  if (!row) return null;
  return {
    ticket_id: row.ticket_id,
    status: row.status,
    current_actor: row.current_actor,
    next_actor: row.next_actor,
    dispatch_state: row.dispatch_state,
    available_actions: row.available_actions_json ? parseJsonObject(row.available_actions_json, []) : [],
    worker_stats: row.worker_stats_json ? parseJsonObject(row.worker_stats_json, {}) : {},
    latest_effective_worker_key: row.latest_effective_worker_key,
    aggregate_version: row.aggregate_version,
    updated_at: row.updated_at,
  };
}

export function upsertWorkerProjection(ticketId, workerKey, data = {}) {
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO worker_projection (ticket_id, worker_key, worker_type, status, session_key, run_id, started_at, last_heartbeat_at, finished_at, replacement_for, is_latest, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(ticket_id, worker_key) DO UPDATE SET
      worker_type = excluded.worker_type,
      status = excluded.status,
      session_key = excluded.session_key,
      run_id = excluded.run_id,
      started_at = excluded.started_at,
      last_heartbeat_at = excluded.last_heartbeat_at,
      finished_at = excluded.finished_at,
      replacement_for = excluded.replacement_for,
      is_latest = 1,
      updated_at = excluded.updated_at
  `).run(
    Number(ticketId),
    String(workerKey ?? ''),
    data.worker_type != null ? String(data.worker_type) : null,
    String(data.status ?? ''),
    data.session_key != null ? String(data.session_key) : null,
    data.run_id != null ? String(data.run_id) : null,
    data.started_at != null ? String(data.started_at) : null,
    data.last_heartbeat_at != null ? String(data.last_heartbeat_at) : null,
    data.finished_at != null ? String(data.finished_at) : null,
    data.replacement_for != null ? String(data.replacement_for) : null,
    now,
  );
}

export function replaceAllAuditReadyProjection(rows) {
  const database = getDb();
  database.prepare('DELETE FROM audit_ready_projection').run();
  const insert = database.prepare(`
    INSERT INTO audit_ready_projection (ticket_id, audit_id, audit_type, status_snapshot, stale_minutes, suggested_status, suggested_actor, suggested_action, reason, confidence, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  for (const r of Array.isArray(rows) ? rows : []) {
    insert.run(
      Number(r.ticket_id),
      Number(r.audit_id ?? 0),
      String(r.audit_type ?? ''),
      r.status != null ? String(r.status) : null,
      r.stale_minutes != null ? Number(r.stale_minutes) : null,
      r.suggested_status ?? null,
      r.suggested_actor ?? null,
      r.suggested_action ?? null,
      r.reason ?? null,
      r.confidence ?? null,
      r.summary ?? null,
      now,
    );
  }
}

export function getAuditReadyProjection() {
  const database = getDb();
  return database.prepare(`
    SELECT ticket_id, audit_id, audit_type, status_snapshot, stale_minutes, suggested_status, suggested_actor, suggested_action, reason, confidence, summary, created_at
    FROM audit_ready_projection ORDER BY created_at ASC
  `).all().map((row) => ({
    ticket_id: row.ticket_id,
    audit_id: row.audit_id,
    audit_type: row.audit_type,
    status: row.status_snapshot,
    stale_minutes: row.stale_minutes,
    suggested_status: row.suggested_status,
    suggested_actor: row.suggested_actor,
    suggested_action: row.suggested_action,
    reason: row.reason,
    confidence: row.confidence,
    summary: row.summary,
    created_at: row.created_at,
  }));
}

export function getWorkerProjectionForTicket(ticketId) {
  const database = getDb();
  return database.prepare(`
    SELECT ticket_id, worker_key, worker_type, status, session_key, run_id, started_at, last_heartbeat_at, finished_at, replacement_for, updated_at
    FROM worker_projection WHERE ticket_id = ? AND is_latest = 1 ORDER BY updated_at DESC
  `).all(Number(ticketId)).map((row) => ({
    ticket_id: row.ticket_id,
    worker_key: row.worker_key,
    worker_type: row.worker_type,
    status: row.status,
    session_key: row.session_key,
    run_id: row.run_id,
    started_at: row.started_at,
    last_heartbeat_at: row.last_heartbeat_at,
    finished_at: row.finished_at,
    replacement_for: row.replacement_for,
    updated_at: row.updated_at,
  }));
}

// 关系建模：补充验证 / smoke / review sample
export function addTicketRelation(sourceTicketId, targetTicketId, relationType) {
  const database = getDb();
  const sourceId = Number(sourceTicketId);
  const targetId = Number(targetTicketId);
  const normalizedRelationType = String(relationType || '').trim();

  if (!Number.isInteger(sourceId) || sourceId <= 0 || !Number.isInteger(targetId) || targetId <= 0) {
    throw new Error('source_ticket_id 和 target_ticket_id 必须是正整数');
  }
  if (sourceId === targetId) {
    throw new Error('source_ticket_id 不能等于 target_ticket_id');
  }
  if (!isSupportedTicketRelationType(normalizedRelationType)) {
    throw new Error(`relation_type 非法：${normalizedRelationType || '(empty)'}`);
  }

  const now = new Date().toISOString();
  try {
    database.prepare(`
      INSERT INTO ticket_relations (source_ticket_id, target_ticket_id, relation_type, created_at)
      VALUES (?, ?, ?, ?)
    `).run(sourceId, targetId, normalizedRelationType, now);
    return true;
  } catch (err) {
    const message = String(err?.message || '');
    if (message.includes('UNIQUE constraint failed')) {
      return false;
    }
    throw err;
  }
}

export function removeTicketRelation(sourceTicketId, targetTicketId, relationType) {
  const database = getDb();
  const info = database.prepare(`
    DELETE FROM ticket_relations
    WHERE source_ticket_id = ? AND target_ticket_id = ? AND relation_type = ?
  `).run(Number(sourceTicketId), Number(targetTicketId), String(relationType || '').trim());
  return info.changes > 0;
}

export function getTicketRelations(ticketId) {
  return getTicketRelationsForTicket(getDb(), Number(ticketId));
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
