/**
 * Express 应用 - 导出 app 供测试使用，server.js 仅负责 listen
 */
import express from 'express';
import * as store from './store.js';
import { getBots } from './bots.js';
import {
  COMMENT_TYPES,
  COMMENT_VISIBILITY,
  COMMENT_MAX_LENGTH,
  THREAD_ID_MAX_LENGTH,
  AUTHOR_MAX_LENGTH,
  isValidCommentType,
  isValidVisibility,
} from '../constants/comments.js';
import { normalizeCommentShape, buildCommentId } from './comment-utils.js';
import { DEFAULT_TRIAGE_OWNER, TICKET_STATUSES, enrichTicketRouting } from './ticket-routing.js';
import { detectWorkflowMismatch } from './workflow-mismatch.js';
import * as dispatch from './dispatch.js';
import { TRANSITIONS, transition, getAvailableActions } from './state-machine.js';
import { broadcastTicketStatusChanged, broadcastTicketComment } from './websocket.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const ALLOWED_TICKET_STATUSES = TICKET_STATUSES;
const ALLOWED_REQUEST_TYPES = ['feature', 'bug', 'optimization', 'ops'];
const OPEN_TICKET_STATUSES = new Set(['triage', 'queued', 'review', 'blocked', 'failed']);

function parseCsvParam(value) {
  if (typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeOptionalText(value, maxLength = 20000) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text.slice(0, maxLength);
}

function normalizeOptionalAgent(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, 120) : null;
}

function normalizeParentTicketId(value) {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === '') return { ok: true, value: null };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, message: 'parent_ticket_id 必须是正整数或 null' };
  }
  return { ok: true, value: parsed };
}

function formatTicketForList(t) {
  const ticket = enrichTicketRouting(t);
  const workflow_mismatch = detectWorkflowMismatch(ticket);
  return {
    ...ticket,
    bot: ticket.assigned_agent,
    created: ticket.created || ticket.last_update,
    priority: ticket.priority || 'medium',
    progress: ticket.status === 'done' ? 100 : ticket.status === 'review' ? 80 : ticket.status === 'running' ? 50 : ticket.status === 'triage' ? 10 : 0,
    workflow_mismatch: workflow_mismatch || undefined,
  };
}

function matchesTicketFilters(ticket, query = {}) {
  const statusFilters = parseCsvParam(query.status);
  if (statusFilters.length > 0 && !statusFilters.includes(ticket.status)) return false;

  const nextActor = normalizeOptionalAgent(query.next_actor);
  if (nextActor && ticket.next_actor !== nextActor) return false;

  const nextActorSource = normalizeOptionalText(query.next_actor_source, 120);
  if (nextActorSource && ticket.next_actor_source !== nextActorSource) return false;

  const triageOwner = normalizeOptionalAgent(query.triage_owner);
  if (triageOwner && ticket.triage_owner !== triageOwner) return false;

  const assignedAgent = normalizeOptionalAgent(query.assigned_agent);
  if (assignedAgent && ticket.assigned_agent !== assignedAgent) return false;

  if (String(query.actionable || '').toLowerCase() === 'true' && !ticket.should_notify) return false;

  return true;
}

function normalizeMentions(mentions = [], content = '') {
  const explicit = Array.isArray(mentions) ? mentions : [];
  const parsed = [...String(content || '').matchAll(/@([^\s@,，。！？；;:：]{1,64})/gu)].map((m) => m[1]);
  return [...new Set([...explicit, ...parsed].map((s) => String(s).trim()).filter(Boolean))];
}

function normalizeComment(comment = {}) {
  return normalizeCommentShape(comment);
}

// GET /api/bots
app.get('/api/bots', async (_req, res) => {
  try {
    const bots = await getBots();
    res.json(bots);
  } catch (err) {
    console.error('[API] /api/bots 失败:', err.message);
    res.status(500).json({ error: 'Failed to fetch bots', message: err.message });
  }
});

// GET /api/metrics/dashboard
function computeDashboardMetrics() {
  const tickets = store.getAllTickets().map((ticket) => enrichTicketRouting(ticket));
  const open = tickets.filter((t) => OPEN_TICKET_STATUSES.has(t.status)).length;
  const inProgress = tickets.filter((t) => t.status === 'running').length;
  const resolved = tickets.filter((t) => t.status === 'done').length;
  const stats = { total: tickets.length, open, inProgress, resolved };

  const dayCounts = {};
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dayCounts[key] = { day: key, tickets: 0 };
  }
  for (const t of tickets) {
    const created = t.created || t.last_update || '';
    const m = created.match(/^(\d{4}-\d{2}-\d{2})/);
    const key = m ? m[1] : null;
    if (key && dayCounts[key]) dayCounts[key].tickets += 1;
  }
  const weeklyTickets = Object.values(dayCounts).sort((a, b) => a.day.localeCompare(b.day));

  const statusDistribution = [
    { name: 'Open', value: open, color: '#ef4444' },
    { name: 'In Progress', value: inProgress, color: '#f59e0b' },
    { name: 'Resolved', value: resolved, color: '#22c55e' },
  ].filter((x) => x.value > 0);

  return { stats, weeklyTickets, statusDistribution };
}

