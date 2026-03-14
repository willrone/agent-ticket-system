/**
 * Express 应用 - 导出 app 供测试使用，server.js 仅负责 listen
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
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
import { TRANSITIONS, transition, getAvailableActions, findRunningEntryConflict } from './state-machine.js';
import { getAuditSessionKeyForTicket, getNotificationSessionKey } from './agent-session-router.js';
import { resolveDispatchDelivery, resolveNotificationDelivery } from './agent-delivery-router.js';
import { getAgentTopologyRegistry } from './agent-topology.js';
import { previewTicketSessionCleanup, runTicketSessionCleanup } from './ticket-session-cleanup.js';
import { broadcastTicketStatusChanged, broadcastTicketComment } from './websocket.js';
import {
  EXECUTION_MODES,
  executionModeRequiresWorker,
  getExecutionWorkerEvidence,
  isExecutionWorkerActiveStatus,
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
  buildRuntimeContext,
  classifyCommentActor,
  getAgentApiBaseUrl,
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

function parseExpectedListParam(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => parseExpectedListParam(item))
      .filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function buildLiveAcceptanceGate(ticket, options = {}) {
  const enriched = enrichTicketForApi(ticket);
  const assignment = store.findLatestAssignmentForTicket(enriched.id);
  const runtimeContext = buildRuntimeContext({ assignment });
  const bundle = buildCurrentAgentSkillBundle();
  const workflow = buildAgentWorkflowSchema();
  const topology = getAgentTopologyRegistry();

  const expectedBundleVersion = normalizeOptionalText(options.expectedBundleVersion, 255) || null;
  const expectedBundleChecksum = normalizeOptionalText(options.expectedBundleChecksum, 255) || null;
  const requiredTicketActions = parseExpectedListParam(options.requiredTicketActions);
  const requiredBootstrapEndpoints = parseExpectedListParam(options.requiredBootstrapEndpoints);
  const requiredWorkboards = parseExpectedListParam(options.requiredWorkboards);

  const dependencies = store.getDependencies(enriched.id).map((dep) => {
    const depTicket = enrichTicketForApi(store.getTicketById(dep.depends_on_ticket_id) || {
      id: dep.depends_on_ticket_id,
      title: dep.title,
      status: dep.status,
      comments: [],
    });
    return {
      ticket_id: dep.depends_on_ticket_id,
      title: depTicket.title,
      status: depTicket.status,
      counts_as_closed: Boolean(getStatusMeta(depTicket.status)?.counts_as_closed),
      dependency_type: dep.dependency_type || 'blocks',
    };
  });
  const unresolvedDependencies = dependencies.filter((item) => !item.counts_as_closed);

  const bundleTicketActions = Array.isArray(bundle.manifest?.ticket_actions)
    ? bundle.manifest.ticket_actions.map((item) => item.key).filter(Boolean)
    : [];
  const runtimeWorkboards = Array.isArray(runtimeContext.workboards)
    ? runtimeContext.workboards.map((item) => item.key).filter(Boolean)
    : [];

  const contractMismatches = [];
  const warnings = [];

  if (runtimeContext.namespace?.canonical_prefix !== AGENT_API_PREFIX) {
    contractMismatches.push({
      code: 'runtime-namespace-mismatch',
      message: `runtime context canonical_prefix=${runtimeContext.namespace?.canonical_prefix || 'null'}，预期 ${AGENT_API_PREFIX}`,
    });
  }
  if (runtimeContext.auth?.preferred_transport?.name !== 'X-Assignment-Token') {
    contractMismatches.push({
      code: 'auth-transport-mismatch',
      message: `runtime context preferred auth=${runtimeContext.auth?.preferred_transport?.name || 'null'}，预期 X-Assignment-Token`,
    });
  }
  if (runtimeContext.request_id?.header !== 'X-Request-Id' || runtimeContext.request_id?.error_field !== 'request_id') {
    contractMismatches.push({
      code: 'request-id-contract-mismatch',
      message: 'runtime context request_id contract 与当前 canonical 约定不一致',
    });
  }
  if (runtimeContext.error_model?.shape?.detail !== 'string' || runtimeContext.error_model?.shape?.request_id !== 'string') {
    contractMismatches.push({
      code: 'error-model-mismatch',
      message: 'runtime context error_model 未保持 {detail, request_id} canonical 形状',
    });
  }
  if (runtimeContext.skill_ref?.version !== bundle.version || runtimeContext.playbook_ref?.version !== bundle.version) {
    contractMismatches.push({
      code: 'bundle-version-mismatch',
      message: 'runtime context 引用的 bundle version 与 live hosted bundle 不一致',
      evidence: {
        runtime_skill_version: runtimeContext.skill_ref?.version || null,
        runtime_playbook_version: runtimeContext.playbook_ref?.version || null,
        live_bundle_version: bundle.version,
      },
    });
  }
  if (runtimeContext.skill_ref?.checksum_sha256 !== bundle.checksum_sha256 || runtimeContext.playbook_ref?.checksum_sha256 !== bundle.checksum_sha256) {
    contractMismatches.push({
      code: 'bundle-checksum-mismatch',
      message: 'runtime context 引用的 checksum 与 live hosted bundle 不一致',
      evidence: {
        runtime_skill_checksum: runtimeContext.skill_ref?.checksum_sha256 || null,
        runtime_playbook_checksum: runtimeContext.playbook_ref?.checksum_sha256 || null,
        live_bundle_checksum: bundle.checksum_sha256,
      },
    });
  }

  for (const key of requiredTicketActions) {
    if (!bundleTicketActions.includes(key)) {
      contractMismatches.push({
        code: 'missing-ticket-action',
        message: `live hosted bundle 缺少 required ticket action: ${key}`,
      });
    }
  }

  for (const key of requiredBootstrapEndpoints) {
    if (!runtimeContext.bootstrap?.[key]) {
      contractMismatches.push({
        code: 'missing-bootstrap-endpoint',
        message: `runtime context 缺少 required bootstrap endpoint: ${key}`,
      });
    }
  }

  for (const key of requiredWorkboards) {
    if (!runtimeWorkboards.includes(key)) {
      contractMismatches.push({
        code: 'missing-workboard',
        message: `runtime context 缺少 required workboard: ${key}`,
      });
    }
  }

  if (!runtimeContext.api_base_url) {
    warnings.push({
      code: 'api-base-url-missing',
      message: 'runtime context 未提供 api_base_url，reviewer 无法据此确认 agent 应访问的 live 平台地址',
    });
  }
  if (!topology?.main_gateway_id) {
    warnings.push({
      code: 'gateway-topology-missing',
      message: 'agent topology 缺少 main_gateway_id，gateway 健康信号不完整',
    });
  }
  if (!assignment) {
    warnings.push({
      code: 'assignment-missing',
      message: 'ticket 当前没有 live assignment，无法完整验证 assignment/runtime/receipt 断面',
    });
  }
  if (enriched.execution_mode !== 'direct' && !enriched.execution_guard?.has_worker_evidence) {
    warnings.push({
      code: 'worker-evidence-missing',
      message: `execution_mode=${enriched.execution_mode} 但当前缺少 worker evidence，live 收口仍可能被 guard 拦截`,
    });
  }

  let verdict = 'pass';
  if (expectedBundleVersion && expectedBundleVersion !== bundle.version) {
    verdict = 'live-not-upgraded';
  } else if (expectedBundleChecksum && expectedBundleChecksum !== bundle.checksum_sha256) {
    verdict = 'live-not-upgraded';
  } else if (unresolvedDependencies.length > 0) {
    verdict = 'dependency-not-closed';
  } else if (contractMismatches.length > 0) {
    verdict = 'contract-mismatch';
  } else if (warnings.length > 0) {
    verdict = 'partial';
  }

  const summaryMap = {
    pass: 'live acceptance gate 通过：关键 live contract 断面已对齐。',
    partial: 'live acceptance gate 部分通过：核心 contract 可读，但仍有 live 健康/证据缺口。',
    'live-not-upgraded': 'live acceptance gate 判定 live-not-upgraded：当前 live bundle/version 尚未达到预期。',
    'contract-mismatch': 'live acceptance gate 判定 contract-mismatch：live 断面之间存在 contract 不一致。',
    'dependency-not-closed': 'live acceptance gate 判定 dependency-not-closed：仍有未闭合依赖阻止 reviewer 视作完整交付。',
  };

  return {
    verdict,
    summary: summaryMap[verdict],
    ticket: {
      id: enriched.id,
      status: enriched.status,
      current_actor: enriched.current_actor,
      current_actor_source: enriched.current_actor_source,
      execution_mode: enriched.execution_mode,
      execution_guard: enriched.execution_guard,
    },
    live_surfaces: {
      workflow_schema: {
        status_count: Array.isArray(workflow.statuses) ? workflow.statuses.length : 0,
        action_count: Array.isArray(workflow.actions) ? workflow.actions.length : 0,
      },
      runtime_context: {
        api_base_url: runtimeContext.api_base_url,
        canonical_prefix: runtimeContext.namespace?.canonical_prefix || null,
        auth_transport: runtimeContext.auth?.preferred_transport?.name || null,
        skill_ref: runtimeContext.skill_ref || null,
        playbook_ref: runtimeContext.playbook_ref || null,
      },
      hosted_bundle: {
        version: bundle.version,
        checksum_sha256: bundle.checksum_sha256,
        ticket_actions: bundleTicketActions,
        workboards: runtimeWorkboards,
      },
      assignment: assignment ? {
        assignment_id: assignment.assignment_id,
        assignment_status: assignment.assignment_status,
        gateway_id: assignment.gateway_id || null,
        transport: assignment.transport || null,
      } : null,
      topology: {
        main_gateway_id: topology?.main_gateway_id || null,
        gateway_count: topology?.gateways ? Object.keys(topology.gateways).length : 0,
      },
      runtime_version: getRuntimeVersion(),
      dependencies: {
        total: dependencies.length,
        unresolved: unresolvedDependencies.length,
        items: dependencies,
      },
    },
    expectations: {
      expected_bundle_version: expectedBundleVersion,
      expected_bundle_checksum: expectedBundleChecksum,
      required_ticket_actions: requiredTicketActions,
      required_bootstrap_endpoints: requiredBootstrapEndpoints,
      required_workboards: requiredWorkboards,
    },
    issues: {
      contract_mismatches: contractMismatches,
      warnings,
      unresolved_dependencies: unresolvedDependencies,
      live_not_upgraded: verdict === 'live-not-upgraded' ? {
        expected_bundle_version: expectedBundleVersion,
        expected_bundle_checksum: expectedBundleChecksum,
        actual_bundle_version: bundle.version,
        actual_bundle_checksum: bundle.checksum_sha256,
      } : null,
    },
    generated_at: new Date().toISOString(),
  };
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

function validateAgentFacingActor(actor) {
  const requestedActor = normalizeOptionalAgent(actor);
  if (!requestedActor) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Missing actor', message: '必须指定 actor（平台登记的 agent id）' },
    };
  }

  const knownAgents = listKnownAgentIds();
  if (!knownAgents.includes(requestedActor)) {
    const humanAliases = ['ronghui', '荣晖'];
    const isHumanPrincipal = humanAliases.includes(String(requestedActor).trim().toLowerCase()) || humanAliases.includes(String(requestedActor).trim());
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

  return { ok: true, actor: requestedActor, requested_actor: requestedActor, alias_applied: false };
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
    if (status !== 'triage') {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'Bad request',
          message: '创建工单只能使用 triage 状态；其他状态必须通过 transition 推进',
          allowed_create_status: 'triage',
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
    const forbiddenFields = ['status', 'triage_owner', 'review_owner', 'decision_owner', 'decision_summary', 'decision_context', 'next_actor', 'review_plan', 'review_state'];
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

  const targetAgent = agentFacing
    ? (normalizeOptionalAgent(assigned_agent ?? agent) ?? actor)
    : (normalizeOptionalAgent(assigned_agent ?? agent) ?? 'donky');

  if (agentFacing && targetAgent !== actor) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'AGENT_ACTION_FORBIDDEN',
        message: 'assigned_agent 只能留空或等于 actor',
        actor,
        assigned_agent: targetAgent,
      },
    };
  }

  const normalizedTriageOwner = agentFacing ? DEFAULT_TRIAGE_OWNER : (normalizeOptionalAgent(triage_owner) ?? DEFAULT_TRIAGE_OWNER);
  const normalizedReviewOwner = agentFacing ? normalizedTriageOwner : (normalizeOptionalAgent(review_owner) ?? normalizedTriageOwner);
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
      status: 'triage',
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

function validateAgentTicketAction(ticket, action, actor) {
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

  const expectedActor = resolveRoleActor(enriched, getActionMeta(action)?.role_key || null);
  if (expectedActor && actor !== expectedActor) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'AGENT_ACTION_FORBIDDEN',
        message: `${action} 仅允许 ${expectedActor} 执行`,
        action,
        actor,
        expected_actor: expectedActor,
        role_key: getActionMeta(action)?.role_key || null,
        ticket_id: enriched.id,
        current_status: enriched.status,
        current_actor: enriched.current_actor || null,
        current_actor_source: enriched.current_actor_source || null,
        available_actions: availableActions,
      },
    };
  }

  return { ok: true, ticket: enriched, availableActions };
}

function runAgentTicketAction(req, res, action) {
  const id = Number(req.params.id);
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return sendAgentError(req, res, 404, { error: 'Ticket not found', detail: '工单不存在' });
  }

  const actorCheck = validateAgentFacingActor(req.body?.actor ?? req.body?.agent_id);
  if (!actorCheck.ok) {
    return sendAgentError(req, res, actorCheck.status, actorCheck.body);
  }
  const actor = actorCheck.actor;

  const assignmentId = String(req.body?.assignment_id ?? '').trim();
  const token = resolveAssignmentToken(req);
  let validatedAssignment = null;
  if (assignmentId && token) {
    const assignment = store.getAssignmentById(assignmentId);
    if (assignment && assignment.assignment_token === token && Number(assignment.ticket_id) === id) {
      const writeValidation = validateAssignmentWrite({
        assignment,
        ticket: enrichTicketForApi(ticket),
        kind: 'reviewer_action',
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
  }

  if (['approve', 'reject'].includes(action) && ['done', 'review'].includes(String(ticket.status || '').trim())) {
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

  const validation = validateAgentTicketAction(ticket, action, actor);
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
  const childTickets = Array.isArray(ticket.child_tickets) ? ticket.child_tickets : [];
  return {
    has_parent: Boolean(ticket.parent_ticket_id),
    parent_ticket_id: ticket.parent_ticket_id || null,
    dependency_count: dependencyCount,
    child_count: childTickets.length,
    related_count: relations.length,
    supplemental_count: supplementalTickets.length,
    supplemental_summary: ticket.supplemental_summary || { total: 0, open: 0, complete: 0, pending_review: 0, by_status: {} },
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
    .map(({ order, ...rest }) => rest);
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

function buildDispatchHandshakeProjection(ticket = {}) {
  const actor = String(ticket.current_actor || ticket.next_actor || '').trim();
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
  return {
    dispatch_state: latest?.dispatch_state || null,
    awaiting_receipt_from: latest?.awaiting_receipt_from || null,
    dispatch_ack_deadline_at: latest?.dispatch_ack_deadline_at || null,
    dispatch_retry_count: Number(latest?.dispatch_retry_count ?? 0),
    next_dispatch_retry_at: latest?.next_dispatch_retry_at || null,
    last_dispatch_receipt_at: latest?.receipt_received_at || null,
    last_dispatch_receipt_decision: latest?.receipt_decision || null,
    dispatch_timeout_reason: latest?.dispatch_state === 'receipt_overdue' ? 'receipt_not_received_before_deadline' : null,
    dispatch_watchers: watchers,
    dispatch_escalation_targets: watchers,
  };
}

function buildExecutionGuard(ticket = {}) {
  const workerEvidence = getExecutionWorkerEvidence(ticket);
  const reservation = ticket.id ? store.getExecutionReservationForTicket(ticket.id) : null;
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

function enrichTicketForApi(ticket = {}) {
  const enriched = enrichTicketRouting(ticket);
  const executionGuard = buildExecutionGuard(enriched);
  const dispatchHandshake = buildDispatchHandshakeProjection(enriched);
  return {
    ...enriched,
    ...dispatchHandshake,
    should_notify: executionGuard.suppress_dispatch ? false : enriched.should_notify,
    execution_guard: executionGuard,
  };
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
    || ticket.execution_guard?.has_worker_evidence;

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
  } else if (checks.some((item) => ['workflow-schema', 'runtime-context'].includes(item.key) && item.status === 'fail')) {
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

function buildStageAdvanceGuidance(ticket = {}) {
  const stage = String(ticket?.status || '').trim();
  const sharedPrefix = '重要：先按 hosted contract 回一条 dispatch_receipt（通过 report API，不要直接写 comment/transition）；receipt 不是终点，你的目标是把【当前阶段】推进到【下一阶段】。';
  const sharedMemory = '完成当前阶段前，请先把关键进展/决策/结论写入你自己工作区的 memory/YYYY-MM-DD.md（必要时更新相关长期记忆），后续继续用 heartbeat / reports 让平台代写状态推进。';
  const stageMap = {
    triage: '当前阶段=triage：请补齐结构化分诊结论与责任链，优先推进到 queued；若责任链仍不完整或范围未定，可继续停在 triage 并用 triage_structured_report 明确缺口，必要时用 decision_request 请求拍板。',
    queued: '当前阶段=queued：receipt 后要尽快进入实际执行；direct 模式就继续实现并用 execution_completed / blocked_report / decision_request 等把 queued 推进到 done / blocked / pending_decision。subagent/acp 模式先登记真实 worker，再继续推进。',
    running: '当前阶段=running：继续实现、验证并收口；优先推进到 done（execution_completed / review_submission），若受阻则推进到 blocked / pending_decision / failed，必要时也可 pause，但不能只停在 running。',
    done: '当前阶段=done：这是 reviewer 接单前态；reviewer receipt 后应推进到 review，并在完成验收后先提交 review_submission，再决定 approve（推进到 complete）或 reject（打回 queued）。',
    review: '当前阶段=review：reviewer 已正式接单；下一步必须给出验收结论。先提交 review_submission 写清依据，再 approve（complete）或 reject（queued）；若缺上下文可 pause / decision_request，但不能只停在 receipt。',
    blocked: '当前阶段=blocked：目标是解除阻塞并恢复推进；若阻塞已解除，推动回 queued/继续执行；若仍无法继续，至少用 heartbeat / decision_request 明确阻塞来源、所需外部动作与下一步。',
    paused: '当前阶段=paused：目标是恢复到挂起前状态并继续推进；若恢复条件已满足就 resume，若仍不满足则通过 heartbeat / decision_request 说明为什么继续保持 paused。',
    pending_decision: '当前阶段=pending_decision：目标是把待拍板问题讲清楚并等决策收口；请用 decision_request 明确可选方案、风险和建议，决策落定后再恢复推进，不要让 ticket 长期停在无结论状态。',
  };
  const fallback = '请先确认当前 stage 的 allowed actions / report contract，并选择一个明确的下一阶段或收口动作推进，不要只完成 receipt。';
  return [sharedPrefix, stageMap[stage] || fallback, sharedMemory].join(' ');
}

function buildAgentDispatchMessage({ ticket, agent, assignment }) {
  const apiBaseUrl = assignment ? getAgentApiBaseUrl({ gatewayId: assignment.gateway_id }) : null;
  const stageGuidance = buildStageAdvanceGuidance(ticket);
  const base = [
    `🔔 你有 1 个当前阶段待处理工单`,
    '',
    `#${ticket.id} ${ticket.title}`,
    `状态：${ticket.status}`,
    `当前责任人：${agent}`,
    '',
    `请立即使用 ticket-handler skill 处理，并把【当前阶段】自行闭环推进到【下一阶段】。`,
    '',
    stageGuidance,
    '',
    `不要等老大再追问。若遇到需要老大决策的关键问题，先写工单评论，再主动通知老大。`,
  ];

  if (!assignment) return base.join('\n');

  base.push(
    '',
    '【Agent-Facing Assignment Contract】',
    `assignment_id: ${assignment.assignment_id}`,
    `assignment_token: ${assignment.assignment_token}`,
    `api_base_url: ${apiBaseUrl || 'UNCONFIGURED_REMOTE_API_BASE_URL'}`,
    `read: GET ${AGENT_API_PREFIX}/assignments/${assignment.assignment_id}`,
    `skill fetch: GET ${AGENT_API_PREFIX}/skills/current`,
    `playbook: GET ${AGENT_API_PREFIX}/playbooks/${AGENT_PLAYBOOK_KEY}`,
    `heartbeat: POST ${AGENT_API_PREFIX}/assignments/${assignment.assignment_id}/heartbeat`,
    `report: POST ${AGENT_API_PREFIX}/assignments/${assignment.assignment_id}/reports`,
    `legacy aliases: ${AGENT_API_LEGACY_PREFIX}/...`,
    '说明：agent 优先走 runtime/assignment/skill fetch/report API；assignment_token 优先放 X-Assignment-Token，body/query 仅保留兼容。不要直接写 ticket comment/transition。',
    ...(apiBaseUrl ? [] : ['注意：当前远端 agent-facing HTTP 地址尚未配置，请在平台侧设置 TICKET_AGENT_API_BASE_URL 后再让远端 agent 直接调 API。']),
  );

  return base.join('\n');
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

app.get('/api/metrics/dashboard', (_req, res) => {
  res.json({ data: computeDashboardMetrics() });
});

// GET /api/tickets
app.get('/api/tickets', (req, res) => {
  const tickets = store.getAllTickets()
    .map(formatTicketForList)
    .filter((ticket) => matchesTicketFilters(ticket, req.query))
    .sort((a, b) => {
      const aTs = Date.parse(a.created || '') || 0;
      const bTs = Date.parse(b.created || '') || 0;
      if (bTs !== aTs) return bTs - aTs;
      return (Number(b.id) || 0) - (Number(a.id) || 0);
    });
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
  }).map((t) => enrichTicketForApi(t));

  const byStatus = {
    done: recent.filter((t) => t.status === 'done'),
    complete: recent.filter((t) => t.status === 'complete'),
    failed: recent.filter((t) => t.status === 'failed'),
    pending_decision: recent.filter((t) => t.status === 'pending_decision'),
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
      total: byStatus.done.length + byStatus.complete.length + byStatus.failed.length + byStatus.pending_decision.length,
    },
    items: {
      done: byStatus.done.map(normalize),
      complete: byStatus.complete.map(normalize),
      failed: byStatus.failed.map(normalize),
      pending_decision: byStatus.pending_decision.map(normalize),
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
    .map((t) => formatTicketForList(t))
    .filter((t) => t.status === 'queued' && t.assigned_agent === agent && !t.execution_guard?.suppress_dispatch)
    .sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
    })
    .slice(0, parseInt(limit, 10) || 1);
  res.json(tickets);
});

// GET /api/tickets/:id/status - 必须在 /api/tickets/:id 之前
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

// GET /api/tickets/:id
app.get('/api/tickets/:id', (req, res) => {
  const id = req.params.id;
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }
  const enriched = enrichTicketForApi(ticket);
  const workflow_mismatch = detectWorkflowMismatch(enriched);
  const detail = {
    ...enriched,
    updated: enriched.updated || enriched.last_update,
    assignee: enriched.assigned_agent || null,
    reporter: null,
    tags: [],
    attachments: [],
    watchers: enriched.watchers || [],
    comments: (enriched.comments || []).map(normalizeComment),
    workflow_mismatch: workflow_mismatch || undefined,
    execution_workers: enriched.execution_workers || [],
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
  const agent = req.body?.agent || 'donky';
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
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
    workers: store.listExecutionWorkers(id),
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
  if (source === 'projection') {
    const projectionRows = store.getDispatchReadyProjection();
    const ready = projectionRows.map((r) => {
      const ticket = enrichTicketForApi(store.getTicketById(r.ticket_id) || {});
      return {
        dispatch_id: r.dispatch_id,
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
    });
    return res.json({ ready, _source: 'projection' });
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
  const ticketById = new Map(allTickets.map((ticket) => [ticket.id, ticket]));

  // 构建候选：正常单 (next_actor) + mismatch 单 (alert_target) + 平台催办 nudge
  const candidates = [];
  for (const ticket of allTickets) {
    const mismatch = detectWorkflowMismatch(ticket);
    if (mismatch) {
      // workflow_mismatch 告警优先发给建议接手人（如 decision_owner / review_owner），其次回退当前责任人
      const agent = mismatch.alert_target || ticket.next_actor || '荣晖';
      if (!agent) continue;
      candidates.push({ ticket, agent, kind: 'workflow_mismatch', mismatch, priority: 1, sortTs: Date.parse(ticket.created || '') || 0 });
    } else if (!ticket.execution_guard?.suppress_dispatch && ticket.status !== 'paused' && ticket.should_notify && ticket.next_actor && ticket.status !== 'pending_decision') {
      const staleHint = getStaleDeliveryHint(ticket, 'dispatch');
      if (staleHint?.stale) {
        dispatch.clearDispatchEvents(ticket.id);
        console.log(`[dispatch/ready] Skip #${ticket.id}: stale dispatch (${staleHint.reason})`);
        continue;
      }
      // 依赖门禁：检查是否有未满足的依赖
      if (store.hasUnmetDependencies(ticket.id)) {
        console.log(`[dispatch/ready] Skip #${ticket.id}: unmet dependencies`);
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
            console.log(`[dispatch/ready] Skip #${ticket.id}: assigned_agent ${ticket.assigned_agent} reservation conflict #${err?.conflict_reservation?.ticket_id || 'unknown'}`);
            continue;
          }
          throw err;
        }
        const refreshed = enrichTicketForApi(store.getTicketById(ticket.id));
        candidates.push({ ticket: refreshed, agent: refreshed.next_actor, kind: undefined, mismatch: null, priority: 2, sortTs: Date.parse(refreshed.created || '') || 0 });
        continue;
      }
      candidates.push({ ticket, agent: ticket.next_actor, kind: undefined, mismatch: null, priority: 2, sortTs: Date.parse(ticket.created || '') || 0 });
    }
  }

  for (const item of [...collectQueuedStaleNudges(allTickets), ...collectAuditResultNudges(allTickets)]) {
    const ticket = ticketById.get(item.ticket_id);
    if (!ticket) continue;
    candidates.push({
      ticket,
      agent: item.agent,
      kind: 'nudge',
      mismatch: null,
      readyItem: item,
      priority: 0,
      sortTs: getTicketLastActivityTs(ticket) || Date.parse(ticket.created || '') || 0,
    });
  }

  console.log('[dispatch/ready] Candidates:', candidates.length);

  // 按 agent 分组，每个 agent 只返回最早 1 张
  const byAgent = new Map();
  for (const candidate of candidates) {
    const { ticket, agent, kind, mismatch, readyItem } = candidate;
    console.log(`[dispatch/ready] Checking #${ticket.id} agent=${agent} kind=${kind || 'normal'}`);
    const governance = kind === 'nudge'
      ? {
          reason: readyItem.nudge_key,
          dedupe_key: readyItem.dedupe_key,
          escalation_tier: readyItem.escalation_tier,
        }
      : buildDispatchEventGovernance({
          ticket,
          agent,
          kind,
          mismatch,
        });
    const statusKey = governance.reason;

    if (kind !== 'nudge') {
      const hasRecent = dispatch.hasRecentDispatch(ticket.id, agent, statusKey, 60);
      if (hasRecent) continue;
    }

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

  // 生成派发事件并返回
  const ready = [];
  for (const { ticket, agent, kind, mismatch, readyItem } of byAgent.values()) {
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
    } else {
      const assignment = store.createOrReuseAssignment({
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
        ...buildAssignmentContract(assignment, ticket),
        assignment_token: assignment.assignment_token,
      };

      ready.push({
        dispatch_id: dispatchId,
        agent,
        ticket_id: ticket.id,
        title: ticket.title,
        status: ticket.status,
        next_actor: ticket.next_actor,
        execution_mode: ticket.execution_mode,
        worker_stats: ticket.worker_stats,
        dispatch_retry_count: latestHandshake?.should_retry ? Number(latestHandshake.dispatch_retry_count || 0) + 1 : Number(latestHandshake?.dispatch_retry_count || 0),
        reason: governance.reason,
        dedupe_key: governance.dedupe_key,
        escalation_tier: governance.escalation_tier,
        reservation: ticket.execution_guard?.reservation || store.getExecutionReservationForTicket(ticket.id),
        reservation_conflict: ticket.execution_guard?.reservation_conflict || null,
        assignment_id: assignment.assignment_id,
        assignment: assignmentContract,
        reset_session: true,
        session_reset_reason: 'assignment_refresh',
        ...delivery,
        message: buildAgentDispatchMessage({ ticket, agent, assignment }),
      });
    }
  }

  if (source === 'compare') {
    const projectionBefore = store.getDispatchReadyProjection();
    store.replaceAllDispatchReadyProjection(ready);
    return res.json({
      ready,
      _source: 'compare',
      _compare: {
        legacy_count: ready.length,
        projection_count: projectionBefore.length,
        projection: projectionBefore,
      },
    });
  }
  store.replaceAllDispatchReadyProjection(ready);
  res.json({ ready });
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
    dispatch_id: dispatchId,
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
    dispatch_id: dispatchId,
    compatibility: true,
    dispatch_state: event?.dispatch_state || 'awaiting_receipt',
    awaiting_receipt_from: event?.awaiting_receipt_from || null,
    dispatch_ack_deadline_at: event?.dispatch_ack_deadline_at || null,
    next_dispatch_retry_at: event?.next_dispatch_retry_at || null,
  });
});

// GET /api/notifications/ready - 获取待通知结果
app.get('/api/notifications/ready', (req, res) => {
  const NOTIFY_STATUSES = new Set(['complete', 'failed', 'pending_decision']);
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
    }

    const target_actor = ticket.decision_owner || '荣晖';
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
      event_id: eventId,
      type: eventType,
      ticket_id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      target_actor,
      reason: governance.reason,
      dedupe_key: governance.dedupe_key,
      escalation_tier: governance.escalation_tier,
      target_session_key,
      ...delivery,
      message,
    });
  }

  res.json({ ready });
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
  res.json({ success: true, event_id: eventId });
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
  res.json({ success: true, event_id: eventId, compatibility: true });
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

const AUDIT_STALE_TRIAGE_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_TRIAGE_MINUTES) || 30;
const AUDIT_STALE_RUNNING_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_RUNNING_MINUTES) || 30;
const AUDIT_STALE_PAUSED_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_PAUSED_MINUTES) || 240;
const AUDIT_STALE_DONE_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_DONE_MINUTES) || 30;
const AUDIT_STALE_REVIEW_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_REVIEW_MINUTES) || 10;
const AUDIT_STALE_PENDING_DECISION_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_PENDING_DECISION_MINUTES) || 720;
const AUDIT_STALE_BLOCKED_MINUTES = parsePositiveInt(process.env.AUDIT_STALE_BLOCKED_MINUTES) || 240;
const AUDIT_REQUEST_RETRY_MINUTES = parsePositiveInt(process.env.AUDIT_REQUEST_RETRY_MINUTES) || 30;
const QUEUED_NUDGE_STALE_MINUTES = parsePositiveInt(process.env.QUEUED_NUDGE_STALE_MINUTES) || 30;
const TICKET_NUDGE_THROTTLE_MINUTES = parsePositiveInt(process.env.TICKET_NUDGE_THROTTLE_MINUTES) || 60;

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

function buildQueuedStaleNudgeMessage({ ticket, agent, staleMinutes }) {
  const assignment = store.findLatestAssignmentForTicket(ticket.id, agent);
  const base = [
    `⏰ [queued_stale 催办]`,
    ``,
    `#${ticket.id} ${ticket.title}`,
    `状态：${ticket.status}`,
    `当前责任人：${agent}`,
    `已滞留：${Math.round(staleMinutes)} 分钟（超过 queued 催办阈值 ${QUEUED_NUDGE_STALE_MINUTES} 分钟）`,
    ``,
    `请尽快开工；如果无法开工，请先补评论说明原因，再按需要 transition。`,
  ];

  if (assignment) {
    base.push('', buildAgentDispatchMessage({ ticket, agent, assignment }));
  }

  return base.join('\n');
}

function buildAuditNudgeMessage({ ticket, agent, auditResult }) {
  const assignment = agent === ticket.assigned_agent
    ? store.findLatestAssignmentForTicket(ticket.id, agent)
    : null;
  const base = [
    `⏰ [audit_nudge 催办]`,
    ``,
    `#${ticket.id} ${ticket.title}`,
    `当前状态：${ticket.status}`,
    `催办对象：${agent}`,
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

function buildDispatchEventGovernance({ ticket, agent, kind, mismatch = null, nudgeSource = null, nudgeKey = null }) {
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
      escalation_tier: nudgeSource === 'audit_result' ? 'escalated' : 'nudge',
    };
  }

  return {
    reason: ticket.status,
    dedupe_key: `dispatch:${ticket.status}:assignment:${agent}`,
    escalation_tier: ['done', 'review'].includes(ticket.status) ? 'review' : 'delivery',
  };
}

function buildNotificationEventGovernance({ ticket, eventType, targetActor }) {
  const actor = targetActor || 'main';
  const isDecision = eventType === 'pending_decision';
  const reason = isDecision
    ? 'decision_required'
    : eventType === 'complete'
      ? 'execution_complete'
      : eventType === 'failed'
        ? 'execution_failed'
        : eventType;

  return {
    reason,
    dedupe_key: `notify:${ticket.status}:${reason}:${actor}`,
    escalation_tier: isDecision ? 'decision' : 'result',
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
  staleMinutes = null,
  auditResult = null,
}) {
  const governance = buildDispatchEventGovernance({
    ticket,
    agent,
    kind: 'nudge',
    nudgeSource,
    nudgeKey,
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
    ...(staleMinutes === null ? {} : { stale_minutes: Math.round(staleMinutes) }),
    ...(auditResult
      ? {
          audit_result: {
            audit_id: auditResult.audit_id,
            audit_type: auditResult.audit_type,
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
    if (ticket.dispatch_state === 'receipt_accepted' && ticket.last_dispatch_receipt_decision === 'accepted') continue;
    if (store.hasUnmetDependencies(ticket.id)) continue;

    const agent = normalizeOptionalAgent(ticket.assigned_agent || ticket.next_actor);
    if (!agent) continue;
    if (!dispatch.hasRecentDispatch(ticket.id, agent, 'queued', 30 * 24 * 60)) continue;

    const staleMinutes = computeTicketStaleMinutes(ticket, now);
    if (!Number.isFinite(staleMinutes) || staleMinutes < QUEUED_NUDGE_STALE_MINUTES) continue;

    const statusKey = 'nudge_queued_stale';
    if (dispatch.hasRecentDispatch(ticket.id, agent, statusKey, TICKET_NUDGE_THROTTLE_MINUTES)) continue;

    let dispatchId = dispatch.getUnackedDispatchEvent(ticket.id, agent, statusKey);
    if (!dispatchId) {
      dispatchId = dispatch.recordDispatchEvent(ticket.id, agent, statusKey);
    }

    ready.push(buildNudgeReadyItem({
      ticket,
      agent,
      dispatchId,
      delivery: resolveDispatchDelivery({ agent, ticketId: ticket.id, kind: 'nudge' }),
      message: buildQueuedStaleNudgeMessage({ ticket, agent, staleMinutes }),
      nudgeKey: statusKey,
      nudgeSource: 'queued_stale',
      staleMinutes,
    }));
  }

  return ready;
}

function collectAuditResultNudges(allTickets) {
  const latestByTicketId = new Map();
  for (const result of dispatch.listAuditResults({ limit: 200 })) {
    if (!latestByTicketId.has(result.ticket_id)) {
      latestByTicketId.set(result.ticket_id, result);
    }
  }

  const ready = [];
  for (const ticket of allTickets) {
    if (!['running', 'review'].includes(ticket.status)) continue;
    const auditResult = latestByTicketId.get(ticket.id);
    if (!auditResult) continue;
    if (auditResult.audit_type !== `stale_${ticket.status}`) continue;
    if (!AUDIT_NUDGEABLE_ACTIONS.has(auditResult.suggested_action || '')) continue;

    const agent = resolveAuditSuggestedActor(ticket, auditResult);
    if (!agent) continue;

    const statusKey = `nudge_${auditResult.audit_type}_${auditResult.suggested_action}`;
    if (dispatch.hasRecentDispatch(ticket.id, agent, statusKey, TICKET_NUDGE_THROTTLE_MINUTES)) continue;

    let dispatchId = dispatch.getUnackedDispatchEvent(ticket.id, agent, statusKey);
    if (!dispatchId) {
      dispatchId = dispatch.recordDispatchEvent(ticket.id, agent, statusKey);
    }

    ready.push(buildNudgeReadyItem({
      ticket,
      agent,
      dispatchId,
      delivery: resolveDispatchDelivery({ agent, ticketId: ticket.id, kind: 'nudge' }),
      message: buildAuditNudgeMessage({ ticket, agent, auditResult }),
      nudgeKey: statusKey,
      nudgeSource: 'audit_result',
      auditResult,
    }));
  }

  return ready;
}

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
    const threshold = AUDIT_THRESHOLDS[ticket.status];
    if (!threshold) continue;

    const staleMinutes = computeTicketStaleMinutes(ticket, now);
    if (!Number.isFinite(staleMinutes) || staleMinutes < threshold) continue;

    const auditType = `stale_${ticket.status}`;
    if (dispatch.hasResolvedAudit(ticket.id, auditType)) continue;

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

// GET /api/live-acceptance/tickets/:id - reviewer/read-only live acceptance gate
app.get('/api/live-acceptance/tickets/:id', (req, res) => {
  const id = Number(req.params.id);
  const ticket = store.getTicketById(id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
  }

  const gate = buildLiveAcceptanceGate(ticket, {
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

// POST /tickets/:id/queue - agent-facing 执行 queue
agentRouter.post('/tickets/:id/queue', (req, res) => runAgentTicketAction(req, res, 'queue'));

// POST /tickets/:id/start-work - agent-facing 执行 start_work
agentRouter.post('/tickets/:id/start-work', (req, res) => runAgentTicketAction(req, res, 'start_work'));

// POST /tickets/:id/pause - agent-facing 执行 pause
agentRouter.post('/tickets/:id/pause', (req, res) => runAgentTicketAction(req, res, 'pause'));

// POST /tickets/:id/resume - agent-facing 执行 resume
agentRouter.post('/tickets/:id/resume', (req, res) => runAgentTicketAction(req, res, 'resume'));

// POST /tickets/:id/approve - agent-facing 执行 approve
agentRouter.post('/tickets/:id/approve', (req, res) => runAgentTicketAction(req, res, 'approve'));

// POST /tickets/:id/reject - agent-facing 执行 reject
agentRouter.post('/tickets/:id/reject', (req, res) => runAgentTicketAction(req, res, 'reject'));

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

// 静态文件服务 - 提供前端页面
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));

// SPA fallback - 所有未匹配的非 API 路由返回 index.html
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

export default app;

