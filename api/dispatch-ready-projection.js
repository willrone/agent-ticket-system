import * as store from './store.js';
import * as dispatch from './dispatch.js';
import { resolveDispatchDelivery } from './agent-delivery-router.js';
import { buildAssignmentContract } from './agent-facing.js';
import { createLogger } from './logger.js';

const logger = createLogger('dispatch.ready');

export function buildDispatchEventGovernance({ ticket, agent, kind, mismatch = null, nudgeSource = null, nudgeKey = null, nudgeLevel = null }) {
  if (kind === 'workflow_mismatch') {
    return {
      reason: mismatch?.category || 'workflow_mismatch',
      dedupe_key: `dispatch:${ticket.status}:workflow_mismatch:${agent}:${mismatch?.category || 'workflow_mismatch'}`,
      escalation_tier: 'warning',
    };
  }

  if (kind === 'nudge') {
    const reason = nudgeKey || nudgeSource || 'nudge';
    return {
      reason,
      dedupe_key: `dispatch:${ticket.status}:${reason}:${agent}`,
      escalation_tier: nudgeLevel || (nudgeSource === 'audit_result' ? 'escalated' : 'nudge'),
    };
  }

  return {
    reason: ticket.status,
    dedupe_key: `dispatch:${ticket.status}:assignment:${agent}`,
    escalation_tier: ['done', 'review'].includes(ticket.status) ? 'review' : 'delivery',
  };
}

export function selectDispatchReadyCandidates(allTickets, options = {}) {
  const detectWorkflowMismatch = options.detectWorkflowMismatch;
  const getStaleDeliveryHint = options.getStaleDeliveryHint;
  const collectReadyNudges = options.collectReadyNudges;
  const enrichTicketForApi = options.enrichTicketForApi;

  if (typeof detectWorkflowMismatch !== 'function'
    || typeof getStaleDeliveryHint !== 'function'
    || typeof collectReadyNudges !== 'function'
    || typeof enrichTicketForApi !== 'function') {
    throw new Error('selectDispatchReadyCandidates missing required callbacks');
  }

  const ticketById = new Map(allTickets.map((ticket) => [ticket.id, ticket]));
  const candidates = [];
  const terminalStatuses = new Set(['complete', 'failed', 'deprecated']);

  for (const ticket of allTickets) {
    if (terminalStatuses.has(ticket.status)) continue;

    const mismatch = detectWorkflowMismatch(ticket);
    if (mismatch) {
      const agent = mismatch.alert_target || ticket.next_actor || '荣晖';
      if (!agent) continue;
      candidates.push({ ticket, agent, kind: 'workflow_mismatch', mismatch, priority: 1, sortTs: Date.parse(ticket.created || '') || 0 });
    } else if (!ticket.execution_guard?.suppress_dispatch
      && ticket.status !== 'paused'
      && ticket.workflow_notify_policy?.dispatch_ready
      && (ticket.next_actor || ticket.status === 'review')) {
      const hasOpenNudge = collectReadyNudges(allTickets).some((item) => item.ticket_id === ticket.id && item.kind === 'nudge');
      const hasUnresolvedNudgeForward = dispatch.listPendingForwards({
        channel: 'telegram',
        unresolvedOnly: true,
        ticketId: ticket.id,
        limit: 50,
      }).some((row) => row.event_kind === 'dispatch_nudge');
      const suppressNormalReadyForNudge = ticket.status !== 'queued' && (hasOpenNudge || hasUnresolvedNudgeForward);
      if (suppressNormalReadyForNudge) {
        continue;
      }
      const staleHint = getStaleDeliveryHint(ticket, 'dispatch');
      if (staleHint?.stale) {
        dispatch.clearDispatchEvents(ticket.id);
        logger.info('skip stale dispatch', { ticket_id: ticket.id, reason: staleHint.reason });
        continue;
      }
      if (store.hasUnmetDependencies(ticket.id)) {
        logger.info('skip unmet dependencies', { ticket_id: ticket.id });
        continue;
      }
      if (ticket.advance_chain && ticket.advance_chain.ok === false) {
        logger.warn('skip invalid advance chain', { ticket_id: ticket.id, code: ticket.advance_chain.code || 'unknown' });
        continue;
      }
      if (ticket.status === 'queued') {
        try {
          store.tryAcquireExecutionReservation({
            lane_key: 'single_running',
            agent_id: ticket.assigned_agent,
            ticket_id: ticket.id,
            state: 'reserved',
            holder_kind: 'dispatch',
            holder_key: `ticket:${ticket.id}`,
          });
        } catch (err) {
          if (err?.code === 'EXECUTION_RESERVATION_CONFLICT') {
            logger.info('skip execution reservation conflict', {
              ticket_id: ticket.id,
              assigned_agent: ticket.assigned_agent,
              conflict_ticket_id: err?.conflict_reservation?.ticket_id || null,
            });
            continue;
          }
          throw err;
        }
        const refreshed = enrichTicketForApi(store.getTicketById(ticket.id));
        candidates.push({ ticket: refreshed, agent: refreshed.next_actor, kind: undefined, mismatch: null, priority: 2, sortTs: Date.parse(refreshed.created || '') || 0 });
        continue;
      }
      const dispatchAgent = ticket.status === 'review'
        ? (ticket.review_owner || ticket.next_actor)
        : ticket.next_actor;
      candidates.push({ ticket, agent: dispatchAgent, kind: undefined, mismatch: null, priority: 2, sortTs: Date.parse(ticket.created || '') || 0 });
    }
  }

  for (const item of collectReadyNudges(allTickets)) {
    const ticket = ticketById.get(item.ticket_id);
    if (!ticket) continue;
    if (item.kind === 'nudge') {
      candidates.push({
        ticket,
        agent: item.agent,
        kind: 'nudge',
        mismatch: null,
        readyItem: item,
        priority: item.nudge_source === 'manual' ? -2 : ((options.nudgeLevelOrder?.[item.nudge_level] ?? 2) - 1),
        sortTs: options.getTicketLastActivityTs?.(ticket) || Date.parse(ticket.created || '') || 0,
      });
      continue;
    }
    candidates.push({
      ticket,
      agent: item.agent,
      kind: item.kind,
      mismatch: null,
      readyItem: item,
      priority: item.priority ?? 2,
      sortTs: options.getTicketLastActivityTs?.(ticket) || Date.parse(ticket.created || '') || 0,
    });
  }

  return candidates;
}

