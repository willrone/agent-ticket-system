/**
 * Express 应用 - 导出 app 供测试使用，server.js 仅负责 listen
 */
import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import path from 'path';
import { fileURLToPath } from 'url';
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
import {
  getWorkflowSchema,
  getAvailableActionObjects,
  getRequiredFieldsForAction,
  getStatusMeta,
  getActionMeta,
  resolveActionActor,
  resolveCommentAuthor,
  resolveRoleActor,
  WORKFLOW_BUCKET_META,
  WORKFLOW_BUCKET_ORDER,
} from '../workflow-schema.js';
import { buildDashboardMetrics, getTicketProgress } from '../ticket-selectors.js';
import { detectWorkflowMismatch } from './workflow-mismatch.js';
import * as dispatch from './dispatch.js';
import { TRANSITIONS, transition, getAvailableActions } from './state-machine.js';
import { getAuditSessionKeyForTicket, getNotificationSessionKey } from './agent-session-router.js';
import { resolveDispatchDelivery, resolveNotificationDelivery } from './agent-delivery-router.js';
import { getAgentTopologyRegistry } from './agent-topology.js';
import { buildParticipantRegistrySnapshot, getParticipantById, resolveParticipantRoute } from './participant-registry.js';
import { previewTicketSessionCleanup, runTicketSessionCleanup } from './ticket-session-cleanup.js';
import { broadcastTicketStatusChanged, broadcastTicketComment } from './websocket.js';
import {
  EXECUTION_MODES,
  normalizeExecutionMode,
} from '../execution-policy.js';
import {
  AGENT_API_LEGACY_PREFIX,
  AGENT_API_PREFIX,
  AGENT_API_VERSION,
  AGENT_PLAYBOOK_KEY,
  AGENT_REPORT_TYPES,
  AGENT_SCHEMA_VERSION,
  buildAgentWorkflowSchema,
  buildAgentWorkboards,
  buildAssignmentContract,
  buildCurrentAgentSkillBundle,
  buildDependencySnapshot,
  buildPlaybookStageSnapshot,
  buildRuntimeContext,
  classifyCommentActor,
  getAgentApiBaseUrl,
  getAgentTicketActionRouteBindings,
  resolveAssignmentToken,
} from './agent-facing.js';
import {
  AGENT_ADMIN_API_LEGACY_PREFIX,
  AGENT_ADMIN_API_PREFIX,
  buildAgentAdminAuthContract,
  buildAgentAdminErrorModel,
  getAgentAdminGrantByToken,
  hasAgentAdminCapability,
  resolveAgentAdminToken,
} from './agent-admin.js';
import { interpretAgentReport } from './report-interpreter.js';
import { getRuntimeVersion } from './runtime-version.js';
import { validateAssignmentWrite } from './assignment-write-validation.js';
import { validateDispatchAdvanceChain } from './dispatch-advance-chain.js';
import {
  validateTicketPlatformAssignedAgent,
  resolveTicketPlatformAssignedAgent,
  resolveDefaultTriageOwner,
} from './ticket-platform-rules.js';
import { buildTicketControlReadModel } from './control-read-model.js';
import { buildParentChildSummary, enrichTicketForApi } from './ticket-enrichment.js';
import { buildLiveAcceptanceGate } from './live-acceptance.js';
import { buildAgentDispatchMessage } from './dispatch-message-builder.js';
import { buildDispatchEventGovernance, buildDispatchReadyProjection } from './dispatch-ready-projection.js';
import { registerTicketReadRoutes } from './ticket-read-routes.js';
import { buildRoutingPreview } from './platform-routing.js';
import {
  DEFAULT_PLATFORM_CAPABILITIES,
  DEFAULT_PLATFORM_AGENTS,
  DEFAULT_ROLE_CONTRACTS,
  DEFAULT_WORKFLOW_TEMPLATES,
} from './platform-registry-defaults.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const inboundRequestId = String(req.get('x-request-id') || '').trim();
  const requestId = inboundRequestId || randomUUID();
  req.requestId = requestId;
  res.set('X-Request-Id', requestId);
  next();
});

const ALLOWED_TICKET_STATUSES = TICKET_STATUSES;
const ALLOWED_REQUEST_TYPES = ['feature', 'bug', 'optimization', 'ops'];
const ALLOWED_EXECUTION_MODES = EXECUTION_MODES;
const ALLOWED_TICKET_RELATION_TYPES = ['validation_of', 'smoke_of', 'review_sample_of'];
const AGENT_ROUTE_PREFIXES = [AGENT_API_PREFIX, AGENT_API_LEGACY_PREFIX];

function getRequestId(req, res) {
  return String(res.get('X-Request-Id') || req.requestId || '').trim() || randomUUID();
}

function sendAgentError(req, res, status, body = {}) {
  const payload = body && typeof body === 'object' ? { ...body } : {};
  const detail = String(payload.detail || payload.message || payload.error || 'Request failed');
  delete payload.message;
  delete payload.detail;
  delete payload.error;
  return res.status(status).json({
    detail,
    request_id: getRequestId(req, res),
    ...payload,
  });
}

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


function normalizeOptionalWorkerLimit(value) {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === '') return { ok: true, value: null };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { ok: false, message: 'max_active_workers 必须是非负整数、null 或留空' };
  }
  return { ok: true, value: parsed };
}

function normalizeReviewPlan(value, { fallbackReviewOwner = null } = {}) {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === '') return { ok: true, value: {} };
  const plan = typeof value === 'object' ? value : null;
  if (!plan || Array.isArray(plan)) {
    return { ok: false, message: 'review_plan 必须是对象' };
  }

  const rounds = Array.isArray(plan.rounds) ? plan.rounds : [];
  const normalizedRounds = rounds.map((round, index) => {
    const reviewers = Array.isArray(round?.reviewers)
      ? round.reviewers.map((item) => normalizeOptionalAgent(item)).filter(Boolean)
      : [];
    return {
      round: Number(round?.round ?? index + 1),
      reviewers: [...new Set(reviewers)],
      required_all: round?.required_all !== false,
      label: normalizeOptionalText(round?.label, 255) || null,
    };
  }).filter((round) => round.reviewers.length > 0);

  if (normalizedRounds.length === 0) {
    const fallback = normalizeOptionalAgent(fallbackReviewOwner);
    if (!fallback) return { ok: true, value: {} };
    return {
      ok: true,
      value: {
        mode: 'single',
        rounds: [{ round: 1, reviewers: [fallback], required_all: true, label: null }],
      },
    };
  }

  return {
    ok: true,
    value: {
      mode: normalizedRounds.length > 1 || normalizedRounds.some((round) => round.reviewers.length > 1) ? 'multi' : 'single',
      rounds: normalizedRounds,
    },
  };
}

function buildInitialReviewState(reviewPlan = {}) {
  const rounds = Array.isArray(reviewPlan?.rounds) ? reviewPlan.rounds : [];
  if (rounds.length === 0) return {};
  return {
    current_round: 0,
    approvals: {},
  };
}


function listKnownAgentIds() {
  return Object.keys(getAgentTopologyRegistry().agent_gateway_map || {}).sort();
}

function validateAgentFacingActor(actor, options = {}) {
  const requestedActor = normalizeOptionalAgent(actor);
  if (!requestedActor) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Missing actor', message: '必须指定 actor（平台登记的 agent id）' },
    };
  }

  const allowedActorIds = Array.isArray(options.allowedActorIds)
    ? options.allowedActorIds.map((item) => normalizeOptionalAgent(item)).filter(Boolean)
    : [];
  const knownAgents = listKnownAgentIds();
  if (!knownAgents.includes(requestedActor)) {
    const participant = getParticipantById(requestedActor);
    const isHumanPrincipal = participant?.participant_type === 'human'
      || participant?.role_type === 'human_principal'
      || Boolean(participant?.capabilities?.includes('participant_type:human_principal'));
    if (!isHumanPrincipal && allowedActorIds.includes(requestedActor)) {
      return {
        ok: true,
        actor: requestedActor,
        requested_actor: requestedActor,
        alias_applied: false,
        identity_source: 'assignment_agent',
      };
    }
    return {
      ok: false,
      status: 403,
      body: {
        error: 'AGENT_ACTION_FORBIDDEN',
        message: isHumanPrincipal
          ? `actor ${requestedActor} 是人类主体，不是平台注册 agent；如已授权代办，请改用被授权的 agent id`
          : `actor ${requestedActor} 不是平台注册 agent`,
        actor: requestedActor,
        known_agents: knownAgents,
        human_principal: isHumanPrincipal || undefined,
      },
    };
  }

  return {
    ok: true,
    actor: requestedActor,
    requested_actor: requestedActor,
    alias_applied: false,
    identity_source: 'platform_agent',
  };
}

function prepareTicketCreatePayload(body = {}, { agentFacing = false, actor = null } = {}) {
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
    review_plan,
    parent_ticket_id,
    execution_mode,
    max_active_workers,
  } = body || {};

  if (!title || typeof title !== 'string' || !title.trim()) {
    return { ok: false, status: 400, body: { error: 'Bad request', message: '工单标题不能为空' } };
  }

  if (!agentFacing && status !== undefined) {
    if (!ALLOWED_TICKET_STATUSES.includes(status)) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'Bad request',
          message: `status 非法，允许值：${ALLOWED_TICKET_STATUSES.join('/')}`,
        },
      };
    }
    if (!['triage', 'queued'].includes(status)) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'Bad request',
          message: '创建工单只能使用 triage 状态；其他状态必须通过 transition 推进',
          allowed_create_status: 'triage',
          allowed_fixture_statuses: ['triage', 'queued'],
        },
      };
    }
  }

  if (request_type !== undefined && request_type !== null && request_type !== '' && !ALLOWED_REQUEST_TYPES.includes(request_type)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'Bad request',
        message: `request_type 非法，允许值：${ALLOWED_REQUEST_TYPES.join('/')}`,
      },
    };
  }

  if (execution_mode !== undefined && execution_mode !== null && execution_mode !== '' && !ALLOWED_EXECUTION_MODES.includes(String(execution_mode).trim().toLowerCase())) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'Bad request',
        message: `execution_mode 非法，允许值：${ALLOWED_EXECUTION_MODES.join('/')}`,
      },
    };
  }

  const normalizedWorkerLimit = normalizeOptionalWorkerLimit(max_active_workers);
  if (!normalizedWorkerLimit.ok) {
    return { ok: false, status: 400, body: { error: 'Bad request', message: normalizedWorkerLimit.message } };
  }

  const normalizedParent = normalizeParentTicketId(parent_ticket_id);
  if (!normalizedParent.ok) {
    return { ok: false, status: 400, body: { error: 'Bad request', message: normalizedParent.message } };
  }
  if (normalizedParent.value && !store.getTicketById(normalizedParent.value)) {
    return { ok: false, status: 400, body: { error: 'Bad request', message: 'parent_ticket_id 对应工单不存在' } };
  }

  if (agentFacing) {
    const forbiddenFields = ['status', 'decision_owner', 'decision_summary', 'decision_context', 'next_actor', 'review_plan', 'review_state'];
    const providedForbidden = forbiddenFields.filter((field) => body?.[field] !== undefined && body?.[field] !== null && body?.[field] !== '');
    if (providedForbidden.length > 0) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'AGENT_ACTION_FIELD_FORBIDDEN',
          message: `agent-facing create 不允许直接覆盖字段：${providedForbidden.join(', ')}`,
          forbidden_fields: providedForbidden,
        },
      };
    }
  }

  const requestedAgent = normalizeOptionalAgent(assigned_agent ?? agent);
  const targetAgent = agentFacing
    ? (resolveTicketPlatformAssignedAgent(platform, requestedAgent, { defaultToExecutor: true }) ?? actor)
    : (resolveTicketPlatformAssignedAgent(platform, requestedAgent, { defaultToExecutor: true }) ?? 'donky');

  const platformAgentValidation = validateTicketPlatformAssignedAgent(platform, targetAgent);
  if (!platformAgentValidation.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        error: platformAgentValidation.error,
        message: platformAgentValidation.message,
        platform: platformAgentValidation.platform,
        allowed_assigned_agents: platformAgentValidation.allowed_assigned_agents,
      },
    };
  }

  const normalizedTriageOwner = agentFacing
    ? (normalizeOptionalAgent(triage_owner) ?? resolveDefaultTriageOwner(platform, DEFAULT_TRIAGE_OWNER))
    : (normalizeOptionalAgent(triage_owner) ?? resolveDefaultTriageOwner(platform, DEFAULT_TRIAGE_OWNER));
  const normalizedReviewOwner = agentFacing
    ? (normalizeOptionalAgent(review_owner) ?? normalizedTriageOwner)
    : (normalizeOptionalAgent(review_owner) ?? normalizedTriageOwner);
  const normalizedDecisionOwner = agentFacing ? null : normalizeOptionalAgent(decision_owner);
  const normalizedReviewPlan = normalizeReviewPlan(review_plan, { fallbackReviewOwner: normalizedReviewOwner });
  if (!normalizedReviewPlan.ok) {
    return { ok: false, status: 400, body: { error: 'Bad request', message: normalizedReviewPlan.message } };
  }
  const initialReviewState = buildInitialReviewState(normalizedReviewPlan.value);

  return {
    ok: true,
    payload: {
      title: title.trim(),
      description: normalizeOptionalText(description, 20000) ?? '',
      status: !agentFacing && status === 'queued' ? 'queued' : 'triage',
      triage_owner: normalizedTriageOwner,
      review_owner: normalizedReviewOwner,
      decision_owner: normalizedDecisionOwner,
      decision_summary: agentFacing ? null : normalizeOptionalText(decision_summary, 4000),
      decision_context: agentFacing ? null : normalizeOptionalText(decision_context, 4000),
      assigned_agent: targetAgent,
      next_actor_override: agentFacing ? null : normalizeOptionalAgent(next_actor),
      priority: 'medium',
      platform: normalizeOptionalText(platform, 120) ?? null,
      request_type: normalizeOptionalText(request_type, 120) ?? null,
      triage_summary: normalizeOptionalText(triage_summary, 4000) ?? '',
      implementation_scope: normalizeOptionalText(implementation_scope, 4000) ?? '',
      constraints: normalizeOptionalText(constraints, 4000) ?? '',
      deliverables: normalizeOptionalText(deliverables, 4000) ?? '',
      acceptance_criteria: normalizeOptionalText(acceptance_criteria, 4000) ?? '',
      review_plan: normalizedReviewPlan.value,
      review_state: initialReviewState,
      parent_ticket_id: normalizedParent.value ?? null,
      execution_mode: normalizeExecutionMode(execution_mode),
      max_active_workers: normalizedWorkerLimit.value,
      created: new Date().toISOString(),
    },
  };
}

function canAssignmentActForExpectedActor(ticket, action, actor, assignment) {
  if (!ticket || !assignment) return { ok: false, reason: 'missing_context' };
  if (String(assignment.agent_id || '').trim() !== String(actor || '').trim()) {
    return { ok: false, reason: 'assignment_actor_mismatch' };
  }

  const roleKey = getActionMeta(action)?.role_key || null;
  const expectedActor = resolveRoleActor(ticket, roleKey);
  if (!expectedActor) {
    return { ok: false, reason: 'expected_actor_missing' };
  }

  if (String(expectedActor).trim() === String(actor || '').trim()) {
    return { ok: true, delegated: false, expected_actor: expectedActor, role_key: roleKey };
  }

  const expectedParticipant = getParticipantById(expectedActor);
  const assignmentParticipant = getParticipantById(actor);
  const expectedIsHuman = expectedParticipant?.participant_type === 'human'
    || expectedParticipant?.role_type === 'human_principal'
    || Boolean(expectedParticipant?.capabilities?.includes('role:decision'));
  const assignmentAllowed = assignmentParticipant?.primary_platform
    && ticket.platform
    && assignmentParticipant.primary_platform === ticket.platform;

  if (action === 'resume_from_decision' && expectedIsHuman && assignmentAllowed) {
    return {
      ok: true,
      delegated: true,
      role_key: roleKey,
      expected_actor: expectedActor,
      principal_participant: expectedParticipant || null,
      assignment_participant: assignmentParticipant || null,
      delegation_reason: 'human_decision_owner_authorized_agent',
    };
  }

  return {
    ok: false,
    reason: expectedIsHuman ? 'human_principal_requires_authorized_agent' : 'actor_mismatch',
    expected_actor: expectedActor,
    role_key: roleKey,
  };
}

function validateAgentTicketAction(ticket, action, actor, options = {}) {
  const enriched = enrichTicketForApi(ticket);
  const availableActions = getAvailableActions(enriched.id);
  if (!availableActions.includes(action)) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'AGENT_ACTION_NOT_ALLOWED',
        message: `当前 status=${enriched.status} 不允许 ${action}`,
        action,
        ticket_id: enriched.id,
        current_status: enriched.status,
        available_actions: availableActions,
      },
    };
  }

  const roleKey = getActionMeta(action)?.role_key || null;
  const expectedActor = resolveRoleActor(enriched, roleKey);
  if (expectedActor && actor !== expectedActor) {
    const delegated = canAssignmentActForExpectedActor(enriched, action, actor, options.assignment);
    if (delegated.ok) {
      return {
        ok: true,
        ticket: enriched,
        availableActions,
        actor,
        delegated,
      };
    }
    return {
      ok: false,
      status: 403,
      body: {
        error: 'AGENT_ACTION_FORBIDDEN',
        message: `${action} 仅允许 ${expectedActor} 执行`,
        action,
        actor,
        expected_actor: expectedActor,
        role_key: roleKey,
        ticket_id: enriched.id,
        current_status: enriched.status,
        current_actor: enriched.current_actor || null,
        current_actor_source: enriched.current_actor_source || null,
        available_actions: availableActions,
      },
    };
  }

  return { ok: true, ticket: enriched, availableActions, actor, delegated: null };
}

function runAgentTicketAction(req, res, action) {
  const id = Number(req.params.id);
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return sendAgentError(req, res, 404, { error: 'Ticket not found', detail: '工单不存在' });
  }

  const assignmentId = String(req.body?.assignment_id ?? '').trim();
  const token = resolveAssignmentToken(req);
  const candidateAssignment = assignmentId && token ? store.getAssignmentById(assignmentId) : null;
  const assignmentMatchesRequest = Boolean(
    candidateAssignment
      && candidateAssignment.assignment_token === token
      && Number(candidateAssignment.ticket_id) === id,
  );

  const allowedActorIds = assignmentMatchesRequest
    ? [candidateAssignment.agent_id, candidateAssignment.review_owner, candidateAssignment.agent_label]
    : [];
  const actorCheck = validateAgentFacingActor(req.body?.actor ?? req.body?.agent_id, {
    allowedActorIds,
  });
  if (!actorCheck.ok) {
    return sendAgentError(req, res, actorCheck.status, actorCheck.body);
  }
  const actor = actorCheck.actor;

  let validatedAssignment = null;
  if (assignmentMatchesRequest) {
    const assignment = candidateAssignment;
    const writeValidation = validateAssignmentWrite({
      assignment,
      ticket: enrichTicketForApi(ticket),
      kind: 'reviewer_action',
      payload: { action },
      appendAudit: (audit) => store.appendValidationAudit(audit),
      latestAssignment: store.findLatestAssignmentForTicket(id, assignment.agent_id),
    });
    if (!writeValidation.ok) {
      return sendAgentError(req, res, writeValidation.status, {
        code: writeValidation.code,
        message: writeValidation.message,
        validation_audit_id: writeValidation.audit?.id ?? null,
        machine_readable: writeValidation.machine_readable,
      });
    }
    validatedAssignment = assignment;
  }

  if (['approve', 'reject'].includes(action) && String(ticket.status || '').trim() === 'review') {
    if (!validatedAssignment) {
      return sendAgentError(req, res, 409, {
        error: 'Conflict',
        detail: 'review 阶段 approve/reject 必须携带当前 assignment_id + assignment_token，并先完成 review_submission',
        code: 'REVIEW_ASSIGNMENT_CONTEXT_REQUIRED',
        required_fields: ['assignment_id'],
      });
    }
    if (!hasReviewSubmissionForAssignment(validatedAssignment.assignment_id)) {
      return sendAgentError(req, res, 409, {
        error: 'Conflict',
        detail: 'review 阶段必须先通过 report API 提交 review_submission，再执行 approve/reject',
        code: 'REVIEW_SUBMISSION_REQUIRED',
        assignment_id: validatedAssignment.assignment_id,
      });
    }
  }

  const validation = validateAgentTicketAction(ticket, action, actor, {
    assignment: validatedAssignment,
  });
  if (!validation.ok) {
    return sendAgentError(req, res, validation.status, validation.body);
  }

  const fields = {};
  if (action === 'pause') {
    const pauseReason = normalizeOptionalText(req.body?.pause_reason, 4000);
    if (!pauseReason) {
      return sendAgentError(req, res, 400, {
        error: 'Bad request',
        detail: 'pause_reason 不能为空',
        required_fields: ['actor', 'pause_reason'],
      });
    }
    fields.pause_reason = pauseReason;
  }
  if (action === 'reject') {
    const rejectReason = normalizeOptionalText(req.body?.reject_reason, 4000);
    if (!rejectReason) {
      return sendAgentError(req, res, 400, {
        error: 'Bad request',
        detail: 'reject_reason 不能为空',
        required_fields: ['actor', 'reject_reason'],
      });
    }
    fields.reject_reason = rejectReason;
  }
  if (action === 'deprecate') {
    const deprecationReason = normalizeOptionalText(req.body?.deprecation_reason, 4000);
    if (!deprecationReason) {
      return sendAgentError(req, res, 400, {
        error: 'Bad request',
        detail: 'deprecation_reason 不能为空',
        required_fields: ['actor', 'deprecation_reason'],
      });
    }
    fields.deprecation_reason = deprecationReason;
  }
  if (action === 'approve' && req.body?.approve_reviewer !== undefined) {
    fields.approve_reviewer = normalizeOptionalAgent(req.body.approve_reviewer);
  }
  if (action === 'reject' && req.body?.reject_reviewer !== undefined) {
    fields.reject_reviewer = normalizeOptionalAgent(req.body.reject_reviewer);
  }

  const oldStatus = ticket.status;
  const result = transition(id, action, { actor, ...fields });
  if (!result.success) {
    const statusCode = Number(result.statusCode || (result.error === 'RUNNING_TICKET_CONFLICT' ? 409 : 400));
    return sendAgentError(req, res, statusCode >= 400 && statusCode < 600 ? statusCode : 400, {
      ...result,
      action,
      available_actions: getAvailableActions(id),
    });
  }

  const updated = store.getTicketById(id);

  if (action === 'reject' && updated?.status === 'queued') {
    const queueAgent = validatedAssignment?.agent_id || updated.assigned_agent;
    if (queueAgent) {
      const latestAssignment = store.findLatestAssignmentForTicket(id, queueAgent);
      const latestQueuedAssignment = latestAssignment?.stage === 'queued' ? latestAssignment : null;
      const shouldReuseQueuedAssignment = latestQueuedAssignment
        && latestQueuedAssignment.assignment_id !== validatedAssignment?.assignment_id
        && latestQueuedAssignment.assignment_status !== 'submitted';

      if (shouldReuseQueuedAssignment) {
        const queuedDelivery = resolveDispatchDelivery({ agent: queueAgent, ticketId: id, kind: 'queued' });
        store.updateAssignment(latestQueuedAssignment.assignment_id, {
          gateway_id: queuedDelivery.target_gateway_id || latestQueuedAssignment.gateway_id || validatedAssignment?.gateway_id || null,
          execution_mode: latestQueuedAssignment.execution_mode ?? validatedAssignment?.execution_mode ?? updated.execution_mode,
          assignment_status: latestQueuedAssignment.assignment_status || 'created',
          intent: queuedDelivery.delivery_intent || latestQueuedAssignment.intent || 'dispatch',
          role: latestQueuedAssignment.role || 'execute',
          stage: 'queued',
          target_session_key: queuedDelivery.target_session_key || latestQueuedAssignment.target_session_key || validatedAssignment?.target_session_key || null,
          transport: queuedDelivery.transport || latestQueuedAssignment.transport || validatedAssignment?.transport || null,
        });
      } else {
        const queuedDelivery = resolveDispatchDelivery({ agent: queueAgent, ticketId: id, kind: 'queued' });
        store.createOrReuseAssignment({
          ticket_id: id,
          agent_id: queueAgent,
          gateway_id: queuedDelivery.target_gateway_id || validatedAssignment?.gateway_id || null,
          execution_mode: validatedAssignment?.execution_mode ?? updated.execution_mode,
          assignment_status: 'created',
          intent: queuedDelivery.delivery_intent || 'dispatch',
          role: 'execute',
          stage: 'queued',
          target_session_key: queuedDelivery.target_session_key || validatedAssignment?.target_session_key || null,
          transport: queuedDelivery.transport || validatedAssignment?.transport || null,
        });
      }
    }
  }

  if (validation.delegated?.delegated) {
    persistTicketComment(id, {
      id: buildCommentId(),
      author: actor,
      timestamp: new Date().toISOString(),
      content: `代理代办审计：${actor} 已按 assignment 代 ${validation.delegated.expected_actor} 执行 ${action}，工单 ${oldStatus} → ${updated.status}`,
      type: 'system',
      visibility: 'internal',
      thread_id: null,
      mentions: [],
      metadata: {
        source: 'agent_assignment_delegation_audit',
        action,
        actor,
        acted_for: validation.delegated.expected_actor,
        delegated: true,
        delegation_reason: validation.delegated.delegation_reason || null,
        assignment_id: validatedAssignment?.assignment_id || null,
        assignment_agent: validatedAssignment?.agent_id || null,
        from_status: oldStatus,
        to_status: updated.status,
        role_key: validation.delegated.role_key || null,
      },
    }, { preserveAudit: true });
  }
  if (oldStatus !== updated.status) {
    broadcastTicketStatusChanged(updated, oldStatus, updated.status);
  }

  return res.json({
    success: true,
    action,
    ticket: formatTicketForList(updated),
    available_actions: getAvailableActions(id),
    message: `agent-facing ${action} 已完成`,
  });
}

