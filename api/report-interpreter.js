import * as store from './store.js';
import * as dispatch from './dispatch.js';
import { getExecutionWorkerEvidence, executionModeRequiresWorker } from '../execution-policy.js';
import { transition } from './state-machine.js';
import { buildCommentId } from './comment-utils.js';
import { resolveDispatchDelivery } from './agent-delivery-router.js';

function normalizeText(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

function buildSummary(payload = {}) {
  return normalizeText(
    payload.receipt?.message
      || payload.result?.summary
      || payload.summary
      || payload.observation?.summary
      || payload.proposed_next_step?.reason
      || payload.progress?.message
      || payload.error?.message,
    500,
  );
}

function renderArtifacts(artifacts = []) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return null;
  return artifacts.map((artifact) => {
    const name = normalizeText(artifact?.name, 120) || 'artifact';
    const kind = normalizeText(artifact?.kind, 40) || 'file';
    const ref = normalizeText(artifact?.content_ref || artifact?.url || artifact?.path, 500);
    return `- ${name} (${kind})${ref ? ` -> ${ref}` : ''}`;
  }).join('\n');
}

function resolveReceiptPayload(payload = {}, assignment = {}, ticket = {}) {
  const receipt = payload.receipt && typeof payload.receipt === 'object' ? payload.receipt : payload;
  const dispatchId = Number(receipt.dispatch_id ?? payload.dispatch_id ?? assignment.dispatch_event_id ?? 0);
  const stage = normalizeText(receipt.stage || assignment.stage || ticket.status, 80) || null;
  const agent = normalizeText(receipt.agent || assignment.agent_id, 120) || assignment.agent_id;
  const decision = normalizeText(receipt.decision || 'accepted', 40).toLowerCase() || 'accepted';
  const message = normalizeText(receipt.message || payload.summary || payload.progress?.message, 1000) || null;
  return {
    dispatch_id: Number.isInteger(dispatchId) && dispatchId > 0 ? dispatchId : null,
    ticket_id: Number(ticket.id || receipt.ticket_id || payload.ticket_id || 0) || ticket.id,
    stage,
    agent,
    decision,
    message,
  };
}

function resolveTriagePayload(payload = {}) {
  const triage = payload.triage && typeof payload.triage === 'object' ? payload.triage : {};
  const route = triage.route && typeof triage.route === 'object' ? triage.route : {};
  const responsibility = triage.responsibility && typeof triage.responsibility === 'object' ? triage.responsibility : {};
  const suggestedNextStep = triage.suggested_next_step && typeof triage.suggested_next_step === 'object'
    ? triage.suggested_next_step
    : payload.proposed_next_step && typeof payload.proposed_next_step === 'object'
      ? payload.proposed_next_step
      : {};
  const machineReasonCode = normalizeText(
    triage.machine_reason_code
      || route.machine_reason_code
      || suggestedNextStep.machine_reason_code,
    120,
  ) || null;
  const verdict = normalizeText(triage.verdict, 80) || null;
  const executable = triage.is_executable;
  return {
    verdict,
    is_executable: typeof executable === 'boolean' ? executable : null,
    route_target_status: normalizeText(route.target_status || suggestedNextStep.suggested_status, 80) || null,
    route_reason: normalizeText(route.reason || suggestedNextStep.reason, 1000) || null,
    machine_reason_code: machineReasonCode,
    responsibility: {
      assigned_agent: normalizeText(responsibility.assigned_agent, 120) || null,
      review_owner: normalizeText(responsibility.review_owner, 120) || null,
      triage_owner: normalizeText(responsibility.triage_owner, 120) || null,
      chain_complete: typeof responsibility.chain_complete === 'boolean' ? responsibility.chain_complete : null,
      missing_fields: Array.isArray(responsibility.missing_fields)
        ? responsibility.missing_fields.map((item) => normalizeText(item, 80)).filter(Boolean)
        : [],
    },
    suggested_next_step: {
      action: normalizeText(suggestedNextStep.action, 80) || null,
      suggested_status: normalizeText(suggestedNextStep.suggested_status, 80) || null,
      reason: normalizeText(suggestedNextStep.reason, 1000) || null,
      machine_reason_code: machineReasonCode,
    },
  };
}