export function buildDispatchReadyProjection(allTickets, { requestId, buildAgentDispatchMessage, detectWorkflowMismatch, getStaleDeliveryHint, collectReadyNudges, enrichTicketForApi, getTicketLastActivityTs, nudgeLevelOrder = {} } = {}) {
  const safeBuildAssignmentContract = (assignment, ticket) => {
    try {
      return buildAssignmentContract(assignment, ticket);
    } catch (error) {
      logger.error('buildAssignmentContract failed', {
        assignment_id: assignment?.assignment_id || null,
        ticket_id: ticket?.id || null,
        agent: assignment?.agent_id || ticket?.next_actor || null,
        error,
      });
      throw error;
    }
  };
  if (typeof buildAgentDispatchMessage !== 'function') {
    throw new Error('buildDispatchReadyProjection requires buildAgentDispatchMessage');
  }

  const readyNudgesSnapshot = collectReadyNudges(allTickets);

  const candidates = selectDispatchReadyCandidates(allTickets, {
    detectWorkflowMismatch,
    getStaleDeliveryHint,
    collectReadyNudges: () => readyNudgesSnapshot,
    enrichTicketForApi,
    getTicketLastActivityTs,
    nudgeLevelOrder,
  });

  logger.debug('selected candidates', { candidate_count: candidates.length, request_id: requestId });

  const byAgent = new Map();
  const nudgeReady = [];
  for (const candidate of candidates) {
    const { ticket, agent, kind, mismatch, readyItem } = candidate;
    logger.debug('checking candidate', {
      ticket_id: ticket.id,
      agent,
      kind: kind || 'normal',
      request_id: requestId,
    });
    const governance = kind === 'nudge'
      ? {
          reason: readyItem.nudge_key,
          dedupe_key: readyItem.dedupe_key,
          escalation_tier: readyItem.escalation_tier,
        }
      : buildDispatchEventGovernance({ ticket, agent, kind, mismatch });
    const statusKey = governance.reason;

    if (kind === 'nudge') {
      nudgeReady.push(candidate);
      continue;
    }

    const hasRecent = dispatch.hasRecentDispatch(ticket.id, agent, statusKey, 60);
    if (hasRecent) continue;

    const existing = byAgent.get(agent);
    if (!existing) {
      byAgent.set(agent, candidate);
      continue;
    }

    const currentPriority = Number(candidate.priority ?? 2);
    const existingPriority = Number(existing.priority ?? 2);
    if (currentPriority < existingPriority || (currentPriority === existingPriority && candidate.sortTs < existing.sortTs)) {
      byAgent.set(agent, candidate);
    }
  }

  const ready = [];
  for (const { ticket, agent, kind, mismatch, readyItem } of [...nudgeReady, ...byAgent.values()]) {
    if (kind === 'nudge') {
      ready.push(readyItem);
      continue;
    }

    const governance = buildDispatchEventGovernance({ ticket, agent, kind, mismatch });
    const statusKey = governance.reason;
    const latestHandshake = dispatch.getLatestDispatchHandshakeState(ticket.id, agent, statusKey);
    let dispatchId = dispatch.getUnackedDispatchEvent(ticket.id, agent, statusKey);
    if (!dispatchId) {
      dispatchId = dispatch.recordDispatchEvent(ticket.id, agent, statusKey, {
        retry_count: latestHandshake?.should_retry ? Number(latestHandshake.dispatch_retry_count || 0) + 1 : 0,
      });
    }

    const delivery = resolveDispatchDelivery({ agent, ticketId: ticket.id, kind });

    if (kind === 'workflow_mismatch') {
      const alertMsg = mismatch.reason || '状态与评论不一致';
      ready.push({
        dispatch_id: dispatchId,
        request_id: requestId,
        dispatch_event_id: dispatchId,
        agent,
        ticket_id: ticket.id,
        title: ticket.title,
        status: ticket.status,
        next_actor: agent,
        execution_mode: ticket.execution_mode,
        worker_stats: ticket.worker_stats,
        dispatch_retry_count: latestHandshake?.should_retry ? Number(latestHandshake.dispatch_retry_count || 0) + 1 : Number(latestHandshake?.dispatch_retry_count || 0),
        reason: governance.reason,
        dedupe_key: governance.dedupe_key,
        escalation_tier: governance.escalation_tier,
        kind: 'workflow_mismatch',
        workflow_mismatch: mismatch,
        ...delivery,
        message: `⚠️ [workflow_mismatch 告警]\n\n#${ticket.id} ${ticket.title}\n当前状态：${ticket.status}\n问题：${alertMsg}\n推荐状态：${mismatch.recommended_status}\n\n请核实工单当前阶段：\n- 如果确实需要决策/授权，请通过 transition API 切到 ${mismatch.recommended_status}\n- 如果仍在正常施工中，可以忽略此告警（评论语义可能被误判）`,
      });
      continue;
    }

    const latestAssignment = store.findLatestAssignmentForTicket(ticket.id, agent);
    const reusableRunningAssignment = ticket.status === 'running'
      && latestAssignment
      && latestAssignment.stage === 'running'
      && !latestAssignment.dispatch_event_id;

    const assignment = reusableRunningAssignment
      ? store.updateAssignment(latestAssignment.assignment_id, {
          dispatch_event_id: dispatchId,
          gateway_id: delivery.target_gateway_id,
          assignment_status: latestAssignment.assignment_status || 'created',
          intent: delivery.delivery_intent || latestAssignment.intent || 'dispatch',
          role: latestAssignment.role || 'execute',
          stage: ticket.status,
          target_session_key: delivery.target_session_key,
          transport: delivery.transport,
        })
      : store.createOrReuseAssignment({
          ticket_id: ticket.id,
          dispatch_event_id: dispatchId,
          agent_id: agent,
          gateway_id: delivery.target_gateway_id,
          execution_mode: ticket.execution_mode,
          assignment_status: 'created',
          intent: delivery.delivery_intent || 'dispatch',
          role: 'execute',
          stage: ticket.status,
          target_session_key: delivery.target_session_key,
          transport: delivery.transport,
        });
    store.updateExecutionReservation(ticket.id, {
      assignment_id: assignment.assignment_id,
      dispatch_event_id: dispatchId,
      state: 'reserved',
      holder_kind: 'assignment',
      holder_key: assignment.assignment_id,
      release_reason: null,
      released_at: null,
    });
    dispatch.emitAssignmentDeliveryRequested(assignment.assignment_id, ticket.id, dispatchId, {
      target_gateway_id: delivery.target_gateway_id,
      transport: delivery.transport,
      target_session_key: delivery.target_session_key,
    });
    const assignmentContract = {
      ...safeBuildAssignmentContract(assignment, ticket),
      assignment_token: assignment.assignment_token,
    };

    ready.push({
      dispatch_id: dispatchId,
      request_id: requestId,
      agent,
      target_agent: agent,
      ticket_id: ticket.id,
      assignment_id: assignment.assignment_id,
      dispatch_event_id: dispatchId,
      title: ticket.title,
      status: ticket.status,
      status_before: ticket.status,
      status_after: ticket.status,
      next_actor: ticket.next_actor,
      computed_actor: ticket.current_actor || ticket.next_actor || agent,
      override_actor: ticket.next_actor_override || null,
      target_session: delivery.target_session_key,
      execution_mode: ticket.execution_mode,
      worker_stats: ticket.worker_stats,
      dispatch_retry_count: latestHandshake?.should_retry ? Number(latestHandshake.dispatch_retry_count || 0) + 1 : Number(latestHandshake?.dispatch_retry_count || 0),
      reason: governance.reason,
      dedupe_key: governance.dedupe_key,
      escalation_tier: governance.escalation_tier,
      reservation: ticket.execution_guard?.reservation || store.getExecutionReservationForTicket(ticket.id),
      reservation_conflict: ticket.execution_guard?.reservation_conflict || null,
      assignment: assignmentContract,
      reset_session: true,
      session_reset_reason: 'assignment_refresh',
      ...delivery,
      message: buildAgentDispatchMessage({ ticket, agent, assignment }),
    });
  }

  return ready;
}
