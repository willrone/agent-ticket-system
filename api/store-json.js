/**
 * 工单 JSON 文件持久化
 * 最小字段：id, title, description, status, assigned_agent, 分诊结构化字段, session_key, run_id, last_update, result_summary, error, comments
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = process.env.TICKETS_JSON_PATH || path.join(__dirname, '..', 'data', 'tickets.json');

function ensureDir() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readAll() {
  ensureDir();
  if (!fs.existsSync(STORE_PATH)) {
    return [];
  }
  const raw = fs.readFileSync(STORE_PATH, 'utf8');
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeAll(tickets) {
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(tickets, null, 2), 'utf8');
}

function normalizeComment(comment = {}) {
  return {
    id: comment.id ?? Date.now(),
    author: comment.author ?? 'Current User',
    timestamp: comment.timestamp ?? new Date().toISOString(),
    content: comment.content ?? '',
    type: comment.type ?? 'progress',
    visibility: comment.visibility ?? 'internal',
    thread_id: comment.thread_id ?? null,
    mentions: Array.isArray(comment.mentions) ? comment.mentions : [],
    notify_targets: Array.isArray(comment.notify_targets) ? comment.notify_targets : [],
  };
}

export function getAllTickets() {
  return readAll();
}

export function getTicketById(id) {
  const tickets = readAll();
  return tickets.find((t) => String(t.id) === String(id)) || null;
}

export function createTicket(ticket) {
  const tickets = readAll();
  const nextId = tickets.length > 0 ? Math.max(...tickets.map((t) => t.id)) + 1 : 1;
  const now = new Date().toISOString();
  const t = {
    id: nextId,
    title: ticket.title || '',
    description: ticket.description || '',
    status: ticket.status || 'queued',
    assigned_agent: ticket.assigned_agent || null,
    priority: ticket.priority || 'medium',
    platform: ticket.platform || null,
    request_type: ticket.request_type || null,
    triage_summary: ticket.triage_summary || '',
    implementation_scope: ticket.implementation_scope || '',
    constraints: ticket.constraints || '',
    deliverables: ticket.deliverables || '',
    acceptance_criteria: ticket.acceptance_criteria || '',
    parent_ticket_id: ticket.parent_ticket_id || null,
    session_key: ticket.session_key || null,
    run_id: ticket.run_id || null,
    created: ticket.created || now,
    last_update: ticket.last_update || now,
    result_summary: ticket.result_summary || null,
    error: ticket.error || null,
    watchers: Array.isArray(ticket.watchers) ? ticket.watchers : [],
    comments: (ticket.comments || []).map(normalizeComment),
  };
  tickets.push(t);
  writeAll(tickets);
  return t;
}

export function updateTicket(id, updates) {
  const tickets = readAll();
  const idx = tickets.findIndex((t) => String(t.id) === String(id));
  if (idx < 0) return null;
  const now = new Date().toISOString();
  const merged = { ...tickets[idx], ...updates, last_update: now };
  if (updates.watchers !== undefined) {
    merged.watchers = Array.isArray(updates.watchers) ? updates.watchers : tickets[idx].watchers || [];
  }
  tickets[idx] = merged;
  writeAll(tickets);
  return tickets[idx];
}

export function addComment(ticketId, comment) {
  const tickets = readAll();
  const idx = tickets.findIndex((t) => String(t.id) === String(ticketId));
  if (idx < 0) return null;
  const comments = tickets[idx].comments || [];
  comments.push(normalizeComment(comment));
  tickets[idx] = { ...tickets[idx], comments, last_update: new Date().toISOString() };
  writeAll(tickets);
  return tickets[idx];
}
