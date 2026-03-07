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

const app = express();
app.use(express.json({ limit: '1mb' }));

function formatTicketForList(t) {
  return {
    ...t,
    bot: t.assigned_agent,
    created: t.created || t.last_update,
    priority: t.priority || 'medium',
    progress: t.status === 'done' ? 100 : t.status === 'running' ? 50 : 0,
  };
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
  const tickets = store.getAllTickets();
  const open = tickets.filter((t) => t.status === 'queued' || t.status === 'failed').length;
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
app.get('/api/tickets', (_req, res) => {
  const tickets = store.getAllTickets().map(formatTicketForList);
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
  });

  const done = recent.filter((t) => t.status === 'done');
  const failed = recent.filter((t) => t.status === 'failed');

  const normalize = (t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    assigned_agent: t.assigned_agent,
    last_update: t.last_update,
    result_summary: t.result_summary || null,
    error: t.error || null,
  });

  res.json({
    windowMinutes: minutes,
    generatedAt: new Date(now).toISOString(),
    counts: {
      done: done.length,
      failed: failed.length,
      total: done.length + failed.length,
    },
    items: {
      done: done.map(normalize),
      failed: failed.map(normalize),
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
  res.json({
    status: ticket.status,
    session_key: ticket.session_key,
    result_summary: ticket.result_summary,
    last_update: ticket.last_update,
    run_id: ticket.run_id,
    assigned_agent: ticket.assigned_agent,
    error: ticket.error,
  });
});

// GET /api/tickets/:id
app.get('/api/tickets/:id', (req, res) => {
  const id = req.params.id;
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }
  const detail = {
    ...ticket,
    updated: ticket.updated || ticket.last_update,
    assignee: null,
    reporter: null,
    tags: [],
    attachments: [],
    watchers: ticket.watchers || [],
    comments: (ticket.comments || []).map(normalizeComment),
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
  const { title, description, agent } = req.body || {};
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Bad request', message: '工单标题不能为空' });
  }
  const targetAgent = agent || 'donky';
  const ticket = store.createTicket({
    title: title.trim(),
    description: (description || '').trim(),
    status: 'queued',
    assigned_agent: targetAgent,
    priority: 'medium',
    created: new Date().toISOString(),
  });
  return res.status(201).json(formatTicketForList(ticket));
});

// PATCH /api/tickets/:id - 更新工单状态（Agent 拉取后更新 running/done/failed）
app.patch('/api/tickets/:id', (req, res) => {
  const id = req.params.id;
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }
  const { status, result_summary, error, session_key, watchers } = req.body || {};
  const updates = {};
  if (status) updates.status = status;
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

export { app };
export default app;
