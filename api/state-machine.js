/**
 * State Machine - 工单状态转换引擎
 *
 * 核心职责：
 * 1. 定义合法的状态转换规则
 * 2. 自动路由 current_actor / next_actor
 * 3. 执行副作用（锁定、解锁、清空通知）
 * 4. 拒绝非法转换
 */

import * as store from './store.js';
import * as dispatch from './dispatch.js';
import {
  DEFAULT_DECISION_OWNER,
  WORKFLOW_TRANSITION_META,
  listAvailableActionsForStatus,
  resolveResumeStatus,
  enrichTicketWorkflow,
  resolveRoleActor,
} from '../workflow-schema.js';
import {
  executionModeRequiresWorker,
  getExecutionWorkerEvidence,
  getExecutionModeMeta,
} from '../execution-policy.js';
import {
  parseReviewPlan,
  applyApproveToReviewState,
  getInitialReviewState,
} from './review-plan-helper.js';
import { validateTicketPlatformAssignedAgent } from './ticket-platform-rules.js';

export const TRANSITIONS = Object.fromEntries(
  Object.entries(WORKFLOW_TRANSITION_META).map(([action, meta]) => [
    action,
    {
      from: meta.from,
      to: meta.to,
      required_fields: meta.required_fields,
      label: meta.label,
      role_key: meta.role_key,
    },
  ])
);

const RUNNING_ENTRY_ACTIONS = new Set(['start_work', 'resume']);
const PARENT_CLOSEOUT_TERMINAL_STATUSES = new Set(['complete', 'failed', 'deprecated']);


export function findRunningEntryConflict(ticket, context = {}, action = 'start_work') {
  const actor = String(context.actor || '').trim();
  const assignedAgent = String(ticket.assigned_agent || '').trim();
  if (!actor || !assignedAgent || actor !== assignedAgent) return null;

  const runningConflict = store.findRunningTicketConflict({
    assignedAgent,
    excludeTicketId: ticket.id,
  });
  if (runningConflict) {
    return {
      kind: 'running_ticket',
      ticket: runningConflict,
      message: `agent ${assignedAgent} 已有进行中的工单 #${runningConflict.id}，当前工单不能再进入 running`,
      recommended_action: action === 'resume' ? '请先 pause/block/done/failed 已占用工单，或保持当前工单为 paused' : '请先完成/挂起/阻塞当前 running 工单，或稍后再 start_work',
    };
  }

  const reservationConflict = store.findExecutionReservationConflict({
    agentId: assignedAgent,
    excludeTicketId: ticket.id,
  });
  if (reservationConflict) {
    return {
      kind: reservationConflict.state === 'receipt_accepted' ? 'pending_running_reservation' : 'execution_reservation',
      ticket: {
        id: reservationConflict.ticket_id,
        assigned_agent: reservationConflict.agent_id,
        reservation_state: reservationConflict.state,
        assignment_id: reservationConflict.assignment_id,
        dispatch_event_id: reservationConflict.dispatch_event_id,
        holder_kind: reservationConflict.holder_kind,
        holder_key: reservationConflict.holder_key,
      },
      reservation: reservationConflict,
      message: `agent ${assignedAgent} 已被 ticket #${reservationConflict.ticket_id} 的 execution reservation 占用，当前工单不能再进入 running`,
      recommended_action: '请先让已持有 reservation 的工单完成、释放或显式回收 execution reservation 后再继续',
    };
  }

  return null;
}

function buildRunningConflictResult(ticket, context = {}, action) {
  const conflict = findRunningEntryConflict(ticket, context, action);
  if (!conflict) return null;

  return {
    success: false,
    statusCode: 409,
    error: 'RUNNING_TICKET_CONFLICT',
    message: conflict.message,
    actor: String(ticket.assigned_agent || '').trim(),
    attempted_action: action,
    current_status: ticket.status,
    conflict_kind: conflict.kind,
    recommended_action: conflict.recommended_action,
    conflict_ticket: conflict.ticket,
  };
}

