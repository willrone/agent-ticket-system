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

function buildRunningConflictResult(ticket, context = {}, action) {
  const actor = String(context.actor || '').trim();
  const assignedAgent = String(ticket.assigned_agent || '').trim();
  if (!actor || !assignedAgent || actor !== assignedAgent) return null;

  const conflict = store.findRunningTicketConflict({
    assignedAgent,
    excludeTicketId: ticket.id,
  });
  if (!conflict) return null;

  return {
    success: false,
    statusCode: 409,
    error: 'RUNNING_TICKET_CONFLICT',
    message: `agent ${assignedAgent} 已有进行中的工单 #${conflict.id}，当前工单不能再进入 running`,
    actor: assignedAgent,
    attempted_action: action,
    current_status: ticket.status,
    recommended_action: action === 'resume' ? '请先 pause/block/done/failed 已占用工单，或保持当前工单为 paused' : '请先完成/挂起/阻塞当前 running 工单，或稍后再 start_work',
    conflict_ticket: conflict,
  };
}

function buildWorkerRequiredRunningGuardResult(ticket, action) {
  if (!executionModeRequiresWorker(ticket.execution_mode)) return null;

  const evidence = getExecutionWorkerEvidence(ticket);
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

function buildDynamicTransitionTarget(action, ticket, context) {
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
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
      };

    case 'start_review':
      return {
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
      };

    case 'request_decision':
      return {
        decision_summary: context.decision_summary,
        decision_context: context.decision_context || null,
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
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
      };

    case 'reject':
      return {
        next_actor_override: null,
        result_summary: null,
        locked_by: null,
        locked_at: null,
      };

    case 'block':
      return {
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
      };

    case 'unblock':
      return {
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
      };

    case 'fail':
      return {
        error: context.error,
        next_actor_override: null,
        locked_by: null,
        locked_at: null,
      };

    case 'resume_from_decision':
      return {
        decision_summary: null,
        decision_context: null,
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

  if (nextStatus === 'pending_decision' && !ticket.decision_owner) {
    updates.decision_owner = DEFAULT_DECISION_OWNER;
  }

  store.updateTicket(ticketId, updates);

  if (action === 'submit_for_review' && nextStatus === 'done') {
    store.terminateActiveExecutionWorkersForTicket(ticketId);
  }

  dispatch.clearNotificationEvents(ticketId);
  dispatch.clearDispatchEvents(ticketId);
  dispatch.clearAuditEvents(ticketId);

  const updatedTicket = enrichTicketWorkflow(store.getTicketById(ticketId));
  const shouldDispatch = updatedTicket.workflow_notify_policy?.dispatch_ready && updatedTicket.current_actor;
  if (shouldDispatch) {
    dispatch.recordDispatchEvent(ticketId, updatedTicket.current_actor, updatedTicket.status);
  }

  return { success: true, ticket: updatedTicket };
}

export function getAvailableActions(ticketId) {
  const ticket = store.getTicketById(ticketId);
  if (!ticket) return [];
  return listAvailableActionsForStatus(ticket.status);
}