function getSupplementalPrimaryContext(ticket = {}) {
  const relation = ticket.supplemental_for_ticket;
  const primaryTicket = relation?.ticket;
  if (!relation || !primaryTicket) return null;
  return {
    relation_type: relation.relation_type,
    relation_label: relation.relation_label,
    primary_ticket: primaryTicket,
  };
}

function getStaleDeliveryHint(ticket = {}, kind = 'notification') {
  const supplemental = getSupplementalPrimaryContext(ticket);
  if (!supplemental) return null;
  const primaryStatus = String(supplemental.primary_ticket?.status || '').trim();
  if (primaryStatus !== 'complete') return null;

  if (kind === 'dispatch' && !['done', 'review'].includes(ticket.status)) {
    return null;
  }
  if (kind === 'notification' && !['done', 'review', 'complete'].includes(ticket.status)) {
    return null;
  }

  return {
    stale: true,
    reason: 'supplemental_ticket_after_primary_complete',
    relation_type: supplemental.relation_type,
    relation_label: supplemental.relation_label,
    primary_ticket_id: supplemental.primary_ticket.id,
    primary_ticket_status: primaryStatus,
  };
}

function formatTicketForList(t) {
  const ticket = enrichTicketForApi(t);
  const workflow_mismatch = detectWorkflowMismatch(ticket);
  return {
    ...ticket,
    bot: ticket.assigned_agent,
    created: ticket.created || ticket.last_update,
    priority: ticket.priority || 'medium',
    progress: getTicketProgress(ticket.status),
    workflow_mismatch: workflow_mismatch || undefined,
  };
}

function buildTicketListItem(ticket, dependencySummaryMap = new Map()) {
  const formatted = formatTicketForList(ticket);
  const dependencySummary = dependencySummaryMap.get(formatted.id) || { dependency_count: 0, dependent_count: 0 };

  return {
    id: formatted.id,
    title: formatted.title,
    status: formatted.status,
    priority: formatted.priority,
    bot: formatted.bot,
    triage_owner: formatted.triage_owner,
    review_owner: formatted.review_owner || null,
    decision_owner: formatted.decision_owner || null,
    deprecation_reason: formatted.deprecation_reason || null,
    assigned_agent: formatted.assigned_agent,
    current_actor: formatted.current_actor,
    current_actor_source: formatted.current_actor_source,
    next_actor: formatted.next_actor,
    next_actor_override: formatted.next_actor_override,
    next_actor_source: formatted.next_actor_source,
    manual_override_active: Boolean(formatted.manual_override_active),
    should_notify: Boolean(formatted.should_notify),
    session_key: formatted.session_key || null,
    created: formatted.created || formatted.last_update,
    last_update: formatted.last_update,
    progress: formatted.progress,
    error: formatted.error || null,
    platform: formatted.platform || null,
    request_type: formatted.request_type || null,
    triage_summary: formatted.triage_summary || '',
    execution_mode: formatted.execution_mode || null,
    dispatch_state: formatted.dispatch_state || null,
    awaiting_receipt_from: formatted.awaiting_receipt_from || null,
    execution_guard: formatted.execution_guard || null,
    paused_by: formatted.paused_by || null,
    paused_from_status: formatted.paused_from_status || null,
    pause_reason: formatted.pause_reason || null,
    result_summary: formatted.result_summary || null,
    workflow_mismatch: formatted.workflow_mismatch || undefined,
    dependency_summary: dependencySummary,
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

  const executionMode = normalizeOptionalText(query.execution_mode, 32);
  if (executionMode && ticket.execution_mode !== executionMode) return false;

  if (String(query.actionable || '').toLowerCase() === 'true' && !ticket.should_notify) return false;

  return true;
}

// Deprecated: use WORKFLOW_BUCKET_META/WORKFLOW_BUCKET_ORDER from workflow-schema instead
const WORKBOARD_BUCKET_LABELS = WORKFLOW_BUCKET_META;

const WORKBOARD_BUCKET_ORDER = WORKFLOW_BUCKET_ORDER;

const WORKBOARD_PRIORITY_ORDER = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function normalizeBooleanQuery(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(text)) return true;
  if (['false', '0', 'no'].includes(text)) return false;
  return null;
}

function normalizePaginationNumber(value, { defaultValue = 0, min = 0, max = 200 } = {}) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, parsed));
}

function getWorkboardBucket(status) {
  return getStatusMeta(status).group || 'active';
}

function getWorkboardBucketLabel(bucket) {
  // WORKBOARD_BUCKET_LABELS is aliased from WORKFLOW_BUCKET_META
  const meta = WORKBOARD_BUCKET_LABELS[bucket];
  if (meta && typeof meta === 'object') return meta.label || bucket || '未知';
  if (typeof meta === 'string') return meta;
  return bucket || '未知';
}

function summarizeLatestComment(ticket = {}) {
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = normalizeComment(comments[i]);
    const excerpt = String(comment.content || '').trim();
    if (!excerpt) continue;
    return {
      id: comment.id ?? null,
      author: comment.author || null,
      type: comment.type || 'progress',
      at: comment.timestamp || null,
      excerpt: excerpt.slice(0, 240),
    };
  }
  return null;
}

function hasReviewSubmissionForAssignment(assignmentId) {
  if (!assignmentId) return false;
  const reports = store.listAssignmentReports(String(assignmentId), { limit: 20 });
  return reports.some((report) => String(report?.report_type || '').trim() === 'review_submission');
}

function buildWorkboardRelationSummary(ticket = {}, dependencyCount = 0) {
  const relations = Array.isArray(ticket.ticket_relations) ? ticket.ticket_relations : [];
  const supplementalTickets = Array.isArray(ticket.supplemental_tickets) ? ticket.supplemental_tickets : [];
  const parentChildSummary = buildParentChildSummary(ticket);
  return {
    has_parent: parentChildSummary.has_parent,
    parent_ticket_id: parentChildSummary.parent_ticket_id,
    dependency_count: dependencyCount,
    child_count: parentChildSummary.child_count,
    related_count: relations.length,
    supplemental_count: supplementalTickets.length,
    supplemental_summary: ticket.supplemental_summary || { total: 0, open: 0, complete: 0, pending_review: 0, by_status: {} },
    parent_child_summary: parentChildSummary,
  };
}

function buildWorkboardItem(ticket = {}, dependencyCount = 0) {
  const statusMeta = getStatusMeta(ticket.status);
  const bucket = getWorkboardBucket(ticket.status);
  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    status_label: statusMeta.label,
    bucket,
    bucket_label: getWorkboardBucketLabel(bucket),
    priority: ticket.priority || 'medium',
    platform: ticket.platform || null,
    request_type: ticket.request_type || null,
    execution_mode: ticket.execution_mode || null,
    assigned_agent: ticket.assigned_agent || null,
    current_actor: ticket.current_actor || null,
    current_actor_source: ticket.current_actor_source || null,
    review_owner: ticket.review_owner || null,
    triage_owner: ticket.triage_owner || null,
    decision_owner: ticket.decision_owner || null,
    parent_ticket_id: ticket.parent_ticket_id || null,
    has_dependencies: dependencyCount > 0,
    relation_summary: buildWorkboardRelationSummary(ticket, dependencyCount),
    last_comment_excerpt: summarizeLatestComment(ticket),
    result_summary: ticket.result_summary || null,
    created: ticket.created || null,
    last_update: ticket.last_update || null,
  };
}

function matchesStockWorkboardFilters(item, query = {}) {
  const platform = normalizeOptionalText(query.platform, 120);
  if (platform && platform !== 'stock-platform') return false;

  const statusFilters = parseCsvParam(query.status);
  if (statusFilters.length > 0 && !statusFilters.includes(item.status)) return false;

  const bucketFilters = parseCsvParam(query.bucket);
  if (bucketFilters.length > 0 && !bucketFilters.includes(item.bucket)) return false;

  const assignedAgent = normalizeOptionalAgent(query.assigned_agent);
  if (assignedAgent && item.assigned_agent !== assignedAgent) return false;

  const currentActor = normalizeOptionalAgent(query.current_actor);
  if (currentActor && item.current_actor !== currentActor) return false;

  const reviewOwner = normalizeOptionalAgent(query.review_owner);
  if (reviewOwner && item.review_owner !== reviewOwner) return false;

  const hasDependencies = normalizeBooleanQuery(query.has_dependencies);
  if (hasDependencies !== null && item.has_dependencies !== hasDependencies) return false;

  const parentTicketId = normalizeParentTicketId(query.parent_ticket_id);
  if (!parentTicketId.ok) return false;
  if (parentTicketId.value !== undefined && (item.parent_ticket_id || null) !== parentTicketId.value) return false;

  return true;
}

function sortStockWorkboardItems(items = [], sort = 'updated_desc') {
  const normalizedSort = String(sort || 'updated_desc').trim() || 'updated_desc';
  return [...items].sort((a, b) => {
    const aUpdated = Date.parse(a.last_update || a.created || '') || 0;
    const bUpdated = Date.parse(b.last_update || b.created || '') || 0;
    const aCreated = Date.parse(a.created || '') || 0;
    const bCreated = Date.parse(b.created || '') || 0;
    const aPriority = WORKBOARD_PRIORITY_ORDER[a.priority] || WORKBOARD_PRIORITY_ORDER.medium;
    const bPriority = WORKBOARD_PRIORITY_ORDER[b.priority] || WORKBOARD_PRIORITY_ORDER.medium;
    const aStatusOrder = getStatusMeta(a.status).board_order ?? 999;
    const bStatusOrder = getStatusMeta(b.status).board_order ?? 999;

    switch (normalizedSort) {
      case 'created_desc':
        if (bCreated !== aCreated) return bCreated - aCreated;
        break;
      case 'priority_desc':
        if (bPriority !== aPriority) return bPriority - aPriority;
        if (bUpdated !== aUpdated) return bUpdated - aUpdated;
        break;
      case 'priority_asc':
        if (aPriority !== bPriority) return aPriority - bPriority;
        if (bUpdated !== aUpdated) return bUpdated - aUpdated;
        break;
      case 'status_order':
        if (aStatusOrder !== bStatusOrder) return aStatusOrder - bStatusOrder;
        if (bUpdated !== aUpdated) return bUpdated - aUpdated;
        break;
      case 'id_desc':
        return (Number(b.id) || 0) - (Number(a.id) || 0);
      case 'updated_desc':
      default:
        if (bUpdated !== aUpdated) return bUpdated - aUpdated;
        break;
    }

    return (Number(b.id) || 0) - (Number(a.id) || 0);
  });
}

function buildStockWorkboardSummary(items = []) {
  const byStatusMap = new Map();
  const byBucketMap = new Map();

  for (const item of items) {
    const statusKey = item.status;
    const bucketKey = item.bucket;
    if (!byStatusMap.has(statusKey)) {
      byStatusMap.set(statusKey, {
        status: statusKey,
        status_label: item.status_label,
        bucket: bucketKey,
        bucket_label: item.bucket_label,
        count: 0,
      });
    }
    byStatusMap.get(statusKey).count += 1;

    if (!byBucketMap.has(bucketKey)) {
      byBucketMap.set(bucketKey, {
        bucket: bucketKey,
        bucket_label: item.bucket_label,
        count: 0,
        statuses: {},
      });
    }
    const bucketEntry = byBucketMap.get(bucketKey);
    bucketEntry.count += 1;
    bucketEntry.statuses[statusKey] = (bucketEntry.statuses[statusKey] || 0) + 1;
  }

  return {
    total_filtered: items.length,
    by_status: [...byStatusMap.values()].sort((a, b) => {
      const aOrder = getStatusMeta(a.status).board_order ?? 999;
      const bOrder = getStatusMeta(b.status).board_order ?? 999;
      return aOrder - bOrder;
    }),
    by_bucket: [...byBucketMap.values()].sort((a, b) => {
      const aOrder = WORKBOARD_BUCKET_ORDER[a.bucket] ?? 999;
      const bOrder = WORKBOARD_BUCKET_ORDER[b.bucket] ?? 999;
      return aOrder - bOrder;
    }),
  };
}

function buildStockWorkboardGroups(items = [], groupBy = 'none') {
  const key = String(groupBy || 'none').trim() || 'none';
  if (key === 'none') return [];

  const groups = new Map();
  const normalizeGroup = (item) => {
    switch (key) {
      case 'status':
        return { key: item.status, label: item.status_label, order: getStatusMeta(item.status).board_order ?? 999 };
      case 'bucket':
        return { key: item.bucket, label: item.bucket_label, order: WORKBOARD_BUCKET_ORDER[item.bucket] ?? 999 };
      case 'assigned_agent':
        return { key: item.assigned_agent || 'unassigned', label: item.assigned_agent || '未指派', order: 999 };
      case 'current_actor':
        return { key: item.current_actor || 'unowned', label: item.current_actor || '无人负责', order: 999 };
      case 'review_owner':
        return { key: item.review_owner || 'unassigned', label: item.review_owner || '未设置 review_owner', order: 999 };
      case 'parent_ticket_id':
        return { key: item.parent_ticket_id ? String(item.parent_ticket_id) : 'root', label: item.parent_ticket_id ? `父单 #${item.parent_ticket_id}` : '根工单', order: 999 };
      default:
        return null;
    }
  };

  for (const item of items) {
    const group = normalizeGroup(item);
    if (!group) continue;
    if (!groups.has(group.key)) {
      groups.set(group.key, {
        group_by: key,
        group_key: group.key,
        group_label: group.label,
        order: group.order,
        count: 0,
        items: [],
      });
    }
    const entry = groups.get(group.key);
    entry.count += 1;
    entry.items.push(item);
  }

  return [...groups.values()]
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return String(a.group_label).localeCompare(String(b.group_label), 'zh-Hans-CN');
    })
    .map((group) => {
      const { order: _order, ...rest } = group;
      return rest;
    });
}

function normalizeMentions(mentions = [], content = '') {
  const explicit = Array.isArray(mentions) ? mentions : [];
  const parsed = [...String(content || '').matchAll(/@([^\s@,，。！？；;:：]{1,64})/gu)].map((m) => m[1]);
  return [...new Set([...explicit, ...parsed].map((s) => String(s).trim()).filter(Boolean))];
}

function normalizeComment(comment = {}) {
  return normalizeCommentShape(comment);
}

function persistTicketComment(ticketId, comment, { preserveAudit = false } = {}) {
  if (!comment) return null;
  store.addComment(ticketId, comment);
  if (!preserveAudit) {
    dispatch.clearAuditEvents(Number(ticketId));
  }
  broadcastTicketComment(ticketId, comment);
  return comment;
}

function buildTransitionAuditComment({
  action,
  actor,
  oldStatus,
  newStatus,
  comment,
  fields = {},
}) {
  const trimmedComment = String(comment || '').trim();
  const resetReason = String(fields?.reason || fields?.reset_reason || '').trim();
  const forceAudit = action === 'reset_to_queued';
  if (!forceAudit && !trimmedComment) return null;

  const content = forceAudit
    ? [
        `撤销开工：${oldStatus} → ${newStatus}`,
        `原因：${resetReason || '未填写'}`,
        ...(trimmedComment ? ['', `备注：${trimmedComment}`] : []),
      ].join('\n')
    : trimmedComment;

  return {
    id: buildCommentId(),
    author: actor,
    timestamp: new Date().toISOString(),
    content,
    type: 'status_change',
    visibility: 'internal',
    thread_id: null,
    mentions: [],
    metadata: {
      action,
      from: oldStatus,
      from_status: oldStatus,
      to: newStatus,
      to_status: newStatus,
      actor,
      ...(resetReason ? { reason: resetReason } : {}),
    },
  };
}

function appendTransitionAuditComment(ticketId, options = {}) {
  const comment = buildTransitionAuditComment(options);
  if (!comment || !comment.content) return null;
  return persistTicketComment(ticketId, comment, { preserveAudit: true });
}

function ensureRunningAssignmentAfterAutoStart(ticketBefore, ticketAfter, latestHandshake) {
  if (!ticketBefore || !ticketAfter) return null;
  if (ticketBefore.status !== 'queued' || ticketAfter.status !== 'running') return null;

  const agent = ticketAfter.assigned_agent || ticketAfter.current_actor || ticketAfter.next_actor;
  if (!agent) return null;

  const latestAssignment = store.findLatestAssignmentForTicket(ticketAfter.id, agent);
  if (latestAssignment && latestAssignment.stage === 'running') {
    if (!latestAssignment.dispatch_event_id) {
      const runningDispatchId = dispatch.recordDispatchEvent(ticketAfter.id, agent, 'running');
      const refreshed = store.updateAssignment(latestAssignment.assignment_id, {
        dispatch_event_id: runningDispatchId,
        gateway_id: runningDelivery.target_gateway_id || latestAssignment.gateway_id || null,
        assignment_status: latestAssignment.assignment_status || 'created',
        intent: runningDelivery.delivery_intent || latestAssignment.intent || 'dispatch',
        role: latestAssignment.role || 'execute',
        stage: 'running',
        target_session_key: runningDelivery.target_session_key
          || latestAssignment.target_session_key
          || latestHandshake?.receipt_payload?.target_session_key
          || null,
        transport: runningDelivery.transport || latestAssignment.transport || null,
      });
      store.updateExecutionReservation(ticketAfter.id, {
        assignment_id: refreshed.assignment_id,
        dispatch_event_id: runningDispatchId,
        state: 'reserved',
        holder_kind: 'assignment',
        holder_key: refreshed.assignment_id,
        release_reason: null,
        released_at: null,
      });
      dispatch.emitAssignmentDeliveryRequested(refreshed.assignment_id, ticketAfter.id, runningDispatchId, {
        target_gateway_id: refreshed.gateway_id,
        transport: refreshed.transport,
        target_session_key: refreshed.target_session_key,
      });
      return refreshed;
    }

    store.updateExecutionReservation(ticketAfter.id, {
      assignment_id: latestAssignment.assignment_id,
      dispatch_event_id: latestAssignment.dispatch_event_id,
      state: 'reserved',
      holder_kind: 'assignment',
      holder_key: latestAssignment.assignment_id,
      release_reason: null,
      released_at: null,
    });
    return latestAssignment;
  }

  const runningDispatchId = dispatch.recordDispatchEvent(ticketAfter.id, agent, 'running');
  const runningDelivery = resolveDispatchDelivery({ agent, ticketId: ticketAfter.id, kind: 'running' });
  const successor = store.createOrReuseAssignment({
    ticket_id: ticketAfter.id,
    dispatch_event_id: runningDispatchId,
    agent_id: agent,
    gateway_id: runningDelivery.target_gateway_id || latestAssignment?.gateway_id || null,
    execution_mode: latestAssignment?.execution_mode ?? ticketAfter.execution_mode,
    assignment_status: 'created',
    intent: runningDelivery.delivery_intent || latestAssignment?.intent || 'dispatch',
    role: latestAssignment?.role || 'execute',
    stage: 'running',
    target_session_key: runningDelivery.target_session_key
      || latestAssignment?.target_session_key
      || latestHandshake?.receipt_payload?.target_session_key
      || null,
    transport: runningDelivery.transport || latestAssignment?.transport || null,
  });

  store.updateExecutionReservation(ticketAfter.id, {
    assignment_id: successor.assignment_id,
    dispatch_event_id: runningDispatchId,
    state: 'reserved',
    holder_kind: 'assignment',
    holder_key: successor.assignment_id,
    release_reason: null,
    released_at: null,
  });

  dispatch.emitAssignmentDeliveryRequested(successor.assignment_id, ticketAfter.id, runningDispatchId, {
    target_gateway_id: successor.gateway_id,
    transport: successor.transport,
    target_session_key: successor.target_session_key,
  });

  return successor;
}