function buildWorkerRequiredRunningGuardResult(ticket, action) {
  if (!executionModeRequiresWorker(ticket.execution_mode)) return null;

  const evidence = getExecutionWorkerEvidence(ticket);
  // 与 report-interpreter 完成回写门禁对齐：历史 succeeded 仍算 worker 痕迹，允许 queued 桥接 running
  if (evidence.has_worker_evidence) return null;

  const modeMeta = getExecutionModeMeta(ticket.execution_mode) || {};
  return {
    success: false,
    statusCode: 409,
    error: 'EXECUTION_WORKER_REQUIRED',
    message: `execution_mode=${ticket.execution_mode} 的工单进入 running 前必须先派生并登记 worker`,
    attempted_action: action,
    current_status: ticket.status,
    execution_mode: ticket.execution_mode || null,
    expected_worker_type: modeMeta.worker_type || null,
    requires_worker: true,
    worker_evidence: evidence,
  };
}

function buildParentCloseoutGuardResult(ticket, action) {
  if (!['approve', 'reject'].includes(action)) return null;
  const parentCloseoutSummary = ticket.parent_child_summary || {
    is_parent: Array.isArray(ticket.child_tickets) && ticket.child_tickets.length > 0,
    has_parent: Boolean(ticket.parent_ticket_id),
    parent_ticket_id: ticket.parent_ticket_id || null,
    child_count: Array.isArray(ticket.child_tickets) ? ticket.child_tickets.length : 0,
    terminal_child_count: 0,
    open_child_count: 0,
    all_children_terminal: true,
    by_status: {},
    blocking_children: [],
  };
  const childTickets = Array.isArray(ticket.child_tickets) ? ticket.child_tickets : [];
  if (childTickets.length === 0) return null;

  const blockingChildren = childTickets.filter((child) => {
    const status = String(child?.status || '').trim();
    return !PARENT_CLOSEOUT_TERMINAL_STATUSES.has(status);
  });
  if (blockingChildren.length === 0) return null;

  return {
    success: false,
    statusCode: 409,
    error: 'PARENT_CLOSEOUT_CHILDREN_INCOMPLETE',
    message: `母单存在未闭环子单，当前不允许 ${action}`,
    action,
    current_status: ticket.status,
    blocking_child_count: blockingChildren.length,
    blocking_children: blockingChildren.map((child) => ({
      id: child.id,
      title: child.title,
      status: child.status,
      assigned_agent: child.assigned_agent || null,
      result_summary: child.result_summary || null,
      last_update: child.last_update || null,
    })),
    parent_closeout_summary: {
      ...parentCloseoutSummary,
      terminal_child_count: childTickets.length - blockingChildren.length,
      open_child_count: blockingChildren.length,
      all_children_terminal: blockingChildren.length === 0,
      blocking_children: blockingChildren.map((child) => ({
        id: child.id,
        title: child.title,
        status: child.status,
        assigned_agent: child.assigned_agent || null,
        result_summary: child.result_summary || null,
        last_update: child.last_update || null,
      })),
    },
  };
}

function buildDynamicTransitionTarget(action, ticket, _context) {
  switch (action) {
    case 'formal_reassign':
    case 'handoff':
      return 'queued';
    default:
      return action === 'resume' ? resolveResumeStatus(ticket) : TRANSITIONS[action]?.to;
  }
}

function buildTransitionSideEffects(action, ticket, context) {
  switch (action) {
    case 'queue':
      return {
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
      };

    case 'start_work':
      return {
        locked_by: context.actor,
        locked_at: new Date().toISOString(),
        next_actor: null,
        next_actor_override: null,
      };

    case 'reset_to_queued':
      return {
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
        paused_from_status: null,
        paused_by: null,
        paused_at: null,
        pause_reason: null,
      };

    case 'submit_for_review':
      return {
        result_summary: context.result_summary,
        next_actor: null,
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
      };

    case 'start_review':
      return {
        next_actor: null,
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
      };

    case 'request_decision':
      return {
        decision_summary: context.decision_summary,
        decision_context: context.decision_context || null,
        next_actor: null,
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
      };

    case 'pause':
      return {
        pause_reason: context.pause_reason,
        paused_from_status: ticket.status,
        paused_by: context.actor,
        paused_at: new Date().toISOString(),
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
      };

    case 'resume': {
      const resumeStatus = resolveResumeStatus(ticket);
      const updates = {
        status: resumeStatus,
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
        paused_from_status: null,
        paused_by: null,
        paused_at: null,
        pause_reason: null,
      };

      if (resumeStatus === 'running') {
        updates.locked_by = ticket.assigned_agent || context.actor;
        updates.locked_at = new Date().toISOString();
      }

      return updates;
    }

    case 'formal_reassign':
      return {
        assigned_agent: context.target_agent,
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
        paused_from_status: null,
        paused_by: null,
        paused_at: null,
        pause_reason: null,
      };

    case 'handoff':
      return {
        assigned_agent: context.target_agent,
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
        paused_from_status: null,
        paused_by: null,
        paused_at: null,
        pause_reason: null,
      };

    case 'approve':
      return {
        next_actor: null,
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
      };

    case 'reject':
      return {
        next_actor: null,
        next_actor_override: null,
        result_summary: null,
        locked_by: null,
        locked_at: null,
      };

    case 'block':
      return {
        next_actor: null,
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
      };

    case 'unblock':
      return {
        next_actor: null,
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
      };

    case 'fail':
      return {
        error: context.error,
        next_actor: null,
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
      };

    case 'deprecate':
      return {
        deprecation_reason: context.deprecation_reason,
        next_actor: null,
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
        paused_from_status: null,
        paused_by: null,
        paused_at: null,
        pause_reason: null,
      };

    case 'resume_from_decision':
      return {
        decision_summary: null,
        decision_context: null,
        next_actor: null,
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
      };

    default:
      return {};
  }
}