app.get('/api/metrics/dashboard', (_req, res) => {
  res.json({ data: computeDashboardMetrics() });
});

// GET /api/tickets
app.get('/api/tickets', (req, res) => {
  const tickets = store.getAllTickets()
    .map(formatTicketForList)
    .filter((ticket) => matchesTicketFilters(ticket, req.query))
    .sort((a, b) => {
      const aTs = Date.parse(a.created || '') || 0;
      const bTs = Date.parse(b.created || '') || 0;
      if (bTs !== aTs) return bTs - aTs;
      return (Number(b.id) || 0) - (Number(a.id) || 0);
    });
  res.json(tickets);
});

// GET /api/notifications/summary?minutes=60
app.get('/api/notifications/summary', (req, res) => {
  const minutes = Math.max(1, parseInt(req.query.minutes || '60', 10) || 60);
  const now = Date.now();
  const fromTs = now - minutes * 60 * 1000;

  const all = store.getAllTickets();
  const recent = all.filter((t) => {
    const ts = Date.parse(t.last_update || t.created || '');
    if (!Number.isFinite(ts)) return false;
    return ts >= fromTs;
  }).map((t) => enrichTicketRouting(t));

  const byStatus = {
    done: recent.filter((t) => t.status === 'done'),
    complete: recent.filter((t) => t.status === 'complete'),
    failed: recent.filter((t) => t.status === 'failed'),
    pending_decision: recent.filter((t) => t.status === 'pending_decision'),
  };

  const normalize = (t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    triage_owner: t.triage_owner,
    review_owner: t.review_owner || null,
    decision_owner: t.decision_owner || null,
    assigned_agent: t.assigned_agent,
    next_actor: t.next_actor,
    next_actor_source: t.next_actor_source,
    last_update: t.last_update,
    result_summary: t.result_summary || null,
    error: t.error || null,
    decision_summary: t.decision_summary || null,
  });

  res.json({
    windowMinutes: minutes,
    generatedAt: new Date(now).toISOString(),
    counts: {
      done: byStatus.done.length,
      complete: byStatus.complete.length,
      failed: byStatus.failed.length,
      pending_decision: byStatus.pending_decision.length,
      total: byStatus.done.length + byStatus.complete.length + byStatus.failed.length + byStatus.pending_decision.length,
    },
    items: {
      done: byStatus.done.map(normalize),
      complete: byStatus.complete.map(normalize),
      failed: byStatus.failed.map(normalize),
      pending_decision: byStatus.pending_decision.map(normalize),
    },
  });
});

// GET /api/tickets/pull - Agent 拉取待处理工单（必须在 /api/tickets/:id 之前）
app.get('/api/tickets/pull', (req, res) => {
  const { agent, limit = 1 } = req.query;
  if (!agent) {
    return res.status(400).json({ error: 'Bad request', message: 'agent 参数必填' });
  }
  const tickets = store.getAllTickets()
    .filter((t) => t.status === 'queued' && t.assigned_agent === agent)
    .sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
    })
    .slice(0, parseInt(limit, 10) || 1);
  res.json(tickets.map(formatTicketForList));
});

// GET /api/tickets/:id/status - 必须在 /api/tickets/:id 之前
app.get('/api/tickets/:id/status', (req, res) => {
  const id = req.params.id;
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }
  const enriched = enrichTicketRouting(ticket);
  res.json({
    status: enriched.status,
    session_key: enriched.session_key,
    result_summary: enriched.result_summary,
    last_update: enriched.last_update,
    run_id: enriched.run_id,
    triage_owner: enriched.triage_owner,
    assigned_agent: enriched.assigned_agent,
    next_actor: enriched.next_actor,
    next_actor_override: enriched.next_actor_override,
    next_actor_source: enriched.next_actor_source,
    should_notify: enriched.should_notify,
    error: enriched.error,
  });
});

// GET /api/tickets/:id
app.get('/api/tickets/:id', (req, res) => {
  const id = req.params.id;
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }
  const enriched = enrichTicketRouting(ticket);
  const workflow_mismatch = detectWorkflowMismatch(enriched);
  const detail = {
    ...enriched,
    updated: enriched.updated || enriched.last_update,
    assignee: enriched.assigned_agent || null,
    reporter: null,
    tags: [],
    attachments: [],
    watchers: enriched.watchers || [],
    comments: (enriched.comments || []).map(normalizeComment),
    workflow_mismatch: workflow_mismatch || undefined,
  };
  res.json(detail);
});