function maybeAutoStartQueuedTicketAfterWorkerChange(ticketId, worker = {}) {
  const ticket = enrichTicketForApi(store.getTicketById(ticketId));
  if (!ticket || ticket.status !== 'queued') {
    return store.getTicketById(ticketId);
  }

  const latestHandshake = dispatch.getLatestDispatchHandshakeState(ticket.id, ticket.next_actor || ticket.assigned_agent, ticket.status);
  const acceptedQueuedReceipt = latestHandshake
    && latestHandshake.dispatch_state === 'receipt_accepted'
    && latestHandshake.receipt_decision === 'accepted'
    && String(latestHandshake.receipt_payload?.stage || '').trim() === 'queued';

  if (!acceptedQueuedReceipt) {
    return store.getTicketById(ticketId);
  }

  const workerStatus = String(worker?.status || '').trim().toLowerCase();
  const hasFreshActiveWorker = ['starting', 'running'].includes(workerStatus)
    || ticket.execution_guard?.has_active_execution_evidence;

  if (hasFreshActiveWorker) {
    store.updateExecutionReservation(ticket.id, {
      state: 'receipt_accepted',
      holder_kind: 'worker',
      holder_key: String(worker?.worker_key || worker?.session_key || 'worker'),
      release_reason: null,
      released_at: null,
    });
  }

  if (!hasFreshActiveWorker) {
    return store.getTicketById(ticketId);
  }

  const started = transition(ticket.id, 'start_work', {
    actor: ticket.assigned_agent || ticket.current_actor || ticket.next_actor,
  });

  if (!started?.success && started?.error !== 'AGENT_ACTION_NOT_ALLOWED') {
    console.warn(`[workers] auto start queued ticket #${ticket.id} skipped: ${started?.error || 'unknown error'}`);
  }

  const ticketAfter = store.getTicketById(ticketId);
  if (started?.success) {
    ensureRunningAssignmentAfterAutoStart(ticket, ticketAfter, latestHandshake);
  }

  return store.getTicketById(ticketId);
}

function handleExecutionStoreError(res, err, req = null) {
  const statusCode = Number(err?.statusCode || 500);
  const body = {
    error: err?.code || 'Execution worker error',
    message: err?.message || 'worker 操作失败',
    ...(err?.expected_worker_type ? { expected_worker_type: err.expected_worker_type } : {}),
    ...(err?.max_active_workers !== undefined ? { max_active_workers: err.max_active_workers } : {}),
    ...(err?.active_workers !== undefined ? { active_workers: err.active_workers } : {}),
  };

  if (statusCode >= 400 && statusCode < 600) {
    return req ? sendAgentError(req, res, statusCode, body) : res.status(statusCode).json(body);
  }

  console.error('[API] execution worker 失败:', err?.message || err);
  return req
    ? sendAgentError(req, res, 500, body)
    : res.status(500).json(body);
}

function loadAssignmentAccess(req, res) {
  const assignmentId = String(req.params.assignment_id || req.query.assignment_id || '').trim();
  if (!assignmentId) {
    sendAgentError(req, res, 400, { error: 'Bad request', detail: 'assignment_id 不能为空' });
    return null;
  }

  const assignment = store.getAssignmentById(assignmentId);
  if (!assignment) {
    sendAgentError(req, res, 404, { error: 'Assignment not found', detail: 'assignment 不存在' });
    return null;
  }

  const token = resolveAssignmentToken(req);
  if (!token || token !== assignment.assignment_token) {
    sendAgentError(req, res, 401, { error: 'Unauthorized', detail: 'assignment_token 无效或缺失' });
    return null;
  }

  const ticket = enrichTicketForApi(store.getTicketById(assignment.ticket_id));
  if (!ticket) {
    sendAgentError(req, res, 404, { error: 'Ticket not found', detail: 'assignment 对应 ticket 不存在' });
    return null;
  }

  return { assignment, ticket };
}

function parseExpectedString(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function buildAssignmentLiveAcceptanceVerdict({ assignment, ticket, expected = {} }) {
  const workflow = buildAgentWorkflowSchema();
  const runtime = buildRuntimeContext({ assignment });
  const skill = buildCurrentAgentSkillBundle();
  const dependencies = store.getDependencies(ticket.id).map((dep) => ({
    ticket_id: dep.depends_on_ticket_id,
    title: dep.title,
    status: dep.status,
    dependency_type: dep.dependency_type || 'blocks',
    blocking: (dep.dependency_type || 'blocks') === 'blocks' && !['done', 'complete'].includes(dep.status),
    satisfied: ['done', 'complete'].includes(dep.status),
  }));
  const unresolvedDependencies = dependencies.filter((dep) => dep.blocking);
  const dispatchStale = getStaleDeliveryHint(ticket, 'dispatch');
  const notifyStale = getStaleDeliveryHint(ticket, 'notification');
  const expectedBundleVersion = parseExpectedString(expected.bundle_version);
  const expectedBundleChecksum = parseExpectedString(expected.bundle_checksum_sha256);
  const expectedWorkflowVersion = parseExpectedString(expected.workflow_schema_version);
  const expectedApiBaseUrl = parseExpectedString(expected.api_base_url);
  const advanceChain = validateDispatchAdvanceChain(ticket);

  const checks = [
    {
      key: 'workflow-schema',
      status: expectedWorkflowVersion && expectedWorkflowVersion !== workflow.schema_version ? 'fail' : 'pass',
      actual: workflow.schema_version,
      expected: expectedWorkflowVersion,
      detail: expectedWorkflowVersion && expectedWorkflowVersion !== workflow.schema_version
        ? `live workflow schema_version=${workflow.schema_version}，预期=${expectedWorkflowVersion}`
        : `workflow schema_version=${workflow.schema_version}`,
      source: '/api/v1/agent/workflow/schema',
    },
    {
      key: 'advance-chain',
      status: advanceChain.ok ? 'pass' : 'fail',
      actual: advanceChain,
      expected: { ok: true },
      detail: advanceChain.ok
        ? `stage=${ticket.status} 存在合法推进链，dispatch_actor=${advanceChain.dispatch_actor || 'null'}`
        : advanceChain.message || `stage=${ticket.status} 缺少合法推进链`,
      source: '/api/dispatch/ready + workflow schema/action bridge',
    },
    {
      key: 'runtime-context',
      status: runtime.api_base_url ? 'pass' : 'warn',
      actual: runtime.api_base_url,
      expected: expectedApiBaseUrl,
      detail: runtime.api_base_url
        ? `runtime api_base_url=${runtime.api_base_url}`
        : 'runtime api_base_url 为 null，说明当前 assignment 尚未升级到可直接回连的 live host 配置',
      source: '/api/v1/agent/runtime/context',
    },
    {
      key: 'hosted-skill-bundle',
      status: (expectedBundleVersion && expectedBundleVersion !== skill.version) || (expectedBundleChecksum && expectedBundleChecksum !== skill.checksum_sha256)
        ? 'fail'
        : 'pass',
      actual: {
        version: skill.version,
        checksum_sha256: skill.checksum_sha256,
      },
      expected: {
        version: expectedBundleVersion,
        checksum_sha256: expectedBundleChecksum,
      },
      detail: ((expectedBundleVersion && expectedBundleVersion !== skill.version) || (expectedBundleChecksum && expectedBundleChecksum !== skill.checksum_sha256))
        ? `live skill bundle 未升级到预期版本；actual=${skill.version}/${skill.checksum_sha256}`
        : `live skill bundle=${skill.version}/${skill.checksum_sha256}`,
      source: '/api/v1/agent/skills/current',
    },
    {
      key: 'dependencies',
      status: unresolvedDependencies.length ? 'fail' : 'pass',
      actual: {
        total: dependencies.length,
        unresolved: unresolvedDependencies.length,
      },
      expected: null,
      detail: unresolvedDependencies.length
        ? `仍有 ${unresolvedDependencies.length} 个 blocks 依赖未闭合`
        : '无未闭合 blocks 依赖',
      source: '/api/v1/agent/assignments/:assignment_id/dependencies',
    },
    {
      key: 'delivery-health',
      status: dispatchStale || notifyStale ? 'warn' : 'pass',
      actual: {
        dispatch_stale: dispatchStale,
        notification_stale: notifyStale,
      },
      expected: null,
      detail: dispatchStale || notifyStale
        ? '检测到 stale delivery 提示，reviewer 需要结合 live 队列二次确认'
        : '未检测到 stale delivery 提示',
      source: '/api/dispatch/ready + /api/notifications/ready',
    },
  ];

  if (expectedApiBaseUrl) {
    const runtimeCheck = checks.find((item) => item.key === 'runtime-context');
    if (runtimeCheck && runtime.api_base_url !== expectedApiBaseUrl) {
      runtimeCheck.status = 'fail';
      runtimeCheck.detail = `live runtime api_base_url=${runtime.api_base_url || 'null'}，预期=${expectedApiBaseUrl}`;
    }
  }

  let verdict = 'pass';
  if (unresolvedDependencies.length) {
    verdict = 'dependency-not-closed';
  } else if (checks.some((item) => item.key === 'hosted-skill-bundle' && item.status === 'fail')) {
    verdict = 'live-not-upgraded';
  } else if (checks.some((item) => ['workflow-schema', 'runtime-context', 'advance-chain'].includes(item.key) && item.status === 'fail')) {
    verdict = 'contract-mismatch';
  } else if (checks.some((item) => item.status === 'warn')) {
    verdict = 'partial';
  }

  return {
    verdict,
    summary: (() => {
      switch (verdict) {
        case 'dependency-not-closed':
          return '存在未闭合 blocks 依赖，当前不满足 reviewer live acceptance gate。';
        case 'live-not-upgraded':
          return 'live skill bundle / hosted contract 版本未升级到 reviewer 预期版本。';
        case 'contract-mismatch':
          return 'live runtime contract 与 reviewer 提供的预期不一致。';
        case 'partial':
          return 'live surfaces 可读，但仍有降级/告警项，建议 reviewer 标记 partial。';
        default:
          return 'live acceptance gate 通过，runtime / bundle / dependency contract 一致。';
      }
    })(),
    checked_at: new Date().toISOString(),
    assignment_id: assignment.assignment_id,
    ticket_id: ticket.id,
    ticket_status: ticket.status,
    expected: {
      bundle_version: expectedBundleVersion,
      bundle_checksum_sha256: expectedBundleChecksum,
      workflow_schema_version: expectedWorkflowVersion,
      api_base_url: expectedApiBaseUrl,
    },
    live: {
      workflow_schema_version: workflow.schema_version,
      api_base_url: runtime.api_base_url,
      bundle_version: skill.version,
      bundle_checksum_sha256: skill.checksum_sha256,
      gateway_id: runtime.gateway_id,
      platform_host_gateway_id: runtime.platform_host_gateway_id,
      runtime_version: getRuntimeVersion(),
    },
    dependency_snapshot: {
      total: dependencies.length,
      unresolved: unresolvedDependencies,
    },
    checks,
  };
}

function requireAgentAdminGrant(req, res, capability = null) {
  const token = resolveAgentAdminToken(req);
  const grant = getAgentAdminGrantByToken(token);
  if (!grant) {
    sendAgentError(req, res, 401, { error: 'Unauthorized', detail: 'agent-admin token 无效或缺失' });
    return null;
  }

  if (capability && !hasAgentAdminCapability(grant, capability)) {
    sendAgentError(req, res, 403, {
      error: 'AGENT_ADMIN_FORBIDDEN',
      detail: `当前 agent-admin token 缺少能力：${capability}`,
      required_capability: capability,
      agent_id: grant.agent_id,
      capabilities: grant.capabilities,
    });
    return null;
  }

  return grant;
}

function loadStockAdminTicket(req, res, capability = 'stock_tickets:read') {
  const grant = requireAgentAdminGrant(req, res, capability);
  if (!grant) return null;

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    sendAgentError(req, res, 400, { error: 'Bad request', detail: 'ticket id 非法' });
    return null;
  }

  const ticket = store.getTicketById(id);
  if (!ticket) {
    sendAgentError(req, res, 404, { error: 'Ticket not found', detail: '工单不存在' });
    return null;
  }

  const enriched = enrichTicketForApi(ticket);
  if (enriched.platform !== 'stock-platform') {
    sendAgentError(req, res, 403, {
      error: 'AGENT_ADMIN_SCOPE_FORBIDDEN',
      detail: '当前 agent-admin 接口仅允许管理 stock-platform 工单',
      ticket_id: enriched.id,
      platform: enriched.platform || null,
    });
    return null;
  }

  return { grant, ticket: enriched };
}

// GET /api/version - 运行态版本表面：git commit / build time / schema version / bundle version（live acceptance 与 reviewer 先核此契约）
app.get('/api/version', (_req, res) => {
  res.json({ data: getRuntimeVersion() });
});

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
  const tickets = store.getAllTickets().map((ticket) => enrichTicketForApi(ticket));
  return buildDashboardMetrics(tickets);
}
function computeSlaRemainingMs(ticket = {}, now = Date.now()) {
  const statusMeta = getStatusMeta(ticket.status);
  const defaultMinutes = Number(statusMeta?.sla?.default_minutes);
  if (!Number.isFinite(defaultMinutes) || defaultMinutes <= 0) return null;

  const baselineTs = Date.parse(ticket.last_update || ticket.created || '');
  if (!Number.isFinite(baselineTs)) return null;
  return baselineTs + defaultMinutes * 60 * 1000 - now;
}

function inferInboxLane(ticket = {}) {
  if (ticket.status === 'triage') return 'triage';
  if (ticket.status === 'queued' || ticket.status === 'running') return 'execution';
  if (ticket.status === 'pending_decision') return 'decision';
  if (ticket.status === 'done' || ticket.status === 'review') return 'review';
  return null;
}

function inferInboxReason(ticket = {}, lane) {
  const available = Array.isArray(ticket.available_actions) ? ticket.available_actions : [];
  switch (lane) {
    case 'triage':
      return ticket.triage_summary || '等待 triage owner 完成范围收敛并决定是否入队';
    case 'execution':
      if (ticket.dispatch_state === 'awaiting_receipt') {
        return `等待 ${ticket.awaiting_receipt_from || ticket.current_actor || ticket.assigned_agent || '执行人'} 回执；receipt accepted 后继续推进执行`;
      }
      if (ticket.status === 'running') {
        return '当前由执行人处理中，等待实现完成后提交验收或请求决策';
      }
      if (available.includes('start_work')) {
        return '已进入执行队列，责任链已落到执行人，下一步应 start_work 开工';
      }
      return '已进入执行队列，等待执行侧补齐前置条件后继续推进';
    case 'review':
      if (ticket.dispatch_state === 'awaiting_receipt') {
        return `等待 ${ticket.awaiting_receipt_from || ticket.review_owner || ticket.current_actor || 'reviewer'} 回执并进入 review`; 
      }
      if (ticket.status === 'done') {
        return ticket.result_summary || '实现已完成，等待 reviewer 开始验收';
      }
      if (available.includes('approve') || available.includes('reject')) {
        return ticket.result_summary || 'review 已开始，等待 reviewer approve / reject 或请求决策';
      }
      return ticket.result_summary || '等待 reviewer 收口';
    case 'decision':
      if (available.includes('resume_from_decision')) {
        return ticket.decision_summary || ticket.triage_summary || '等待 decision owner 拍板，决策后可恢复执行';
      }
      return ticket.decision_summary || ticket.triage_summary || '等待 decision owner 拍板';
    default:
      return ticket.triage_summary || ticket.result_summary || null;
  }
}

function inferRecommendedAction(ticket = {}, lane) {
  const available = Array.isArray(ticket.available_actions) ? ticket.available_actions : [];
  const preferredByLane = {
    triage: ['queue', 'deprecate', 'pause'],
    execution: ticket.status === 'queued'
      ? ['start_work', 'request_decision', 'block', 'pause', 'fail', 'submit_for_review']
      : ['submit_for_review', 'request_decision', 'block', 'pause', 'fail', 'start_work'],
    review: ticket.status === 'done'
      ? ['start_review', 'approve', 'reject', 'request_decision', 'pause']
      : ['approve', 'reject', 'request_decision', 'pause', 'start_review'],
    decision: ['resume_from_decision', 'approve', 'pause'],
  };
  const preferred = preferredByLane[lane] || [];
  const selected = preferred.find((action) => available.includes(action)) || available[0] || null;
  return selected;
}

function buildInboxList(statuses = []) {
  const now = Date.now();
  const dependencySummaryMap = store.getDependencySummaryMap();

  return store.getAllTickets()
    .map((ticket) => ({
      ...buildTicketListItem(ticket, dependencySummaryMap),
      available_actions: getAvailableActions(ticket.id),
    }))
    .filter((ticket) => statuses.includes(ticket.status))
    .map((ticket) => {
      const inbox_lane = inferInboxLane(ticket);
      const sla_remaining_ms = computeSlaRemainingMs(ticket, now);
      return {
        ...ticket,
        inbox_lane,
        inbox_reason: inferInboxReason(ticket, inbox_lane),
        recommended_action: inferRecommendedAction(ticket, inbox_lane),
        owner_label: ticket.current_actor || ticket.next_actor || ticket.assigned_agent || ticket.triage_owner || ticket.review_owner || ticket.decision_owner || null,
        sla_remaining_ms,
        sla_remaining_minutes: sla_remaining_ms == null ? null : Math.round(sla_remaining_ms / 60000),
      };
    })
    .sort((a, b) => {
      const aSla = a.sla_remaining_ms;
      const bSla = b.sla_remaining_ms;
      if (aSla != null && bSla != null && aSla !== bSla) return aSla - bSla;
      if (aSla != null && bSla == null) return -1;
      if (aSla == null && bSla != null) return 1;

      const aTs = Date.parse(a.last_update || a.created || '') || 0;
      const bTs = Date.parse(b.last_update || b.created || '') || 0;
      if (aTs !== bTs) return aTs - bTs;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });
}

function buildInboxPayload() {
  const lanes = {
    triage: buildInboxList(['triage']),
    execution: buildInboxList(['queued', 'running']),
    review: buildInboxList(['done', 'review']),
    decision: buildInboxList(['pending_decision']),
  };

  return {
    items: Object.values(lanes).flat(),
    lanes,
    counts: Object.fromEntries(Object.entries(lanes).map(([key, value]) => [key, value.length])),
  };
}

app.get('/api/metrics/dashboard', (_req, res) => {
  res.json({ data: computeDashboardMetrics() });
});

app.get('/api/inbox', (_req, res) => {
  res.json(buildInboxPayload());
});

app.get('/api/inbox/triage', (_req, res) => {
  res.json({ items: buildInboxList(['triage']) });
});

app.get('/api/inbox/execution', (_req, res) => {
  res.json({ items: buildInboxList(['queued', 'running']) });
});

app.get('/api/inbox/review', (_req, res) => {
  res.json({ items: buildInboxList(['done', 'review']) });
});

app.get('/api/inbox/decisions', (_req, res) => {
  res.json({ items: buildInboxList(['pending_decision']) });
});

registerTicketReadRoutes(app, {
  buildTicketListItem,
  matchesTicketFilters,
  formatTicketForList,
  normalizeComment,
  getAvailableActions,
});