export function transition(ticketId, action, context = {}) {
  const ticket = store.getTicketById(ticketId);
  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }

  const transitionDef = TRANSITIONS[action];
  if (!transitionDef) {
    return {
      success: false,
      error: `Invalid action: ${action}`,
      allowed_actions: Object.keys(TRANSITIONS),
    };
  }

  if (!transitionDef.from.includes(ticket.status)) {
    return {
      success: false,
      error: `Cannot ${action} from status ${ticket.status}`,
      current_status: ticket.status,
      allowed_from: transitionDef.from,
    };
  }

  for (const field of transitionDef.required_fields) {
    if (!context[field]) {
      return {
        success: false,
        error: `Missing required field: ${field}`,
        required_fields: transitionDef.required_fields,
      };
    }
  }

  if (action === 'queue') {
    const assignedAgent = (ticket.assigned_agent ?? '').toString().trim();
    const reviewOwner = (ticket.review_owner ?? '').toString().trim();
    const missing = [];
    if (!assignedAgent) missing.push('assigned_agent');
    if (!reviewOwner) missing.push('review_owner');
    if (missing.length > 0) {
      return {
        success: false,
        statusCode: 409,
        error: 'TRIAGE_QUEUE_CHAIN_INCOMPLETE',
        message: `triage -> queue 前责任链须已落链：缺少 ${missing.join('、')}；queue 后 current_actor/next_actor 将切到 assigned_agent，需同时具备 assigned_agent 与 review_owner`,
        action,
        current_status: ticket.status,
        missing_fields: missing,
      };
    }
  }

  if (['queue', 'formal_reassign', 'handoff'].includes(action)) {
    const targetAgent = action === 'queue' ? ticket.assigned_agent : context.target_agent;
    const platformAgentValidation = validateTicketPlatformAssignedAgent(ticket.platform, targetAgent);
    if (!platformAgentValidation.ok) {
      return {
        success: false,
        statusCode: 409,
        error: platformAgentValidation.error,
        message: platformAgentValidation.message,
        action,
        current_status: ticket.status,
        platform: platformAgentValidation.platform,
        allowed_assigned_agents: platformAgentValidation.allowed_assigned_agents,
      };
    }
  }

  if (action === 'reset_to_queued') {
    const expectedActor = resolveRoleActor(ticket, transitionDef.role_key);
    if (expectedActor && context.actor !== expectedActor) {
      return {
        success: false,
        statusCode: 403,
        error: 'ACTION_FORBIDDEN',
        message: `${action} 仅允许 ${expectedActor} 执行`,
        action,
        actor: context.actor,
        expected_actor: expectedActor,
        role_key: transitionDef.role_key,
        current_status: ticket.status,
      };
    }
  }

  const parentCloseoutGuard = buildParentCloseoutGuardResult(ticket, action);
  if (parentCloseoutGuard) {
    return parentCloseoutGuard;
  }

  if (action !== 'reset_to_queued' && ticket.locked_by && ticket.locked_by !== context.actor) {
    return {
      success: false,
      error: `Ticket locked by ${ticket.locked_by}`,
      locked_by: ticket.locked_by,
      locked_at: ticket.locked_at,
    };
  }

  if (RUNNING_ENTRY_ACTIONS.has(action)) {
    const workerRequired = buildWorkerRequiredRunningGuardResult(ticket, action);
    if (workerRequired) {
      return workerRequired;
    }

    const runningConflict = buildRunningConflictResult(ticket, context, action);
    if (runningConflict) {
      return runningConflict;
    }
  }

  const nextStatus = buildDynamicTransitionTarget(action, ticket, context);
  const updates = {
    status: nextStatus,
    last_update: new Date().toISOString(),
  };

  Object.assign(updates, buildTransitionSideEffects(action, ticket, context));

  if (action === 'approve') {
    const plan = parseReviewPlan(ticket);
    if (plan.valid) {
      const reviewerId = (context.approve_reviewer ?? context.actor) || ticket.review_owner || '';
      const result = applyApproveToReviewState(ticket, reviewerId);
      updates.review_state = result.review_state;
      updates.status = result.done ? 'complete' : 'review';
    }
  }
  if (action === 'reject') {
    const plan = parseReviewPlan(ticket);
    if (plan.valid) {
      updates.review_state = getInitialReviewState();
    }
  }

  if (updates.status === 'pending_decision' && !ticket.decision_owner) {
    updates.decision_owner = DEFAULT_DECISION_OWNER;
  }

  store.updateTicket(ticketId, updates);

  if (action === 'submit_for_review' && nextStatus === 'done') {
    store.terminateActiveExecutionWorkersForTicket(ticketId);
    store.releaseExecutionReservationByTicket(ticketId, 'submitted_for_review');
  }

  if (['block', 'pause', 'request_decision', 'fail', 'deprecate', 'reset_to_queued'].includes(action)) {
    store.terminateActiveExecutionWorkersForTicket(ticketId);
  }

  if (action === 'start_work') {
    store.updateExecutionReservation(ticketId, {
      state: 'running',
      holder_kind: 'workflow',
      holder_key: 'start_work',
      release_reason: null,
      released_at: null,
    });
  }

  if (['approve', 'fail', 'reject', 'reset_to_queued', 'formal_reassign', 'handoff', 'deprecate', 'block', 'pause', 'request_decision'].includes(action)) {
    store.releaseExecutionReservationByTicket(ticketId, action);
  }

  if (action === 'reset_to_queued') {
    store.invalidateAssignmentsForTicket(ticketId, {
      assignment_status: 'failed_delivery',
      last_error: 'ticket_reset_to_queued',
      stage: 'queued',
    });
  }

  dispatch.clearNotificationEvents(ticketId);
  dispatch.clearDispatchEvents(ticketId);
  dispatch.clearAuditEvents(ticketId);

  const updatedTicket = enrichTicketWorkflow(store.getTicketById(ticketId));
  const shouldDispatch = updatedTicket.workflow_notify_policy?.dispatch_ready && updatedTicket.current_actor;
  if (shouldDispatch) {
    dispatch.recordDispatchEvent(ticketId, updatedTicket.current_actor, updatedTicket.status);
  }

  // 双写：domain event + ticket_projection
  const eventType = getTicketEventTypeForAction(action);
  if (eventType) {
    const version = store.getAggregateVersion('ticket', String(ticketId)) + 1;
    store.appendDomainEvent({
      event_type: eventType,
      aggregate_type: 'ticket',
      aggregate_id: String(ticketId),
      aggregate_version: version,
      producer: 'workflow-orchestrator',
      correlation_id: `ticket-${ticketId}`,
      causation_id: null,
      idempotency_key: `ticket-${ticketId}-${eventType}-v${version}`,
      payload: {
        from_status: ticket.status,
        to_status: updatedTicket.status,
        actor: context.actor,
        current_actor: updatedTicket.current_actor,
        next_actor: updatedTicket.next_actor,
      },
      occurred_at: new Date().toISOString(),
    });
  }
  store.upsertTicketProjection(ticketId, {
    status: updatedTicket.status,
    current_actor: updatedTicket.current_actor ?? null,
    next_actor: updatedTicket.next_actor ?? null,
    dispatch_state: updatedTicket.dispatch_state ?? null,
    available_actions: listAvailableActionsForStatus(updatedTicket.status),
    worker_stats: updatedTicket.worker_stats ?? {},
    aggregate_version: store.getAggregateVersion('ticket', String(ticketId)),
  });

  return { success: true, ticket: updatedTicket };
}

