import * as store from './store.js';
import { enrichTicketRouting } from './ticket-routing.js';
import {
  executionModeRequiresWorker,
  getExecutionWorkerEvidence,
  mergeExecutionWorkerProjection,
} from '../execution-policy.js';
import { validateDispatchAdvanceChain } from './dispatch-advance-chain.js';
import * as dispatch from './dispatch.js';

export function buildParentChildSummary(ticket = {}) {
  const childTickets = Array.isArray(ticket.child_tickets) ? ticket.child_tickets : [];
  const byStatus = {};
  const blockingChildren = [];
  const terminalStatuses = new Set(['complete', 'failed', 'deprecated']);
  let latestCompletedChild = null;
  let blockedCount = 0;
  let failedCount = 0;

  childTickets.forEach((child) => {
    const status = String(child?.status || 'unknown').trim() || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;

    if (status === 'blocked') blockedCount += 1;
    if (status === 'failed') failedCount += 1;

    if (terminalStatuses.has(status)) {
      const childCompletedAt = child?.last_update || child?.created || null;
      if (childCompletedAt) {
        const childTs = Date.parse(childCompletedAt) || 0;
        const latestTs = Date.parse(latestCompletedChild?.completed_at || '') || 0;
        if (!latestCompletedChild || childTs >= latestTs) {
          latestCompletedChild = {
            id: child.id,
            title: child.title,
            status: child.status,
            completed_at: childCompletedAt,
          };
        }
      }
    } else {
      blockingChildren.push({
        id: child.id,
        title: child.title,
        status: child.status,
        assigned_agent: child.assigned_agent || null,
        result_summary: child.result_summary || null,
        last_update: child.last_update || null,
      });
    }
  });

  return {
    is_parent: childTickets.length > 0,
    has_parent: Boolean(ticket.parent_ticket_id),
    parent_ticket_id: ticket.parent_ticket_id || null,
    child_count: childTickets.length,
    terminal_child_count: childTickets.length - blockingChildren.length,
    open_child_count: blockingChildren.length,
    all_children_terminal: childTickets.length > 0 ? blockingChildren.length === 0 : true,
    by_status: byStatus,
    latest_completed_child: latestCompletedChild,
    latest_completed_at: latestCompletedChild?.completed_at || null,
    blocked_child_count: blockedCount,
    failed_child_count: failedCount,
    attention_required: blockedCount > 0 || failedCount > 0,
    blocking_children: blockingChildren,
  };
}

export function buildDispatchHandshakeProjection(ticket = {}) {
  const actor = String(ticket.current_actor || ticket.next_actor || ticket.assigned_agent || '').trim();
  const watchers = Array.from(new Set([
    ticket.assigned_agent,
    ticket.review_owner,
    ticket.triage_owner,
    ticket.current_actor,
  ].map((value) => String(value || '').trim()).filter(Boolean)));

  if (!ticket.id || !ticket.status || !actor) {
    return {
      dispatch_state: null,
      awaiting_receipt_from: null,
      dispatch_ack_deadline_at: null,
      dispatch_retry_count: 0,
      next_dispatch_retry_at: null,
      last_dispatch_receipt_at: null,
      last_dispatch_receipt_decision: null,
      dispatch_timeout_reason: null,
      dispatch_watchers: watchers,
      dispatch_escalation_targets: watchers,
    };
  }

  const latest = dispatch.getLatestDispatchHandshakeState(ticket.id, actor, ticket.status);
  const fallbackDispatchState = ticket.dispatch_state || null;
  const resolvedDispatchState = latest?.dispatch_state || fallbackDispatchState;
  return {
    dispatch_state: resolvedDispatchState,
    awaiting_receipt_from: latest?.awaiting_receipt_from || ticket.awaiting_receipt_from || null,
    dispatch_ack_deadline_at: latest?.dispatch_ack_deadline_at || null,
    dispatch_retry_count: Number(latest?.dispatch_retry_count ?? 0),
    next_dispatch_retry_at: latest?.next_dispatch_retry_at || null,
    last_dispatch_receipt_at: latest?.receipt_received_at || null,
    last_dispatch_receipt_decision: latest?.receipt_decision || ticket.last_dispatch_receipt_decision || null,
    dispatch_timeout_reason: resolvedDispatchState === 'receipt_overdue' ? 'receipt_not_received_before_deadline' : null,
    dispatch_watchers: watchers,
    dispatch_escalation_targets: watchers,
  };
}