// POST /api/tickets - 创建工单，立即返回；未传 status 时默认 triage（triage -> queue 须经 transition 且责任链已落链）
app.post('/api/tickets', (req, res) => {
  const prepared = prepareTicketCreatePayload(req.body);
  if (!prepared.ok) {
    return res.status(prepared.status).json(prepared.body);
  }

  const ticket = store.createTicket(prepared.payload);
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
    execution_mode,
    max_active_workers,
  } = req.body || {};
  const updates = {};

  // 禁止直接修改 status，必须使用 transition API
  if (status !== undefined) {
    return res.status(400).json({
      error: 'Direct status update forbidden',
      message: '禁止直接修改状态，请使用 POST /api/tickets/:id/transition',
      hint: 'Use transition API for state changes',
      available_actions: getAvailableActions(id)
    });
  }
  if (request_type !== undefined && request_type !== null && request_type !== '' && !ALLOWED_REQUEST_TYPES.includes(request_type)) {
    return res.status(400).json({
      error: 'Bad request',
      message: `request_type 非法，允许值：${ALLOWED_REQUEST_TYPES.join('/')}`,
    });
  }
  if (execution_mode !== undefined && execution_mode !== null && execution_mode !== '' && !ALLOWED_EXECUTION_MODES.includes(String(execution_mode).trim().toLowerCase())) {
    return res.status(400).json({
      error: 'Bad request',
      message: `execution_mode 非法，允许值：${ALLOWED_EXECUTION_MODES.join('/')}`,
    });
  }
  const normalizedWorkerLimit = normalizeOptionalWorkerLimit(max_active_workers);
  if (!normalizedWorkerLimit.ok) {
    return res.status(400).json({ error: 'Bad request', message: normalizedWorkerLimit.message });
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
  if (next_actor !== undefined) updates.next_actor_override = normalizeOptionalAgent(next_actor);
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
  if (execution_mode !== undefined) updates.execution_mode = normalizeExecutionMode(execution_mode);
  if (max_active_workers !== undefined) updates.max_active_workers = normalizedWorkerLimit.value;
  if (watchers !== undefined) {
    if (!Array.isArray(watchers)) {
      return res.status(400).json({ error: 'Bad request', message: 'watchers 必须是数组' });
    }
    updates.watchers = watchers
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .slice(0, 100);
  }
  const effectivePlatform = updates.platform !== undefined ? updates.platform : ticket.platform;
  const effectiveAssignedAgent = updates.assigned_agent !== undefined ? updates.assigned_agent : ticket.assigned_agent;
  const patchAgentValidation = validateTicketPlatformAssignedAgent(effectivePlatform, effectiveAssignedAgent);
  if (!patchAgentValidation.ok) {
    return res.status(400).json({
      error: patchAgentValidation.error,
      message: patchAgentValidation.message,
      platform: patchAgentValidation.platform,
      allowed_assigned_agents: patchAgentValidation.allowed_assigned_agents,
    });
  }

  updates.last_update = new Date().toISOString();

  const statusChanged = updates.status !== undefined && updates.status !== ticket.status;
  store.updateTicket(id, updates);
  if (statusChanged) {
    dispatch.clearNotificationEvents(Number(id));
    dispatch.clearAuditEvents(Number(id));
  }

  const updated = store.getTicketById(id);
  res.json(formatTicketForList(updated));
});

// POST /api/tickets/:id/dispatch - 手动重派（仅更新 assigned_agent 和状态，不调用 OpenClaw）
app.post('/api/tickets/:id/dispatch', (req, res) => {
  const id = req.params.id;
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }

  const agent = resolveTicketPlatformAssignedAgent(ticket.platform, req.body?.agent, { defaultToExecutor: true }) || 'donky';
  const dispatchAgentValidation = validateTicketPlatformAssignedAgent(ticket.platform, agent);
  if (!dispatchAgentValidation.ok) {
    return res.status(400).json({
      error: dispatchAgentValidation.error,
      message: dispatchAgentValidation.message,
      platform: dispatchAgentValidation.platform,
      allowed_assigned_agents: dispatchAgentValidation.allowed_assigned_agents,
    });
  }

  const statusChanged = ticket.status !== 'queued';
  store.updateTicket(id, {
    status: 'queued',
    assigned_agent: agent,
    next_actor_override: null,
    error: null,
    last_update: new Date().toISOString(),
  });
  if (statusChanged) {
    dispatch.clearNotificationEvents(Number(id));
    dispatch.clearAuditEvents(Number(id));
  }

  const updated = store.getTicketById(id);
  res.json(formatTicketForList(updated));
});

// POST /api/tickets/:id/nudge - 手动催当前处理人（通过 dispatch nudge 通道发送消息，不改状态）
app.post('/api/tickets/:id/nudge', (req, res) => {
  const id = Number(req.params.id);
  const rawTicket = store.getTicketById(id);
  if (!rawTicket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }

  const ticket = enrichTicketForApi(rawTicket);
  if (['complete', 'failed', 'deprecated'].includes(ticket.status)) {
    return res.status(409).json({
      error: 'Action not allowed',
      message: `状态 ${ticket.status} 不支持催单`,
      ticket: formatTicketForList(rawTicket),
    });
  }

  const agent = normalizeOptionalAgent(ticket.current_actor || ticket.next_actor || ticket.assigned_agent);
  if (!agent) {
    return res.status(409).json({
      error: 'Action not allowed',
      message: '当前责任人未解析，无法发送催单消息',
      ticket: formatTicketForList(rawTicket),
    });
  }

  let dispatchId = dispatch.getUnackedDispatchEvent(ticket.id, agent, MANUAL_NUDGE_STATUS_KEY);
  const reused = Boolean(dispatchId);

  if (!dispatchId && dispatch.hasRecentDispatch(ticket.id, agent, MANUAL_NUDGE_STATUS_KEY, TICKET_NUDGE_THROTTLE_MINUTES)) {
    const latest = dispatch.getLatestDispatchEvent(ticket.id, agent, MANUAL_NUDGE_STATUS_KEY);
    return res.status(409).json({
      error: 'Nudge throttled',
      message: `最近 ${TICKET_NUDGE_THROTTLE_MINUTES} 分钟内已催过 ${agent}，请稍后再试`,
      agent,
      dispatch_id: latest?.id || null,
      last_dispatch_at: latest?.created_at || null,
      ticket: formatTicketForList(rawTicket),
    });
  }

  if (!dispatchId) {
    dispatchId = dispatch.recordDispatchEvent(ticket.id, agent, MANUAL_NUDGE_STATUS_KEY);
  }

  const readyItem = buildNudgeReadyItem({
    ticket,
    agent,
    dispatchId,
    delivery: resolveDispatchDelivery({ agent, ticketId: ticket.id, kind: 'nudge', nudgeSource: 'manual' }),
    message: buildManualNudgeMessage({ ticket, agent }),
    nudgeKey: MANUAL_NUDGE_STATUS_KEY,
    nudgeSource: 'manual',
    nudgeLevel: 'L1',
  });

  return res.status(reused ? 200 : 201).json({
    success: true,
    reused,
    dispatch_id: dispatchId,
    ticket: formatTicketForList(rawTicket),
    ready_item: readyItem,
  });
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

  const cleanAuthor = resolveCommentAuthor(enrichTicketForApi(ticket), author).slice(0, AUTHOR_MAX_LENGTH) || 'Current User';
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
  persistTicketComment(id, newComment);
  res.status(201).json(newComment);
});



// GET /api/tickets/:id/workers - 获取执行 worker 列表
app.get('/api/tickets/:id/workers', (req, res) => {
  const id = Number(req.params.id);
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }

  const enriched = enrichTicketForApi(ticket);
  res.json({
    ticket_id: id,
    execution_mode: enriched.execution_mode,
    max_active_workers: enriched.max_active_workers,
    worker_stats: enriched.worker_stats,
    execution_guard: enriched.execution_guard,
    workers: enriched.execution_workers,
  });
});

// POST /api/tickets/:id/workers - 登记执行 worker
app.post('/api/tickets/:id/workers', (req, res) => {
  const id = Number(req.params.id);
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }

  const {
    worker_key,
    worker_type,
    status = 'starting',
    session_key,
    run_id,
    label,
    summary,
    metadata,
    started_at,
    last_heartbeat_at,
    finished_at,
  } = req.body || {};

  if (!worker_key || typeof worker_key !== 'string' || !worker_key.trim()) {
    return res.status(400).json({ error: 'Bad request', message: 'worker_key 不能为空' });
  }
  if (!worker_type || typeof worker_type !== 'string' || !worker_type.trim()) {
    return res.status(400).json({ error: 'Bad request', message: 'worker_type 不能为空' });
  }

  try {
    const worker = store.registerExecutionWorker(id, {
      worker_key: worker_key.trim(),
      worker_type: worker_type.trim(),
      status,
      session_key: normalizeOptionalText(session_key, 255),
      run_id: normalizeOptionalText(run_id, 255),
      label: normalizeOptionalText(label, 255),
      summary: normalizeOptionalText(summary, 4000),
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      started_at: normalizeOptionalText(started_at, 64),
      last_heartbeat_at: normalizeOptionalText(last_heartbeat_at, 64),
      finished_at: normalizeOptionalText(finished_at, 64),
    });
    const maybeStarted = maybeAutoStartQueuedTicketAfterWorkerChange(id, worker);
    dispatch.clearAuditEvents(id);
    const enriched = enrichTicketForApi(maybeStarted || store.getTicketById(id));
    return res.status(201).json({ worker, ticket: formatTicketForList(enriched) });
  } catch (err) {
    return handleExecutionStoreError(res, err);
  }
});

// PATCH /api/tickets/:id/workers/:worker_key - 更新执行 worker
app.patch('/api/tickets/:id/workers/:worker_key', (req, res) => {
  const id = Number(req.params.id);
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }

  try {
    const worker = store.updateExecutionWorker(id, req.params.worker_key, {
      worker_type: req.body?.worker_type !== undefined ? String(req.body.worker_type || '').trim() : undefined,
      status: req.body?.status,
      session_key: req.body?.session_key !== undefined ? normalizeOptionalText(req.body.session_key, 255) : undefined,
      run_id: req.body?.run_id !== undefined ? normalizeOptionalText(req.body.run_id, 255) : undefined,
      label: req.body?.label !== undefined ? normalizeOptionalText(req.body.label, 255) : undefined,
      summary: req.body?.summary !== undefined ? normalizeOptionalText(req.body.summary, 4000) : undefined,
      metadata: req.body?.metadata !== undefined ? (req.body.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {}) : undefined,
      last_heartbeat_at: req.body?.last_heartbeat_at !== undefined ? normalizeOptionalText(req.body.last_heartbeat_at, 64) : undefined,
      finished_at: req.body?.finished_at !== undefined ? normalizeOptionalText(req.body.finished_at, 64) : undefined,
    });
    const maybeStarted = maybeAutoStartQueuedTicketAfterWorkerChange(id, worker);
    dispatch.clearAuditEvents(id);
    const enriched = enrichTicketForApi(maybeStarted || store.getTicketById(id));
    return res.json({ worker, ticket: formatTicketForList(enriched) });
  } catch (err) {
    return handleExecutionStoreError(res, err);
  }
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

// GET /api/dispatch/ready - 获取待派发工单
// ?source=legacy|projection|compare  (default: legacy)
app.get('/api/dispatch/ready', (req, res) => {
  const source = (req.query.source || 'legacy').toLowerCase();
  const requestId = getRequestId(req, res);
  if (source === 'projection') {
    const terminalStatuses = new Set(['complete', 'failed', 'deprecated']);
    const projectionRows = store.getDispatchReadyProjection();
    const ready = projectionRows
      .map((r) => {
        const ticket = enrichTicketForApi(store.getTicketById(r.ticket_id) || {});
        return {
          dispatch_id: r.dispatch_id,
          dispatch_event_id: r.dispatch_id,
          agent: r.agent,
          ticket_id: r.ticket_id,
          title: ticket.title ?? '',
          status: ticket.status ?? '',
          next_actor: ticket.next_actor ?? r.agent,
          execution_mode: ticket.execution_mode ?? null,
          worker_stats: ticket.worker_stats ?? {},
          reason: r.reason,
          dedupe_key: r.dedupe_key,
          escalation_tier: r.escalation_tier,
          assignment_id: r.assignment_id,
          assignment: r.assignment ?? null,
          reset_session: r.reset_session,
          session_reset_reason: r.session_reset_reason,
          target_session_key: r.target_session_key,
          target_gateway_id: r.target_gateway_id,
          message: r.message ?? null,
          kind: r.kind ?? null,
          workflow_mismatch: r.workflow_mismatch ?? null,
        };
      })
      .filter((item) => !terminalStatuses.has(item.status));
    return res.json({ ready, request_id: requestId, _source: 'projection' });
  }

  const rawTickets = store.getAllTickets();
  const PENDING_DELIVERY_STALE_MS = 60 * 60 * 1000;
  for (const t of rawTickets) {
    if (t.status !== 'queued') continue;
    const agent = String(t.assigned_agent || t.next_actor || '').trim();
    if (!agent) continue;
    const latest = dispatch.getLatestDispatchHandshakeState(t.id, agent, 'queued');
    if (latest?.dispatch_state === 'pending_delivery' && latest?.created_at) {
      const ageMs = Date.now() - new Date(latest.created_at).getTime();
      if (ageMs > PENDING_DELIVERY_STALE_MS) dispatch.clearDispatchEvents(t.id);
    }
  }
  const allTickets = rawTickets.map(enrichTicketForApi);
  const terminalStatuses = new Set(['complete', 'failed', 'deprecated']);
  for (const ticket of allTickets) {
    if (terminalStatuses.has(ticket.status) && (ticket.dispatch_state || ticket.execution_guard?.reservation || ticket.execution_guard?.suppress_dispatch)) {
      dispatch.clearDispatchEvents(ticket.id);
    }
  }

  const ready = buildDispatchReadyProjection(allTickets, {
    requestId,
    buildAgentDispatchMessage,
    detectWorkflowMismatch,
    getStaleDeliveryHint,
    collectReadyNudges,
    enrichTicketForApi,
    getTicketLastActivityTs,
    nudgeLevelOrder: NUDGE_LEVEL_ORDER,
  });

  if (source === 'compare') {
    const projectionBefore = store.getDispatchReadyProjection();
    store.replaceAllDispatchReadyProjection(ready);
    return res.json({
      ready,
      request_id: requestId,
      _source: 'compare',
      _compare: {
        legacy_count: ready.length,
        projection_count: projectionBefore.length,
        projection: projectionBefore,
      },
    });
  }
  store.replaceAllDispatchReadyProjection(ready);
  res.json({ ready, request_id: requestId });
});

function parsePositiveInt(value) {
  const num = parseInt(value, 10);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function resolveDispatchId(req) {
  return (
    parsePositiveInt(req.params?.dispatch_id)
    || parsePositiveInt(req.body?.dispatch_id)
    || parsePositiveInt(req.body?.id)
    || parsePositiveInt(req.query?.dispatch_id)
  );
}

function resolveNotificationEventId(req) {
  return (
    parsePositiveInt(req.params?.event_id)
    || parsePositiveInt(req.body?.event_id)
    || parsePositiveInt(req.body?.id)
    || parsePositiveInt(req.query?.event_id)
  );
}

// POST /api/dispatch/:dispatch_id/ack - 确认派发（transport delivery success，后续等待 agent receipt）
app.post('/api/dispatch/:dispatch_id/ack', (req, res) => {
  const dispatchId = resolveDispatchId(req);
  if (!dispatchId) {
    return res.status(400).json({ error: 'Bad request', message: 'dispatch_id 必须是正整数' });
  }
  const ok = dispatch.ackDispatchEvent(dispatchId);
  if (!ok) {
    return res.status(404).json({ error: 'Not found', message: `dispatch_id ${dispatchId} 不存在` });
  }
  const event = dispatch.getDispatchEventById(dispatchId);
  res.json({
    success: true,
    request_id: getRequestId(req, res),
    dispatch_id: dispatchId,
    dispatch_event_id: dispatchId,
    status_before: event?.status || null,
    status_after: event?.status || null,
    dispatch_state: event?.dispatch_state || 'awaiting_receipt',
    awaiting_receipt_from: event?.awaiting_receipt_from || null,
    dispatch_ack_deadline_at: event?.dispatch_ack_deadline_at || null,
    next_dispatch_retry_at: event?.next_dispatch_retry_at || null,
  });
});

// POST /api/dispatch/ack - 兼容旧调用（body/query 携带 dispatch_id）
app.post('/api/dispatch/ack', (req, res) => {
  const dispatchId = resolveDispatchId(req);
  if (!dispatchId) {
    return res.status(400).json({ error: 'Bad request', message: 'dispatch_id 必须是正整数' });
  }
  const ok = dispatch.ackDispatchEvent(dispatchId);
  if (!ok) {
    return res.status(404).json({ error: 'Not found', message: `dispatch_id ${dispatchId} 不存在` });
  }
  const event = dispatch.getDispatchEventById(dispatchId);
  res.json({
    success: true,
    request_id: getRequestId(req, res),
    dispatch_id: dispatchId,
    dispatch_event_id: dispatchId,
    compatibility: true,
    status_before: event?.status || null,
    status_after: event?.status || null,
    dispatch_state: event?.dispatch_state || 'awaiting_receipt',
    awaiting_receipt_from: event?.awaiting_receipt_from || null,
    dispatch_ack_deadline_at: event?.dispatch_ack_deadline_at || null,
    next_dispatch_retry_at: event?.next_dispatch_retry_at || null,
  });
});

// GET /api/notifications/ready - 获取待通知结果
app.get('/api/notifications/ready', (req, res) => {
  const requestId = getRequestId(req, res);
  const NOTIFY_STATUSES = new Set(['complete', 'failed', 'pending_decision', 'blocked']);
  const tickets = store.getAllTickets()
    .map(enrichTicketForApi)
    .filter(t => NOTIFY_STATUSES.has(t.status) && t.should_notify);

  const ready = [];
  for (const ticket of tickets) {
    const eventType = ticket.status;
    const staleHint = getStaleDeliveryHint(ticket, 'notification');
    if (staleHint?.stale) {
      dispatch.clearNotificationEvents(ticket.id);
      console.log(`[notifications/ready] Skip #${ticket.id}: stale notification (${staleHint.reason})`);
      continue;
    }

    let message = '';
    if (eventType === 'complete') {
      message = `✅ 工单已完成\n\n#${ticket.id} ${ticket.title}\n结果：${ticket.result_summary || '已完成'}`;
    } else if (eventType === 'failed') {
      message = `❌ 工单失败\n\n#${ticket.id} ${ticket.title}\n错误：${ticket.error || '执行失败'}`;
    } else if (eventType === 'pending_decision') {
      message = `⏸️ 工单等待决策\n\n#${ticket.id} ${ticket.title}\n决策摘要：${ticket.decision_summary || '需要老大决策'}`;
    } else if (eventType === 'blocked') {
      message = `🚧 工单已阻塞\n\n#${ticket.id} ${ticket.title}\n阻塞摘要：${ticket.blocker_summary || ticket.decision_summary || '需要老大关注阻塞并协调处理'}`;
    }

    const target_actor = ['pending_decision', 'blocked'].includes(eventType)
      ? (ticket.decision_owner || '荣晖')
      : (ticket.decision_owner || '荣晖');
    const target_session_key = getNotificationSessionKey({
      status: ticket.status,
      reviewOwner: ticket.review_owner,
      ticketId: ticket.id,
    });
    const delivery = resolveNotificationDelivery({
      status: ticket.status,
      reviewOwner: ticket.review_owner,
      ticketId: ticket.id,
      targetActor: target_actor,
    });
    const governance = buildNotificationEventGovernance({
      ticket,
      eventType,
      targetActor: target_actor,
    });

    // 检查是否最近已通知（按 stage/reason/actor 去重，只看已 ack）
    if (dispatch.hasRecentNotification(ticket.id, eventType, {
      target_actor,
      reason: governance.reason,
    })) continue;

    // 复用未 ack 事件，避免每次拉 ready 都插入新事件
    let eventId = dispatch.getUnackedNotificationEvent(ticket.id, eventType, ticket.status, {
      target_actor,
      reason: governance.reason,
    });
    if (!eventId) {
      eventId = dispatch.recordNotificationEvent(ticket.id, eventType, ticket.status, {
        target_actor,
        reason: governance.reason,
        dedupe_key: governance.dedupe_key,
        escalation_tier: governance.escalation_tier,
      });
    }

    ready.push({
      request_id: requestId,
      event_id: eventId,
      notification_event_id: eventId,
      type: eventType,
      ticket_id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      status_before: ticket.status,
      status_after: ticket.status,
      target_actor,
      computed_actor: ticket.current_actor || ticket.next_actor || target_actor,
      override_actor: ticket.next_actor_override || null,
      target_session: target_session_key,
      target_actor_session: target_session_key,
      reason: governance.reason,
      dedupe_key: governance.dedupe_key,
      escalation_tier: governance.escalation_tier,
      target_session_key,
      ...delivery,
      message,
    });
  }

  res.json({ ready, request_id: requestId });
});

// GET /api/pending-forwards - 查看待补偿/已补偿的 Telegram 转发记录
app.get('/api/pending-forwards', (req, res) => {
  const unresolvedOnly = String(req.query.unresolved_only || req.query.unresolvedOnly || 'false').toLowerCase() === 'true';
  const ticketIdRaw = req.query.ticket_id ?? req.query.ticketId;
  const ticketId = ticketIdRaw === undefined ? null : Number.parseInt(String(ticketIdRaw), 10);
  if (ticketIdRaw !== undefined && (!Number.isInteger(ticketId) || ticketId <= 0)) {
    return res.status(400).json({ error: 'Bad request', message: 'ticket_id 必须是正整数' });
  }

  const items = dispatch.listPendingForwards({
    channel: 'telegram',
    unresolvedOnly,
    ticketId,
    limit: Number.parseInt(String(req.query.limit || '50'), 10) || 50,
  });

  return res.json({
    ready: items,
    items,
    unresolved_count: items.filter((item) => !item.resolved_at).length,
    request_id: getRequestId(req, res),
  });
});

// POST /api/notifications/:event_id/ack - 确认通知
app.post('/api/notifications/:event_id/ack', (req, res) => {
  const eventId = resolveNotificationEventId(req);
  if (!eventId) {
    return res.status(400).json({ error: 'Bad request', message: 'event_id 必须是正整数' });
  }
  const ok = dispatch.ackNotificationEvent(eventId);
  if (!ok) {
    return res.status(404).json({ error: 'Not found', message: `event_id ${eventId} 不存在` });
  }
  res.json({
    success: true,
    request_id: getRequestId(req, res),
    event_id: eventId,
  });
});

// POST /api/notifications/ack - 兼容旧调用（body/query 携带 event_id）
app.post('/api/notifications/ack', (req, res) => {
  const eventId = resolveNotificationEventId(req);
  if (!eventId) {
    return res.status(400).json({ error: 'Bad request', message: 'event_id 必须是正整数' });
  }
  const ok = dispatch.ackNotificationEvent(eventId);
  if (!ok) {
    return res.status(404).json({ error: 'Not found', message: `event_id ${eventId} 不存在` });
  }
  res.json({
    success: true,
    request_id: getRequestId(req, res),
    event_id: eventId,
    compatibility: true,
  });
});

// 关系建模 API（补充验证 / smoke / review sample）
app.get('/api/tickets/:id/relations', (req, res) => {
  const ticketId = parseInt(req.params.id, 10);
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    return res.status(400).json({ error: 'Bad request', message: 'ticket_id 必须是正整数' });
  }

  const ticket = store.getTicketById(ticketId);
  if (!ticket) {
    return res.status(404).json({ error: 'Not found', message: '工单不存在' });
  }

  return res.json(store.getTicketRelations(ticketId));
});

app.post('/api/tickets/:id/relations', (req, res) => {
  const sourceTicketId = parseInt(req.params.id, 10);
  const targetTicketId = Number(req.body?.related_ticket_id ?? req.body?.target_ticket_id);
  const relationType = String(req.body?.relation_type || '').trim();

  if (!Number.isInteger(sourceTicketId) || sourceTicketId <= 0) {
    return res.status(400).json({ error: 'Bad request', message: 'ticket_id 必须是正整数' });
  }
  if (!Number.isInteger(targetTicketId) || targetTicketId <= 0) {
    return res.status(400).json({ error: 'Bad request', message: 'related_ticket_id 必须是正整数' });
  }
  if (!ALLOWED_TICKET_RELATION_TYPES.includes(relationType)) {
    return res.status(400).json({
      error: 'Bad request',
      message: `relation_type 非法：${relationType || '(empty)'}`,
      allowed_relation_types: ALLOWED_TICKET_RELATION_TYPES,
    });
  }
  if (sourceTicketId === targetTicketId) {
    return res.status(400).json({ error: 'Bad request', message: 'related_ticket_id 不能指向自身' });
  }
  if (!store.getTicketById(sourceTicketId) || !store.getTicketById(targetTicketId)) {
    return res.status(404).json({ error: 'Not found', message: 'source/target 工单不存在' });
  }

  try {
    const success = store.addTicketRelation(sourceTicketId, targetTicketId, relationType);
    if (!success) {
      return res.status(409).json({ error: 'Conflict', message: '工单关系已存在' });
    }
    dispatch.clearDispatchEvents(sourceTicketId);
    dispatch.clearNotificationEvents(sourceTicketId);
    return res.status(201).json({ success: true, relations: store.getTicketRelations(sourceTicketId) });
  } catch (err) {
    return res.status(400).json({ error: 'Bad request', message: err?.message || '工单关系创建失败' });
  }
});

app.delete('/api/tickets/:id/relations/:related_ticket_id', (req, res) => {
  const sourceTicketId = parseInt(req.params.id, 10);
  const targetTicketId = parseInt(req.params.related_ticket_id, 10);
  const relationType = String(req.query?.relation_type || req.body?.relation_type || '').trim();

  if (!Number.isInteger(sourceTicketId) || sourceTicketId <= 0 || !Number.isInteger(targetTicketId) || targetTicketId <= 0) {
    return res.status(400).json({ error: 'Bad request', message: 'ticket_id 和 related_ticket_id 必须是正整数' });
  }
  if (!ALLOWED_TICKET_RELATION_TYPES.includes(relationType)) {
    return res.status(400).json({
      error: 'Bad request',
      message: `relation_type 非法：${relationType || '(empty)'}`,
      allowed_relation_types: ALLOWED_TICKET_RELATION_TYPES,
    });
  }

  const success = store.removeTicketRelation(sourceTicketId, targetTicketId, relationType);
  if (!success) {
    return res.status(404).json({ error: 'Not found', message: '工单关系不存在' });
  }
  return res.json({ success: true, relations: store.getTicketRelations(sourceTicketId) });
});

// 依赖关系 API
// POST /api/tickets/:id/dependencies - 添加依赖
app.post('/api/tickets/:id/dependencies', (req, res) => {
  const ticketId = parseInt(req.params.id, 10);
  const { depends_on_ticket_id, dependency_type } = req.body;
  
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    return res.status(400).json({ error: 'Bad request', message: 'ticket_id 必须是正整数' });
  }
  
  if (!depends_on_ticket_id || !Number.isInteger(depends_on_ticket_id) || depends_on_ticket_id <= 0) {
    return res.status(400).json({ error: 'Bad request', message: 'depends_on_ticket_id 必须是正整数' });
  }
  
  const success = store.addDependency(ticketId, depends_on_ticket_id, dependency_type || 'blocks');
  if (!success) {
    return res.status(409).json({ error: 'Conflict', message: '依赖关系已存在' });
  }
  
  res.json({ success: true });
});

