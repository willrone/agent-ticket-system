/**
 * 最小控制读模型（P0）：单票聚合视图
 * 提供 responsibility_view、ticket_operational_view、execution_guard_view，
 * 供单票详情与 GET /api/control/tickets/:id/operational-view 使用。
 * 不改写真相源，仅在现有 enrich 结果上做 additive 聚合。
 */

import { getStatusMeta } from '../workflow-schema.js';
import { getAvailableActions } from './state-machine.js';
import { AGENT_REPORT_TYPES } from './agent-facing.js';
import { buildTicketRuntimeDigest } from '../ticket-selectors.js';

function latestCommentSummary(ticket = {}) {
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const c = comments[i];
    const content = String(c?.content ?? '').trim();
    if (!content) continue;
    return {
      at: c.timestamp ?? null,
      by: c.author ?? null,
      excerpt: content.slice(0, 240),
      type: c.type ?? 'progress',
    };
  }
  return null;
}

function latestReportType(ticket = {}) {
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  const reportTypes = new Set(AGENT_REPORT_TYPES);
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const t = String(comments[i]?.type ?? '').trim();
    if (reportTypes.has(t)) return t;
  }
  return null;
}

function buildResponsibilityChain(ticket = {}) {
  return [
    { role: 'triage_owner', label: '分诊负责人', value: ticket.triage_owner ?? null, source: 'ticket' },
    { role: 'assigned_agent', label: '执行人', value: ticket.assigned_agent ?? null, source: 'ticket' },
    { role: 'review_owner', label: '验收负责人', value: ticket.review_owner ?? null, source: 'ticket' },
    { role: 'decision_owner', label: '决策负责人', value: ticket.decision_owner ?? null, source: 'ticket' },
  ].filter((item) => item.value != null && item.value !== '');
}

function buildResponsibilityExplanation(ticket = {}, rawTicket = null) {
  const status = ticket.status ?? null;
  const statusMeta = getStatusMeta(status);
  const current_actor = ticket.current_actor ?? null;
  const current_actor_source = ticket.current_actor_source ?? null;
  const next_actor = ticket.next_actor ?? current_actor;
  const next_actor_source = ticket.next_actor_source ?? current_actor_source;
  const next_actor_override = ticket.next_actor_override ?? null;
  const stored_next_actor_override = rawTicket?.next_actor_override ?? ticket.next_actor_override ?? null;
  const manual_override_active = Boolean(ticket.manual_override_active);
  const manualOverrideAllowed = Boolean(statusMeta?.allow_manual_override);
  const overrideGovernance = {
    allowed_in_status: manualOverrideAllowed,
    active: manual_override_active,
    override_actor: next_actor_override,
    stored_override_actor: stored_next_actor_override,
    effective: manual_override_active && manualOverrideAllowed,
    residual: Boolean(stored_next_actor_override) && !manual_override_active,
    reason: null,
  };

  if (manual_override_active) {
    overrideGovernance.reason = '当前状态允许手动覆盖，责任人已切到 override actor';
  } else if (stored_next_actor_override && !manualOverrideAllowed) {
    overrideGovernance.reason = '工单残留了 override actor，但当前状态不允许手动覆盖，已回退到默认责任链';
  } else if (stored_next_actor_override) {
    overrideGovernance.reason = '工单保存了 override actor，但当前未生效；责任链以默认路由为准';
  } else if (!manualOverrideAllowed) {
    overrideGovernance.reason = '当前状态不允许手动覆盖，责任链完全按默认状态路由计算';
  } else {
    overrideGovernance.reason = '当前状态允许手动覆盖，但尚未设置 override actor';
  }

  return {
    status,
    status_label: statusMeta?.label ?? null,
    current_actor,
    current_actor_source,
    next_actor,
    next_actor_source,
    next_actor_override,
    manual_override_active,
    default_actor_source: manual_override_active ? null : current_actor_source,
    resolution: {
      actor: current_actor,
      source: current_actor_source,
      mode: manual_override_active ? 'manual_override' : 'workflow_default',
    },
    override_governance: overrideGovernance,
  };
}

/**
 * 责任链视图：谁负责、来源、是否手动覆盖
 */
export function buildResponsibilityView(ticket = {}, options = {}) {
  const triage_owner = ticket.triage_owner ?? null;
  const assigned_agent = ticket.assigned_agent ?? null;
  const review_owner = ticket.review_owner ?? null;
  const decision_owner = ticket.decision_owner ?? null;
  const current_actor = ticket.current_actor ?? null;
  const current_actor_source = ticket.current_actor_source ?? null;
  const next_actor = ticket.next_actor ?? current_actor;
  const next_actor_source = ticket.next_actor_source ?? current_actor_source;
  const next_actor_override = ticket.next_actor_override ?? null;
  const manual_override_active = Boolean(ticket.manual_override_active);
  const chain = buildResponsibilityChain(ticket);
  const explanation = buildResponsibilityExplanation(ticket, options.raw_ticket ?? null);

  return {
    chain,
    current_actor,
    current_actor_source,
    next_actor,
    next_actor_source,
    next_actor_override,
    manual_override_active,
    explanation,
    summary: [
      triage_owner && `分诊: ${triage_owner}`,
      assigned_agent && `执行: ${assigned_agent}`,
      review_owner && `验收: ${review_owner}`,
      decision_owner && `决策: ${decision_owner}`,
      current_actor && `当前责任: ${current_actor}`,
      manual_override_active && next_actor_override ? `override: ${next_actor_override}` : null,
    ].filter(Boolean).join(' · '),
  };
}