// GET /api/tickets/:id/comments?type=blocker&visibility=internal&thread_id=xxx
app.get('/api/tickets/:id/comments', (req, res) => {
  const id = req.params.id;
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }

  const { type, visibility, thread_id } = req.query;
  if (type && !COMMENT_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Bad request', message: 'type 非法' });
  }
  if (visibility && !COMMENT_VISIBILITY.includes(visibility)) {
    return res.status(400).json({ error: 'Bad request', message: 'visibility 非法' });
  }
  if (thread_id && String(thread_id).length > THREAD_ID_MAX_LENGTH) {
    return res.status(400).json({ error: 'Bad request', message: 'thread_id 过长' });
  }

  let comments = (ticket.comments || []).map(normalizeComment);

  if (type) comments = comments.filter((c) => c.type === type);
  if (visibility) comments = comments.filter((c) => c.visibility === visibility);
  if (thread_id) comments = comments.filter((c) => String(c.thread_id || '') === String(thread_id));

  res.json({
    ticket_id: Number(id),
    filters: {
      type: type || null,
      visibility: visibility || null,
      thread_id: thread_id || null,
    },
    total: comments.length,
    comments,
  });
});

// POST /api/tickets - 创建工单，立即返回（Pull 模式：status: queued）
app.post('/api/tickets', (req, res) => {
  const {
    title,
    description,
    agent,
    status,
    triage_owner,
    review_owner,
    decision_owner,
    decision_summary,
    decision_context,
    assigned_agent,
    next_actor,
    platform,
    request_type,
    triage_summary,
    implementation_scope,
    constraints,
    deliverables,
    acceptance_criteria,
    parent_ticket_id,
  } = req.body || {};
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Bad request', message: '工单标题不能为空' });
  }
  if (status !== undefined && !ALLOWED_TICKET_STATUSES.includes(status)) {
    return res.status(400).json({
      error: 'Bad request',
      message: `status 非法，允许值：${ALLOWED_TICKET_STATUSES.join('/')}`,
    });
  }
  if (request_type !== undefined && request_type !== null && request_type !== '' && !ALLOWED_REQUEST_TYPES.includes(request_type)) {
    return res.status(400).json({
      error: 'Bad request',
      message: `request_type 非法，允许值：${ALLOWED_REQUEST_TYPES.join('/')}`,
    });
  }
  const normalizedParent = normalizeParentTicketId(parent_ticket_id);
  if (!normalizedParent.ok) {
    return res.status(400).json({ error: 'Bad request', message: normalizedParent.message });
  }
  if (normalizedParent.value && !store.getTicketById(normalizedParent.value)) {
    return res.status(400).json({ error: 'Bad request', message: 'parent_ticket_id 对应工单不存在' });
  }

  const targetAgent = normalizeOptionalAgent(assigned_agent ?? agent) ?? 'donky';
  const normalizedTriageOwner = normalizeOptionalAgent(triage_owner) ?? DEFAULT_TRIAGE_OWNER;
  const normalizedReviewOwner = normalizeOptionalAgent(review_owner) ?? normalizedTriageOwner;
  const normalizedDecisionOwner = normalizeOptionalAgent(decision_owner);
  const ticket = store.createTicket({
    title: title.trim(),
    description: normalizeOptionalText(description, 20000) ?? '',
    status: status ?? 'queued',
    triage_owner: normalizedTriageOwner,
    review_owner: normalizedReviewOwner,
    decision_owner: normalizedDecisionOwner,
    decision_summary: normalizeOptionalText(decision_summary, 4000),
    decision_context: normalizeOptionalText(decision_context, 4000),
    assigned_agent: targetAgent,
    next_actor: normalizeOptionalAgent(next_actor),
    priority: 'medium',
    platform: normalizeOptionalText(platform, 120) ?? null,
    request_type: normalizeOptionalText(request_type, 120) ?? null,
    triage_summary: normalizeOptionalText(triage_summary, 4000) ?? '',
    implementation_scope: normalizeOptionalText(implementation_scope, 4000) ?? '',
    constraints: normalizeOptionalText(constraints, 4000) ?? '',
    deliverables: normalizeOptionalText(deliverables, 4000) ?? '',
    acceptance_criteria: normalizeOptionalText(acceptance_criteria, 4000) ?? '',
    parent_ticket_id: normalizedParent.value ?? null,
    created: new Date().toISOString(),
  });
  return res.status(201).json(formatTicketForList(ticket));
});