// DELETE /api/tickets/:id/dependencies/:depends_on_id - 删除依赖
app.delete('/api/tickets/:id/dependencies/:depends_on_id', (req, res) => {
  const ticketId = parseInt(req.params.id, 10);
  const dependsOnId = parseInt(req.params.depends_on_id, 10);
  
  if (!Number.isInteger(ticketId) || ticketId <= 0 || !Number.isInteger(dependsOnId) || dependsOnId <= 0) {
    return res.status(400).json({ error: 'Bad request', message: 'ticket_id 和 depends_on_id 必须是正整数' });
  }
  
  const success = store.removeDependency(ticketId, dependsOnId);
  if (!success) {
    return res.status(404).json({ error: 'Not found', message: '依赖关系不存在' });
  }
  
  res.json({ success: true });
});

// GET /api/tickets/:id/dependencies - 获取工单的依赖
app.get('/api/tickets/:id/dependencies', (req, res) => {
  const ticketId = parseInt(req.params.id, 10);
  
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    return res.status(400).json({ error: 'Bad request', message: 'ticket_id 必须是正整数' });
  }
  
  const dependencies = store.getDependencies(ticketId);
  const dependents = store.getDependents(ticketId);
  
  res.json({ dependencies, dependents });
});

// ── Audit API（平台巡检长期未动工单）──

function getDefaultStatusSlaMinutes(status, fallback) {
  const minutes = Number(getStatusMeta(status)?.sla?.default_minutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : fallback;
}

const AUDIT_STALE_TRIAGE_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_TRIAGE_MINUTES) || getDefaultStatusSlaMinutes('triage', 5);
const AUDIT_STALE_RUNNING_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_RUNNING_MINUTES) || getDefaultStatusSlaMinutes('running', 30);
const AUDIT_STALE_PAUSED_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_PAUSED_MINUTES) || getDefaultStatusSlaMinutes('paused', 240);
const AUDIT_STALE_DONE_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_DONE_MINUTES) || getDefaultStatusSlaMinutes('done', 15);
const AUDIT_STALE_REVIEW_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_REVIEW_MINUTES) || getDefaultStatusSlaMinutes('review', 60);
const AUDIT_STALE_PENDING_DECISION_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_PENDING_DECISION_MINUTES) || getDefaultStatusSlaMinutes('pending_decision', 720);
const AUDIT_STALE_BLOCKED_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_BLOCKED_MINUTES) || getDefaultStatusSlaMinutes('blocked', 240);
const AUDIT_REQUEST_RETRY_MINUTES = parsePositiveInt(process.env.AUDIT_REQUEST_RETRY_MINUTES) || 30;
const QUEUED_NUDGE_STALE_MINUTES = parsePositiveInt(process.env.QUEUED_NUDGE_STALE_MINUTES) || getDefaultStatusSlaMinutes('queued', 10);
const AUDIT_STALE_QUEUED_AFTER_RECEIPT_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_QUEUED_AFTER_RECEIPT_MINUTES) || getDefaultStatusSlaMinutes('queued', 10);
const TICKET_NUDGE_THROTTLE_MINUTES = parsePositiveInt(process.env.TICKET_NUDGE_THROTTLE_MINUTES) || 30;
const MANUAL_NUDGE_STATUS_KEY = 'nudge_manual';
const NUDGE_LEVEL_ORDER = { L3: 0, L2: 1, L1: 2 };

const AUDIT_THRESHOLDS = {
  triage: AUDIT_STALE_TRIAGE_MINUTES,
  running: AUDIT_STALE_RUNNING_MINUTES,
  paused: AUDIT_STALE_PAUSED_MINUTES,
  done: AUDIT_STALE_DONE_MINUTES,
  review: AUDIT_STALE_REVIEW_MINUTES,
  pending_decision: AUDIT_STALE_PENDING_DECISION_MINUTES,
  blocked: AUDIT_STALE_BLOCKED_MINUTES,
};

const AUDIT_RESULT_ALLOWED_CONCLUSIONS = new Set([
  'workflow_mismatch',
  'stale_triage',
  'stale_running',
  'stale_paused',
  'stale_done',
  'stale_review',
  'stale_pending_decision',
  'stale_blocked',
  'stale_queued_after_receipt',
  'no_issue',
]);
const AUDIT_RESULT_ALLOWED_ACTIONS = new Set([
  'notify_only',
  'manual_review',
  'transition_recommended',
  'no_action',
]);
const AUDIT_RESULT_ALLOWED_CONFIDENCE = new Set(['high', 'medium', 'low']);
const AUDIT_NUDGEABLE_ACTIONS = new Set(['notify_only', 'manual_review', 'transition_recommended']);

function getTicketLastActivityTs(ticket = {}) {
  const ts = Date.parse(ticket.last_update || ticket.updated || ticket.created || '');
  return Number.isFinite(ts) ? ts : null;
}

function computeTicketStaleMinutes(ticket, now = Date.now()) {
  const lastUpdateTs = getTicketLastActivityTs(ticket);
  if (!Number.isFinite(lastUpdateTs)) return null;
  return (now - lastUpdateTs) / (60 * 1000);
}

function getTicketSlaMinutes(ticket = {}) {
  return getDefaultStatusSlaMinutes(ticket.status, null);
}

function resolveNudgeLevel(ticket, staleMinutes) {
  const slaMinutes = getTicketSlaMinutes(ticket);
  if (!Number.isFinite(staleMinutes) || !Number.isFinite(slaMinutes) || slaMinutes <= 0) return null;
  if (staleMinutes >= slaMinutes * 3) return 'L3';
  if (staleMinutes >= slaMinutes * 2) return 'L2';
  if (staleMinutes >= slaMinutes) return 'L1';
  return null;
}

function buildTieredNudgeStatusKey(baseKey, level) {
  const normalizedBase = String(baseKey || '').trim().replace(/^nudge_/, '');
  const normalizedLevel = String(level || 'L1').trim().toLowerCase();
  return `nudge_${normalizedLevel}_${normalizedBase}`;
}