function renderReportComment(reportType, assignment, payload = {}, ticket = {}) {
  const summary = buildSummary(payload) || '无摘要';
  const details = normalizeText(payload.result?.details_markdown || payload.details_markdown, 8000);
  const progressStatus = normalizeText(payload.progress?.status, 80);
  const percent = Number(payload.progress?.percent);
  const nextStep = normalizeText(payload.proposed_next_step?.suggested_status, 80);
  const nextReason = normalizeText(payload.proposed_next_step?.reason, 500);
  const blockedBy = Array.isArray(payload.observation?.blocked_by)
    ? payload.observation.blocked_by.map((id) => `#${id}`).join(', ')
    : '';
  const artifacts = renderArtifacts(payload.artifacts);
  const receipt = reportType === 'dispatch_receipt' ? resolveReceiptPayload(payload, assignment, ticket) : null;
  const triage = reportType === 'triage_structured_report' ? resolveTriagePayload(payload) : null;
  const sections = [
    `【agent_report】${reportType}`,
    `【assignment】${assignment.assignment_id}`,
    `【agent】${assignment.agent_id}`,
    `【摘要】${summary}`,
  ];

  if (receipt) {
    sections.push(`【receipt】dispatch=${receipt.dispatch_id || 'n/a'} · stage=${receipt.stage || 'n/a'} · decision=${receipt.decision || 'n/a'}`);
  }

  if (triage) {
    sections.push(`【triage】verdict=${triage.verdict || 'n/a'} · executable=${triage.is_executable === null ? 'n/a' : triage.is_executable ? 'true' : 'false'} · target=${triage.route_target_status || triage.suggested_next_step.suggested_status || 'n/a'}`);
    if (triage.responsibility.assigned_agent || triage.responsibility.review_owner || triage.responsibility.triage_owner) {
      sections.push(`【责任链】triage_owner=${triage.responsibility.triage_owner || 'n/a'} · assigned_agent=${triage.responsibility.assigned_agent || 'n/a'} · review_owner=${triage.responsibility.review_owner || 'n/a'} · chain_complete=${triage.responsibility.chain_complete === null ? 'n/a' : triage.responsibility.chain_complete ? 'true' : 'false'}`);
    }
    if (triage.machine_reason_code || triage.responsibility.missing_fields.length > 0) {
      sections.push(`【machine_reason】${triage.machine_reason_code || 'n/a'}${triage.responsibility.missing_fields.length > 0 ? ` · missing=${triage.responsibility.missing_fields.join(',')}` : ''}`);
    }
  }

  if (progressStatus || Number.isFinite(percent)) {
    sections.push(`【进度】${progressStatus || 'n/a'}${Number.isFinite(percent) ? ` (${percent}%)` : ''}`);
  }
  if (blockedBy) {
    sections.push(`【阻塞依赖】${blockedBy}`);
  }
  if (nextStep || nextReason) {
    sections.push(`【建议下一步】${nextStep || '未指定'}${nextReason ? ` - ${nextReason}` : ''}`);
  }
  if (details) {
    sections.push(`【详情】\n${details}`);
  }
  if (artifacts) {
    sections.push(`【产物】\n${artifacts}`);
  }

  return sections.join('\n\n');
}

function getCommentType(reportType) {
  switch (reportType) {
    case 'dispatch_receipt':
      return 'progress';
    case 'blocked_report':
      return 'blocker';
    case 'decision_request':
      return 'decision';
    case 'execution_completed':
    case 'review_submission':
    case 'analysis_result':
    case 'handoff_note':
    case 'artifact_upload':
    case 'triage_structured_report':
      return 'result';
    case 'execution_failed':
      return 'system';
    default:
      return 'progress';
  }
}

function buildTriageQueueGuard(ticket = {}, triagePayload = null) {
  const responsibility = triagePayload?.responsibility || {};
  const routeTarget = triagePayload?.route_target_status || triagePayload?.suggested_next_step?.suggested_status || null;
  if (routeTarget !== 'queued') return null;

  const assignedAgent = normalizeText(responsibility.assigned_agent || ticket.assigned_agent, 120) || null;
  const reviewOwner = normalizeText(responsibility.review_owner || ticket.review_owner, 120) || null;
  const triageOwner = normalizeText(responsibility.triage_owner || ticket.triage_owner, 120) || null;
  const missing = [];
  if (!assignedAgent) missing.push('assigned_agent');
  if (!reviewOwner) missing.push('review_owner');
  if (!triageOwner) missing.push('triage_owner');
  if (responsibility.chain_complete === false && missing.length === 0 && Array.isArray(responsibility.missing_fields)) {
    missing.push(...responsibility.missing_fields.filter(Boolean));
  }
  if (missing.length === 0) return null;

  return {
    code: triagePayload?.machine_reason_code || 'TRIAGE_QUEUE_CHAIN_INCOMPLETE',
    message: `triage structured report 请求 auto-queue，但责任链未完整：缺少 ${missing.join('、')}`,
    missing_fields: [...new Set(missing)],
    target_status: 'queued',
  };
}

