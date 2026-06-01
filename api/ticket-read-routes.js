import * as store from './store.js';
import { COMMENT_TYPES, COMMENT_VISIBILITY, THREAD_ID_MAX_LENGTH } from '../constants/comments.js';
import { detectWorkflowMismatch } from './workflow-mismatch.js';
import { buildTicketControlReadModel } from './control-read-model.js';
import { buildParentChildSummary, enrichTicketForApi } from './ticket-enrichment.js';

function classifyPausedTail(ticket = {}) {
  if (ticket.status !== 'paused') return null;

  const reason = String(ticket.pause_reason || '').trim();
  const lowerReason = reason.toLowerCase();
  const lastStatus = String(ticket.paused_from_status || '').trim().toLowerCase();

  if (lastStatus === 'done') {
    return {
      category: 'resume_then_close',
      recommendation: 'resume_then_close',
      reason: reason || 'paused from done',
    };
  }

  if (lowerReason.includes('worker stuck') || lowerReason.includes('reservation_conflict')) {
    return {
      category: 'superseded_by_governance_fix',
      recommendation: 'close_with_evidence_migration',
      reason: reason || 'governance tail',
    };
  }

  if (lowerReason.includes('debug cleanup') || lowerReason.includes('脏票')) {
    return {
      category: 'cleanup_candidate',
      recommendation: 'deprecate_when_triage_confirms',
      reason: reason || 'cleanup candidate',
    };
  }

  return null;
}

function attachPausedTailClassification(ticket = {}) {
  const paused_tail_classification = classifyPausedTail(ticket);
  return paused_tail_classification
    ? { ...ticket, paused_tail_classification }
    : ticket;
}