function dedupeActors(actors = []) {
  const seen = new Set();
  const result = [];
  for (const actor of actors) {
    const normalized = normalizeOptionalAgent(actor);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function resolveNudgeTargets(ticket, level, { preferredActor = null } = {}) {
  if (level === 'L3') {
    return dedupeActors([
      preferredActor,
      resolveRoleActor(ticket, 'decision_owner'),
    ]);
  }
  if (level === 'L2') {
    return dedupeActors([
      preferredActor,
      resolveRoleActor(ticket, 'review_owner'),
      resolveRoleActor(ticket, 'triage_owner'),
    ]);
  }
  return dedupeActors([
    preferredActor,
    resolveRoleActor(ticket, 'current_actor'),
    resolveRoleActor(ticket, 'assigned_agent'),
  ]);
}

function describeNudgeLevel(level, slaMinutes, staleMinutes) {
  const ratio = Number.isFinite(slaMinutes) && slaMinutes > 0 && Number.isFinite(staleMinutes)
    ? `${(staleMinutes / slaMinutes).toFixed(1)}x SLA`
    : 'SLA 超时';
  if (level === 'L3') return `${level}（${ratio}，升级到决策人）`;
  if (level === 'L2') return `${level}（${ratio}，升级到 review_owner + triage_owner）`;
  return `${level}（${ratio}，提醒当前责任人）`;
}

function buildAuditRequestContract(ticket, auditId, auditType, staleMinutes) {
  const latestComment = Array.isArray(ticket.comments) && ticket.comments.length > 0
    ? normalizeComment(ticket.comments[ticket.comments.length - 1])
    : null;

  return {
    version: '2026-03-12.audit-request.v1',
    audit_id: auditId,
    audit_type: auditType,
    stale_minutes: Math.round(staleMinutes),
    target_session_key: getAuditSessionKeyForTicket(ticket.id),
    read_endpoint: `/api/tickets/${ticket.id}`,
    result_endpoint: `/api/audits/${auditId}/result`,
    ack_endpoint: `/api/audits/${auditId}/ack`,
    allowed_conclusions: Array.from(AUDIT_RESULT_ALLOWED_CONCLUSIONS),
    allowed_suggested_actions: Array.from(AUDIT_RESULT_ALLOWED_ACTIONS),
    allowed_confidence: Array.from(AUDIT_RESULT_ALLOWED_CONFIDENCE),
    allowed_suggested_statuses: TICKET_STATUSES,
    ticket_snapshot: {
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      assigned_agent: ticket.assigned_agent || null,
      current_actor: ticket.current_actor || null,
      current_actor_source: ticket.current_actor_source || null,
      review_owner: ticket.review_owner || null,
      decision_owner: ticket.decision_owner || null,
      next_actor: ticket.next_actor || null,
      next_actor_override: ticket.next_actor_override || null,
      last_update: ticket.last_update || null,
      comment_count: Array.isArray(ticket.comments) ? ticket.comments.length : 0,
      latest_comment: latestComment
        ? {
            author: latestComment.author,
            timestamp: latestComment.timestamp,
            type: latestComment.type,
            content: String(latestComment.content || '').slice(0, 500),
          }
        : null,
    },
  };
}

function buildAuditMessage(ticket, auditId, auditType, staleMinutes) {
  const hours = (staleMinutes / 60).toFixed(1);
  return [
    `🔍 【审计任务】`,
    ``,
    `这是一个平台自动巡检产生的审计任务，不是派单执行任务。`,
    `请你仅做审计分析，不要自动修改工单状态。`,
    ``,
    `## 工单信息`,
    `- 工单 ID：#${ticket.id}`,
    `- 标题：${ticket.title}`,
    `- 当前状态：${ticket.status}`,
    `- 负责 Agent：${ticket.assigned_agent || '未指定'}`,
    `- current_actor：${ticket.current_actor || '未指定'}`,
    `- current_actor_source：${ticket.current_actor_source || '未指定'}`,
    `- next_actor_override：${ticket.next_actor_override || '无'}`,
    `- manual_override_active：${ticket.manual_override_active ? 'true' : 'false'}`,
    `- 上次更新：${ticket.last_update}`,
    `- 滞留时间：${hours} 小时`,
    `- 审计类型：${auditType}`,
    ``,
    `## 审计要求`,
    `1. 检查该工单最新评论内容和时间`,
    `2. 确认当前状态是否合理（是否应该已经推进到下一阶段）`,
    `3. 确认 current_actor / override 责任链是否正确`,
    `4. 判断是否卡住、等待外部依赖、或已实际完成但未更新状态`,
    ``,
    `## 结果回传（不要直接调 transition / 不要直接手改状态）`,
    `请调用 POST /api/audits/${auditId}/result 回传结构化结果，JSON body 字段如下：`,
    ``,
    '```json',
    JSON.stringify({
      conclusion: auditType,
      suggested_status: ticket.status,
      suggested_actor: ticket.current_actor || ticket.assigned_agent || null,
      suggested_action: 'notify_only',
      reason: '一句话说明为什么要催办 / 人责链是否异常',
      confidence: 'medium',
      summary: '可选，给平台用于 comment / nudge 文案的补充摘要',
      author: 'sheeply',
    }, null, 2),
    '```',
    ``,
    `重要：你只负责审计判断并调用 result API，平台会统一写回评论并决定是否催办。`,
  ].join('\n');
}

function normalizeAuditChoice(rawValue, allowedValues, { required = false, field = 'value' } = {}) {
  const normalized = normalizeOptionalText(rawValue, 120)?.toLowerCase() ?? null;
  if (!normalized) {
    if (!required) return null;
    throw new Error(`${field} 不能为空`);
  }
  if (!allowedValues.has(normalized)) {
    throw new Error(`${field} 非法：${normalized}`);
  }
  return normalized;
}

function resolveAuditSuggestedStatus(rawValue) {
  const normalized = normalizeOptionalText(rawValue, 64)?.toLowerCase() ?? null;
  if (!normalized) return null;
  if (!TICKET_STATUSES.includes(normalized)) {
    throw new Error(`suggested_status 非法：${normalized}`);
  }
  return normalized;
}

function resolveAuditSuggestedActor(ticket, result = {}) {
  return normalizeOptionalAgent(result.suggested_actor)
    || normalizeOptionalAgent(ticket.current_actor)
    || normalizeOptionalAgent(ticket.assigned_agent)
    || normalizeOptionalAgent(ticket.review_owner)
    || normalizeOptionalAgent(ticket.decision_owner)
    || null;
}

function buildAuditResultCommentContent(ticket, auditResult) {
  return [
    `【审计回写】#${ticket.id} ${ticket.title}`,
    `审计类型：${auditResult.audit_type}`,
    `审计结论：${auditResult.conclusion}`,
    `建议状态：${auditResult.suggested_status || '无'}`,
    `建议下一责任人：${auditResult.suggested_actor || '无'}`,
    `建议动作：${auditResult.suggested_action || 'no_action'}`,
    `原因：${auditResult.reason || '未填写'}`,
    `置信度：${auditResult.confidence || 'unknown'}`,
    ...(auditResult.summary ? [`补充摘要：${auditResult.summary}`] : []),
  ].join('\n');
}

function buildQueuedStaleNudgeMessage({ ticket, agent, staleMinutes, nudgeLevel, slaMinutes }) {
  const assignment = store.findLatestAssignmentForTicket(ticket.id, agent);
  const waitingForWorker = ticket.dispatch_state === 'receipt_accepted'
    && ticket.last_dispatch_receipt_decision === 'accepted'
    && Boolean(ticket.execution_guard?.requires_worker)
    && !ticket.execution_guard?.has_active_execution_evidence;
  const base = [
    `⏰ [queued_stale 催办 ${nudgeLevel}]`,
    ``,
    `#${ticket.id} ${ticket.title}`,
    `状态：${ticket.status}`,
    `催办对象：${agent}`,
    `催办层级：${describeNudgeLevel(nudgeLevel, slaMinutes, staleMinutes)}`,
    `已滞留：${Math.round(staleMinutes)} 分钟（queued SLA ${slaMinutes} 分钟）`,
    ``,
    waitingForWorker
      ? `当前已接单成功，但仍未开工成功（receipt accepted 且暂无 worker / running 证据）。请尽快补齐开工前置条件；若无法开工，请明确回写 blocked / pending_decision / failed。`
      : `请尽快开工；如果无法开工，请先补评论说明原因，再按需要 transition。`,
  ];

  if (assignment) {
    base.push('', buildAgentDispatchMessage({ ticket, agent, assignment }));
  }

  return base.join('\n');
}

function buildAuditNudgeMessage({ ticket, agent, auditResult, staleMinutes, nudgeLevel, slaMinutes }) {
  const assignment = agent === ticket.assigned_agent
    ? store.findLatestAssignmentForTicket(ticket.id, agent)
    : null;
  const base = [
    `⏰ [audit_nudge 催办 ${nudgeLevel}]`,
    ``,
    `#${ticket.id} ${ticket.title}`,
    `当前状态：${ticket.status}`,
    `催办对象：${agent}`,
    `催办层级：${describeNudgeLevel(nudgeLevel, slaMinutes, staleMinutes)}`,
    `审计类型：${auditResult.audit_type}`,
    `审计结论：${auditResult.conclusion}`,
    `建议动作：${auditResult.suggested_action || 'no_action'}`,
    `建议状态：${auditResult.suggested_status || '无'}`,
    `建议下一责任人：${auditResult.suggested_actor || '无'}`,
    `原因：${auditResult.reason || '未填写'}`,
    ...(auditResult.summary ? [`补充摘要：${auditResult.summary}`] : []),
    ``,
    `这是平台根据 Sheeply 审计结果统一下发的催办，不代表系统已自动改状态。请先核实现场，再补评论/transition。`,
  ];

  if (assignment) {
    base.push('', buildAgentDispatchMessage({ ticket, agent, assignment }));
  }

  return base.join('\n');
}

function buildManualNudgeMessage({ ticket, agent }) {
  const assignment = agent === ticket.assigned_agent
    ? store.findLatestAssignmentForTicket(ticket.id, agent)
    : null;
  const base = [
    `⚡ [manual_nudge 催单]`,
    ``,
    `#${ticket.id} ${ticket.title}`,
    `当前状态：${ticket.status}`,
    `当前责任人：${ticket.current_actor || ticket.next_actor || agent || '未解析'}`,
    `催单对象：${agent}`,
    ``,
    `这是人工触发的一键催单，不会自动改状态。请先核实现场，并尽快补进展评论 / report / transition。`,
  ];

  if (assignment) {
    base.push('', buildAgentDispatchMessage({ ticket, agent, assignment }));
  }

  return base.join('\n');
}

function buildNotificationEventGovernance({ ticket, eventType, targetActor }) {
  const actor = targetActor || 'main';
  const isDecision = eventType === 'pending_decision';
  const isBlocked = eventType === 'blocked';
  const reason = isDecision
    ? 'decision_required'
    : isBlocked
      ? 'blocked_attention_required'
      : eventType === 'complete'
        ? 'execution_complete'
        : eventType === 'failed'
          ? 'execution_failed'
          : eventType;

  return {
    reason,
    dedupe_key: `notify:${ticket.status}:${reason}:${actor}`,
    escalation_tier: (isDecision || isBlocked) ? 'decision' : 'result',
  };
}

function buildNudgeReadyItem({
  ticket,
  agent,
  dispatchId,
  delivery,
  message,
  nudgeKey,
  nudgeSource,
  nudgeLevel = null,
  staleMinutes = null,
  auditResult = null,
}) {
  const governance = buildDispatchEventGovernance({
    ticket,
    agent,
    kind: 'nudge',
    nudgeSource,
    nudgeKey,
    nudgeLevel,
  });

  return {
    dispatch_id: dispatchId,
    agent,
    ticket_id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    next_actor: agent,
    execution_mode: ticket.execution_mode,
    worker_stats: ticket.worker_stats,
    kind: 'nudge',
    reason: governance.reason,
    dedupe_key: governance.dedupe_key,
    escalation_tier: governance.escalation_tier,
    nudge_key: nudgeKey,
    nudge_source: nudgeSource,
    nudge_level: nudgeLevel,
    nudge_window_minutes: TICKET_NUDGE_THROTTLE_MINUTES,
    ...(staleMinutes === null ? {} : { stale_minutes: Math.round(staleMinutes) }),
    ...(auditResult
      ? {
          audit_result: {
            audit_id: auditResult.audit_id,
            audit_type: auditResult.audit_type,
            stale_minutes: auditResult.stale_minutes ?? null,
            conclusion: auditResult.conclusion,
            suggested_status: auditResult.suggested_status,
            suggested_actor: auditResult.suggested_actor,
            suggested_action: auditResult.suggested_action,
            reason: auditResult.reason,
            confidence: auditResult.confidence,
            summary: auditResult.summary,
          },
        }
      : {}),
    ...delivery,
    message,
  };
}

function collectQueuedStaleNudges(allTickets) {
  const now = Date.now();
  const ready = [];

  for (const ticket of allTickets) {
    if (ticket.status !== 'queued') continue;
    if (ticket.execution_guard?.suppress_dispatch) continue;
    // 仅当「已接单且已真正开工」时跳过催办；接单但未开工（如 requires_worker 且无活跃执行证据）在阈值后仍进入 queued_stale 催办
    if (ticket.dispatch_state === 'receipt_accepted' && ticket.last_dispatch_receipt_decision === 'accepted') {
      const effectivelyStarted = !ticket.execution_guard?.requires_worker || ticket.execution_guard?.has_active_execution_evidence;
      if (effectivelyStarted) continue;
    }
    if (store.hasUnmetDependencies(ticket.id)) continue;

    const assignedAgent = normalizeOptionalAgent(ticket.assigned_agent || ticket.next_actor);
    if (!assignedAgent) continue;
    if (!dispatch.hasRecentDispatch(ticket.id, assignedAgent, 'queued', 30 * 24 * 60)) continue;

    const staleMinutes = computeTicketStaleMinutes(ticket, now);
    if (!Number.isFinite(staleMinutes) || staleMinutes < QUEUED_NUDGE_STALE_MINUTES) continue;

    const nudgeLevel = resolveNudgeLevel(ticket, staleMinutes);
    const slaMinutes = getTicketSlaMinutes(ticket);
    const rawDecisionOwner = typeof ticket.decision_owner === 'string' ? ticket.decision_owner.trim() : '';
    const targets = nudgeLevel === 'L3'
      ? dedupeActors([
          rawDecisionOwner || resolveRoleActor(ticket, 'decision_owner'),
          assignedAgent,
        ])
      : resolveNudgeTargets(ticket, nudgeLevel, { preferredActor: assignedAgent });
    if (!nudgeLevel || targets.length === 0) continue;

    const statusKey = buildTieredNudgeStatusKey('queued_stale', nudgeLevel);
    for (const agent of targets) {
      const delivery = resolveDispatchDelivery({ agent, ticketId: ticket.id, kind: 'nudge', nudgeSource: 'queued_stale' });
      const hasUnresolvedForward = dispatch.listPendingForwards({
        channel: 'telegram',
        unresolvedOnly: true,
        ticketId: ticket.id,
        limit: 50,
      }).some((row) => row.event_kind === 'dispatch_nudge'
        && row.target_session_key === delivery.target_session_key);
      if (!hasUnresolvedForward && dispatch.hasRecentDispatch(ticket.id, agent, statusKey, TICKET_NUDGE_THROTTLE_MINUTES)) continue;

      let dispatchId = dispatch.getUnackedDispatchEvent(ticket.id, agent, statusKey);
      if (!dispatchId) {
        dispatchId = dispatch.recordDispatchEvent(ticket.id, agent, statusKey);
      }

      ready.push(buildNudgeReadyItem({
        ticket,
        agent,
        dispatchId,
        delivery,
        message: buildQueuedStaleNudgeMessage({ ticket, agent, staleMinutes, nudgeLevel, slaMinutes }),
        nudgeKey: statusKey,
        nudgeSource: 'queued_stale',
        nudgeLevel,
        staleMinutes,
      }));
    }
  }

  return ready;
}

function collectAuditResultNudges(allTickets) {
  const targetTicketIds = new Set(allTickets.map((ticket) => Number(ticket.id)).filter(Number.isFinite));
  const latestByTicketId = new Map();
  for (const result of dispatch.listAuditResults({ limit: 2000 })) {
    const ticketId = Number(result.ticket_id);
    if (!targetTicketIds.has(ticketId)) continue;
    const existing = latestByTicketId.get(ticketId);
    if (!existing) {
      latestByTicketId.set(ticketId, result);
      continue;
    }
    const existingTs = Date.parse(existing.updated_at || existing.created_at || '') || 0;
    const resultTs = Date.parse(result.updated_at || result.created_at || '') || 0;
    if (resultTs > existingTs || (resultTs === existingTs && Number(result.id || 0) > Number(existing.id || 0))) {
      latestByTicketId.set(ticketId, result);
    }
  }

  const now = Date.now();
  const ready = [];
  for (const ticket of allTickets) {
    if (!['running', 'review', 'done'].includes(ticket.status)) continue;
    const auditResult = latestByTicketId.get(ticket.id);
    if (!auditResult) continue;
    if (auditResult.audit_type !== `stale_${ticket.status}`) continue;
    if (!AUDIT_NUDGEABLE_ACTIONS.has(auditResult.suggested_action || '')) continue;

    const rawStaleMinutes = Number.isFinite(Number(auditResult.stale_minutes))
      ? Number(auditResult.stale_minutes)
      : computeTicketStaleMinutes(ticket, now);
    const inferredStaleMinutes = Number.isFinite(rawStaleMinutes)
      ? rawStaleMinutes
      : Math.max(getTicketSlaMinutes(ticket), 0);
    if (!Number.isFinite(inferredStaleMinutes) || inferredStaleMinutes <= 0) continue;
    const nudgeLevel = resolveNudgeLevel(ticket, inferredStaleMinutes);
    console.log('[audit_result_nudge]', {
      ticket_id: ticket.id,
      audit_type: auditResult.audit_type,
      raw_stale_minutes: rawStaleMinutes,
      inferred_stale_minutes: inferredStaleMinutes,
      nudge_level: nudgeLevel,
      suggested_action: auditResult.suggested_action,
    });
    const slaMinutes = getTicketSlaMinutes(ticket);
    const preferredActor = resolveAuditSuggestedActor(ticket, auditResult);
    const targets = resolveNudgeTargets(ticket, nudgeLevel, { preferredActor });
    if (!nudgeLevel || targets.length === 0) continue;

    const statusKey = buildTieredNudgeStatusKey(`${auditResult.audit_type}_${auditResult.suggested_action}`, nudgeLevel);
    for (const agent of targets) {
      const delivery = resolveDispatchDelivery({ agent, ticketId: ticket.id, kind: 'nudge', nudgeSource: 'audit_result' });
      const hasUnresolvedForward = dispatch.listPendingForwards({
        channel: 'telegram',
        unresolvedOnly: true,
        ticketId: ticket.id,
        limit: 50,
      }).some((row) => row.event_kind === 'dispatch_nudge'
        && row.target_session_key === delivery.target_session_key);
      if (!hasUnresolvedForward && dispatch.hasRecentDispatch(ticket.id, agent, statusKey, TICKET_NUDGE_THROTTLE_MINUTES)) continue;

      let dispatchId = dispatch.getUnackedDispatchEvent(ticket.id, agent, statusKey);
      if (!dispatchId) {
        dispatchId = dispatch.recordDispatchEvent(ticket.id, agent, statusKey);
      }

      ready.push(buildNudgeReadyItem({
        ticket,
        agent,
        dispatchId,
        delivery,
        message: buildAuditNudgeMessage({ ticket, agent, auditResult, staleMinutes: inferredStaleMinutes, nudgeLevel, slaMinutes }),
        nudgeKey: statusKey,
        nudgeSource: 'audit_result',
        nudgeLevel,
        staleMinutes: inferredStaleMinutes,
        auditResult,
      }));
    }
  }

  return ready;
}

function collectManualNudges(allTickets) {
  const ticketById = new Map(allTickets.map((ticket) => [ticket.id, ticket]));
  const ready = [];

  for (const event of dispatch.listPendingDispatchEventsByStatusPrefix(MANUAL_NUDGE_STATUS_KEY, { limit: 200 })) {
    const ticket = ticketById.get(event.ticket_id);
    if (!ticket) continue;
    if (['complete', 'failed', 'deprecated'].includes(ticket.status)) continue;

    const liveActor = normalizeOptionalAgent(ticket.current_actor || ticket.next_actor || ticket.assigned_agent);
    if (!liveActor || liveActor !== event.agent) continue;
    if (dispatch.hasRecentDispatch(ticket.id, event.agent, MANUAL_NUDGE_STATUS_KEY, TICKET_NUDGE_THROTTLE_MINUTES)) continue;

    ready.push(buildNudgeReadyItem({
      ticket,
      agent: event.agent,
      dispatchId: event.id,
      delivery: resolveDispatchDelivery({ agent: event.agent, ticketId: ticket.id, kind: 'nudge', nudgeSource: 'manual' }),
      message: buildManualNudgeMessage({ ticket, agent: event.agent }),
      nudgeKey: MANUAL_NUDGE_STATUS_KEY,
      nudgeSource: 'manual',
      nudgeLevel: 'L1',
    }));
  }

  return ready;
}

function collectReadyNudges(allTickets) {
  return [
    ...collectQueuedStaleNudges(allTickets),
    ...collectAuditResultNudges(allTickets),
    ...collectManualNudges(allTickets),
  ].sort((a, b) => {
    const levelDiff = (NUDGE_LEVEL_ORDER[a.nudge_level] ?? 99) - (NUDGE_LEVEL_ORDER[b.nudge_level] ?? 99);
    if (levelDiff !== 0) return levelDiff;
    const staleDiff = Number(b.stale_minutes ?? 0) - Number(a.stale_minutes ?? 0);
    if (staleDiff !== 0) return staleDiff;
    return Number(a.ticket_id || 0) - Number(b.ticket_id || 0);
  });
}

app.get('/api/nudges/ready', (req, res) => {
  const requestId = getRequestId(req, res);
  const allTickets = store.getAllTickets().map(enrichTicketForApi);
  const ready = collectReadyNudges(allTickets).map((item) => ({
    ...item,
    request_id: requestId,
    dispatch_event_id: item.dispatch_id,
  }));
  return res.json({ request_id: requestId, ready });
});

// GET /api/audits/ready
// ?source=legacy|projection|compare (default: legacy). 审计只产 signal，双写 audit.signal.* 到 domain_events 并更新 audit_ready_projection。
app.get('/api/audits/ready', (req, res) => {
  const source = (req.query.source || 'legacy').toLowerCase();
  if (source === 'projection') {
    const projectionRows = store.getAuditReadyProjection();
    const ready = projectionRows.map((r) => {
      const ticket = enrichTicketForApi(store.getTicketById(r.ticket_id) || {});
      const staleMinutes = r.stale_minutes ?? 0;
      const contract = buildAuditRequestContract(ticket, r.audit_id, r.audit_type, staleMinutes);
      return {
        audit_id: r.audit_id,
        ticket_id: r.ticket_id,
        title: ticket.title ?? '',
        status: r.status ?? ticket.status,
        audit_type: r.audit_type,
        stale_minutes: Math.round(staleMinutes),
        target_session_key: contract?.target_session_key,
        contract,
        message: buildAuditMessage(ticket, r.audit_id, r.audit_type, staleMinutes),
      };
    });
    return res.json({ ready, _source: 'projection' });
  }

  const allTickets = store.getAllTickets().map(enrichTicketForApi);
  const now = Date.now();
  const retryWindowMs = AUDIT_REQUEST_RETRY_MINUTES * 60 * 1000;

  const ready = [];
  for (const ticket of allTickets) {
    if (ticket.status === 'deprecated') continue;
    const isQueuedAcceptedPendingStart = ticket.status === 'queued'
      && ticket.dispatch_state === 'receipt_accepted'
      && ticket.last_dispatch_receipt_decision === 'accepted'
      && Boolean(ticket.execution_guard?.requires_worker)
      && !ticket.execution_guard?.has_active_execution_evidence;

    const threshold = isQueuedAcceptedPendingStart
      ? AUDIT_STALE_QUEUED_AFTER_RECEIPT_MINUTES
      : AUDIT_THRESHOLDS[ticket.status];
    if (!threshold) continue;

    const staleMinutes = computeTicketStaleMinutes(ticket, now);
    if (!Number.isFinite(staleMinutes) || staleMinutes < threshold) continue;

    const auditType = isQueuedAcceptedPendingStart
      ? 'stale_queued_after_receipt'
      : `stale_${ticket.status}`;
    const latestResolvedAudit = dispatch.getLatestResolvedAudit(ticket.id, auditType);
    if (latestResolvedAudit) {
      const latestResolvedAt = Date.parse(latestResolvedAudit.created_at || '');
      const cycleAnchorAt = Date.parse(ticket.last_update || '');
      const lastReceiptAt = Date.parse(ticket.last_dispatch_receipt_at || '');
      const isFreshQueuedCycle = (auditType === 'stale_queued'
        && Number.isFinite(latestResolvedAt)
        && Number.isFinite(cycleAnchorAt)
        && latestResolvedAt < cycleAnchorAt)
        || (auditType === 'stale_queued_after_receipt'
          && Number.isFinite(lastReceiptAt)
          && Number.isFinite(latestResolvedAt)
          && lastReceiptAt > latestResolvedAt);
      if (!isFreshQueuedCycle && dispatch.hasResolvedAudit(ticket.id, auditType)) continue;
    }

    const pendingAudit = dispatch.getPendingAuditEvent(ticket.id, auditType);
    if (pendingAudit?.acked_at) {
      const ackedAtTs = Date.parse(pendingAudit.acked_at || '');
      if (Number.isFinite(ackedAtTs) && (now - ackedAtTs) < retryWindowMs) {
        continue;
      }
    }

    const auditId = pendingAudit?.id || dispatch.recordAuditEvent(ticket.id, auditType, ticket.status);
    const contract = buildAuditRequestContract(ticket, auditId, auditType, staleMinutes);

    const item = {
      audit_id: auditId,
      ticket_id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      audit_type: auditType,
      stale_minutes: Math.round(staleMinutes),
      target_session_key: contract.target_session_key,
      contract,
      message: buildAuditMessage(ticket, auditId, auditType, staleMinutes),
    };
    ready.push(item);

    store.appendDomainEvent({
      event_type: `audit.${auditType}_detected`,
      aggregate_type: 'ticket',
      aggregate_id: String(ticket.id),
      aggregate_version: store.getAggregateVersion('ticket', String(ticket.id)) + 1,
      producer: 'audit-engine',
      correlation_id: `ticket-${ticket.id}`,
      causation_id: null,
      idempotency_key: `audit-${ticket.id}-${auditType}-${auditId}`,
      payload: {
        ticket_id: ticket.id,
        audit_type: auditType,
        suggested_status: ticket.status,
        suggested_actor: ticket.assigned_agent ?? ticket.review_owner,
        reason: `stale ${staleMinutes} min`,
        confidence: 'medium',
      },
      occurred_at: new Date().toISOString(),
    });
  }

  store.replaceAllAuditReadyProjection(ready.map((r) => ({ ticket_id: r.ticket_id, audit_id: r.audit_id, audit_type: r.audit_type, status: r.status, stale_minutes: r.stale_minutes })));
  if (source === 'compare') {
    const projectionBefore = store.getAuditReadyProjection();
    return res.json({
      ready,
      _source: 'compare',
      _compare: { legacy_count: ready.length, projection_count: projectionBefore.length, projection: projectionBefore },
    });
  }
  res.json({ ready });
});

function resolveAuditId(req) {
  return (
    parsePositiveInt(req.params?.id)
    || parsePositiveInt(req.body?.audit_id)
    || parsePositiveInt(req.body?.id)
    || parsePositiveInt(req.query?.audit_id)
  );
}

// POST /api/audits/:id/ack
app.post('/api/audits/:id/ack', (req, res) => {
  const auditId = resolveAuditId(req);
  if (!auditId) {
    return res.status(400).json({ error: 'Bad request', message: 'audit_id 必须是正整数' });
  }
  const ok = dispatch.ackAuditEvent(auditId);
  if (!ok) {
    return res.status(404).json({ error: 'Not found', message: `audit_id ${auditId} 不存在` });
  }
  res.json({ success: true, audit_id: auditId });
});

// POST /api/audits/:id/result
app.post('/api/audits/:id/result', (req, res) => {
  const auditId = resolveAuditId(req);
  if (!auditId) {
    return res.status(400).json({ error: 'Bad request', message: 'audit_id 必须是正整数' });
  }

  const auditEvent = dispatch.getAuditEventById(auditId);
  if (!auditEvent) {
    return res.status(404).json({ error: 'Not found', message: `audit_id ${auditId} 不存在` });
  }

  const ticket = enrichTicketForApi(store.getTicketById(auditEvent.ticket_id));
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: `audit_id ${auditId} 对应 ticket 不存在` });
  }

  const existing = dispatch.getAuditResultByAuditId(auditId);
  if (existing) {
    return res.json({ success: true, audit_id: auditId, deduped: true, result: existing });
  }

  let conclusion;
  let suggestedAction;
  let confidence;
  let suggestedStatus;
  try {
    conclusion = normalizeAuditChoice(
      req.body?.conclusion ?? req.body?.audit_conclusion,
      AUDIT_RESULT_ALLOWED_CONCLUSIONS,
      { required: true, field: 'conclusion' },
    );
    suggestedAction = normalizeAuditChoice(
      req.body?.suggested_action ?? req.body?.recommended_action,
      AUDIT_RESULT_ALLOWED_ACTIONS,
      { required: true, field: 'suggested_action' },
    );
    confidence = normalizeAuditChoice(
      req.body?.confidence,
      AUDIT_RESULT_ALLOWED_CONFIDENCE,
      { required: true, field: 'confidence' },
    );
    suggestedStatus = resolveAuditSuggestedStatus(req.body?.suggested_status ?? req.body?.recommended_status);
  } catch (err) {
    return res.status(400).json({ error: 'Bad request', message: err?.message || 'audit result 参数非法' });
  }

  const suggestedActor = normalizeOptionalAgent(
    req.body?.suggested_actor
    ?? req.body?.suggested_next_actor
    ?? req.body?.recommended_actor,
  );
  const reason = normalizeOptionalText(req.body?.reason, 4000);
  const summary = normalizeOptionalText(req.body?.summary, 4000);
  const author = normalizeOptionalAgent(req.body?.author) || 'sheeply';
  const staleMinutesAtAudit = computeTicketStaleMinutes(ticket);

  const comment = {
    id: buildCommentId(),
    author,
    timestamp: new Date().toISOString(),
    content: buildAuditResultCommentContent(ticket, {
      audit_type: auditEvent.audit_type,
      conclusion,
      suggested_status: suggestedStatus,
      suggested_actor: suggestedActor,
      suggested_action: suggestedAction,
      reason,
      confidence,
      summary,
    }),
    type: 'system',
    visibility: 'internal',
    thread_id: null,
    mentions: [],
    metadata: {
      source: 'audit_result',
      audit_id: auditId,
      audit_type: auditEvent.audit_type,
      conclusion,
      suggested_status: suggestedStatus,
      suggested_actor: suggestedActor,
      suggested_action: suggestedAction,
      confidence,
    },
  };
  persistTicketComment(ticket.id, comment, { preserveAudit: true });

  const result = dispatch.recordAuditResult({
    auditId,
    ticketId: ticket.id,
    auditType: auditEvent.audit_type,
    statusSnapshot: auditEvent.status_snapshot,
    staleMinutes: staleMinutesAtAudit,
    conclusion,
    suggestedStatus,
    suggestedActor,
    suggestedAction,
    reason,
    confidence,
    summary,
    commentId: String(comment.id),
    rawPayload: req.body && typeof req.body === 'object' ? req.body : {},
  });

  return res.status(201).json({
    success: true,
    audit_id: auditId,
    ticket_id: ticket.id,
    result,
  });
});

// POST /api/admin/ticket-sessions/cleanup - 独立 ticket session 安全清理（默认 dry-run）
app.post('/api/admin/ticket-sessions/cleanup', async (req, res) => {
  const retentionDays = req.body?.retention_days ?? req.body?.retentionDays;
  const cleanupStatuses = req.body?.cleanup_statuses ?? req.body?.cleanupStatuses;
  const dryRun = req.body?.dry_run !== false && req.body?.enforce !== true;

  try {
    const result = dryRun
      ? previewTicketSessionCleanup({ retentionDays, cleanupStatuses })
      : await runTicketSessionCleanup({ retentionDays, cleanupStatuses });
    res.json(result);
  } catch (err) {
    console.error('[API] ticket session cleanup 失败:', err?.message || err);
    res.status(500).json({ error: 'Ticket session cleanup failed', message: err?.message || 'unknown error' });
  }
});