// PATCH /api/tickets/:id - 更新工单状态与结构化分诊信息
app.patch('/api/tickets/:id', (req, res) => {
  const id = req.params.id;
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }
  const {
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
    constraints,
    deliverables,
    acceptance_criteria,
    parent_ticket_id,
    result_summary,
    error,
    session_key,
    watchers,
  } = req.body || {};
  const updates = {};

  // 禁止直接修改 status，必须使用 transition API
  if (status !== undefined) {
    return res.status(400).json({
      error: 'Direct status update forbidden',
      message: '禁止直接修改状态，请使用 POST /api/tickets/:id/transition',
      hint: 'Use transition API for state changes',
      available_actions: getAvailableActions(id)
    });
  }
  if (request_type !== undefined && request_type !== null && request_type !== '' && !ALLOWED_REQUEST_TYPES.includes(request_type)) {
    return res.status(400).json({
      error: 'Bad request',
      message: `request_type 非法，允许值：${ALLOWED_REQUEST_TYPES.join('/')}`,
    });
  }

  const normalizedParent = normalizeParentTicketId(parent_ticket_id);
  if (!normalizedParent.ok) {
    return res.status(400).json({ error: 'Bad request', message: normalizedParent.message });
  }
  if (normalizedParent.value === Number(id)) {
    return res.status(400).json({ error: 'Bad request', message: 'parent_ticket_id 不能指向自身' });
  }
  if (normalizedParent.value && !store.getTicketById(normalizedParent.value)) {
    return res.status(400).json({ error: 'Bad request', message: 'parent_ticket_id 对应工单不存在' });
  }

  if (title !== undefined) updates.title = normalizeOptionalText(title, 500) ?? '';
  if (description !== undefined) updates.description = normalizeOptionalText(description, 20000) ?? '';
  if (triage_owner !== undefined) updates.triage_owner = normalizeOptionalAgent(triage_owner);
  if (review_owner !== undefined) updates.review_owner = normalizeOptionalAgent(review_owner);
  if (decision_owner !== undefined) updates.decision_owner = normalizeOptionalAgent(decision_owner);
  if (decision_summary !== undefined) updates.decision_summary = normalizeOptionalText(decision_summary, 4000);
  if (decision_context !== undefined) updates.decision_context = normalizeOptionalText(decision_context, 4000);
  if (assigned_agent !== undefined) updates.assigned_agent = normalizeOptionalAgent(assigned_agent);
  if (next_actor !== undefined) updates.next_actor = normalizeOptionalAgent(next_actor);
  if (priority !== undefined) updates.priority = normalizeOptionalText(priority, 120) ?? 'medium';
  if (platform !== undefined) updates.platform = normalizeOptionalText(platform, 120);
  if (request_type !== undefined) updates.request_type = normalizeOptionalText(request_type, 120);
  if (triage_summary !== undefined) updates.triage_summary = normalizeOptionalText(triage_summary, 4000) ?? '';
  if (implementation_scope !== undefined) updates.implementation_scope = normalizeOptionalText(implementation_scope, 4000) ?? '';
  if (constraints !== undefined) updates.constraints = normalizeOptionalText(constraints, 4000) ?? '';
  if (deliverables !== undefined) updates.deliverables = normalizeOptionalText(deliverables, 4000) ?? '';
  if (acceptance_criteria !== undefined) updates.acceptance_criteria = normalizeOptionalText(acceptance_criteria, 4000) ?? '';
  if (parent_ticket_id !== undefined) updates.parent_ticket_id = normalizedParent.value ?? null;
  if (result_summary !== undefined) updates.result_summary = result_summary;
  if (error !== undefined) updates.error = error;
  if (session_key !== undefined) updates.session_key = session_key;
  if (watchers !== undefined) {
    if (!Array.isArray(watchers)) {
      return res.status(400).json({ error: 'Bad request', message: 'watchers 必须是数组' });
    }
    updates.watchers = watchers
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .slice(0, 100);
  }
  updates.last_update = new Date().toISOString();

  const statusChanged = updates.status !== undefined && updates.status !== ticket.status;
  store.updateTicket(id, updates);
  if (statusChanged) {
    dispatch.clearNotificationEvents(Number(id));
    dispatch.clearAuditEvents(Number(id));
  }

  const updated = store.getTicketById(id);
  res.json(formatTicketForList(updated));
});

// POST /api/tickets/:id/dispatch - 手动重派（仅更新 assigned_agent 和状态，不调用 OpenClaw）
app.post('/api/tickets/:id/dispatch', (req, res) => {
  const id = req.params.id;
  const agent = req.body?.agent || 'donky';
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }
  const statusChanged = ticket.status !== 'queued';
  store.updateTicket(id, {
    status: 'queued',
    assigned_agent: agent,
    next_actor: null,
    error: null,
    last_update: new Date().toISOString(),
  });
  if (statusChanged) {
    dispatch.clearNotificationEvents(Number(id));
    dispatch.clearAuditEvents(Number(id));
  }

  const updated = store.getTicketById(id);
  res.json(formatTicketForList(updated));
});