function buildTransitionPlan(reportType, ticket = {}, payload = {}) {
  const summary = buildSummary(payload) || ticket.title || 'agent report';
  const detailMarkdown = normalizeText(
    payload.result?.details_markdown || payload.decision_context || payload.details_markdown,
    4000,
  ) || null;
  const triagePayload = reportType === 'triage_structured_report' ? resolveTriagePayload(payload) : null;

  switch (reportType) {
    case 'dispatch_receipt': {
      const receipt = resolveReceiptPayload(payload, {}, ticket);
      if (receipt.decision !== 'accepted') {
        return {
          action: null,
          suggested_status: ticket.status,
          allowedStatuses: [],
          stepsByStatus: {},
          receipt,
        };
      }

      if (receipt.stage === 'queued') {
        const workerEvidence = getExecutionWorkerEvidence(ticket);
        const requiresWorker = executionModeRequiresWorker(ticket.execution_mode);
        const hasOnlyCompletedEvidence = requiresWorker
          && !workerEvidence.has_active_execution_evidence
          && workerEvidence.has_completed_execution_evidence;
        if (hasOnlyCompletedEvidence) {
          return {
            action: null,
            suggested_status: ticket.status,
            allowedStatuses: ['queued'],
            stepsByStatus: {},
            receipt,
          };
        }
        return {
          action: 'start_work',
          suggested_status: 'running',
          allowedStatuses: ['queued'],
          stepsByStatus: {
            queued: [{ action: 'start_work', fields: {} }],
          },
          receipt,
        };
      }

      if (receipt.stage === 'done') {
        return {
          action: 'start_review',
          suggested_status: 'review',
          allowedStatuses: ['done'],
          stepsByStatus: {
            done: [{ action: 'start_review', fields: {} }],
          },
          receipt,
        };
      }

      return {
        action: null,
        suggested_status: ticket.status,
        allowedStatuses: [],
        stepsByStatus: {},
        receipt,
      };
    }
    case 'execution_completed':
    case 'review_submission':
    case 'analysis_result':
    case 'handoff_note':
    case 'artifact_upload': {
      const submitFields = { result_summary: summary };
      return {
        action: 'submit_for_review',
        suggested_status: 'done',
        allowedStatuses: ['queued', 'running'],
        stepsByStatus: {
          queued: [
            { action: 'start_work', fields: {} },
            { action: 'submit_for_review', fields: submitFields },
          ],
          running: [
            { action: 'submit_for_review', fields: submitFields },
          ],
        },
      };
    }

    case 'triage_structured_report': {
      const queueGuard = buildTriageQueueGuard(ticket, triagePayload);
      const routeTarget = triagePayload?.route_target_status || triagePayload?.suggested_next_step?.suggested_status || null;
      const canAutoQueue = triagePayload?.verdict === 'queue'
        && triagePayload?.is_executable === true
        && routeTarget === 'queued'
        && !queueGuard;
      return {
        action: canAutoQueue ? 'queue' : null,
        suggested_status: routeTarget || ticket.status,
        allowedStatuses: ['triage'],
        stepsByStatus: canAutoQueue
          ? {
              triage: [
                { action: 'queue', fields: {} },
              ],
            }
          : {},
        guard: queueGuard,
        machine_reason_code: triagePayload?.machine_reason_code || queueGuard?.code || null,
        target_status: routeTarget || null,
      };
    }

    case 'decision_request': {
      const requestFields = {
        decision_summary: summary,
        decision_context: detailMarkdown,
      };
      return {
        action: 'request_decision',
        suggested_status: 'pending_decision',
        allowedStatuses: ['queued', 'running', 'review'],
        stepsByStatus: {
          queued: [{ action: 'request_decision', fields: requestFields }],
          running: [
            { action: 'request_decision', fields: requestFields },
          ],
          review: [
            { action: 'request_decision', fields: requestFields },
          ],
        },
      };
    }

    case 'blocked_report': {
      const blockFields = { blocker_summary: summary };
      return {
        action: 'block',
        suggested_status: 'blocked',
        allowedStatuses: ['queued', 'running'],
        stepsByStatus: {
          queued: [{ action: 'block', fields: blockFields }],
          running: [
            { action: 'block', fields: blockFields },
          ],
        },
      };
    }

    case 'execution_failed': {
      const failFields = { error: summary };
      return {
        action: 'fail',
        suggested_status: 'failed',
        allowedStatuses: ['queued', 'running'],
        stepsByStatus: {
          queued: [{ action: 'fail', fields: failFields }],
          running: [
            { action: 'fail', fields: failFields },
          ],
        },
      };
    }

    default: {
      const suggested = normalizeText(payload.proposed_next_step?.suggested_status, 80);
      return suggested
        ? {
            action: null,
            suggested_status: suggested,
            allowedStatuses: [],
            stepsByStatus: {},
          }
        : null;
    }
  }
}