function getTicketEventTypeForAction(action) {
  const map = {
    queue: 'ticket.queued',
    start_work: 'ticket.started',
    submit_for_review: 'ticket.submitted_for_review',
    start_review: 'ticket.review_started',
    approve: 'ticket.completed',
    reject: 'ticket.rejected_to_queue',
    pause: 'ticket.paused',
    block: 'ticket.blocked',
    fail: 'ticket.failed',
    request_decision: 'ticket.pending_decision',
    resume: 'ticket.resumed',
    formal_reassign: 'ticket.reassigned',
    handoff: 'ticket.handed_off',
  };
  return map[action] || null;
}

// ---------- Orchestrator command handlers (单写者入口) ----------

export function handleQueueTicket(ticketId, payload = {}) {
  return transition(ticketId, 'queue', { actor: payload.actor ?? payload.issuer_id ?? '' });
}

export function handleStartWork(ticketId, payload = {}) {
  return transition(ticketId, 'start_work', {
    actor: payload.actor ?? payload.issuer_id ?? '',
    assignment_id: payload.assignment_id,
    worker_evidence: payload.worker_evidence,
  });
}

export function handleSubmitForReview(ticketId, payload = {}) {
  return transition(ticketId, 'submit_for_review', {
    actor: payload.actor ?? payload.issuer_id ?? '',
    result_summary: payload.result_summary,
    artifacts: payload.artifacts,
  });
}