// POST /api/tickets/:id/comments
app.post('/api/tickets/:id/comments', (req, res) => {
  const id = req.params.id;
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }
  const {
    content,
    author = 'Current User',
    type = 'progress',
    visibility = 'internal',
    thread_id = null,
    mentions = [],
  } = req.body || {};

  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Bad request', message: '评论内容不能为空' });
  }
  if (content.length > COMMENT_MAX_LENGTH) {
    return res.status(400).json({ error: 'Bad request', message: '评论内容过长' });
  }
  if (!isValidCommentType(type)) {
    return res.status(400).json({ error: 'Bad request', message: 'type 非法' });
  }
  if (!isValidVisibility(visibility)) {
    return res.status(400).json({ error: 'Bad request', message: 'visibility 非法' });
  }
  if (thread_id && String(thread_id).length > THREAD_ID_MAX_LENGTH) {
    return res.status(400).json({ error: 'Bad request', message: 'thread_id 过长' });
  }

  const cleanAuthor = String(author || 'Current User').trim().slice(0, AUTHOR_MAX_LENGTH) || 'Current User';
  const watcherList = Array.isArray(ticket.watchers) ? ticket.watchers : [];
  const normalizedMentions = normalizeMentions(mentions, content);
  const notifyTargets = normalizedMentions.length > 0
    ? [...new Set([...normalizedMentions, ...watcherList])]
    : normalizedMentions;

  const newComment = {
    id: buildCommentId(),
    author: cleanAuthor,
    timestamp: new Date().toISOString(),
    content: content.trim(),
    type,
    visibility,
    thread_id,
    mentions: normalizedMentions,
    notify_targets: notifyTargets,
  };
  store.addComment(id, newComment);
  res.status(201).json(newComment);
});


// DELETE /api/tickets/:id - 删除单个工单
app.delete('/api/tickets/:id', (req, res) => {
  const id = req.params.id;
  const deleted = store.deleteTicket(id);
  if (!deleted) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }
  res.status(204).send();
});

// POST /api/tickets/batch-delete - 批量删除工单
app.post('/api/tickets/batch-delete', (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Bad request', message: 'ids 必须是非空数组' });
  }
  const count = store.deleteTickets(ids);
  res.json({ deleted: count });
});

// GET /api/dispatch/ready - 获取待派发工单
app.get('/api/dispatch/ready', (req, res) => {
  const allTickets = store.getAllTickets().map(enrichTicketRouting);

  // 构建候选：正常单 (next_actor) + mismatch 单 (alert_target)
  const candidates = [];
  for (const ticket of allTickets) {
    const mismatch = detectWorkflowMismatch(ticket);
    if (mismatch) {
      const agent = mismatch.alert_target || '荣晖';
      if (!agent) continue;
      candidates.push({ ticket, agent, kind: 'workflow_mismatch', mismatch });
    } else if (ticket.should_notify && ticket.next_actor && ticket.status !== 'pending_decision') {
      // 依赖门禁：检查是否有未满足的依赖
      if (store.hasUnmetDependencies(ticket.id)) {
        console.log(`[dispatch/ready] Skip #${ticket.id}: unmet dependencies`);
        continue;
      }
      candidates.push({ ticket, agent: ticket.next_actor, kind: undefined, mismatch: null });
    }
  }

  console.log('[dispatch/ready] Candidates:', candidates.length);

  // 按 agent 分组，每个 agent 只返回最早 1 张
  const byAgent = new Map();
  for (const { ticket, agent, kind, mismatch } of candidates) {
    console.log(`[dispatch/ready] Checking #${ticket.id} agent=${agent} kind=${kind || 'normal'}`);
    const statusKey = kind === 'workflow_mismatch' ? 'workflow_mismatch' : ticket.status;
    const hasRecent = dispatch.hasRecentDispatch(ticket.id, agent, statusKey, 60);
    if (hasRecent) continue;

    const existing = byAgent.get(agent);
    if (!existing || Date.parse(ticket.created) < Date.parse(existing.ticket.created)) {
      byAgent.set(agent, { ticket, agent, kind, mismatch });
    }
  }

  // 生成派发事件并返回
  const ready = [];
  for (const { ticket, agent, kind, mismatch } of byAgent.values()) {
    const statusKey = kind === 'workflow_mismatch' ? 'workflow_mismatch' : ticket.status;
    let dispatchId = dispatch.getUnackedDispatchEvent(ticket.id, agent, statusKey);
    if (!dispatchId) {
      dispatchId = dispatch.recordDispatchEvent(ticket.id, agent, statusKey);
    }

    if (kind === 'workflow_mismatch') {
      const alertMsg = mismatch.reason || '状态与评论不一致';
      ready.push({
        dispatch_id: dispatchId,
        agent,
        ticket_id: ticket.id,
        title: ticket.title,
        status: ticket.status,
        next_actor: agent,
        kind: 'workflow_mismatch',
        workflow_mismatch: mismatch,
        message: `⚠️ [workflow_mismatch 告警]\n\n#${ticket.id} ${ticket.title}\n状态：${ticket.status}（running）与最新评论类型不一致\n${alertMsg}\n推荐状态：${mismatch.recommended_status}\n请核实并手动调整工单状态。`,
      });
    } else {
      ready.push({
        dispatch_id: dispatchId,
        agent,
        ticket_id: ticket.id,
        title: ticket.title,
        status: ticket.status,
        next_actor: ticket.next_actor,
        message: `🔔 你有 1 个当前阶段待处理工单\n\n#${ticket.id} ${ticket.title}\n状态：${ticket.status}\n当前责任人：${agent}\n\n请立即使用 ticket-handler skill 处理，并把【当前阶段】自行闭环推进到【下一阶段】。\n\n重要：为了避免主会话上下文堆积，本单使用独立 ticket session。完成当前阶段前，请先把关键进展/决策/结论写入你自己工作区的 memory/YYYY-MM-DD.md（必要时更新相关长期记忆），再通过 transition API 推进工单状态。\n\n不要等老大再追问。若遇到需要老大决策的关键问题，先写工单评论，再主动通知老大。`,
      });
    }
  }

  res.json({ ready });
});