function buildWorkerEvidenceSnapshot(ticket = {}) {
  const workerStats = ticket.worker_stats && typeof ticket.worker_stats === 'object'
    ? {
        total_workers: Number(ticket.worker_stats.total_workers ?? 0),
        active_workers: Number(ticket.worker_stats.active_workers ?? 0),
        running_workers: Number(ticket.worker_stats.running_workers ?? 0),
      }
    : {
        total_workers: 0,
        active_workers: 0,
        running_workers: 0,
      };
  const currentWorkers = Array.isArray(ticket.current_workers) ? ticket.current_workers : [];
  const executionWorkers = Array.isArray(ticket.execution_workers) ? ticket.execution_workers : [];
  const evidence = getExecutionWorkerEvidence(ticket);
  return {
    worker_stats: workerStats,
    current_workers: currentWorkers,
    execution_workers: executionWorkers,
    has_worker_evidence: evidence.has_worker_evidence,
    has_active_execution_evidence: evidence.has_active_execution_evidence,
    has_completed_execution_evidence: evidence.has_completed_execution_evidence,
    has_historical_started_worker: evidence.has_historical_started_worker,
    succeeded_workers: evidence.succeeded_workers,
    failed_terminal_workers: evidence.failed_terminal_workers,
    evidence_tiers: {
      active_execution: Boolean(evidence.has_active_execution_evidence),
      historical_started: Boolean(evidence.has_historical_started_worker),
      completed: evidence.succeeded_workers > 0,
      failed_terminal: evidence.failed_terminal_workers,
    },
  };
}

function buildTransitionGuard(reportType, ticket = {}, transitionPlan = null) {
  if (!transitionPlan?.action) return null;
  if (!['execution_completed', 'review_submission'].includes(reportType)) return null;
  if (!['subagent', 'acp'].includes(String(ticket.execution_mode || 'direct').trim().toLowerCase())) return null;

  const workerEvidence = buildWorkerEvidenceSnapshot(ticket);
  if (workerEvidence.has_worker_evidence) return null;

  const expectedWorkerType = ticket.worker_type || String(ticket.execution_mode || '').trim().toLowerCase() || null;
  return {
    code: 'EXECUTION_WORKER_REQUIRED',
    message: `execution_mode=${ticket.execution_mode} 的完成回写前必须先登记至少一个 ${expectedWorkerType || 'execution'} worker`,
    expected_worker_type: expectedWorkerType,
    worker_evidence_required: true,
    worker_stats: workerEvidence.worker_stats,
    current_workers: workerEvidence.current_workers,
    execution_workers: workerEvidence.execution_workers,
  };
}

function resolveTransitionSteps(transitionPlan = null, currentStatus = '') {
  if (!transitionPlan?.action) return [];
  if (!transitionPlan.allowedStatuses.includes(currentStatus)) return [];
  const steps = transitionPlan.stepsByStatus?.[currentStatus];
  return Array.isArray(steps) ? steps : [];
}

/**
 * 双写 command 到 commands 表（事件驱动 Phase 2 铺垫）。
 * 不改变现有 transition 流程，仅记录等价 command 供后续 Orchestrator 消费。
 */