// POST /api/tickets/:id/transition - 状态转换接口（强制）
app.post('/api/tickets/:id/transition', (req, res) => {
  const id = req.params.id;
  const { action, actor, comment, ...fields } = req.body || {};

  if (!action) {
    return res.status(400).json({
      error: 'Missing action',
      message: '必须指定 action',
      available_actions: Object.keys(TRANSITIONS)
    });
  }

  const previousTicket = store.getTicketById(id);
  if (!previousTicket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }
  const oldStatus = previousTicket.status;
  const resolvedActor = resolveActionActor(enrichTicketForApi(previousTicket), action, actor);
  if (!resolvedActor) {
    return res.status(400).json({
      error: 'Missing actor',
      message: '必须指定 actor（执行此操作的 agent）'
    });
  }

  if (action === 'reset_to_queued') {
    const reason = normalizeOptionalText(req.body?.reason ?? req.body?.reset_reason, 4000);
    if (!reason) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'reason 不能为空',
        required_fields: ['actor', 'reason'],
      });
    }
    fields.reason = reason;
  }

  // 执行状态转换
  const result = transition(Number(id), action, { actor: resolvedActor, ...fields });

  if (!result.success) {
    const statusCode = Number(result.statusCode || 400);
    return res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 400).json(result);
  }

  // 广播状态变化
  if (oldStatus !== result.ticket.status) {
    broadcastTicketStatusChanged(result.ticket, oldStatus, result.ticket.status);
  }

  appendTransitionAuditComment(id, {
    action,
    actor: resolvedActor,
    oldStatus,
    newStatus: result.ticket.status,
    comment,
    fields,
  });

  const updated = store.getTicketById(id);
  res.json({
    success: true,
    ticket: formatTicketForList(updated),
    message: `状态已从 ${oldStatus} 转换为 ${updated.status}`
  });
});

// GET /api/workflow/schema - 输出 workflow 单一真相源 contract
app.get('/api/workflow/schema', (_req, res) => {
  res.json({ data: getWorkflowSchema() });
});

// GET /api/playbooks/:stage - 当前 stage 的结构化 SOP / gate checklist
app.get('/api/playbooks/:stage', (req, res) => {
  const stage = String(req.params.stage || '').trim().toLowerCase();
  const mode = String(req.query.mode || '').trim().toLowerCase() || null;
  const role = String(req.query.role || '').trim().toLowerCase() || null;
  const snapshot = buildPlaybookStageSnapshot(stage, { mode, role });

  if (!snapshot) {
    return res.status(404).json({ error: 'Playbook stage not found', message: `stage ${req.params.stage} 不存在` });
  }

  return res.json({ data: snapshot });
});

// GET /api/live-acceptance/tickets/:id - reviewer/read-only live acceptance gate
app.get('/api/live-acceptance/tickets/:id', (req, res) => {
  const id = Number(req.params.id);
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }

  const gate = buildLiveAcceptanceGate(ticket, {
    enrichTicketForApi,
    expectedBundleVersion: req.query.expected_bundle_version,
    expectedBundleChecksum: req.query.expected_bundle_checksum,
    requiredTicketActions: req.query.required_ticket_actions,
    requiredBootstrapEndpoints: req.query.required_bootstrap_endpoints,
    requiredWorkboards: req.query.required_workboards,
  });

  return res.json({ data: gate });
});

// Admin management API（canonical: /api/v1/admin；legacy alias: /api/admin）
const adminRouter = express.Router();

// Agent-facing API（canonical: /api/v1/agent；legacy alias: /api/agent）
const agentRouter = express.Router();

// GET /workflow/schema - 输出 agent-facing workflow contract
agentRouter.get('/workflow/schema', (_req, res) => {
  res.json({ data: buildAgentWorkflowSchema() });
});

// GET /skills/current - 输出当前平台托管 skill/playbook bundle
agentRouter.get('/skills/current', (_req, res) => {
  res.json({ data: buildCurrentAgentSkillBundle() });
});

// GET /playbooks/:key - 通过 key 拉取指定 playbook bundle
agentRouter.get('/playbooks/:key', (req, res) => {
  if (String(req.params.key || '').trim() !== AGENT_PLAYBOOK_KEY) {
    return sendAgentError(req, res, 404, { error: 'Not found', detail: `playbook ${req.params.key} 不存在` });
  }
  return res.json({ data: buildCurrentAgentSkillBundle() });
});

// POST /tickets - agent-facing 创建工单
agentRouter.post('/tickets', (req, res) => {
  const actorCheck = validateAgentFacingActor(req.body?.actor ?? req.body?.agent_id);
  if (!actorCheck.ok) {
    return sendAgentError(req, res, actorCheck.status, actorCheck.body);
  }

  const prepared = prepareTicketCreatePayload(req.body, { agentFacing: true, actor: actorCheck.actor });
  if (!prepared.ok) {
    return sendAgentError(req, res, prepared.status, prepared.body);
  }

  const ticket = store.createTicket(prepared.payload);
  return res.status(201).json({
    success: true,
    action: 'create',
    ticket: formatTicketForList(ticket),
    available_actions: getAvailableActions(ticket.id),
  });
});

getAgentTicketActionRouteBindings().forEach((binding) => {
  agentRouter.post(binding.route_path, (req, res) => runAgentTicketAction(req, res, binding.action));
});

// GET /workboards/stock-tickets - 股票平台全局盘面
agentRouter.get('/workboards/stock-tickets', (req, res) => {
  const groupBy = String(req.query.group_by || 'none').trim() || 'none';
  const sort = String(req.query.sort || 'updated_desc').trim() || 'updated_desc';
  const allowedGroupBy = ['none', 'status', 'bucket', 'assigned_agent', 'current_actor', 'review_owner', 'parent_ticket_id'];
  const allowedSort = ['updated_desc', 'created_desc', 'priority_desc', 'priority_asc', 'status_order', 'id_desc'];

  if (!allowedGroupBy.includes(groupBy)) {
    return sendAgentError(req, res, 400, {
      error: 'Bad request',
      detail: `group_by 非法：${groupBy}`,
      allowed_group_by: allowedGroupBy,
    });
  }

  if (!allowedSort.includes(sort)) {
    return sendAgentError(req, res, 400, {
      error: 'Bad request',
      detail: `sort 非法：${sort}`,
      allowed_sort: allowedSort,
    });
  }

  const normalizedParent = normalizeParentTicketId(req.query.parent_ticket_id);
  if (!normalizedParent.ok) {
    return sendAgentError(req, res, 400, { error: 'Bad request', detail: normalizedParent.message });
  }

  const limit = normalizePaginationNumber(req.query.limit, { defaultValue: 50, min: 1, max: 200 });
  const offset = normalizePaginationNumber(req.query.offset, { defaultValue: 0, min: 0, max: 100000 });
  const workboardSpec = buildAgentWorkboards({ apiBaseUrl: getAgentApiBaseUrl() }).find((item) => item.key === 'stock-tickets');

  const allStockItems = store.getAllTickets()
    .map((ticket) => store.getTicketById(ticket.id) || ticket)
    .map((ticket) => enrichTicketForApi(ticket))
    .filter((ticket) => ticket.platform === 'stock-platform')
    .map((ticket) => {
      const dependencyCount = store.getDependencies(ticket.id).length;
      return buildWorkboardItem(ticket, dependencyCount);
    })
    .filter((item) => matchesStockWorkboardFilters(item, req.query));

  const sortedItems = sortStockWorkboardItems(allStockItems, sort);
  const pageItems = sortedItems.slice(offset, offset + limit);

  return res.json({
    data: {
      api_version: AGENT_API_VERSION,
      schema_version: AGENT_SCHEMA_VERSION,
      workboard_key: 'stock-tickets',
      title: workboardSpec?.title || 'Stock Platform Workboard',
      summary: buildStockWorkboardSummary(allStockItems),
      filters: {
        platform: 'stock-platform',
        status: parseCsvParam(req.query.status),
        bucket: parseCsvParam(req.query.bucket),
        assigned_agent: normalizeOptionalAgent(req.query.assigned_agent) || null,
        current_actor: normalizeOptionalAgent(req.query.current_actor) || null,
        review_owner: normalizeOptionalAgent(req.query.review_owner) || null,
        has_dependencies: normalizeBooleanQuery(req.query.has_dependencies),
        parent_ticket_id: normalizedParent.value === undefined ? null : normalizedParent.value,
        group_by: groupBy,
        sort,
      },
      pagination: {
        total: sortedItems.length,
        limit,
        offset,
        returned: pageItems.length,
        has_more: offset + pageItems.length < sortedItems.length,
      },
      supported_query_params: workboardSpec?.supported_query_params || [],
      items: groupBy === 'none' ? pageItems : [],
      groups: groupBy === 'none' ? [] : buildStockWorkboardGroups(pageItems, groupBy),
      generated_at: new Date().toISOString(),
    },
  });
});

// GET /runtime/context - 输出 agent-facing runtime context
agentRouter.get('/runtime/context', (req, res) => {
  const assignmentId = String(req.query.assignment_id || '').trim();
  if (!assignmentId) {
    return res.json({ data: buildRuntimeContext() });
  }

  const assignment = store.getAssignmentById(assignmentId);
  if (!assignment) {
    return sendAgentError(req, res, 404, { error: 'Assignment not found', detail: 'assignment 不存在' });
  }

  const token = resolveAssignmentToken(req);
  if (!token || token !== assignment.assignment_token) {
    return sendAgentError(req, res, 401, { error: 'Unauthorized', detail: 'assignment_token 无效或缺失' });
  }

  return res.json({ data: buildRuntimeContext({ assignment }) });
});

// GET /participants - v2 bootstrap participant registry skeleton
agentRouter.get('/participants', (req, res) => {
  const registry = buildParticipantRegistrySnapshot();
  const platformId = normalizeOptionalText(req.query.platform_id, 120) || null;
  const participantId = normalizeOptionalAgent(req.query.participant_id) || null;
  const roleKey = normalizeOptionalText(req.query.role_key, 120) || null;

  let participants = registry.participants;
  if (platformId) {
    const platform = registry.platforms.find((item) => item.platform_id === platformId) || null;
    if (platform) {
      const allowed = new Set([
        platform.owner_agent_id,
        platform.triage_owner_agent_id,
        platform.review_owner_agent_id,
        ...(platform.development_agent_ids || []),
        ...(platform.audit_agent_ids || []),
      ].filter(Boolean));
      participants = participants.filter((item) => allowed.has(item.participant_id) || item.primary_platform === platformId);
    } else {
      participants = [];
    }
  }
  if (participantId) {
    participants = participants.filter((item) => item.participant_id === participantId);
  }
  if (roleKey) {
    participants = participants.filter((item) => item.platform_roles.includes(roleKey) || item.responsibilities.includes(roleKey));
  }

  return res.json({
    data: {
      ...registry,
      participants,
      summary: {
        ...registry.summary,
        filtered_participants: participants.length,
      },
      query: {
        platform_id: platformId,
        participant_id: participantId,
        role_key: roleKey,
      },
    },
  });
});

// GET /participants/:participant_id - 单 participant 详情
agentRouter.get('/participants/:participant_id', (req, res) => {
  const participantId = normalizeOptionalAgent(req.params.participant_id);
  const participant = participantId ? getParticipantById(participantId) : null;
  if (!participant) {
    return sendAgentError(req, res, 404, { error: 'Participant not found', detail: 'participant 不存在' });
  }
  return res.json({ data: participant });
});

// GET /routing/resolve - participant-based routing skeleton
agentRouter.get('/routing/resolve', (req, res) => {
  const route = resolveParticipantRoute({
    participant_id: req.query.participant_id,
    role_key: req.query.role_key,
    platform_id: req.query.platform_id,
    reason: req.query.reason,
    intent: req.query.intent,
    capability: req.query.capability,
    session_kind: req.query.session_kind,
    ticket_id: req.query.ticket_id,
  });
  return res.json({ data: route });
});

// GET /assignments/:assignment_id - 获取 assignment 详情
agentRouter.get('/assignments/:assignment_id', (req, res) => {
  const access = loadAssignmentAccess(req, res);
  if (!access) return;
  res.json(buildAssignmentContract(access.assignment, access.ticket));
});

// GET /assignments/:assignment_id/dependencies - 获取 assignment 依赖
agentRouter.get('/assignments/:assignment_id/dependencies', (req, res) => {
  const access = loadAssignmentAccess(req, res);
  if (!access) return;

  const dependencies = store.getDependencies(access.ticket.id).map((dep) => {
    const depTicket = enrichTicketForApi(store.getTicketById(dep.depends_on_ticket_id) || {
      id: dep.depends_on_ticket_id,
      title: dep.title,
      status: dep.status,
      comments: [],
    });
    return buildDependencySnapshot(access.ticket, 'depends_on', depTicket, dep.dependency_type || 'blocks');
  });

  const parents = access.ticket.parent_ticket
    ? [buildDependencySnapshot(access.ticket, 'parent', enrichTicketForApi(store.getTicketById(access.ticket.parent_ticket.id) || access.ticket.parent_ticket), 'relates_to')]
    : [];
  const children = (access.ticket.child_tickets || []).map((child) => (
    buildDependencySnapshot(access.ticket, 'child', enrichTicketForApi(store.getTicketById(child.id) || child), 'relates_to')
  ));
  const related = (access.ticket.ticket_relations || []).map((relation) => {
    const targetTicket = enrichTicketForApi(store.getTicketById(relation.ticket?.id) || relation.ticket || {});
    const snapshot = buildDependencySnapshot(access.ticket, relation.direction, targetTicket, relation.relation_type);
    return {
      ...snapshot,
      relation_label: relation.relation_label,
      stale_hint: getStaleDeliveryHint(access.ticket, 'notification'),
    };
  });

  res.json({
    api_version: AGENT_API_VERSION,
    schema_version: AGENT_SCHEMA_VERSION,
    assignment_id: access.assignment.assignment_id,
    ticket_id: access.ticket.id,
    dependencies,
    parents,
    children,
    related,
  });
});

// GET /assignments/:assignment_id/comments - 获取 assignment 评论流
agentRouter.get('/assignments/:assignment_id/comments', (req, res) => {
  const access = loadAssignmentAccess(req, res);
  if (!access) return;

  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '20'), 10) || 20));
  const cursor = Number.parseInt(String(req.query.cursor || ''), 10);
  let comments = (access.ticket.comments || []).map((comment) => ({
    ...normalizeComment(comment),
    actor_role: classifyCommentActor(comment, access.ticket, access.assignment),
  }));

  if (Number.isInteger(cursor) && cursor > 0) {
    comments = comments.filter((comment) => Number(comment.id) > cursor);
  } else if (comments.length > limit) {
    comments = comments.slice(-limit);
  }

  res.json({
    api_version: AGENT_API_VERSION,
    schema_version: AGENT_SCHEMA_VERSION,
    assignment_id: access.assignment.assignment_id,
    ticket_id: access.ticket.id,
    total: comments.length,
    cursor: comments.length > 0 ? comments[comments.length - 1].id : null,
    comments,
  });
});

// GET /assignments/:assignment_id/live-acceptance - reviewer 可消费的 live acceptance verdict
agentRouter.get('/assignments/:assignment_id/live-acceptance', (req, res) => {
  const access = loadAssignmentAccess(req, res);
  if (!access) return;

  const verdict = buildAssignmentLiveAcceptanceVerdict({
    assignment: access.assignment,
    ticket: access.ticket,
    expected: {
      bundle_version: req.query.expected_bundle_version,
      bundle_checksum_sha256: req.query.expected_bundle_checksum_sha256,
      workflow_schema_version: req.query.expected_workflow_schema_version,
      api_base_url: req.query.expected_api_base_url,
    },
  });

  res.json({
    api_version: AGENT_API_VERSION,
    schema_version: AGENT_SCHEMA_VERSION,
    ...verdict,
  });
});

// POST /assignments/:assignment_id/heartbeat - assignment 心跳
agentRouter.post('/assignments/:assignment_id/heartbeat', (req, res) => {
  const access = loadAssignmentAccess(req, res);
  if (!access) return;

  const validation = validateAssignmentWrite({
    assignment: access.assignment,
    ticket: access.ticket,
    kind: 'heartbeat',
    appendAudit: (audit) => store.appendValidationAudit(audit),
    latestAssignment: store.findLatestAssignmentForTicket(access.ticket.id, access.assignment.agent_id),
  });
  if (!validation.ok) {
    return sendAgentError(req, res, validation.status, {
      code: validation.code,
      message: validation.message,
      validation_audit_id: validation.audit?.id ?? null,
      machine_readable: validation.machine_readable,
    });
  }

  try {
    const result = store.recordAssignmentHeartbeat(access.assignment.assignment_id, {
      idempotency_key: req.body?.idempotency_key,
      progress: req.body?.progress,
    });
    res.status(result.idempotent ? 200 : 201).json({
      accepted: true,
      idempotent: result.idempotent,
      assignment_id: access.assignment.assignment_id,
      assignment_status: result.assignment?.assignment_status || access.assignment.assignment_status,
      heartbeat: result.heartbeat,
      validation_audit_id: validation.audit?.id ?? null,
    });
  } catch (err) {
    handleExecutionStoreError(res, err, req);
  }
});

// POST /assignments/:assignment_id/reports - 提交结构化 report
agentRouter.post('/assignments/:assignment_id/reports', (req, res) => {
  const access = loadAssignmentAccess(req, res);
  if (!access) return;

  const reportType = String(req.body?.report_type || '').trim();
  if (!AGENT_REPORT_TYPES.includes(reportType)) {
    return sendAgentError(req, res, 400, {
      error: 'Bad request',
      detail: `report_type 非法：${reportType || '(empty)'}`,
      allowed_report_types: AGENT_REPORT_TYPES,
    });
  }

  const payload = { ...req.body };
  delete payload.assignment_token;
  delete payload.report_type;
  delete payload.idempotency_key;

  const validation = validateAssignmentWrite({
    assignment: access.assignment,
    ticket: access.ticket,
    kind: 'report',
    reportType,
    payload,
    appendAudit: (audit) => store.appendValidationAudit(audit),
    latestAssignment: store.findLatestAssignmentForTicket(access.ticket.id, access.assignment.agent_id),
  });
  if (!validation.ok) {
    return sendAgentError(req, res, validation.status, {
      code: validation.code,
      message: validation.message,
      validation_audit_id: validation.audit?.id ?? null,
      machine_readable: validation.machine_readable,
    });
  }

  try {
    const created = store.createAssignmentReport(access.assignment.assignment_id, {
      report_type: reportType,
      idempotency_key: req.body?.idempotency_key,
      payload,
    });

    if (created.idempotent) {
      return res.json({
        accepted: true,
        idempotent: true,
        report_id: created.report?.report_id,
        assignment_id: access.assignment.assignment_id,
        assignment_status: created.assignment?.assignment_status || access.assignment.assignment_status,
        interpreter_preview: created.report?.interpreter_result?.transition_preview || null,
        interpreter_result: created.report?.interpreter_result || {},
        validation_audit_id: validation.audit?.id ?? null,
      });
    }

    const interpreterResult = interpretAgentReport({
      assignment: access.assignment,
      ticket: access.ticket,
      reportType,
      payload,
    });
    const finalized = store.finalizeAssignmentReport(access.assignment.assignment_id, req.body?.idempotency_key, {
      interpreter_result: interpreterResult,
      assignment_status: interpreterResult.assignment_status,
      latest_progress: interpreterResult.latest_progress || undefined,
    });
    const updatedAssignment = store.getAssignmentById(access.assignment.assignment_id);

    return res.status(201).json({
      accepted: true,
      idempotent: false,
      report_id: finalized?.report_id,
      assignment_id: access.assignment.assignment_id,
      assignment_status: updatedAssignment?.assignment_status || interpreterResult.assignment_status,
      interpreter_preview: interpreterResult.transition_preview,
      interpreter_result: interpreterResult,
      validation_audit_id: validation.audit?.id ?? null,
    });
  } catch (err) {
    return handleExecutionStoreError(res, err, req);
  }
});

function buildAgentAdminCreateAuditComment(ticket, grant, payload = {}) {
  const explicitOwners = [
    payload.triage_owner ? `triage_owner=${payload.triage_owner}` : null,
    payload.assigned_agent ? `assigned_agent=${payload.assigned_agent}` : null,
    payload.review_owner ? `review_owner=${payload.review_owner}` : null,
  ].filter(Boolean);

  return {
    id: buildCommentId(),
    author: grant.agent_id,
    timestamp: new Date().toISOString(),
    content: [
      '通过 control-ui stock admin 创建工单。',
      explicitOwners.length > 0
        ? `显式责任链：${explicitOwners.join(' / ')}`
        : '责任链：未显式指定，已按 stock-platform 默认路由。',
    ].join('\n'),
    type: 'system',
    visibility: 'internal',
    thread_id: null,
    mentions: [],
    metadata: {
      source: 'control-ui-stock-admin',
      actor_role: 'agent_admin',
      actor: grant.agent_id,
      explicit_triage_owner: payload.triage_owner || null,
      explicit_assigned_agent: payload.assigned_agent || null,
      explicit_review_owner: payload.review_owner || null,
      platform: ticket.platform || null,
      ticket_id: ticket.id,
    },
  };
}