function parsePositiveInt(value) {
  const num = parseInt(value, 10);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function resolveDispatchId(req) {
  return (
    parsePositiveInt(req.params?.dispatch_id)
    || parsePositiveInt(req.body?.dispatch_id)
    || parsePositiveInt(req.body?.id)
    || parsePositiveInt(req.query?.dispatch_id)
  );
}

function resolveNotificationEventId(req) {
  return (
    parsePositiveInt(req.params?.event_id)
    || parsePositiveInt(req.body?.event_id)
    || parsePositiveInt(req.body?.id)
    || parsePositiveInt(req.query?.event_id)
  );
}

// POST /api/dispatch/:dispatch_id/ack - 确认派发
app.post('/api/dispatch/:dispatch_id/ack', (req, res) => {
  const dispatchId = resolveDispatchId(req);
  if (!dispatchId) {
    return res.status(400).json({ error: 'Bad request', message: 'dispatch_id 必须是正整数' });
  }
  const ok = dispatch.ackDispatchEvent(dispatchId);
  if (!ok) {
    return res.status(404).json({ error: 'Not found', message: `dispatch_id ${dispatchId} 不存在` });
  }
  res.json({ success: true, dispatch_id: dispatchId });
});

// POST /api/dispatch/ack - 兼容旧调用（body/query 携带 dispatch_id）
app.post('/api/dispatch/ack', (req, res) => {
  const dispatchId = resolveDispatchId(req);
  if (!dispatchId) {
    return res.status(400).json({ error: 'Bad request', message: 'dispatch_id 必须是正整数' });
  }
  const ok = dispatch.ackDispatchEvent(dispatchId);
  if (!ok) {
    return res.status(404).json({ error: 'Not found', message: `dispatch_id ${dispatchId} 不存在` });
  }
  res.json({ success: true, dispatch_id: dispatchId, compatibility: true });
});

// GET /api/notifications/ready - 获取待通知结果
app.get('/api/notifications/ready', (req, res) => {
  const NOTIFY_STATUSES = new Set(['done', 'review', 'complete', 'failed', 'pending_decision']);
  const tickets = store.getAllTickets()
    .map(enrichTicketRouting)
    .filter(t => NOTIFY_STATUSES.has(t.status) && t.should_notify);

  const ready = [];
  for (const ticket of tickets) {
    const eventType = ticket.status;

    // 检查是否最近已通知（只看已 ack）
    if (dispatch.hasRecentNotification(ticket.id, eventType)) continue;

    // 复用未 ack 事件，避免每次拉 ready 都插入新事件
    let eventId = dispatch.getUnackedNotificationEvent(ticket.id, eventType, ticket.status);
    if (!eventId) {
      eventId = dispatch.recordNotificationEvent(ticket.id, eventType, ticket.status);
    }

    let message = '';
    if (eventType === 'complete') {
      message = `✅ 工单已完成\n\n#${ticket.id} ${ticket.title}\n结果：${ticket.result_summary || '已完成'}`;
    } else if (eventType === 'failed') {
      message = `❌ 工单失败\n\n#${ticket.id} ${ticket.title}\n错误：${ticket.error || '执行失败'}`;
    } else if (eventType === 'pending_decision') {
      message = `⏸️ 工单等待决策\n\n#${ticket.id} ${ticket.title}\n决策摘要：${ticket.decision_summary || '需要老大决策'}`;
    } else if (eventType === 'done' || eventType === 'review') {
      message = `📋 工单待验收\n\n#${ticket.id} ${ticket.title}\n结果：${ticket.result_summary || '待验收'}`;
    }
    
    ready.push({
      event_id: eventId,
      type: eventType,
      ticket_id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      message,
    });
  }

  res.json({ ready });
});

// POST /api/notifications/:event_id/ack - 确认通知
app.post('/api/notifications/:event_id/ack', (req, res) => {
  const eventId = resolveNotificationEventId(req);
  if (!eventId) {
    return res.status(400).json({ error: 'Bad request', message: 'event_id 必须是正整数' });
  }
  const ok = dispatch.ackNotificationEvent(eventId);
  if (!ok) {
    return res.status(404).json({ error: 'Not found', message: `event_id ${eventId} 不存在` });
  }
  res.json({ success: true, event_id: eventId });
});

// POST /api/notifications/ack - 兼容旧调用（body/query 携带 event_id）
app.post('/api/notifications/ack', (req, res) => {
  const eventId = resolveNotificationEventId(req);
  if (!eventId) {
    return res.status(400).json({ error: 'Bad request', message: 'event_id 必须是正整数' });
  }
  const ok = dispatch.ackNotificationEvent(eventId);
  if (!ok) {
    return res.status(404).json({ error: 'Not found', message: `event_id ${eventId} 不存在` });
  }
  res.json({ success: true, event_id: eventId, compatibility: true });
});

// 依赖关系 API
// POST /api/tickets/:id/dependencies - 添加依赖
app.post('/api/tickets/:id/dependencies', (req, res) => {
  const ticketId = parseInt(req.params.id, 10);
  const { depends_on_ticket_id, dependency_type } = req.body;
  
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    return res.status(400).json({ error: 'Bad request', message: 'ticket_id 必须是正整数' });
  }
  
  if (!depends_on_ticket_id || !Number.isInteger(depends_on_ticket_id) || depends_on_ticket_id <= 0) {
    return res.status(400).json({ error: 'Bad request', message: 'depends_on_ticket_id 必须是正整数' });
  }
  
  const success = store.addDependency(ticketId, depends_on_ticket_id, dependency_type || 'blocks');
  if (!success) {
    return res.status(409).json({ error: 'Conflict', message: '依赖关系已存在' });
  }
  
  res.json({ success: true });
});

