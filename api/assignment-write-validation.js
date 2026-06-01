/**
 * Assignment write validation gateway
 * 统一校验 heartbeat / reports / reviewer write 的 assignment 身份、expected truth、
 * 一致性与 stale/live precondition；dispatch_receipt 强校验 dispatch_id/ticket_id/stage/agent。
 */
import * as dispatch from './dispatch.js';

/** Machine-readable error codes */
export const VALIDATION_CODES = {
  ASSIGNMENT_TICKET_MISMATCH: 'ASSIGNMENT_TICKET_MISMATCH',
  ASSIGNMENT_STALE: 'ASSIGNMENT_STALE',
  DISPATCH_RECEIPT_DISPATCH_ID_INVALID: 'DISPATCH_RECEIPT_DISPATCH_ID_INVALID',
  DISPATCH_RECEIPT_TICKET_ID_MISMATCH: 'DISPATCH_RECEIPT_TICKET_ID_MISMATCH',
  DISPATCH_RECEIPT_STAGE_MISMATCH: 'DISPATCH_RECEIPT_STAGE_MISMATCH',
  DISPATCH_RECEIPT_AGENT_MISMATCH: 'DISPATCH_RECEIPT_AGENT_MISMATCH',
  DISPATCH_RECEIPT_MISSING_FIELDS: 'DISPATCH_RECEIPT_MISSING_FIELDS',
};

function buildDeliveryStale(assignment = {}, ticket = {}, latestAssignment = null, kind = null, payload = {}) {
  const assignmentStage = assignment.stage || null;
  const liveStatus = ticket.status || null;
  const supplemental = ticket.supplemental_for_ticket?.ticket
    ? { primary_ticket: ticket.supplemental_for_ticket.ticket }
    : null;
  const action = String(payload?.action || '').trim();
  const allowReviewerRejectWithFreshQueuedSuccessor = kind === 'reviewer_action'
    && action === 'reject'
    && assignmentStage === 'done'
    && liveStatus === 'done'
    && latestAssignment?.assignment_id
    && latestAssignment.assignment_id !== assignment.assignment_id
    && latestAssignment.stage === 'queued'
    && String(latestAssignment.assignment_status || '').trim() !== 'submitted';

  if (latestAssignment?.assignment_id && assignment?.assignment_id && latestAssignment.assignment_id !== assignment.assignment_id) {
    if (allowReviewerRejectWithFreshQueuedSuccessor) {
      return {
        stale: false,
        stale_reason: null,
        latest_assignment_id: latestAssignment.assignment_id,
        latest_assignment_status: latestAssignment.assignment_status || null,
        latest_assignment_stage: latestAssignment.stage || null,
      };
    }
    return {
      stale: true,
      stale_reason: 'superseded_assignment',
      latest_assignment_id: latestAssignment.assignment_id,
      latest_assignment_status: latestAssignment.assignment_status || null,
      latest_assignment_stage: latestAssignment.stage || null,
    };
  }
  if (assignmentStage && liveStatus && assignmentStage !== liveStatus) {
    return { stale: true, stale_reason: 'ticket_status_changed_after_dispatch' };
  }
  if (supplemental?.primary_ticket?.status === 'complete' && ['done', 'review', 'complete'].includes(liveStatus || assignmentStage || '')) {
    return { stale: true, stale_reason: 'supplemental_ticket_after_primary_complete' };
  }
  return { stale: false, stale_reason: null };
}

function normalizeText(value, max = 200) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

/**
 * Strong validation for dispatch_receipt: dispatch_id, ticket_id, stage, agent must match assignment and dispatch event.
 */