adminRouter.get('/stock-tickets', (req, res) => {
  const grant = requireAgentAdminGrant(req, res, 'stock_tickets:read');
  if (!grant) return;

  const groupBy = String(req.query.group_by || 'none').trim() || 'none';
  const sort = String(req.query.sort || 'updated_desc').trim() || 'updated_desc';
  const allowedGroupBy = ['none', 'status', 'bucket', 'assigned_agent', 'current_actor', 'review_owner', 'parent_ticket_id'];
  const allowedSort = ['updated_desc', 'created_desc', 'priority_desc', 'priority_asc', 'status_order', 'id_desc'];

  if (!allowedGroupBy.includes(groupBy)) {
    return sendAgentError(req, res, 400, {
      error: 'Bad request',
      detail: `group_by 非法：${groupBy}`,
      allowed_group_by: allowedGroupBy,
    });
  }

  if (!allowedSort.includes(sort)) {
    return sendAgentError(req, res, 400, {
      error: 'Bad request',
      detail: `sort 非法：${sort}`,
      allowed_sort: allowedSort,
    });
  }

  const normalizedParent = normalizeParentTicketId(req.query.parent_ticket_id);
  if (!normalizedParent.ok) {
    return sendAgentError(req, res, 400, { error: 'Bad request', detail: normalizedParent.message });
  }

  const limit = normalizePaginationNumber(req.query.limit, { defaultValue: 50, min: 1, max: 200 });
  const offset = normalizePaginationNumber(req.query.offset, { defaultValue: 0, min: 0, max: 100000 });
  const allStockItems = store.getAllTickets()
    .map((ticket) => enrichTicketForApi(ticket))
    .filter((ticket) => ticket.platform === 'stock-platform')
    .map((ticket) => {
      const dependencyCount = store.getDependencies(ticket.id).length;
      return buildWorkboardItem(ticket, dependencyCount);
    })
    .filter((item) => matchesStockWorkboardFilters(item, req.query));

  const sortedItems = sortStockWorkboardItems(allStockItems, sort);
  const pageItems = sortedItems.slice(offset, offset + limit);

  return res.json({
    data: {
      api_version: AGENT_API_VERSION,
      schema_version: AGENT_SCHEMA_VERSION,
      auth: {
        role: 'agent_admin',
        agent_id: grant.agent_id,
        capabilities: grant.capabilities,
        contract: buildAgentAdminAuthContract(),
        error_model: buildAgentAdminErrorModel(),
      },
      workboard_key: 'stock-tickets-admin',
      title: 'Stock Tickets Admin Workboard',
      summary: buildStockWorkboardSummary(allStockItems),
      filters: {
        platform: 'stock-platform',
        status: parseCsvParam(req.query.status),
        bucket: parseCsvParam(req.query.bucket),
        assigned_agent: normalizeOptionalAgent(req.query.assigned_agent) || null,
        current_actor: normalizeOptionalAgent(req.query.current_actor) || null,
        review_owner: normalizeOptionalAgent(req.query.review_owner) || null,
        has_dependencies: normalizeBooleanQuery(req.query.has_dependencies),
        parent_ticket_id: normalizedParent.value === undefined ? null : normalizedParent.value,
        group_by: groupBy,
        sort,
      },
      pagination: {
        total: sortedItems.length,
        limit,
        offset,
        returned: pageItems.length,
        has_more: offset + pageItems.length < sortedItems.length,
      },
      items: groupBy === 'none' ? pageItems : [],
      groups: groupBy === 'none' ? [] : buildStockWorkboardGroups(pageItems, groupBy),
      generated_at: new Date().toISOString(),
    },
  });
});

adminRouter.post('/stock-tickets', (req, res) => {
  const grant = requireAgentAdminGrant(req, res, 'stock_tickets:create');
  if (!grant) return;

  const requestedPlatform = normalizeOptionalText(req.body?.platform, 120);
  if (requestedPlatform && requestedPlatform !== 'stock-platform') {
    return sendAgentError(req, res, 403, {
      error: 'AGENT_ADMIN_SCOPE_FORBIDDEN',
      detail: '当前 agent-admin create 仅允许创建 stock-platform 工单',
      platform: requestedPlatform,
      allowed_platforms: ['stock-platform'],
    });
  }

  const prepared = prepareTicketCreatePayload({
    ...req.body,
    platform: 'stock-platform',
  });
  if (!prepared.ok) {
    return sendAgentError(req, res, prepared.status, prepared.body);
  }

  const ticket = store.createTicket(prepared.payload);
  const auditComment = buildAgentAdminCreateAuditComment(ticket, grant, {
    triage_owner: normalizeOptionalAgent(req.body?.triage_owner),
    assigned_agent: normalizeOptionalAgent(req.body?.assigned_agent ?? req.body?.agent),
    review_owner: normalizeOptionalAgent(req.body?.review_owner),
  });
  persistTicketComment(ticket.id, auditComment, { preserveAudit: true });

  return res.status(201).json({
    success: true,
    ticket: formatTicketForList(store.getTicketById(ticket.id) || ticket),
    audit_comment: auditComment,
    auth: {
      role: 'agent_admin',
      agent_id: grant.agent_id,
      capabilities: grant.capabilities,
    },
  });
});

adminRouter.get('/stock-tickets/:id', (req, res) => {
  const access = loadStockAdminTicket(req, res, 'stock_tickets:read');
  if (!access) return;

  return res.json({
    data: {
      ticket: formatTicketForList(access.ticket),
      available_actions: getAvailableActions(access.ticket.id),
      auth: {
        role: 'agent_admin',
        agent_id: access.grant.agent_id,
        capabilities: access.grant.capabilities,
      },
    },
  });
});

adminRouter.get('/stock-tickets/:id/actions', (req, res) => {
  const access = loadStockAdminTicket(req, res, 'stock_tickets:read');
  if (!access) return;

  return res.json({
    ticket_id: access.ticket.id,
    current_status: access.ticket.status,
    current_actor: access.ticket.current_actor,
    current_actor_source: access.ticket.current_actor_source,
    next_actor_override: access.ticket.next_actor_override,
    manual_override_active: Boolean(access.ticket.manual_override_active),
    available_actions: getAvailableActions(access.ticket.id),
    action_objects: getAvailableActionObjects(access.ticket.status).map((action) => ({
      ...action,
      required_fields: getRequiredFieldsForAction(action.key),
    })),
  });
});

adminRouter.get('/stock-tickets/:id/comments', (req, res) => {
  const access = loadStockAdminTicket(req, res, 'stock_tickets:read');
  if (!access) return;

  return res.json({
    ticket_id: access.ticket.id,
    comments: access.ticket.comments || [],
    total: Array.isArray(access.ticket.comments) ? access.ticket.comments.length : 0,
  });
});

adminRouter.post('/stock-tickets/:id/comments', (req, res) => {
  const access = loadStockAdminTicket(req, res, 'stock_tickets:comment');
  if (!access) return;

  const { content, author, type = 'progress', visibility = 'internal', thread_id = null, mentions = [] } = req.body || {};
  if (!content || typeof content !== 'string' || !content.trim()) {
    return sendAgentError(req, res, 400, { error: 'Bad request', detail: '评论内容不能为空' });
  }
  if (!isValidCommentType(type)) {
    return sendAgentError(req, res, 400, { error: 'Bad request', detail: `无效评论类型：${type}` });
  }
  if (!isValidVisibility(visibility)) {
    return sendAgentError(req, res, 400, { error: 'Bad request', detail: `无效可见性：${visibility}` });
  }
  if (thread_id !== null && typeof thread_id !== 'string') {
    return sendAgentError(req, res, 400, { error: 'Bad request', detail: 'thread_id 必须是字符串或 null' });
  }
  if (thread_id && thread_id.length > THREAD_ID_MAX_LENGTH) {
    return sendAgentError(req, res, 400, { error: 'Bad request', detail: `thread_id 不能超过 ${THREAD_ID_MAX_LENGTH} 个字符` });
  }
  if (content.length > COMMENT_MAX_LENGTH) {
    return sendAgentError(req, res, 400, { error: 'Bad request', detail: `评论内容不能超过 ${COMMENT_MAX_LENGTH} 个字符` });
  }

  const requestedAuthor = author === undefined || author === null || author === '' ? access.grant.agent_id : String(author).trim();
  if (requestedAuthor !== access.grant.agent_id) {
    return sendAgentError(req, res, 403, {
      error: 'AGENT_ADMIN_FORBIDDEN',
      detail: 'agent-admin comment 不允许伪装为其他 author',
      author: requestedAuthor,
      expected_author: access.grant.agent_id,
    });
  }

  const cleanAuthor = resolveCommentAuthor(access.ticket, requestedAuthor).slice(0, AUTHOR_MAX_LENGTH) || access.grant.agent_id;
  const newComment = {
    id: buildCommentId(),
    author: cleanAuthor,
    timestamp: new Date().toISOString(),
    content: content.trim(),
    type,
    visibility,
    thread_id: thread_id || null,
    mentions: normalizeMentions(mentions, content),
  };

  persistTicketComment(access.ticket.id, newComment);
  const updated = store.getTicketById(access.ticket.id);

  return res.status(201).json({
    success: true,
    ticket: formatTicketForList(updated || access.ticket),
    comment: newComment,
  });
});

adminRouter.post('/stock-tickets/:id/transition', (req, res) => {
  const access = loadStockAdminTicket(req, res, 'stock_tickets:transition');
  if (!access) return;

  const { action, actor, comment, ...fields } = req.body || {};
  if (!action) {
    return sendAgentError(req, res, 400, {
      error: 'Missing action',
      detail: '必须指定 action',
      available_actions: getAvailableActions(access.ticket.id),
    });
  }

  const requestedActor = normalizeOptionalAgent(actor) || access.grant.agent_id;
  if (requestedActor !== access.grant.agent_id) {
    return sendAgentError(req, res, 403, {
      error: 'AGENT_ADMIN_FORBIDDEN',
      detail: 'agent-admin transition 不允许伪装为其他 actor',
      actor: requestedActor,
      expected_actor: access.grant.agent_id,
    });
  }

  const validation = validateAgentTicketAction(access.ticket, action, requestedActor);
  if (!validation.ok) {
    return sendAgentError(req, res, validation.status, validation.body);
  }

  if (action === 'reset_to_queued') {
    const reason = normalizeOptionalText(req.body?.reason ?? req.body?.reset_reason, 4000);
    if (!reason) {
      return sendAgentError(req, res, 400, {
        error: 'Bad request',
        detail: 'reason 不能为空',
        required_fields: ['actor', 'reason'],
      });
    }
    fields.reason = reason;
  }

  const oldStatus = access.ticket.status;
  const result = transition(access.ticket.id, action, { actor: requestedActor, ...fields });
  if (!result.success) {
    const statusCode = Number(result.statusCode || (result.error === 'RUNNING_TICKET_CONFLICT' ? 409 : 400));
    return sendAgentError(req, res, statusCode >= 400 && statusCode < 600 ? statusCode : 400, {
      ...result,
      action,
      available_actions: getAvailableActions(access.ticket.id),
    });
  }

  if (oldStatus !== result.ticket.status) {
    broadcastTicketStatusChanged(result.ticket, oldStatus, result.ticket.status);
  }

  appendTransitionAuditComment(access.ticket.id, {
    action,
    actor: requestedActor,
    oldStatus,
    newStatus: result.ticket.status,
    comment,
    fields,
  });

  const updated = store.getTicketById(access.ticket.id);
  return res.json({
    success: true,
    action,
    ticket: formatTicketForList(updated || result.ticket),
    available_actions: getAvailableActions(access.ticket.id),
    message: `agent-admin ${action} 已完成`,
  });
});

[AGENT_ADMIN_API_PREFIX, AGENT_ADMIN_API_LEGACY_PREFIX].forEach((prefix) => {
  app.use(prefix, adminRouter);
});

AGENT_ROUTE_PREFIXES.forEach((prefix) => {
  app.use(prefix, agentRouter);
});

// GET /api/agent-topology - 输出当前 agent -> gateway 拓扑
app.get('/api/v1/platform/agents', (_req, res) => {
  res.json({ agents: store.listPlatformAgents() });
});

app.get('/api/v1/platform/capabilities', (_req, res) => {
  res.json({ capabilities: store.listPlatformCapabilities() });
});

app.get('/api/v1/platform/role-contracts', (_req, res) => {
  res.json({ role_contracts: store.listPlatformRoleContracts() });
});

app.get('/api/v1/platform/workflow-templates', (_req, res) => {
  res.json({ workflow_templates: store.listPlatformWorkflowTemplates() });
});

app.post('/api/v1/platform/routing/preview', (req, res) => {
  const input = req.body && typeof req.body === 'object' ? req.body : {};
  const result = buildRoutingPreview(input, { agents: store.listPlatformAgents() });
  const record = store.recordPlatformRoutingDecision({
    request: input,
    result,
    routing_reason: result.reason,
  });
  res.json({ routing: { ...result, decision_id: record.id, created_at: record.created_at } });
});

app.get('/api/v1/platform/routing/decisions', (req, res) => {
  res.json({ decisions: store.listPlatformRoutingDecisions({ limit: req.query.limit }) });
});

app.get('/api/agent-topology', (_req, res) => {
  res.json({ data: getAgentTopologyRegistry() });
});

// GET /api/tickets/:id/actions - 获取当前可执行的 actions
app.get('/api/tickets/:id/actions', (req, res) => {
  const id = req.params.id;
  const ticket = store.getTicketById(id);

  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  const enriched = enrichTicketRouting(ticket);
  const actions = getAvailableActions(Number(id));
  res.json({
    ticket_id: Number(id),
    current_status: enriched.status,
    current_actor: enriched.current_actor,
    current_actor_source: enriched.current_actor_source,
    next_actor_override: enriched.next_actor_override,
    manual_override_active: Boolean(enriched.manual_override_active),
    available_actions: actions,
    action_objects: getAvailableActionObjects(enriched.status).map((action) => ({
      ...action,
      required_fields: getRequiredFieldsForAction(action.key),
    })),
  });
});

// GET /api/control/tickets/:id/operational-view - 最小控制读模型（单票聚合视图）
app.get('/api/control/tickets/:id/operational-view', (req, res) => {
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
  return res.json({
    ticket_id: Number(id),
    ...control_read_model,
  });
});

function buildProductionBaseline() {
  const repoRoot = path.resolve(__dirname, '..');
  const workingDirectory = process.cwd();
  const runtime = getRuntimeVersion();
  const fingerprintSource = [repoRoot, workingDirectory, runtime.git_commit || '', runtime.schema_version || '', runtime.bundle_version || ''].join('|');
  return {
    production_repo: 'agent-ticket-system',
    repo_root: repoRoot,
    working_directory: workingDirectory,
    release_fingerprint: createHash('sha256').update(fingerprintSource).digest('hex').slice(0, 16),
    environment: 'production',
  };
}

const REGISTRY_ROLES = [
  { key: 'triage', label: 'Triage', enabled: true, management_only: false },
  { key: 'executor', label: 'Executor', enabled: true, management_only: false },
  { key: 'reviewer', label: 'Reviewer', enabled: true, management_only: false },
  { key: 'audit', label: 'Auditor', enabled: true, management_only: false },
  { key: 'manager', label: 'Manager', enabled: true, management_only: true },
];

const registryDomains = new Map([
  ['ticket-platform', { key: 'ticket-platform', label: '工单平台', description: '工单生命周期与多 agent 协作平台', enabled_roles: ['triage', 'executor', 'reviewer', 'audit', 'manager'], created_by: 'system' }],
  ['stock-platform', { key: 'stock-platform', label: '股票平台', description: '股票业务协作域', enabled_roles: ['triage', 'executor', 'reviewer', 'audit', 'manager'], created_by: 'system' }],
]);
const registryAgents = new Map();

function normalizeRegistryKey(value) {
  return String(value || '').trim().toLowerCase();
}

function roleToResponsibility(role) {
  const key = normalizeRegistryKey(role);
  if (key === 'executor') return 'development';
  if (key === 'reviewer') return 'review_owner';
  if (key === 'manager') return 'platform_owner';
  return key;
}

function upsertRegisteredParticipant(agent = {}) {
  const agentId = normalizeRegistryKey(agent.agent_id);
  if (!agentId) return null;
  const roles = Array.isArray(agent.roles) ? agent.roles.map(normalizeRegistryKey).filter(Boolean) : [];
  const domains = Array.isArray(agent.domains) ? agent.domains.map(normalizeRegistryKey).filter(Boolean) : [];
  const primaryPlatform = domains[0] || null;
  const responsibilities = [...new Set(roles.map(roleToResponsibility).filter(Boolean))];
  const capabilities = [...new Set([
    ...responsibilities,
    ...roles.map((role) => `role:${role}`),
    ...domains.map((domain) => `platform:${domain}`),
  ])];
  return store.upsertParticipantRegistryEntry({
    participant_id: agentId,
    display_name: agent.display_name || agentId,
    participant_type: 'agent',
    role_type: roles[0] || 'executor',
    ownership_layer: responsibilities[0] || roles[0] || null,
    primary_platform: primaryPlatform,
    responsibilities,
    collaborates_with: [],
    responsibility_summary: `registered roles=${roles.join(',') || 'none'} domains=${domains.join(',') || 'none'}`,
    gateway_id: agent.gateway || agent.gateway_id || null,
    source_kind: 'agent_registration',
    capabilities,
    status: {
      availability_status: agent.status === 'offline' ? 'unavailable' : 'active',
      eligibility_status: 'eligible',
      accepts_assignment_types: roles,
      metadata: { capacity: agent.capacity ?? null, priority: agent.priority ?? null, session_binding: agent.session_binding || null },
    },
  });
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'ticket-platform-v2',
    status: 'healthy',
    request_id: getRequestId(req, res),
    runtime_version: getRuntimeVersion(),
    production_baseline: buildProductionBaseline(),
  });
});

app.get('/api/v1/platform/describe', (_req, res) => {
  res.json({
    data: {
      platform: 'ticket-platform-v2',
      contract_version: '2026-03-role-domain-registry-v1',
      production_baseline: buildProductionBaseline(),
      apis: {
        list_roles: '/api/v1/registry/roles',
        list_domains: '/api/v1/registry/domains',
        register_agent: '/api/v1/registry/agents/register',
        heartbeat: '/api/v1/registry/agents/heartbeat',
        resolve_assignment: '/api/v1/registry/resolve',
      },
      roles: REGISTRY_ROLES,
      domains: [...registryDomains.values()],
      defaults: {
        capabilities: DEFAULT_PLATFORM_CAPABILITIES.length,
        agents: DEFAULT_PLATFORM_AGENTS.length,
        role_contracts: DEFAULT_ROLE_CONTRACTS.length,
        workflow_templates: DEFAULT_WORKFLOW_TEMPLATES.length,
      },
    },
  });
});

app.get('/api/v1/registry/roles', (_req, res) => {
  res.json({ data: REGISTRY_ROLES });
});

app.get('/api/v1/registry/domains', (_req, res) => {
  res.json({ data: [...registryDomains.values()] });
});

app.post('/api/v1/registry/domains', (req, res) => {
  if (String(req.get('X-Platform-Token') || '') !== 'dev-platform-token') {
    return sendAgentError(req, res, 401, { error: 'Unauthorized', detail: 'X-Platform-Token 无效或缺失' });
  }
  const key = normalizeRegistryKey(req.body?.key);
  if (!key) return sendAgentError(req, res, 400, { error: 'Bad request', detail: 'domain key 必填' });
  const domain = {
    key,
    label: normalizeOptionalText(req.body?.label, 120) || key,
    description: normalizeOptionalText(req.body?.description, 1000) || '',
    enabled_roles: Array.isArray(req.body?.enabled_roles) ? req.body.enabled_roles.map(normalizeRegistryKey).filter(Boolean) : [],
    created_by: 'leoss',
  };
  registryDomains.set(key, domain);
  res.status(201).json({ data: domain });
});

app.post('/api/v1/registry/agents/register', (req, res) => {
  const agentId = normalizeRegistryKey(req.body?.agent_id);
  if (!agentId) return sendAgentError(req, res, 400, { error: 'Bad request', detail: 'agent_id 必填' });
  const agent = {
    agent_id: agentId,
    display_name: normalizeOptionalText(req.body?.display_name, 120) || agentId,
    roles: Array.isArray(req.body?.roles) ? req.body.roles.map(normalizeRegistryKey).filter(Boolean) : [],
    domains: Array.isArray(req.body?.domains) ? req.body.domains.map(normalizeRegistryKey).filter(Boolean) : [],
    gateway: normalizeOptionalText(req.body?.gateway || req.body?.gateway_id, 120) || null,
    session_binding: normalizeOptionalText(req.body?.session_binding, 255) || null,
    capacity: Number(req.body?.capacity ?? 1),
    priority: Number(req.body?.priority ?? 100),
    status: normalizeOptionalText(req.body?.status, 60) || 'online',
    active_load: Number(req.body?.active_load ?? 0),
    registered_at: new Date().toISOString(),
  };
  registryAgents.set(agentId, agent);
  upsertRegisteredParticipant(agent);
  res.json({ data: agent });
});

app.post('/api/v1/registry/agents/heartbeat', (req, res) => {
  const agentId = normalizeRegistryKey(req.body?.agent_id);
  if (!agentId) return sendAgentError(req, res, 400, { error: 'Bad request', detail: 'agent_id 必填' });
  const existing = registryAgents.get(agentId) || { agent_id: agentId, roles: [], domains: [] };
  const agent = {
    ...existing,
    status: normalizeOptionalText(req.body?.status, 60) || existing.status || 'online',
    active_load: Number(req.body?.active_load ?? existing.active_load ?? 0),
    capacity: Number(req.body?.capacity ?? existing.capacity ?? 1),
    metadata: req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : existing.metadata || {},
    last_heartbeat: new Date().toISOString(),
  };
  registryAgents.set(agentId, agent);
  upsertRegisteredParticipant(agent);
  res.json({ data: agent });
});

app.post('/api/v1/registry/resolve', (req, res) => {
  const domainKey = normalizeRegistryKey(req.body?.domain);
  const requiredRole = normalizeRegistryKey(req.body?.required_role || req.body?.role);
  const domain = registryDomains.get(domainKey) || null;
  const candidates = [...registryAgents.values()].filter((agent) => (
    (!domainKey || agent.domains?.includes(domainKey))
    && (!requiredRole || agent.roles?.includes(requiredRole))
    && agent.status !== 'offline'
  )).sort((a, b) => (Number(b.priority || 0) - Number(a.priority || 0)) || String(a.agent_id).localeCompare(String(b.agent_id)));
  const selected = candidates[0] || null;
  res.json({
    data: {
      resolved_agent: selected?.agent_id || null,
      requested: { domain: domainKey || null, required_role: requiredRole || null },
      domain,
      candidates,
      reason: selected ? 'role+domain matched registered agent' : 'no role+domain matched registered agent',
    },
  });
});

// 静态文件服务 - 提供前端页面
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));

// SPA fallback - 所有未匹配的非 API 路由返回 index.html
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

export default app;