// DELETE /api/tickets/:id/dependencies/:depends_on_id - 删除依赖
app.delete('/api/tickets/:id/dependencies/:depends_on_id', (req, res) => {
  const ticketId = parseInt(req.params.id, 10);
  const dependsOnId = parseInt(req.params.depends_on_id, 10);
  
  if (!Number.isInteger(ticketId) || ticketId <= 0 || !Number.isInteger(dependsOnId) || dependsOnId <= 0) {
    return res.status(400).json({ error: 'Bad request', message: 'ticket_id 和 depends_on_id 必须是正整数' });
  }
  
  const success = store.removeDependency(ticketId, dependsOnId);
  if (!success) {
    return res.status(404).json({ error: 'Not found', message: '依赖关系不存在' });
  }
  
  res.json({ success: true });
});

// GET /api/tickets/:id/dependencies - 获取工单的依赖
app.get('/api/tickets/:id/dependencies', (req, res) => {
  const ticketId = parseInt(req.params.id, 10);
  
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    return res.status(400).json({ error: 'Bad request', message: 'ticket_id 必须是正整数' });
  }
  
  const dependencies = store.getDependencies(ticketId);
  const dependents = store.getDependents(ticketId);
  
  res.json({ dependencies, dependents });
});

// ── Audit API（平台巡检长期未动工单）──

const AUDIT_STALE_RUNNING_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_RUNNING_MINUTES) || 120;
const AUDIT_STALE_REVIEW_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_REVIEW_MINUTES) || 120;
const AUDIT_STALE_PENDING_DECISION_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_PENDING_DECISION_MINUTES) || 720;

const AUDIT_THRESHOLDS = {
  running: AUDIT_STALE_RUNNING_MINUTES,
  review: AUDIT_STALE_REVIEW_MINUTES,
  pending_decision: AUDIT_STALE_PENDING_DECISION_MINUTES,
};

function buildAuditMessage(ticket, auditType, staleMinutes) {
  const hours = (staleMinutes / 60).toFixed(1);
  return [
    `🔍 【审计任务】`,
    ``,
    `这是一个平台自动巡检产生的审计任务，不是派单执行任务。`,
    `请你仅做审计分析，不要自动修改工单状态。`,
    ``,
    `## 工单信息`,
    `- 工单 ID：#${ticket.id}`,
    `- 标题：${ticket.title}`,
    `- 当前状态：${ticket.status}`,
    `- 负责 Agent：${ticket.assigned_agent || '未指定'}`,
    `- next_actor：${ticket.next_actor || '未指定'}`,
    `- next_actor_source：${ticket.next_actor_source || '未指定'}`,
    `- 上次更新：${ticket.last_update}`,
    `- 滞留时间：${hours} 小时`,
    `- 审计类型：${auditType}`,
    ``,
    `## 审计要求`,
    `1. 检查该工单最新评论内容和时间`,
    `2. 确认当前状态是否合理（是否应该已经推进到下一阶段）`,
    `3. 确认 next_actor 是否正确`,
    `4. 判断是否卡住、等待外部依赖、或已实际完成但未更新状态`,
    ``,
    `## 输出要求`,
    `请将审计结论以结构化评论写回工单（POST /api/tickets/${ticket.id}/comments），格式如下：`,
    ``,
    '```',
    `【审计结论】workflow_mismatch|stale_running|stale_review|stale_pending_decision|no_issue`,
    `【建议状态】running|review|pending_decision|blocked|done`,
    `【建议下一责任人】<agent name>`,
    `【建议动作】notify_only|manual_review|transition_recommended`,
    `【原因】<简要说明>`,
    `【置信度】high|medium|low`,
    '```',
    ``,
    `重要：你只负责审计并写回评论，不要调用 transition API 修改工单状态。`,
  ].join('\n');
}