/**
 * 执行门禁视图：worker gate、reservation、可执行动作
 */
export function buildExecutionGuardView(ticket = {}, options = {}) {
  const guard = ticket.execution_guard ?? {};
  const ticketId = ticket.id != null ? Number(ticket.id) : null;
  const availableActions = options.available_actions ?? (ticketId != null ? getAvailableActions(ticketId) : []);
  const succeededWorkers = Number(guard.succeeded_workers ?? 0);
  const failedTerminal = Number(guard.failed_terminal_workers ?? 0);

  return {
    requires_worker: Boolean(guard.requires_worker),
    has_worker_evidence: Boolean(guard.has_worker_evidence),
    has_active_execution_evidence: Boolean(guard.has_active_execution_evidence),
    has_completed_execution_evidence: Boolean(guard.has_completed_execution_evidence ?? succeededWorkers > 0),
    has_historical_started_worker: Boolean(guard.has_historical_started_worker),
    evidence_tiers: {
      active_execution: Boolean(guard.has_active_execution_evidence),
      historical_started: Boolean(guard.has_historical_started_worker),
      completed: succeededWorkers > 0,
      failed_terminal: failedTerminal,
    },
    active_workers: Number(guard.active_workers ?? 0),
    running_workers: Number(guard.running_workers ?? 0),
    total_workers: Number(guard.total_workers ?? 0),
    succeeded_workers: succeededWorkers,
    failed_terminal_workers: failedTerminal,
    max_active_workers: Number(guard.max_active_workers ?? 0),
    reservation: guard.reservation ?? null,
    reservation_conflict: guard.reservation_conflict ?? null,
    suppress_dispatch: Boolean(guard.suppress_dispatch),
    reason: guard.reason ?? null,
    available_actions: availableActions,
  };
}

/**
 * 工单运营视图：设计文档 ticket_operational_view 最小子集
 */
export function buildTicketOperationalView(ticket = {}, options = {}) {
  const status = ticket.status ?? null;
  const statusMeta = getStatusMeta(status);
  const bucket = statusMeta?.group ?? 'active';
  const workflowMismatch = ticket.workflow_mismatch ?? options.workflow_mismatch ?? null;
  const storedOverrideActor = options.raw_ticket?.next_actor_override ?? ticket.next_actor_override ?? null;

  return {
    ticket_id: ticket.id ?? null,
    title: ticket.title ?? null,
    platform: ticket.platform ?? null,
    priority: ticket.priority ?? null,
    status,
    bucket,
    triage_owner: ticket.triage_owner ?? null,
    assigned_agent: ticket.assigned_agent ?? null,
    review_owner: ticket.review_owner ?? null,
    decision_owner: ticket.decision_owner ?? null,
    current_actor: ticket.current_actor ?? null,
    latest_comment_summary: latestCommentSummary(ticket),
    latest_report_type: latestReportType(ticket),
    worker_stats: ticket.worker_stats ?? null,
    reservation: ticket.execution_guard?.reservation ?? null,
    execution_mode: ticket.execution_mode ?? null,
    blocker_reason: null,
    audit_flags: workflowMismatch ? [workflowMismatch.category] : [],
    workflow_mismatch: workflowMismatch,
    anomaly_flags: {
      workflow_mismatch: Boolean(workflowMismatch),
      manual_override_residual: Boolean(storedOverrideActor) && !Boolean(ticket.manual_override_active),
    },
    stale_flags: [],
    parent_ticket_id: ticket.parent_ticket_id ?? null,
    parent_child_summary: ticket.parent_child_summary ?? null,
  };
}

/**
 * 单票控制读模型：聚合三块视图，供详情与 control API 使用
 */
export function buildTicketControlReadModel(ticket = {}, options = {}) {
  const ticketId = ticket.id != null ? Number(ticket.id) : null;
  const availableActions = options.available_actions ?? (ticketId != null ? getAvailableActions(ticketId) : []);
  const includeRuntimeDigest = options.include_runtime_digest === true;

  return {
    responsibility_view: buildResponsibilityView(ticket, {
      raw_ticket: options.raw_ticket ?? null,
    }),
    ticket_operational_view: buildTicketOperationalView(ticket, {
      raw_ticket: options.raw_ticket ?? null,
      workflow_mismatch: options.workflow_mismatch ?? null,
    }),
    execution_guard_view: buildExecutionGuardView(ticket, { available_actions: availableActions }),
    ...(includeRuntimeDigest ? { runtime_digest_view: buildTicketRuntimeDigest(ticket) } : {}),
  };
}