export function buildExecutionGuard(ticket = {}) {
  const rawWorkerEvidence = getExecutionWorkerEvidence(ticket);
  const reservation = ticket.id ? store.getExecutionReservationForTicket(ticket.id) : null;
  const ignoreHistoricalWorkerEvidence = ticket.status === 'queued'
    && reservation?.state === 'released'
    && reservation?.release_reason === 'reset_to_queued'
    && Number(rawWorkerEvidence.active_workers || 0) <= 0
    && Number(rawWorkerEvidence.running_workers || 0) <= 0;
  const workerEvidence = ignoreHistoricalWorkerEvidence
    ? {
        ...rawWorkerEvidence,
        succeeded_workers: 0,
        failed_terminal_workers: 0,
        has_worker_evidence: false,
        has_active_execution_evidence: false,
        has_completed_execution_evidence: false,
        has_historical_started_worker: false,
      }
    : rawWorkerEvidence;
  const reservationConflict = ticket.assigned_agent
    ? store.findExecutionReservationConflict({ agentId: ticket.assigned_agent, excludeTicketId: ticket.id })
    : null;
  const guard = {
    ...workerEvidence,
    max_active_workers: Number(ticket.max_active_workers ?? 0),
    requires_worker: executionModeRequiresWorker(ticket.execution_mode),
    suppress_dispatch: false,
    reason: null,
    reservation,
    reservation_conflict: reservationConflict,
  };

  const latestHandshake = buildDispatchHandshakeProjection(ticket);
  const hasAcceptedQueuedReceipt = ticket.status === 'queued'
    && latestHandshake.dispatch_state === 'receipt_accepted'
    && latestHandshake.last_dispatch_receipt_decision === 'accepted';

  if (reservationConflict && ticket.status === 'queued') {
    return {
      ...guard,
      suppress_dispatch: true,
      reason: 'reservation_conflict',
    };
  }

  if (workerEvidence.active_workers <= 0) return guard;

  if (hasAcceptedQueuedReceipt) {
    return {
      ...guard,
      suppress_dispatch: false,
      reason: 'receipt_accepted_pending_running',
    };
  }

  if (ticket.status === 'running') {
    return {
      ...guard,
      suppress_dispatch: false,
      reason: 'running_assignment_refresh',
    };
  }

  if ((ticket.execution_mode || 'direct') === 'direct') {
    return {
      ...guard,
      suppress_dispatch: true,
      reason: 'direct_active_worker',
    };
  }

  return {
    ...guard,
    suppress_dispatch: true,
    reason: 'active_worker_in_progress',
  };
}

export function enrichTicketForApi(ticket = {}) {
  const enriched = enrichTicketRouting(ticket);
  const workerProjection = mergeExecutionWorkerProjection(enriched);
  const withWorkerProjection = {
    ...enriched,
    ...workerProjection,
  };
  const executionGuard = buildExecutionGuard(withWorkerProjection);
  const dispatchHandshake = buildDispatchHandshakeProjection(withWorkerProjection);
  const withGuards = {
    ...withWorkerProjection,
    ...dispatchHandshake,
    should_notify: executionGuard.suppress_dispatch ? false : withWorkerProjection.should_notify,
    execution_guard: executionGuard,
  };
  const parent_child_summary = buildParentChildSummary(withGuards);
  return {
    ...withGuards,
    parent_child_summary,
    advance_chain: validateDispatchAdvanceChain(withGuards),
  };
}