function appendCommandForReport({ reportType, ticket, assignment, payload, transitionPlan, transitionGuard, receipt }) {
  const aggregateId = String(ticket.id);
  const issuer = { kind: 'agent', id: assignment.agent_id };
  const correlationId = `asg_${assignment.assignment_id}`;
  const now = new Date().toISOString();

  if (reportType === 'triage_structured_report' && transitionPlan?.action === 'queue' && !transitionGuard) {
    const triage = resolveTriagePayload(payload);
    const route = {
      assigned_agent: triage.responsibility?.assigned_agent ?? ticket.assigned_agent,
      review_owner: triage.responsibility?.review_owner ?? ticket.review_owner,
    };
    store.appendCommandLog({
      command_type: 'QueueTicket',
      aggregate_type: 'ticket',
      aggregate_id: aggregateId,
      issuer,
      correlation_id: correlationId,
      idempotency_key: `ticket-${ticket.id}-queue-v1`,
      payload: { reason: triage.route_reason || 'triage complete', route },
      issued_at: now,
    });
    return;
  }

  if (reportType === 'dispatch_receipt' && receipt?.dispatch_id) {
    store.appendCommandLog({
      command_type: 'RecordAssignmentReceipt',
      aggregate_type: 'assignment',
      aggregate_id: assignment.assignment_id,
      issuer,
      correlation_id: correlationId,
      idempotency_key: `receipt-${receipt.dispatch_id}-${receipt.stage}-${receipt.decision}`,
      payload: {
        assignment_id: assignment.assignment_id,
        dispatch_id: receipt.dispatch_id,
        decision: receipt.decision,
        stage: receipt.stage,
        agent: receipt.agent ?? assignment.agent_id,
        message: receipt.message,
      },
      issued_at: now,
    });
    return;
  }

  if ((reportType === 'execution_completed' || reportType === 'review_submission' || reportType === 'analysis_result' || reportType === 'handoff_note' || reportType === 'artifact_upload') && transitionPlan?.action === 'submit_for_review' && !transitionGuard) {
    const summary = buildSummary(payload) || '';
    store.appendCommandLog({
      command_type: 'SubmitForReview',
      aggregate_type: 'ticket',
      aggregate_id: aggregateId,
      issuer,
      correlation_id: correlationId,
      idempotency_key: `ticket-${ticket.id}-submit-v1-${Date.now()}`,
      payload: { actor: assignment.agent_id, result_summary: summary, artifacts: payload.artifacts ?? [] },
      issued_at: now,
    });
  }
}

function maybeCreateSuccessorAssignment({ assignment, ticketBefore, ticketAfter, reportType, receipt }) {
  if (reportType !== 'dispatch_receipt') return null;
  if (!receipt || receipt.decision !== 'accepted') return null;

  if (ticketBefore?.status !== 'queued' || ticketAfter?.status !== 'running') return null;

  const ensureRunningDispatch = (runningAssignment) => {
    if (!runningAssignment) return null;
    if (runningAssignment.dispatch_event_id) return runningAssignment;

    const dispatchId = dispatch.recordDispatchEvent(ticketAfter.id, assignment.agent_id, 'running');
    const runningDelivery = resolveDispatchDelivery({ agent: assignment.agent_id, ticketId: ticketAfter.id, kind: 'running' });
    const updatedAssignment = store.updateAssignment(runningAssignment.assignment_id, {
      dispatch_event_id: dispatchId,
      gateway_id: runningDelivery.target_gateway_id || assignment.gateway_id,
      assignment_status: runningAssignment.assignment_status || 'created',
      intent: runningDelivery.delivery_intent || assignment.intent || runningAssignment.intent || 'dispatch',
      role: assignment.role || runningAssignment.role || 'execute',
      stage: 'running',
      target_session_key: runningDelivery.target_session_key || assignment.target_session_key,
      transport: runningDelivery.transport || assignment.transport,
    });

    store.updateExecutionReservation(ticketAfter.id, {
      assignment_id: updatedAssignment.assignment_id,
      dispatch_event_id: dispatchId,
      state: 'reserved',
      holder_kind: 'assignment',
      holder_key: updatedAssignment.assignment_id,
      release_reason: null,
      released_at: null,
    });

    dispatch.emitAssignmentDeliveryRequested(updatedAssignment.assignment_id, ticketAfter.id, dispatchId, {
      target_gateway_id: updatedAssignment.gateway_id,
      transport: updatedAssignment.transport,
      target_session_key: updatedAssignment.target_session_key,
    });

    return updatedAssignment;
  };

  const latest = store.findLatestAssignmentForTicket(ticketAfter.id, assignment.agent_id);
  if (latest && latest.assignment_id !== assignment.assignment_id && latest.stage === 'running') {
    return ensureRunningDispatch(latest);
  }

  const dispatchId = dispatch.recordDispatchEvent(ticketAfter.id, assignment.agent_id, 'running');
  const runningDelivery = resolveDispatchDelivery({ agent: assignment.agent_id, ticketId: ticketAfter.id, kind: 'running' });
  const successor = store.createOrReuseAssignment({
    ticket_id: ticketAfter.id,
    dispatch_event_id: dispatchId,
    agent_id: assignment.agent_id,
    gateway_id: runningDelivery.target_gateway_id || assignment.gateway_id,
    execution_mode: assignment.execution_mode ?? ticketAfter.execution_mode,
    assignment_status: 'created',
    intent: runningDelivery.delivery_intent || assignment.intent || 'dispatch',
    role: assignment.role || 'execute',
    stage: 'running',
    target_session_key: runningDelivery.target_session_key || assignment.target_session_key,
    transport: runningDelivery.transport || assignment.transport,
  });

  store.updateExecutionReservation(ticketAfter.id, {
    assignment_id: successor.assignment_id,
    dispatch_event_id: dispatchId,
    state: 'reserved',
    holder_kind: 'assignment',
    holder_key: successor.assignment_id,
    release_reason: null,
    released_at: null,
  });

  dispatch.emitAssignmentDeliveryRequested(successor.assignment_id, ticketAfter.id, dispatchId, {
    target_gateway_id: successor.gateway_id,
    transport: successor.transport,
    target_session_key: successor.target_session_key,
  });

  return successor;
}

