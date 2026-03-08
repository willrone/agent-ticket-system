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
  return {
    ...ticket,
    bot: ticket.assigned_agent,
    created: ticket.created || ticket.last_update,
    priority: ticket.priority || 'medium',
    progress: ticket.status === 'done' ? 100 : ticket.status === 'review' ? 80 : ticket.status === 'running' ? 50 : ticket.status === 'triage' ? 10 : 0,
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
  const detail = {
    ...enriched,
    updated: enriched.updated || enriched.last_update,
    assignee: enriched.assigned_agent || null,
    reporter: null,
    tags: [],
    attachments: [],
    watchers: enriched.watchers || [],
    comments: (enriched.comments || []).map(normalizeComment),
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

  if (status !== undefined) {
    if (!ALLOWED_TICKET_STATUSES.includes(status)) {
      return res.status(400).json({
        error: 'Bad request',
        message: `status 非法，允许值：${ALLOWED_TICKET_STATUSES.join('/')}`,
      });
    }
    updates.status = status;
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
  store.updateTicket(id, updates);
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
  store.updateTicket(id, {
    status: 'queued',
    assigned_agent: agent,
    next_actor: null,
    error: null,
    last_update: new Date().toISOString(),
  });
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

export { app };
export default app;