function validateDispatchReceipt({ assignment, ticket, payload = {} }) {
  const receipt = payload.receipt && typeof payload.receipt === 'object' ? payload.receipt : payload;
  const errors = [];
  const dispatchId = Number(receipt.dispatch_id ?? payload.dispatch_id ?? assignment.dispatch_event_id ?? 0);
  const boundDispatchId = Number(assignment.dispatch_event_id ?? 0);
  const ticketId = Number(receipt.ticket_id ?? payload.ticket_id ?? 0) || Number(ticket?.id);
  const stage = normalizeText(receipt.stage, 80) || null;
  const agent = normalizeText(receipt.agent ?? assignment.agent_id, 120) || null;

  if (!Number.isInteger(dispatchId) || dispatchId <= 0) {
    errors.push({ code: VALIDATION_CODES.DISPATCH_RECEIPT_DISPATCH_ID_INVALID, message: 'dispatch_id 必须为正整数', field: 'dispatch_id' });
  }
  if (!stage) {
    errors.push({ code: VALIDATION_CODES.DISPATCH_RECEIPT_MISSING_FIELDS, message: 'receipt.stage 缺失', field: 'stage' });
  }
  if (!agent) {
    errors.push({ code: VALIDATION_CODES.DISPATCH_RECEIPT_MISSING_FIELDS, message: 'receipt.agent 缺失', field: 'agent' });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  if (boundDispatchId > 0 && dispatchId !== boundDispatchId) {
    errors.push({
      code: VALIDATION_CODES.DISPATCH_RECEIPT_DISPATCH_ID_INVALID,
      message: `receipt.dispatch_id=${dispatchId} 与 assignment.dispatch_event_id=${boundDispatchId} 不一致`,
      field: 'dispatch_id',
      expected: boundDispatchId,
      received: dispatchId,
    });
  }

  const event = dispatch.getDispatchEventById(dispatchId);
  if (!event) {
    if (errors.length === 0) {
      errors.push({ code: VALIDATION_CODES.DISPATCH_RECEIPT_DISPATCH_ID_INVALID, message: `dispatch_id=${dispatchId} 对应事件不存在`, field: 'dispatch_id' });
    }
    return { ok: false, errors };
  }

  const expectedTicketId = Number(assignment.ticket_id ?? ticket?.id);
  if (ticketId !== expectedTicketId) {
    errors.push({
      code: VALIDATION_CODES.DISPATCH_RECEIPT_TICKET_ID_MISMATCH,
      message: `receipt.ticket_id=${ticketId} 与 assignment.ticket_id=${expectedTicketId} 不一致`,
      field: 'ticket_id',
      expected: expectedTicketId,
      received: ticketId,
    });
  }
  if (Number(event.ticket_id) !== expectedTicketId) {
    errors.push({
      code: VALIDATION_CODES.DISPATCH_RECEIPT_TICKET_ID_MISMATCH,
      message: `dispatch 事件 ticket_id=${event.ticket_id} 与 assignment.ticket_id=${expectedTicketId} 不一致`,
      field: 'ticket_id',
    });
  }

  const expectedAgent = String(assignment.agent_id || '').trim();
  if (agent && expectedAgent && agent !== expectedAgent) {
    errors.push({
      code: VALIDATION_CODES.DISPATCH_RECEIPT_AGENT_MISMATCH,
      message: `receipt.agent=${agent} 与 assignment.agent_id=${expectedAgent} 不一致`,
      field: 'agent',
      expected: expectedAgent,
      received: agent,
    });
  }
  if (String(event.agent || '').trim() !== expectedAgent) {
    errors.push({
      code: VALIDATION_CODES.DISPATCH_RECEIPT_AGENT_MISMATCH,
      message: `dispatch 事件 agent=${event.agent} 与 assignment.agent_id=${expectedAgent} 不一致`,
      field: 'agent',
    });
  }

  const assignmentStage = assignment.stage || null;
  const allowedStages = [assignmentStage, event.status].filter(Boolean);
  if (stage && allowedStages.length > 0 && !allowedStages.includes(stage)) {
    errors.push({
      code: VALIDATION_CODES.DISPATCH_RECEIPT_STAGE_MISMATCH,
      message: `receipt.stage=${stage} 与 assignment.stage/dispatch.status 不一致，允许: ${allowedStages.join(', ')}`,
      field: 'stage',
      expected: allowedStages,
      received: stage,
    });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [] };
}

/**
 * Validate assignment write: identity, expected truth snapshot, consistency, stale/live precondition.
 * @param {Object} options
 * @param {Object} options.assignment - assignment 对象
 * @param {Object} options.ticket - ticket 对象
 * @param {string} options.kind - 'heartbeat' | 'report' | 'reviewer_action'
 * @param {Object} [options.payload] - 仅 report 时使用；若 report_type 为 dispatch_receipt 会强校验 receipt
 * @param {string} [options.reportType] - 仅 kind=report 时使用
 * @param {Function} [options.appendAudit] - (entry) => auditId，可选；用于写入 audit trail
 * @param {Object} [options.latestAssignment] - 该 ticket/agent 当前最新 assignment，用于识别 superseded assignment
 */
export function validateAssignmentWrite({ assignment, ticket, kind, payload = {}, reportType = null, appendAudit = null, latestAssignment = null }) {
  const audit = {
    at: new Date().toISOString(),
    kind,
    assignment_id: assignment?.assignment_id ?? null,
    ticket_id: assignment?.ticket_id ?? ticket?.id ?? null,
    passed: true,
    errors: [],
    codes: [],
  };

  const errors = [];

  if (!assignment || !ticket) {
    errors.push({ code: 'ASSIGNMENT_OR_TICKET_MISSING', message: 'assignment 或 ticket 缺失' });
    audit.passed = false;
    audit.errors = errors;
    audit.codes = errors.map((e) => e.code);
    if (appendAudit) audit.id = appendAudit(audit);
    return { ok: false, status: 400, code: errors[0].code, message: errors[0].message, audit, errors };
  }

  const assignmentTicketId = Number(assignment.ticket_id);
  const ticketId = Number(ticket.id);
  if (assignmentTicketId !== ticketId) {
    errors.push({
      code: VALIDATION_CODES.ASSIGNMENT_TICKET_MISMATCH,
      message: `assignment.ticket_id=${assignmentTicketId} 与 ticket.id=${ticketId} 不一致`,
    });
  }

  const delivery = buildDeliveryStale(assignment, ticket, latestAssignment, kind, payload);
  if (delivery.stale) {
    errors.push({
      code: VALIDATION_CODES.ASSIGNMENT_STALE,
      message: `assignment 已过期：${delivery.stale_reason}，当前 ticket.status=${ticket.status}，assignment.stage=${assignment.stage}`,
      stale_reason: delivery.stale_reason,
      live_ticket_status: ticket.status,
      assignment_stage: assignment.stage,
      latest_assignment_id: delivery.latest_assignment_id,
      latest_assignment_status: delivery.latest_assignment_status,
      latest_assignment_stage: delivery.latest_assignment_stage,
    });
  }

  if (kind === 'report' && reportType === 'dispatch_receipt') {
    const receiptResult = validateDispatchReceipt({ assignment, ticket, payload });
    if (!receiptResult.ok) {
      errors.push(...receiptResult.errors);
    }
  }

  audit.passed = errors.length === 0;
  audit.errors = errors;
  audit.codes = [...new Set(errors.map((e) => e.code))];
  if (delivery.stale !== undefined) {
    audit.stale = delivery.stale;
    audit.stale_reason = delivery.stale_reason || null;
  }
  if (appendAudit) {
    try {
      audit.id = appendAudit(audit);
    } catch (e) {
      audit.append_error = e?.message || 'append audit failed';
    }
  }

  if (errors.length > 0) {
    const status = audit.codes.includes(VALIDATION_CODES.ASSIGNMENT_STALE) ? 409 : 400;
    return {
      ok: false,
      status,
      code: audit.codes[0],
      message: errors[0].message,
      audit,
      errors,
      machine_readable: {
        code: audit.codes[0],
        codes: audit.codes,
        errors: errors.map(({ code, message, field, expected, received }) => ({
          code,
          message,
          ...(field !== undefined && { field }),
          ...(expected !== undefined && { expected }),
          ...(received !== undefined && { received }),
        })),
      },
    };
  }

  return { ok: true, audit, machine_readable: { code: null, codes: [], errors: [] } };
}