function resolveAssignmentStatus(reportType, ticketStatusAfter, ticketStatusBefore, payload = {}) {
  switch (reportType) {
    case 'dispatch_receipt': {
      const decision = normalizeText(payload.receipt?.decision || payload.decision || 'accepted', 40).toLowerCase() || 'accepted';
      if (decision !== 'accepted') return 'receipt_recorded';
      return ['running', 'review'].includes(ticketStatusAfter || ticketStatusBefore) ? 'in_progress' : 'receipt_recorded';
    }
    case 'execution_completed':
    case 'review_submission':
    case 'analysis_result':
    case 'handoff_note':
    case 'artifact_upload':
      return ['done', 'review', 'complete'].includes(ticketStatusAfter || ticketStatusBefore)
        ? 'submitted'
        : 'in_progress';
    case 'triage_structured_report':
      return ticketStatusAfter === 'queued' ? 'in_progress' : 'receipt_recorded';
    case 'decision_request':
      return ticketStatusAfter === 'pending_decision' ? 'waiting_on_decision' : 'in_progress';
    case 'blocked_report':
      return ticketStatusAfter === 'blocked' ? 'waiting_on_dependency' : 'in_progress';
    case 'execution_failed':
      return ticketStatusAfter === 'failed' ? 'failed_execution' : 'in_progress';
    default:
      if (ticketStatusAfter === 'blocked') return 'waiting_on_dependency';
      if (ticketStatusAfter === 'pending_decision') return 'waiting_on_decision';
      return 'in_progress';
  }
}