export function handleStartReview(ticketId, payload = {}) {
  return transition(ticketId, 'start_review', { actor: payload.actor ?? payload.issuer_id ?? '' });
}

export function handleApproveReview(ticketId, payload = {}) {
  return transition(ticketId, 'approve', {
    actor: payload.actor ?? payload.approved_by ?? payload.issuer_id ?? '',
    approve_reviewer: payload.actor ?? payload.approved_by ?? payload.issuer_id,
  });
}

export function handleRejectReview(ticketId, payload = {}) {
  return transition(ticketId, 'reject', { actor: payload.actor ?? payload.issuer_id ?? '' });
}

/**
 * 执行单条 command（从 commands 表读取后调用）。
 * 根据 command_type 路由到对应 handler，更新 command 的 result_status。
 */
export function processCommand(cmd) {
  const { command_id, command_type, aggregate_type, aggregate_id, payload } = cmd;
  const ticketId = aggregate_type === 'ticket' ? Number(aggregate_id) : null;
  let result;
  try {
    if (command_type === 'QueueTicket' && ticketId) {
      result = handleQueueTicket(ticketId, payload);
    } else if (command_type === 'StartWork' && ticketId) {
      result = handleStartWork(ticketId, payload);
    } else if (command_type === 'SubmitForReview' && ticketId) {
      result = handleSubmitForReview(ticketId, payload);
    } else if (command_type === 'StartReview' && ticketId) {
      result = handleStartReview(ticketId, payload);
    } else if (command_type === 'ApproveReview' && ticketId) {
      result = handleApproveReview(ticketId, payload);
    } else if (command_type === 'RejectReview' && ticketId) {
      result = handleRejectReview(ticketId, payload);
    } else if (command_type === 'RecordAssignmentReceipt') {
      result = { success: true, skipped: 'receipt_already_handled_by_report' };
    } else {
      result = { success: false, error: `Unknown command_type: ${command_type}` };
    }
    const success = result?.success === true;
    store.updateCommandResult(command_id, {
      result_status: success ? 'ok' : 'failed',
      result_error_code: success ? null : (result?.error ?? 'UNKNOWN'),
      result_error_message: success ? null : (result?.message ?? result?.error),
    });
    return result;
  } catch (err) {
    store.updateCommandResult(command_id, {
      result_status: 'failed',
      result_error_code: 'COMMAND_EXECUTION_ERROR',
      result_error_message: err?.message ?? String(err),
    });
    throw err;
  }
}

/**
 * 处理一批 pending commands（供 server 或 poller 调用）。
 */
export function processPendingCommands(options = {}) {
  const limit = options.limit ?? 20;
  const pending = store.getPendingCommands({ limit, aggregate_type: 'ticket' });
  const results = [];
  for (const cmd of pending) {
    try {
      results.push(processCommand(cmd));
    } catch (e) {
      results.push({ success: false, error: e?.message });
    }
  }
  return results;
}

export function getAvailableActions(ticketId) {
  const ticket = store.getTicketById(ticketId);
  if (!ticket) return [];
  return listAvailableActionsForStatus(ticket.status);
}