// GET /api/audits/ready
app.get('/api/audits/ready', (_req, res) => {
  const allTickets = store.getAllTickets().map(enrichTicketRouting);
  const now = Date.now();

  const ready = [];
  for (const ticket of allTickets) {
    const threshold = AUDIT_THRESHOLDS[ticket.status];
    if (!threshold) continue;

    const lastUpdateTs = Date.parse(ticket.last_update || '');
    if (!Number.isFinite(lastUpdateTs)) continue;

    const staleMinutes = (now - lastUpdateTs) / (60 * 1000);
    if (staleMinutes < threshold) continue;

    const auditType = `stale_${ticket.status}`;

    if (dispatch.hasRecentAudit(ticket.id, auditType)) continue;

    let auditId = dispatch.getUnackedAuditEvent(ticket.id, auditType);
    if (!auditId) {
      auditId = dispatch.recordAuditEvent(ticket.id, auditType, ticket.status);
    }

    ready.push({
      audit_id: auditId,
      ticket_id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      audit_type: auditType,
      stale_minutes: Math.round(staleMinutes),
      message: buildAuditMessage(ticket, auditType, staleMinutes),
    });
  }

  res.json({ ready });
});

function resolveAuditId(req) {
  return (
    parsePositiveInt(req.params?.id)
    || parsePositiveInt(req.body?.audit_id)
    || parsePositiveInt(req.body?.id)
    || parsePositiveInt(req.query?.audit_id)
  );
}

// POST /api/audits/:id/ack
app.post('/api/audits/:id/ack', (req, res) => {
  const auditId = resolveAuditId(req);
  if (!auditId) {
    return res.status(400).json({ error: 'Bad request', message: 'audit_id 必须是正整数' });
  }
  const ok = dispatch.ackAuditEvent(auditId);
  if (!ok) {
    return res.status(404).json({ error: 'Not found', message: `audit_id ${auditId} 不存在` });
  }
  res.json({ success: true, audit_id: auditId });
});

export { app };
export default app;

// POST /api/tickets/:id/transition - 状态转换接口（强制）
app.post('/api/tickets/:id/transition', (req, res) => {
  const id = req.params.id;
  const { action, actor, comment, ...fields } = req.body || {};

  if (!action) {
    return res.status(400).json({
      error: 'Missing action',
      message: '必须指定 action',
      available_actions: Object.keys(TRANSITIONS)
    });
  }

  if (!actor) {
    return res.status(400).json({
      error: 'Missing actor',
      message: '必须指定 actor（执行此操作的 agent）'
    });
  }

  const previousTicket = store.getTicketById(id);
  if (!previousTicket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }
  const oldStatus = previousTicket.status;

  // 执行状态转换
  const result = transition(Number(id), action, { actor, ...fields });

  if (!result.success) {
    return res.status(400).json(result);
  }

  // 广播状态变化
  if (oldStatus !== result.ticket.status) {
    broadcastTicketStatusChanged(result.ticket, oldStatus, result.ticket.status);
  }

  // 如果提供了 comment，自动添加系统评论
  if (comment) {
    const newComment = {
      id: buildCommentId(),
      author: actor,
      timestamp: new Date().toISOString(),
      content: comment,
      type: 'status_change',
      visibility: 'internal',
      thread_id: null,
      mentions: [],
      metadata: {
        action,
        from: oldStatus,
        to: result.ticket.status
      }
    };

    store.addComment(id, newComment);
  }

  const updated = store.getTicketById(id);
  res.json({
    success: true,
    ticket: formatTicketForList(updated),
    message: `状态已从 ${oldStatus} 转换为 ${updated.status}`
  });
});

// GET /api/tickets/:id/actions - 获取当前可执行的 actions
app.get('/api/tickets/:id/actions', (req, res) => {
  const id = req.params.id;
  const ticket = store.getTicketById(id);
  
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  const actions = getAvailableActions(Number(id));
  res.json({
    ticket_id: Number(id),
    current_status: ticket.status,
    available_actions: actions
  });
});