export function interpretAgentReport({ assignment, ticket, reportType, payload = {} }) {
  const receipt = reportType === 'dispatch_receipt' ? resolveReceiptPayload(payload, assignment, ticket) : null;
  if (receipt && receipt.stage === 'queued') {
    if (receipt.decision === 'accepted') {
      store.updateExecutionReservation(ticket.id, {
        assignment_id: assignment.assignment_id,
        dispatch_event_id: receipt.dispatch_id ?? assignment.dispatch_event_id ?? null,
        state: 'receipt_accepted',
        holder_kind: 'receipt',
        holder_key: assignment.assignment_id,
        release_reason: null,
        released_at: null,
      });
    } else {
      store.releaseExecutionReservationByTicket(ticket.id, `receipt_${receipt.decision || 'declined'}`);
    }
  }
  const comment = {
    id: buildCommentId(),
    author: assignment.agent_id,
    timestamp: new Date().toISOString(),
    content: renderReportComment(reportType, assignment, payload, ticket),
    type: getCommentType(reportType),
    visibility: 'internal',
    thread_id: null,
    mentions: [],
    notify_targets: [],
  };

  store.addComment(ticket.id, comment);

  let receiptEvent = null;
  if (receipt?.dispatch_id) {
    receiptEvent = dispatch.markDispatchReceipt(receipt.dispatch_id, {
      decision: receipt.decision,
      message: receipt.message,
      payload: receipt,
    });
  }

  const transitionPlan = buildTransitionPlan(reportType, ticket, payload);
  const transitionGuard = transitionPlan?.guard || buildTransitionGuard(reportType, ticket, transitionPlan);
  const transitionSteps = transitionGuard
    ? []
    : resolveTransitionSteps(transitionPlan, ticket.status);

  // 双写 command（Phase 2 铺垫：report → command，后续由 Orchestrator 消费）。失败不影响主流程。
  try {
    appendCommandForReport({ reportType, ticket, assignment, payload, transitionPlan, transitionGuard, receipt });
  } catch (err) {
    console.warn('[report-interpreter] appendCommandForReport failed:', err?.message);
  }

  const transition_trace = [];
  let transitionResult = null;
  let workingTicket = ticket;

  for (const step of transitionSteps) {
    transitionResult = transition(workingTicket.id, step.action, {
      actor: assignment.agent_id,
      ...step.fields,
    });

    transition_trace.push({
      action: step.action,
      from_status: workingTicket.status,
      success: Boolean(transitionResult?.success),
      to_status: transitionResult?.success ? transitionResult.ticket?.status || null : null,
      error: transitionResult?.success ? null : transitionResult?.error || 'Transition failed',
    });

    if (!transitionResult?.success) break;
    workingTicket = transitionResult.ticket || store.getTicketById(ticket.id) || workingTicket;
  }

  const applied = transitionSteps.length > 0 && transition_trace.every((step) => step.success);
  const updatedTicket = store.getTicketById(ticket.id) || ticket;
  const successorAssignment = maybeCreateSuccessorAssignment({
    assignment,
    ticketBefore: ticket,
    ticketAfter: updatedTicket,
    reportType,
    receipt,
  });
  const assignmentStatus = resolveAssignmentStatus(reportType, updatedTicket.status, ticket.status, payload);

  store.updateAssignment(assignment.assignment_id, {
    assignment_status: assignmentStatus,
  });

  return {
    comment_appended: true,
    generated_comment_type: comment.type,
    generated_comment_id: comment.id,
    transition_preview: transitionPlan
      ? {
          action: transitionPlan.action,
          suggested_status: transitionPlan.suggested_status,
          will_transition: transitionGuard ? false : transitionSteps.length > 0,
          applied,
          bridge_actions: transitionSteps.map((step) => step.action),
          attempted_steps: transition_trace,
          blocked_by_guard: Boolean(transitionGuard),
          guard_error: transitionGuard?.code || null,
          guard_message: transitionGuard?.message || null,
          expected_worker_type: transitionGuard?.expected_worker_type || null,
          worker_evidence_required: transitionGuard?.worker_evidence_required || false,
          worker_stats: transitionGuard?.worker_stats || null,
          current_workers: transitionGuard?.current_workers || null,
          execution_workers: transitionGuard?.execution_workers || null,
        }
      : null,
    transition_error: transitionGuard?.message || transition_trace.find((step) => !step.success)?.error || null,
    assignment_status: assignmentStatus,
    receipt: receipt ? {
      ...receipt,
      dispatch_state: receiptEvent?.dispatch_state || null,
      receipt_received_at: receiptEvent?.receipt_received_at || null,
    } : null,
    successor_assignment: successorAssignment ? {
      assignment_id: successorAssignment.assignment_id,
      assignment_token: successorAssignment.assignment_token,
      assignment_status: successorAssignment.assignment_status,
      stage: successorAssignment.stage,
      ticket_id: successorAssignment.ticket_id,
      agent_id: successorAssignment.agent_id,
      dispatch_event_id: successorAssignment.dispatch_event_id ?? null,
      target_session_key: successorAssignment.target_session_key || null,
      transport: successorAssignment.transport || null,
      gateway_id: successorAssignment.gateway_id || null,
    } : null,
    latest_progress: payload.progress && typeof payload.progress === 'object' ? payload.progress : null,
    ticket_status_after: updatedTicket.status || ticket.status,
    notification_hint: updatedTicket.status === 'pending_decision'
      ? 'main_session'
      : ['done', 'review', 'complete', 'failed'].includes(updatedTicket.status)
        ? 'workflow_notify_policy'
        : null,
  };
}