export function registerTicketReadRoutes(app, deps) {
  const {
    buildTicketListItem,
    matchesTicketFilters,
    formatTicketForList,
    normalizeComment,
    getAvailableActions,
  } = deps;

  app.get('/api/tickets', (req, res) => {
    const dependencySummaryMap = store.getDependencySummaryMap();
    const pausedTailFlag = String(req.query.historical_paused_tail || '').trim().toLowerCase();
    const pausedTailCategory = String(req.query.paused_tail_category || '').trim();

    const tickets = store.getAllTickets()
      .map((ticket) => attachPausedTailClassification(buildTicketListItem(ticket, dependencySummaryMap)))
      .filter((ticket) => matchesTicketFilters(ticket, req.query))
      .filter((ticket) => {
        if (pausedTailFlag === 'true' && !ticket.paused_tail_classification) return false;
        if (pausedTailFlag === 'false' && ticket.paused_tail_classification) return false;
        if (pausedTailCategory && ticket.paused_tail_classification?.category !== pausedTailCategory) return false;
        return true;
      })
      .sort((a, b) => {
        const aTs = Date.parse(a.created || '') || 0;
        const bTs = Date.parse(b.created || '') || 0;
        if (bTs !== aTs) return bTs - aTs;
        return (Number(b.id) || 0) - (Number(a.id) || 0);
      });
    res.json(tickets);
  });

  app.get('/api/notifications/summary', (req, res) => {
    const minutes = Math.max(1, parseInt(req.query.minutes || '60', 10) || 60);
    const now = Date.now();
    const fromTs = now - minutes * 60 * 1000;

    const all = store.getAllTickets();
    const recent = all.filter((t) => {
      const ts = Date.parse(t.last_update || t.created || '');
      if (!Number.isFinite(ts)) return false;
      return ts >= fromTs;
    }).map((t) => enrichTicketForApi(t));

    const byStatus = {
      done: recent.filter((t) => t.status === 'done'),
      complete: recent.filter((t) => t.status === 'complete'),
      failed: recent.filter((t) => t.status === 'failed'),
      pending_decision: recent.filter((t) => t.status === 'pending_decision'),
      blocked: recent.filter((t) => t.status === 'blocked'),
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
        blocked: byStatus.blocked.length,
        total: byStatus.done.length + byStatus.complete.length + byStatus.failed.length + byStatus.pending_decision.length + byStatus.blocked.length,
      },
      items: {
        done: byStatus.done.map(normalize),
        complete: byStatus.complete.map(normalize),
        failed: byStatus.failed.map(normalize),
        pending_decision: byStatus.pending_decision.map(normalize),
        blocked: byStatus.blocked.map(normalize),
      },
    });
  });

  app.get('/api/tickets/pull', (req, res) => {
    const { agent, limit = 1 } = req.query;
    if (!agent) {
      return res.status(400).json({ error: 'Bad request', message: 'agent 参数必填' });
    }
    const tickets = store.getAllTickets()
      .map((t) => formatTicketForList(t))
      .filter((t) => t.status === 'queued' && t.assigned_agent === agent && !t.execution_guard?.suppress_dispatch)
      .sort((a, b) => {
        const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        return (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
      })
      .slice(0, parseInt(limit, 10) || 1);
    res.json(tickets);
  });

  app.get('/api/tickets/:id/status', (req, res) => {
    const id = req.params.id;
    const ticket = store.getTicketById(id);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
    }
    const enriched = enrichTicketForApi(ticket);
    res.json({
      status: enriched.status,
      session_key: enriched.session_key,
      result_summary: enriched.result_summary,
      last_update: enriched.last_update,
      run_id: enriched.run_id,
      triage_owner: enriched.triage_owner,
      assigned_agent: enriched.assigned_agent,
      current_actor: enriched.current_actor,
      current_actor_source: enriched.current_actor_source,
      next_actor: enriched.next_actor,
      next_actor_override: enriched.next_actor_override,
      next_actor_source: enriched.next_actor_source,
      should_notify: enriched.should_notify,
      execution_mode: enriched.execution_mode,
      execution_mode_source: enriched.execution_mode_source,
      execution_rule_key: enriched.execution_rule_key,
      max_active_workers: enriched.max_active_workers,
      worker_stats: enriched.worker_stats,
      execution_guard: enriched.execution_guard,
      error: enriched.error,
    });
  });

  app.get('/api/tickets/:id', (req, res) => {
    const id = req.params.id;
    const ticket = store.getTicketById(id);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
    }
    const enriched = enrichTicketForApi(ticket);
    const workflow_mismatch = detectWorkflowMismatch(enriched);
    const control_read_model = buildTicketControlReadModel(enriched, {
      raw_ticket: ticket,
      workflow_mismatch,
      available_actions: getAvailableActions(Number(id)),
      include_runtime_digest: true,
    });
    const detail = {
      ...attachPausedTailClassification(enriched),
      parent_summary: enriched.parent_child_summary || null,
      updated: enriched.updated || enriched.last_update,
      assignee: enriched.assigned_agent || null,
      reporter: null,
      tags: [],
      attachments: [],
      watchers: enriched.watchers || [],
      comments: (enriched.comments || []).map(normalizeComment),
      workflow_mismatch: workflow_mismatch || undefined,
      execution_workers: enriched.execution_workers || [],
      control_read_model,
    };
    res.json(detail);
  });

  app.get('/api/tickets/:id/children', (req, res) => {
    const ticketId = parseInt(req.params.id, 10);
    if (!Number.isInteger(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Bad request', message: 'ticket_id 必须是正整数' });
    }

    const ticket = store.getTicketById(ticketId);
    if (!ticket) {
      return res.status(404).json({ error: 'Not found', message: '工单不存在' });
    }

    const enriched = enrichTicketForApi(ticket);
    return res.json({
      ticket_id: ticketId,
      summary: enriched.parent_child_summary || buildParentChildSummary(enriched),
      items: Array.isArray(enriched.child_tickets) ? enriched.child_tickets : [],
    });
  });

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
}
