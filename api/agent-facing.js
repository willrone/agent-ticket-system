import { createHash } from 'node:crypto';
import { buildWorkflowActorContract, getWorkflowSchema } from '../workflow-schema.js';
import { getAgentTopologyRegistry, getGatewayForAgent } from './agent-topology.js';

export const AGENT_API_VERSION = 'agent-facing-v1';
export const AGENT_SCHEMA_VERSION = '2026-03-12';
export const AGENT_API_PREFIX = '/api/v1/agent';
export const AGENT_API_LEGACY_PREFIX = '/api/agent';
export const AGENT_REPORT_TYPES = [
  'progress_update',
  'dispatch_receipt',
  'analysis_result',
  'execution_completed',
  'execution_failed',
  'blocked_report',
  'decision_request',
  'review_submission',
  'triage_structured_report',
  'artifact_upload',
  'workflow_warning',
  'handoff_note',
];
export const AGENT_SKILL_ID = 'ticket-handler';
export const AGENT_PLAYBOOK_KEY = 'ticket-handler';
export const AGENT_PLAYBOOK_VERSION = '2026-03-12.bundle.v8';

const AGENT_WORKBOARD_BUCKET_META = {
  active: { key: 'active', label: '待推进' },
  waiting_review: { key: 'waiting_review', label: '待验收' },
  waiting_decision: { key: 'waiting_decision', label: '待决策' },
  blocked: { key: 'blocked', label: '阻塞' },
  paused: { key: 'paused', label: '暂时挂起' },
  closed: { key: 'closed', label: '已结束' },
};

const AGENT_STOCK_WORKBOARD_QUERY_PARAMS = [
  { key: 'status', type: 'csv', description: '按 workflow status 过滤，如 queued,running,done。' },
  { key: 'bucket', type: 'csv', description: '按 canonical bucket 过滤，如 active,waiting_review,blocked。' },
  { key: 'assigned_agent', type: 'string', description: '按执行人过滤。' },
  { key: 'current_actor', type: 'string', description: '按当前责任人过滤。' },
  { key: 'review_owner', type: 'string', description: '按验收负责人过滤。' },
  { key: 'has_dependencies', type: 'boolean', description: 'true=仅看存在 depends_on 依赖的工单；false=仅看无依赖工单。' },
  { key: 'parent_ticket_id', type: 'integer', description: '按父工单 id 过滤。' },
  { key: 'group_by', type: 'enum', description: '可选：none,status,bucket,assigned_agent,current_actor,review_owner,parent_ticket_id。' },
  { key: 'sort', type: 'enum', description: '可选：updated_desc,created_desc,priority_desc,priority_asc,status_order,id_desc。' },
  { key: 'limit', type: 'integer', description: '分页大小，默认 50，最大 200。' },
  { key: 'offset', type: 'integer', description: '分页偏移，默认 0。' },
];

function buildAgentPath(path, { legacy = false } = {}) {
  const prefix = legacy ? AGENT_API_LEGACY_PREFIX : AGENT_API_PREFIX;
  return `${prefix}${path}`;
}

function buildAgentUrl(apiBaseUrl, path, { legacy = false } = {}) {
  return appendApiBaseUrl(apiBaseUrl, buildAgentPath(path, { legacy }));
}

function buildLegacyAlias(path) {
  return buildAgentPath(path, { legacy: true });
}

function buildRequestIdContract() {
  return {
    header: 'X-Request-Id',
    passthrough_supported: true,
    generated_when_missing: true,
    error_field: 'request_id',
  };
}

function buildAgentAuthContract() {
  return {
    scheme: 'assignment_token',
    preferred_transport: {
      type: 'header',
      name: 'X-Assignment-Token',
    },
    legacy_transports: [
      { type: 'query', name: 'assignment_token' },
      { type: 'body', name: 'assignment_token' },
    ],
    human_api_separation: '保留给人类/控制台的 Bearer 鉴权不要与 agent assignment token 混用。',
  };
}

function buildAgentErrorModel() {
  return {
    shape: {
      detail: 'string',
      request_id: 'string',
    },
    request_id_header: 'X-Request-Id',
    examples: [
      {
        status_code: 401,
        body: {
          detail: 'assignment_token 无效或缺失',
          request_id: 'req_demo_123',
        },
      },
    ],
  };
}

export function getAgentApiBaseUrl(options = {}) {
  const explicit = process.env.TICKET_AGENT_API_BASE_URL || process.env.TICKET_API_BASE_URL || '';
  if (explicit) return explicit;

  const gatewayId = String(options.gatewayId || '').trim();
  const registry = getAgentTopologyRegistry();
  if (gatewayId && gatewayId !== registry.main_gateway_id) {
    return null;
  }

  return 'http://127.0.0.1:8788';
}

function buildBootstrapEndpoints() {
  return {
    workflow_schema: '/api/v1/agent/workflow/schema',
    runtime_context: '/api/v1/agent/runtime/context',
    assignment_read: '/api/v1/agent/assignments/:assignment_id',
    assignment_dependencies: '/api/v1/agent/assignments/:assignment_id/dependencies',
    assignment_comments: '/api/v1/agent/assignments/:assignment_id/comments',
    assignment_live_acceptance: '/api/v1/agent/assignments/:assignment_id/live-acceptance',
    assignment_heartbeat: '/api/v1/agent/assignments/:assignment_id/heartbeat',
    assignment_report: '/api/v1/agent/assignments/:assignment_id/reports',
    ticket_create: '/api/v1/agent/tickets',
    ticket_pause: '/api/v1/agent/tickets/:id/pause',
    ticket_resume: '/api/v1/agent/tickets/:id/resume',
    ticket_approve: '/api/v1/agent/tickets/:id/approve',
    ticket_reject: '/api/v1/agent/tickets/:id/reject',
    skill_current: '/api/v1/agent/skills/current',
    playbook_current: `/api/v1/agent/playbooks/${AGENT_PLAYBOOK_KEY}`,
    stock_tickets_workboard: '/api/v1/agent/workboards/stock-tickets',
  };
}

function appendApiBaseUrl(apiBaseUrl, endpoint) {
  if (!apiBaseUrl) return endpoint;
  return `${String(apiBaseUrl).replace(/\/$/, '')}${endpoint}`;
}

function toNumberOrNull(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildWorkerEvidenceSnapshot(ticket = {}) {
  const workerStats = ticket.worker_stats && typeof ticket.worker_stats === 'object'
    ? {
        total_workers: toNumberOrNull(ticket.worker_stats.total_workers) ?? 0,
        active_workers: toNumberOrNull(ticket.worker_stats.active_workers) ?? 0,
        running_workers: toNumberOrNull(ticket.worker_stats.running_workers) ?? 0,
      }
    : {
        total_workers: 0,
        active_workers: 0,
        running_workers: 0,
      };
  const currentWorkers = Array.isArray(ticket.current_workers) ? ticket.current_workers : [];
  const executionWorkers = Array.isArray(ticket.execution_workers) ? ticket.execution_workers : [];
  return {
    worker_stats: workerStats,
    current_workers: currentWorkers,
    execution_workers: executionWorkers,
    has_worker_evidence: workerStats.total_workers > 0 || currentWorkers.length > 0 || executionWorkers.length > 0,
  };
}

function getExecutionSchema() {
  return getWorkflowSchema().execution || {
    modes: [],
    worker_statuses: [],
    rules: [],
  };
}

function getExecutionModeMeta(mode) {
  const execution = getExecutionSchema();
  const modes = Array.isArray(execution.modes) ? execution.modes : [];
  return modes.find((item) => item.key === mode)
    || modes.find((item) => item.key === 'direct')
    || null;
}

function getWorkflowActionMeta(actionKey) {
  const actions = Array.isArray(getWorkflowSchema().actions) ? getWorkflowSchema().actions : [];
  return actions.find((item) => item.key === actionKey || item.action === actionKey) || null;
}

function buildAgentTicketActionApis({ apiBaseUrl = null } = {}) {
  const createExample = {
    actor: '<agent_id>',
    title: '补一张后续子任务',
    description: '需要把 smoke 校验拆成独立工单。',
    triage_summary: '拆出 smoke 子任务，避免主单继续膨胀。',
    implementation_scope: '新增 smoke 脚本与回归记录',
    constraints: '保持 additive；不要改动主流程 contract',
    deliverables: '脚本、验证记录、回写摘要',
    acceptance_criteria: 'smoke 可独立执行并留痕',
    request_type: 'feature',
    platform: 'ticket-platform',
    parent_ticket_id: 46,
    execution_mode: 'subagent'
  };
  const queueExample = {
    actor: '<triage_owner>'
  };
  const startWorkExample = {
    actor: '<assigned_agent>'
  };
  const pauseExample = {
    actor: '<current_actor>',
    pause_reason: '等待 reviewer 对 API contract 拍板后再继续。'
  };
  const resumeExample = {
    actor: '<paused_by>'
  };
  const approveExample = {
    actor: '<review_owner>',
    assignment_id: '<current_assignment_id>'
  };
  const rejectExample = {
    actor: '<review_owner>',
    assignment_id: '<current_assignment_id>',
    reject_reason: '验收未通过：请补齐 reviewer write path 的 live smoke 与 contract 说明。'
  };
  const queueMeta = getWorkflowActionMeta('queue');
  const startWorkMeta = getWorkflowActionMeta('start_work');
  const pauseMeta = getWorkflowActionMeta('pause');
  const resumeMeta = getWorkflowActionMeta('resume');
  const approveMeta = getWorkflowActionMeta('approve');
  const rejectMeta = getWorkflowActionMeta('reject');
  return [
    {
      key: 'create',
      method: 'POST',
      endpoint: '/api/v1/agent/tickets',
      url: appendApiBaseUrl(apiBaseUrl, '/api/v1/agent/tickets'),
      summary: '创建新工单；status 固定 triage，平台仍是 single writer。triage -> queue 须由 triage_owner 放行，且工单须已具备 assigned_agent 与 review_owner。',
      identity_field: 'actor',
      request_fields: [
        { key: 'actor', type: 'string', required: true, description: '发起 create 的 agent id；必须是平台注册 agent。' },
        { key: 'title', type: 'string', required: true, description: '工单标题。' },
        { key: 'description', type: 'string', required: false, description: '背景描述。' },
        { key: 'triage_summary', type: 'string', required: false, description: '给 reviewer/triage 的简述。' },
        { key: 'implementation_scope', type: 'string', required: false, description: '实现范围。' },
        { key: 'constraints', type: 'string', required: false, description: '约束与边界。' },
        { key: 'deliverables', type: 'string', required: false, description: '交付物。' },
        { key: 'acceptance_criteria', type: 'string', required: false, description: '验收标准。' },
        { key: 'platform', type: 'string', required: false, description: '业务平台，如 ticket-platform / stock-platform。' },
        { key: 'request_type', type: 'enum', required: false, description: 'feature|bug|optimization|ops。' },
        { key: 'parent_ticket_id', type: 'integer|null', required: false, description: '父工单 id。' },
        { key: 'execution_mode', type: 'enum', required: false, description: 'direct|subagent|acp。' },
        { key: 'max_active_workers', type: 'integer|null', required: false, description: '与 execution_mode 配套的 worker 限额。' },
        { key: 'assigned_agent', type: 'string', required: false, description: '可留空；若提供，当前仅允许等于 actor。' },
      ],
      constraints: [
        'status 固定 triage，不允许通过 create 直接把 ticket 建成 queued/running/done/complete。',
        'triage -> queue 须责任链已落链：assigned_agent、review_owner 必填；缺一则 transition queue 返回 409 TRIAGE_QUEUE_CHAIN_INCOMPLETE。',
        'triage_owner/review_owner/decision_owner/next_actor 不允许由 agent-facing create 直接覆盖。',
        'assigned_agent 只能留空或等于 actor，避免 agent 借 create 代他人提单/改派单。',
      ],
      response_contract: {
        status_code: 201,
        fields: ['success', 'action', 'ticket', 'available_actions'],
      },
      error_semantics: [
        { status_code: 400, code: 'Bad request', when: '必填字段缺失、枚举非法、parent_ticket_id 非法/不存在。' },
        { status_code: 403, code: 'AGENT_ACTION_FORBIDDEN', when: 'actor 非平台注册 agent，或 assigned_agent 试图指向他人。' },
      ],
      examples: [
        {
          label: '为自己补一张 follow-up 子工单',
          request: createExample,
        },
      ],
    },
    {
      key: 'queue',
      method: 'POST',
      endpoint: '/api/v1/agent/tickets/:id/queue',
      url: appendApiBaseUrl(apiBaseUrl, '/api/v1/agent/tickets/:id/queue'),
      summary: '由 triage_owner 对 triage ticket 执行 workflow queue，推进到 queued。',
      role_key: queueMeta?.role_key || 'triage_owner',
      allowed_statuses: queueMeta?.from || [],
      request_fields: [
        { key: 'actor', type: 'string', required: true, description: '必须等于当前 workflow 解释出的 triage_owner。' },
      ],
      constraints: [
        '只有 available_actions 包含 queue 时才能调用。',
        'actor 必须等于当前 action.role_key=triage_owner 解析出的身份。',
        '状态推进由平台执行；agent 只调用受控 action，不得直写状态。',
      ],
      response_contract: {
        status_code: 200,
        fields: ['success', 'action', 'ticket', 'available_actions'],
      },
      error_semantics: [
        { status_code: 404, code: 'Ticket not found', when: 'ticket 不存在。' },
        { status_code: 409, code: 'AGENT_ACTION_NOT_ALLOWED', when: '当前 status 不允许 queue；响应会返回 available_actions。' },
        { status_code: 403, code: 'AGENT_ACTION_FORBIDDEN', when: 'actor 不是当前允许执行 queue 的身份。' },
      ],
      examples: [
        { label: 'triage_owner 放行进入 queued', request: queueExample },
      ],
    },
    {
      key: 'start_work',
      method: 'POST',
      endpoint: '/api/v1/agent/tickets/:id/start-work',
      url: appendApiBaseUrl(apiBaseUrl, '/api/v1/agent/tickets/:id/start-work'),
      summary: '由 assigned_agent 对 queued ticket 执行 workflow start_work，推进到 running。',
      role_key: startWorkMeta?.role_key || 'current_actor',
      allowed_statuses: startWorkMeta?.from || [],
      request_fields: [
        { key: 'actor', type: 'string', required: true, description: '必须等于当前 workflow 解释出的 assigned_agent/current_actor。' },
      ],
      constraints: [
        '只有 available_actions 包含 start_work 时才能调用。',
        'actor 必须等于当前 action.role_key=current_actor 解析出的身份。',
        '若 execution_mode 要求 worker，则平台仍会校验 worker evidence 后才允许进入 running。',
      ],
      response_contract: {
        status_code: 200,
        fields: ['success', 'action', 'ticket', 'available_actions'],
      },
      error_semantics: [
        { status_code: 404, code: 'Ticket not found', when: 'ticket 不存在。' },
        { status_code: 409, code: 'AGENT_ACTION_NOT_ALLOWED', when: '当前 status 不允许 start_work；响应会返回 available_actions。' },
        { status_code: 403, code: 'AGENT_ACTION_FORBIDDEN', when: 'actor 不是当前允许执行 start_work 的身份。' },
        { status_code: 409, code: 'RUNNING_TICKET_CONFLICT', when: '当前 agent 已有其他 running 工单。' },
        { status_code: 409, code: 'EXECUTION_WORKER_REQUIRED', when: 'execution_mode 需要 worker evidence，但当前未登记 worker。' },
      ],
      examples: [
        { label: 'assigned_agent 开始处理 queued 工单', request: startWorkExample },
      ],
    },
    {
      key: 'pause',
      method: 'POST',
      endpoint: '/api/v1/agent/tickets/:id/pause',
      url: appendApiBaseUrl(apiBaseUrl, '/api/v1/agent/tickets/:id/pause'),
      summary: '对当前 ticket 执行 workflow pause action。',
      role_key: pauseMeta?.role_key || 'current_actor',
      allowed_statuses: pauseMeta?.from || [],
      request_fields: [
        { key: 'actor', type: 'string', required: true, description: '必须等于当前 workflow 解释出的可执行 actor。' },
        { key: 'pause_reason', type: 'string', required: true, description: '挂起原因；会写入 workflow pause metadata。' },
      ],
      constraints: [
        '只有 available_actions 包含 pause 时才能调用。',
        'actor 必须等于当前 action.role_key=current_actor 解析出的身份。',
      ],
      response_contract: {
        status_code: 200,
        fields: ['success', 'action', 'ticket', 'available_actions'],
      },
      error_semantics: [
        { status_code: 404, code: 'Ticket not found', when: 'ticket 不存在。' },
        { status_code: 409, code: 'AGENT_ACTION_NOT_ALLOWED', when: '当前 status 不允许 pause；响应会返回 available_actions。' },
        { status_code: 403, code: 'AGENT_ACTION_FORBIDDEN', when: 'actor 不是当前允许执行 pause 的身份。' },
      ],
      examples: [
        { label: '等待外部决策时挂起', request: pauseExample },
      ],
    },
    {
      key: 'resume',
      method: 'POST',
      endpoint: '/api/v1/agent/tickets/:id/resume',
      url: appendApiBaseUrl(apiBaseUrl, '/api/v1/agent/tickets/:id/resume'),
      summary: '对 paused ticket 执行 workflow resume action。',
      role_key: resumeMeta?.role_key || 'paused_by',
      allowed_statuses: resumeMeta?.from || [],
      request_fields: [
        { key: 'actor', type: 'string', required: true, description: '通常应等于 paused_by；若 paused_by 缺失则按 workflow fallback。' },
      ],
      constraints: [
        '只有 available_actions 包含 resume 时才能调用。',
        'actor 必须等于当前 action.role_key=paused_by 解析出的身份。',
        '恢复后的目标状态由 workflow 自动决定（通常回到 paused_from_status）。',
      ],
      response_contract: {
        status_code: 200,
        fields: ['success', 'action', 'ticket', 'available_actions'],
      },
      error_semantics: [
        { status_code: 404, code: 'Ticket not found', when: 'ticket 不存在。' },
        { status_code: 409, code: 'AGENT_ACTION_NOT_ALLOWED', when: '当前 status 不允许 resume；响应会返回 available_actions。' },
        { status_code: 403, code: 'AGENT_ACTION_FORBIDDEN', when: 'actor 不是当前允许执行 resume 的身份。' },
        { status_code: 409, code: 'RUNNING_TICKET_CONFLICT', when: 'resume 目标为 running，但该 agent 已有别的 running 工单。' },
      ],
      examples: [
        { label: '挂起条件解除后恢复', request: resumeExample },
      ],
    },
    {
      key: 'approve',
      method: 'POST',
      endpoint: '/api/v1/agent/tickets/:id/approve',
      url: appendApiBaseUrl(apiBaseUrl, '/api/v1/agent/tickets/:id/approve'),
      summary: '由 review_owner 对 done/review ticket 执行 workflow approve，推进到 complete。',
      role_key: approveMeta?.role_key || 'review_owner',
      allowed_statuses: approveMeta?.from || [],
      request_fields: [
        { key: 'actor', type: 'string', required: true, description: '必须等于当前 workflow 解释出的 review_owner。' },
        { key: 'assignment_id', type: 'string', required: true, description: '当前 reviewer assignment_id；需配合 assignment_token 一起提交。' },
      ],
      constraints: [
        '只有 available_actions 包含 approve 时才能调用。',
        'actor 必须等于当前 action.role_key=review_owner 解析出的身份。',
        'review 阶段必须携带当前 assignment_id + assignment_token。',
        'approve 前必须已通过 report API 成功提交至少一条 review_submission。',
      ],
      response_contract: {
        status_code: 200,
        fields: ['success', 'action', 'ticket', 'available_actions'],
      },
      error_semantics: [
        { status_code: 404, code: 'Ticket not found', when: 'ticket 不存在。' },
        { status_code: 409, code: 'AGENT_ACTION_NOT_ALLOWED', when: '当前 status 不允许 approve；响应会返回 available_actions。' },
        { status_code: 403, code: 'AGENT_ACTION_FORBIDDEN', when: 'actor 不是当前允许执行 approve 的身份。' },
      ],
      examples: [
        { label: 'review_owner 验收通过后关单', request: approveExample },
      ],
    },
    {
      key: 'reject',
      method: 'POST',
      endpoint: '/api/v1/agent/tickets/:id/reject',
      url: appendApiBaseUrl(apiBaseUrl, '/api/v1/agent/tickets/:id/reject'),
      summary: '由 review_owner 对 done/review ticket 执行 workflow reject，打回 queued。',
      role_key: rejectMeta?.role_key || 'review_owner',
      allowed_statuses: rejectMeta?.from || [],
      request_fields: [
        { key: 'actor', type: 'string', required: true, description: '必须等于当前 workflow 解释出的 review_owner。' },
        { key: 'assignment_id', type: 'string', required: true, description: '当前 reviewer assignment_id；需配合 assignment_token 一起提交。' },
        { key: 'reject_reason', type: 'string', required: true, description: '打回原因；会进入 workflow reject metadata。' },
      ],
      constraints: [
        '只有 available_actions 包含 reject 时才能调用。',
        'actor 必须等于当前 action.role_key=review_owner 解析出的身份。',
        'review 阶段必须携带当前 assignment_id + assignment_token。',
        'reject 前必须已通过 report API 成功提交至少一条 review_submission。',
        'reject_reason 必填，避免 reviewer 无因打回。',
      ],
      response_contract: {
        status_code: 200,
        fields: ['success', 'action', 'ticket', 'available_actions'],
      },
      error_semantics: [
        { status_code: 404, code: 'Ticket not found', when: 'ticket 不存在。' },
        { status_code: 409, code: 'AGENT_ACTION_NOT_ALLOWED', when: '当前 status 不允许 reject；响应会返回 available_actions。' },
        { status_code: 403, code: 'AGENT_ACTION_FORBIDDEN', when: 'actor 不是当前允许执行 reject 的身份。' },
        { status_code: 400, code: 'Bad request', when: 'reject_reason 缺失。' },
      ],
      examples: [
        { label: 'review_owner 验收未过，打回重做', request: rejectExample },
      ],
    },
  ];
}

function buildExecutionModeGuidance() {
  const execution = getExecutionSchema();
  const groupedRules = new Map();

  for (const rule of Array.isArray(execution.rules) ? execution.rules : []) {
    if (!groupedRules.has(rule.mode)) groupedRules.set(rule.mode, []);
    groupedRules.get(rule.mode).push({
      key: rule.key,
      description: rule.description,
    });
  }

  return (Array.isArray(execution.modes) ? execution.modes : []).map((modeMeta) => {
    const base = {
      mode: modeMeta.key,
      label: modeMeta.label,
      description: modeMeta.description,
      worker_type: modeMeta.worker_type || null,
      allow_worker: Boolean(modeMeta.allow_worker),
      default_max_active_workers: toNumberOrNull(modeMeta.default_max_active_workers) ?? 0,
      policy_rules: groupedRules.get(modeMeta.key) || [],
    };

    switch (modeMeta.key) {
      case 'subagent':
        return {
          ...base,
          spawn_required: true,
          running_requires_worker_evidence: true,
          preferred_runtime: 'subagent',
          coordinator_model: '当前 ticket session 只负责读 contract、派生/守护子代理、汇总结果并统一 heartbeat/report；不要把长执行继续堆在 ticket 主会话里。',
          worker_requirement: '进入 running 前必须先派生并登记 subagent worker；current_workers=0 且无 worker 迹象时不得直接 running。',
          kickoff_summary_template: '已按 execution_mode=subagent 下沉子代理执行，当前 ticket session 保持协调与统一回写。',
          progress_summary_template: '子代理已有阶段性结果；ticket session 正在汇总关键进展并继续回写。',
          completion_summary_template: '子代理执行已完成，ticket session 已汇总结果并准备提交验收。',
        };
      case 'acp':
        return {
          ...base,
          spawn_required: true,
          running_requires_worker_evidence: true,
          preferred_runtime: 'acp',
          coordinator_model: '当前 ticket session 负责调用 ACP harness（如 Cursor/Codex/Claude Code）、跟踪运行单元并统一 heartbeat/report；不要把 ACP 结果直接散落到 ticket 之外。',
          worker_requirement: '进入 running 前必须先派生并登记 ACP 运行单元；current_workers=0 且无 worker 迹象时不得直接 running。',
          kickoff_summary_template: '已按 execution_mode=acp 启动 ACP 编排，当前 ticket session 负责协调、节流与统一回写。',
          progress_summary_template: 'ACP 运行单元已有阶段性输出；ticket session 正在汇总差异、测试与风险。',
          completion_summary_template: 'ACP 执行已完成，ticket session 已汇总结果并准备提交验收。',
        };
      case 'direct':
      default:
        return {
          ...base,
          spawn_required: false,
          running_requires_worker_evidence: false,
          preferred_runtime: null,
          coordinator_model: '直接在当前 ticket session 处理；不要额外下沉子代理或 ACP，也不要登记 worker。',
          worker_requirement: '无需派生 worker；直接由当前 ticket session 处理。',
          kickoff_summary_template: '已按 execution_mode=direct 在当前 ticket session 直接处理。',
          progress_summary_template: '当前 ticket session 正在直接推进实现与验证。',
          completion_summary_template: '当前 ticket session 直接处理已完成，准备提交验收。',
        };
    }
  });
}

function buildStageAdvancePlaybook() {
  return [
    {
      stage: 'triage',
      goal: '把 triage 阶段推进到 queued，或明确说明为什么暂时不能 queue。',
      next_stage_options: ['queued', 'triage', 'pending_decision'],
      recommended_paths: [
        '责任链完整时提交 triage_structured_report，推动 triage -> queued。',
        '责任链/范围不完整时保留 triage，并在 report 里写明缺口与补齐条件。',
        '需要老大/reviewer 拍板时提交 decision_request。',
      ],
    },
    {
      stage: 'queued',
      goal: '把 queued 推进到 running 后继续收口，不能只停在 receipt。',
      next_stage_options: ['running', 'done', 'blocked', 'pending_decision', 'failed', 'paused'],
      recommended_paths: [
        'direct 模式：receipt 后尽快实现并用 execution_completed / blocked_report / decision_request / execution_failed 收口。',
        'subagent/acp 模式：先登记真实 worker，再推进 running 与后续收口。',
        '若暂时无法继续，也要明确 blocked / pending_decision / paused 的原因与恢复条件。',
      ],
    },
    {
      stage: 'running',
      goal: '把 running 收口到 done 或其他明确下一阶段。',
      next_stage_options: ['done', 'blocked', 'pending_decision', 'failed', 'paused'],
      recommended_paths: [
        '实现与验证完成后提交 execution_completed / review_submission，推动 running -> done。',
        '受外部阻塞时用 blocked_report。',
        '需要拍板时用 decision_request；不可恢复失败时用 execution_failed。',
      ],
    },
    {
      stage: 'done',
      goal: 'reviewer 接单后把 done 推进到 review，并继续形成验收结论。',
      next_stage_options: ['review', 'complete', 'queued', 'paused', 'pending_decision'],
      recommended_paths: [
        '先 dispatch_receipt，让 done -> review。',
        'reviewer 完成验收后先提 review_submission，再 approve / reject。',
        '若缺上下文，可 pause 或 decision_request，但不能只停在 receipt。',
      ],
    },
    {
      stage: 'review',
      goal: '给出 reviewer 正式验收结论。',
      next_stage_options: ['complete', 'queued', 'paused', 'pending_decision'],
      recommended_paths: [
        '先 review_submission，再 approve 推进到 complete。',
        '不通过则先 review_submission，再 reject 打回 queued。',
        '信息不足时 pause / decision_request，并明确待补项。',
      ],
    },
    {
      stage: 'blocked',
      goal: '解除阻塞并恢复推进，或明确升级路径。',
      next_stage_options: ['queued', 'running', 'pending_decision', 'blocked'],
      recommended_paths: [
        '阻塞解除后恢复到 queued/running 并继续推进。',
        '仍需外部拍板时提交 decision_request。',
        '持续 blocked 也要持续 heartbeat，写清 blocker、owner、恢复条件。',
      ],
    },
    {
      stage: 'paused',
      goal: '恢复到挂起前状态并继续推进，或明确保持挂起的条件。',
      next_stage_options: ['queued', 'running', 'review', 'paused', 'pending_decision'],
      recommended_paths: [
        '条件满足时 resume 回到 paused_from_status。',
        '条件未满足时 heartbeat 说明保持 paused 的原因与恢复信号。',
        '若需要额外拍板，用 decision_request。',
      ],
    },
    {
      stage: 'pending_decision',
      goal: '把待拍板问题讲清楚并等待明确结论。',
      next_stage_options: ['queued', 'running', 'review', 'complete', 'pending_decision'],
      recommended_paths: [
        '用 decision_request 写清可选方案、风险、建议。',
        '决策落定后回到对应执行/验收阶段继续推进。',
      ],
    },
  ];
}

function buildWritebackTemplates() {
  return {
    heartbeat: {
      channel: 'heartbeat',
      when: '开始接手当前阶段后尽快发送；长任务期间按关键里程碑或保活节奏刷新。',
      example: {
        assignment_token: '<assignment_token>',
        idempotency_key: 'ticket-48-kickoff',
        progress: {
          status: 'in_progress',
          percent: 10,
          message: '已按 execution_mode=subagent 下沉子代理，ticket session 保持协调与统一回写。',
        },
      },
    },
    dispatch_receipt: {
      report_type: 'dispatch_receipt',
      when: 'assignment 已送达目标 ticket session 后，agent 首次正式接单时立即回执；receipt 不是终点，后续必须继续把当前阶段推进到下一阶段；平台只在 decision=accepted 时推进 queued->running / done->review。',
      example: {
        assignment_token: '<assignment_token>',
        report_type: 'dispatch_receipt',
        idempotency_key: 'ticket-48-receipt',
        receipt: {
          dispatch_id: 123,
          ticket_id: 48,
          stage: 'queued',
          agent: 'beavy',
          decision: 'accepted',
          message: '已收到 assignment，开始按 contract 执行，并继续把 queued 阶段推进到下一阶段。',
        },
        progress: {
          status: 'in_progress',
          percent: 5,
          message: 'assignment receipt accepted',
        },
      },
    },
    progress_update: {
      report_type: 'progress_update',
      when: '执行策略已确认、出现关键里程碑、需要把 direct/subagent/acp 当前状态同步回平台时。',
      example: {
        assignment_token: '<assignment_token>',
        report_type: 'progress_update',
        idempotency_key: 'ticket-48-progress-1',
        summary: '已按 execution_mode=subagent 启动子代理，当前开始补 hosted bundle / manifest / 文档 / 测试。',
        progress: {
          status: 'in_progress',
          percent: 45,
          message: '子代理已回传首轮结果，ticket session 正在整理统一回写模板。',
        },
        proposed_next_step: {
          suggested_status: 'running',
          reason: '继续补测试并做最小验证后，再统一提交 execution_completed。',
        },
      },
    },
    execution_completed: {
      report_type: 'execution_completed',
      when: '当前阶段已完成，且已有可交付结果、验证记录与 reviewer 可读摘要时。',
      example: {
        assignment_token: '<assignment_token>',
        report_type: 'execution_completed',
        idempotency_key: 'ticket-48-complete',
        progress: {
          status: 'in_progress',
          percent: 100,
        },
        result: {
          summary: 'ticket-handler bundle 已适配 execution_mode，并统一 direct/subagent/acp 下沉策略与回写模板。',
          details_markdown: '- bundle markdown 新增 execution_mode 行为约束\n- manifest 新增 execution_mode_guidance / writeback_templates\n- assignment contract 直接下发当前 execution contract\n- 已补最小测试与文档说明',
        },
        artifacts: [
          {
            name: 'agent-facing tests',
            kind: 'test',
            path: 'api/app.test.js',
          },
        ],
      },
    },
    review_submission: {
      report_type: 'review_submission',
      when: '与 execution_completed 等价，但想显式强调“已提交 reviewer 验收”语义时。',
      example: {
        assignment_token: '<assignment_token>',
        report_type: 'review_submission',
        idempotency_key: 'ticket-48-review',
        result: {
          summary: '执行改造已完成，等待 reviewer 验收 execution_mode 与回写模板收口。',
          details_markdown: '适合在需要强调“已提审”而非仅“已完成实现”时使用。',
        },
      },
    },
    blocked_report: {
      report_type: 'blocked_report',
      when: '已确认当前阶段无法继续推进，需要平台把 ticket 收口到 blocked。',
      example: {
        assignment_token: '<assignment_token>',
        report_type: 'blocked_report',
        idempotency_key: 'ticket-48-blocked',
        summary: 'execution_mode 已判定为 acp，但当前 ACP harness 不可用，无法继续执行。',
        observation: {
          summary: '受外部执行编排能力影响，当前阶段阻塞。',
          blocked_by: [74],
        },
        proposed_next_step: {
          suggested_status: 'blocked',
          reason: '待 ACP harness 恢复后再继续。',
        },
      },
    },
    decision_request: {
      report_type: 'decision_request',
      when: '需要老大/reviewer 对 execution_mode、范围、风险或上线窗口拍板时。',
      example: {
        assignment_token: '<assignment_token>',
        report_type: 'decision_request',
        idempotency_key: 'ticket-48-decision',
        result: {
          summary: '当前工单文本同时命中 subagent 与 acp 策略，需要 reviewer 明确以哪种 execution_mode 为准。',
          details_markdown: '- 若选 subagent：继续由平台内子代理执行\n- 若选 acp：改由 ACP harness 编排，并保留 ticket session 统一回写',
        },
      },
    },
    execution_failed: {
      report_type: 'execution_failed',
      when: '执行链路已失败，且当前阶段不适合再维持 running / blocked，需要平台收口到 failed。',
      example: {
        assignment_token: '<assignment_token>',
        report_type: 'execution_failed',
        idempotency_key: 'ticket-48-failed',
        error: {
          message: 'ACP harness 启动失败，且 fallback 不允许改成 direct。',
        },
        result: {
          summary: 'execution_mode=acp 的执行链路失败，当前阶段无法继续完成。',
          details_markdown: '- 已尝试重试\n- 不允许改走 direct\n- 建议 reviewer 重新决策执行模式或恢复外部编排能力',
        },
      },
    },
  };
}

function renderJsonExample(example) {
  return ['~~~json', JSON.stringify(example, null, 2), '~~~'].join('\n');
}

export function buildAgentWorkboards({ apiBaseUrl = null } = {}) {
  return [
    {
      key: 'stock-tickets',
      title: 'Stock Platform Workboard',
      summary: '股票平台全局盘面：返回 stock-platform 工单的筛选结果、状态/桶统计与分组视图。',
      endpoint: '/api/v1/agent/workboards/stock-tickets',
      url: appendApiBaseUrl(apiBaseUrl, '/api/v1/agent/workboards/stock-tickets'),
      default_filters: {
        platform: 'stock-platform',
        group_by: 'none',
        sort: 'updated_desc',
      },
      buckets: Object.values(AGENT_WORKBOARD_BUCKET_META),
      supported_query_params: AGENT_STOCK_WORKBOARD_QUERY_PARAMS,
      query_examples: [
        {
          label: '全部 stock 平台工单盘面',
          query: '/api/v1/agent/workboards/stock-tickets',
        },
        {
          label: '只看执行中的 stock 工单，按当前责任人分组',
          query: '/api/v1/agent/workboards/stock-tickets?status=running&group_by=current_actor',
        },
        {
          label: '看待验收 / 阻塞盘面，按 bucket 聚合',
          query: '/api/v1/agent/workboards/stock-tickets?bucket=waiting_review,blocked&group_by=bucket&sort=priority_desc',
        },
        {
          label: '只看 cowder 负责且存在依赖的子工单',
          query: '/api/v1/agent/workboards/stock-tickets?assigned_agent=cowder&has_dependencies=true&parent_ticket_id=46',
        },
      ],
      response_contract: {
        summary: ['total_filtered', 'by_status', 'by_bucket'],
        items: ['bucket', 'relation_summary', 'last_comment_excerpt'],
        groups: ['group_by', 'group_key', 'count', 'items'],
      },
    },
  ];
}

function buildAgentDiscoverability({ apiBaseUrl = null } = {}) {
  return {
    workboards: buildAgentWorkboards({ apiBaseUrl }),
    ticket_actions: buildAgentTicketActionApis({ apiBaseUrl }),
  };
}

function buildHostedSkillMarkdown() {
  const executionGuidance = buildExecutionModeGuidance();
  const writebackTemplates = buildWritebackTemplates();
  const stageAdvancePlaybook = buildStageAdvancePlaybook();
  const sections = [
    '# Ticket Handler（平台托管 bundle）',
    '',
    '## 用途',
    '用于 agent-ticket-system 的执行 agent 在收到 assignment 后，按平台统一 contract 完成 execution_mode 判定、read / heartbeat / report 闭环。',
    '',
    '## 最小 bootstrap path',
    '1. 读取 runtime context：确认 api_base_url、gateway、feature flags。',
    '2. 读取 assignment：获得当前 ticket 目标、约束、skill/playbook 引用，以及当前 execution_mode contract。',
    '3. 拉取当前 skill/playbook bundle：获取 markdown + machine-readable manifest。',
    '4. 如需更多上下文，再读 dependencies / comments。',
    '5. 执行过程中只提交 heartbeat / reports；由平台解释为 comment / transition / notify。',
    '5.1 assignment 送达后先提交 dispatch_receipt；receipt 不是终点，当前阶段必须继续推进到下一阶段；平台只在 receipt.decision=accepted 时推进 queued->running / done->review；若 stage=review，则仅确认 reviewer 已正式接单并停止重派。',
    '6. 若当前需要正式提单、挂起/恢复，或 reviewer 需要 approve/reject，优先使用 agent-facing ticket action API，而不是猜测 comment/transition 直写。',
    '6.1 reviewer 阶段必须遵循 dispatch_receipt -> review_submission -> approve/reject 顺序；不能 receipt 后直接关单或打回。',
    '',
    '## 强约束',
    '- single-writer：平台是 ticket comment / transition 的唯一写入者。',
    '- agent 禁止直接写 ticket comment / transition。',
    '- assignment/read/comment/dependencies/heartbeat/report 走 assignment_token 鉴权。',
    '- 当前允许的 report_type 仅限 manifest.allowed_report_types。',
    '- dispatch_receipt 必须携带 dispatch_id / ticket_id / stage / agent / decision / message；decision=accepted 之外的平台只记 receipt，不推进状态；stage=review + accepted 也只记 receipt/停止重派，不额外改状态。',
    '- execution_mode 以 assignment.ticket.execution_mode 与 workflow schema.execution 为准；skill 只能做策略适配，不能绕过平台 enforce。',
    '',
    '## execution_mode 适配规则',
    '- 先看 assignment.ticket.execution_mode，再参考 assignment.execution / workflow schema.execution。',
    '- 若 execution_mode=direct，就在当前 ticket session 直接处理；不要再下沉子代理或 ACP。',
    '- 若 execution_mode=subagent 或 acp，当前 ticket session 只做协调与统一回写，不要把长执行继续堆在 ticket 主会话里。',
    '- 若 execution_mode=subagent 或 acp，进入 running 前必须先派生并登记 worker；current_workers=0 且无真实 worker 迹象时，不要直接把 ticket 推进到 running。',
    '- subagent / acp 完成回写前，至少要能在 assignment.ticket.worker_stats / current_workers / execution_workers、GET /api/tickets/:id 或 /api/tickets/:id/workers 中看到真实 worker 迹象。',
  ];

  executionGuidance.forEach((mode) => {
    sections.push(
      '',
      `### ${mode.mode}（${mode.label}）`,
      `- 描述：${mode.description}`,
      `- 会话模型：${mode.coordinator_model}`,
      `- 是否必须下沉：${mode.spawn_required ? '是' : '否'}`,
      `- running 前是否必须先有 worker 迹象：${mode.running_requires_worker_evidence ? '是' : '否'}`,
      `- worker 约束：${mode.worker_requirement}`,
      `- 推荐 runtime：${mode.preferred_runtime || '无'}`,
      `- worker_type：${mode.worker_type || '无'}`,
      `- 默认 max_active_workers：${mode.default_max_active_workers}`,
      `- 完成前是否要求 worker 证据：${mode.spawn_required && mode.allow_worker ? '是' : '否'}`,
      `- 启动摘要模板：${mode.kickoff_summary_template}`,
      `- 进度摘要模板：${mode.progress_summary_template}`,
      `- 完成摘要模板：${mode.completion_summary_template}`,
      `- 平台策略来源：${mode.policy_rules.length > 0 ? mode.policy_rules.map((rule) => `${rule.key}（${rule.description}）`).join('；') : 'direct_default（未命中下沉策略时兜底）'}`,
    );
  });

  const ticketActions = buildAgentTicketActionApis();

  sections.push(
    '',
    '## Agent-Facing Ticket Action API（受控写动作）',
    '- 这些接口仍由平台执行 workflow 写入；agent 不能借此直接绕过 single-writer。',
    '- create 只允许创建 queued 新单；pause/resume/approve/reject 都只允许按 workflow allowed_actions 执行。',
    '- review_owner 可在 done/review 阶段通过 approve/reject 受控推进 complete 或打回 queued；这仍由平台统一写 workflow。',
    '- reviewer 不能在 dispatch_receipt 后直接 approve/reject；必须先提交 review_submission 留下正式验收结论。',
    '- running/paused -> queued 的 `reset_to_queued` 属于平台管理动作，不在 agent-facing ticket_actions 直写范围内；应由 triage_owner 通过常规 transition 管理面执行，并填写 `reason`。',
    '- 调用前先看 runtime context / workflow schema / available_actions，避免猜当前是否可 pause/resume/approve/reject。',
  );

  ticketActions.forEach((action) => {
    sections.push(
      '',
      `### ${action.key}`,
      `- 方法：${action.method} ${action.endpoint}`,
      `- 用途：${action.summary}`,
      ...(Array.isArray(action.allowed_statuses) && action.allowed_statuses.length > 0
        ? [`- allowed_statuses：${action.allowed_statuses.join(', ')}`]
        : []),
      ...(action.role_key ? [`- role_key：${action.role_key}`] : []),
      '- 关键约束：',
      ...action.constraints.map((item) => `  - ${item}`),
      '- 请求示例：',
      ...action.examples.map((example) => [`  - ${example.label}`, renderJsonExample(example.request)].join('\n')),
    );
  });

  sections.push(
    '',
    '## 统一回写模板',
    '- direct / subagent / acp 都用同一套 heartbeat/report contract；差别只体现在 summary/details 里必须写清 execution_mode 与当前协调状态。',
    '- subagent / acp 模式下，由 ticket session 汇总子执行单元结果后再回写，不要把平台 comment/report 直接分散到外部执行单元。',
  );

  Object.entries(writebackTemplates).forEach(([key, template]) => {
    const title = template.report_type ? `${key}（report）` : `${key}（${template.channel}）`;
    sections.push(
      '',
      `### ${title}`,
      `- 什么时候用：${template.when}`,
      '- 示例：',
      renderJsonExample(template.example),
    );
  });

  sections.push(
    '',
    '## 当前阶段推进剧本（receipt 不是终点）',
    '- 所有 stage 通用要求：先 dispatch_receipt，再把当前阶段推进到一个明确的下一阶段或收口状态。',
    '- 若暂时不能推进，也必须用 heartbeat / progress_update / blocked_report / decision_request 说明原因、证据、恢复条件与建议下一步。',
  );

  stageAdvancePlaybook.forEach((item) => {
    sections.push(
      '',
      `### stage=${item.stage}`,
      `- 当前阶段目标：${item.goal}`,
      `- 下一阶段可选项：${item.next_stage_options.join(' / ')}`,
      '- 推荐收口路径：',
      ...item.recommended_paths.map((path) => `  - ${path}`),
    );
  });

  sections.push(
    '',
    '## 建议执行方式',
    '- queued / running 阶段都先回源上下文，再决定 direct / subagent / acp 的具体执行姿势。',
    '- assignment 送达后先回 dispatch_receipt；receipt 不是终点，后续必须继续把当前阶段推进到下一阶段；只有 receipt=accepted 才会推进 queued->running / done->review；review 阶段则只确认正式接单并停止重派。',
    '- 进入执行后尽快发 heartbeat；关键里程碑用 progress_update。',
    '- 执行完成后优先提交 execution_completed 或 review_submission。',
    '- 若当前是 reviewer assignment，则必须先提交 review_submission，再调用 approve/reject。',
    '- 若遇阻塞，提交 blocked_report；若需要老大拍板，提交 decision_request。',
    '',
    '## Stock Workboard API（平台内置 discoverability）',
    '- 入口：GET /api/v1/agent/workboards/stock-tickets',
    '- 默认：只看 platform=stock-platform',
    '- 支持 query：status、bucket、assigned_agent、current_actor、review_owner、has_dependencies、parent_ticket_id、group_by、sort、limit、offset',
    '- 返回：summary.by_status/by_bucket + items/groups，每条 item 至少包含 bucket、relation_summary、last_comment_excerpt',
    '- 示例：',
    '  - GET /api/v1/agent/workboards/stock-tickets?status=running&group_by=current_actor',
    '  - GET /api/v1/agent/workboards/stock-tickets?bucket=waiting_review,blocked&group_by=bucket&sort=priority_desc',
    '',
    '## 兼容范围',
    '- 适用于本地 / 远端 gateway。',
    '- 适用于 direct / subagent / acp 三种 execution_mode。',
    '- 本 bundle 是平台下发 contract，不依赖本地静态 SKILL.md。',
  );

  return sections.join('\n');
}

function buildHostedSkillRules() {
  return [
    {
      key: 'single_writer',
      value: true,
      description: '平台是 ticket comment / transition / notify 的唯一写入者。',
    },
    {
      key: 'direct_ticket_write_forbidden',
      value: true,
      description: 'agent 不得直接调用 ticket comment / transition 写接口。',
    },
    {
      key: 'assignment_token_required',
      value: true,
      description: 'assignment/read/comment/dependencies/heartbeat/report 均需 assignment_token。',
    },
    {
      key: 'allowed_report_types',
      value: AGENT_REPORT_TYPES,
      description: '仅允许使用平台声明的 report types。',
    },
    {
      key: 'execution_mode_contract_required',
      value: true,
      description: 'agent 必须按 assignment.ticket.execution_mode 与 workflow schema.execution 行事，不能自创另一套下沉规则。',
    },
  ];
}

function buildReplyContract({ assignmentId = ':assignment_id', apiBaseUrl = null } = {}) {
  const heartbeatPath = buildAgentPath(`/assignments/${assignmentId}/heartbeat`);
  const reportPath = buildAgentPath(`/assignments/${assignmentId}/reports`);
  const templates = buildWritebackTemplates();
  return {
    version: 'v1',
    kind: 'agent.reply_contract',
    transport: 'http',
    auth: buildAgentAuthContract(),
    request_id: buildRequestIdContract(),
    error_model: buildAgentErrorModel(),
    legacy_aliases: [
      buildLegacyAlias(`/assignments/${assignmentId}/heartbeat`),
      buildLegacyAlias(`/assignments/${assignmentId}/reports`),
    ],
    channels: {
      heartbeat: {
        method: 'POST',
        endpoint: heartbeatPath,
        url: buildAgentUrl(apiBaseUrl, `/assignments/${assignmentId}/heartbeat`),
        example: templates.heartbeat.example,
      },
      reports: {
        method: 'POST',
        endpoint: reportPath,
        url: buildAgentUrl(apiBaseUrl, `/assignments/${assignmentId}/reports`),
        allowed_report_types: AGENT_REPORT_TYPES,
      },
    },
    reply_types: Object.entries(templates).map(([key, template]) => ({
      kind: key,
      report_type: template.report_type || null,
      when: template.when,
      example: template.example,
    })),
  };
}

function buildHostedSkillManifest() {
  return {
    manifest_version: 'v1',
    kind: 'agent.skill_bundle_manifest',
    skill_id: AGENT_SKILL_ID,
    playbook_key: AGENT_PLAYBOOK_KEY,
    version: AGENT_PLAYBOOK_VERSION,
    title: 'Ticket Platform Hosted Ticket Handler',
    summary: '平台托管的 agent ticket handling playbook bundle，覆盖 execution_mode 适配、read / skill fetch / heartbeat / report 回写 contract。',
    namespace: {
      canonical_prefix: AGENT_API_PREFIX,
      legacy_prefixes: [AGENT_API_LEGACY_PREFIX],
    },
    auth: buildAgentAuthContract(),
    request_id: buildRequestIdContract(),
    error_model: buildAgentErrorModel(),
    reply_contract: buildReplyContract(),
    allowed_report_types: AGENT_REPORT_TYPES,
    rules: buildHostedSkillRules(),
    constraints: {
      single_writer: true,
      platform_writer: 'ticket-platform',
      direct_ticket_write_allowed: false,
      assignment_token_required: true,
      allowed_report_types: AGENT_REPORT_TYPES,
    },
    bootstrap: buildBootstrapEndpoints(),
    supported_execution_modes: ['direct', 'subagent', 'acp'],
    supported_gateways: ['local', 'remote'],
    execution_mode_guidance: buildExecutionModeGuidance(),
    writeback_templates: buildWritebackTemplates(),
    workboards: buildAgentWorkboards(),
    discoverability: buildAgentDiscoverability(),
    ticket_actions: buildAgentTicketActionApis(),
    artifact_contract: {
      max_items: 10,
      max_inline_bytes: 65536,
    },
  };
}

function buildHostedSkillChecksum({ manifest, markdown }) {
  return createHash('sha256')
    .update(JSON.stringify(manifest))
    .update('\n---\n')
    .update(markdown)
    .digest('hex');
}

export function buildCurrentAgentSkillBundle() {
  const markdown = buildHostedSkillMarkdown();
  const manifest = buildHostedSkillManifest();
  const checksumSha256 = buildHostedSkillChecksum({ manifest, markdown });
  const discoverability = buildAgentDiscoverability();
  return {
    kind: 'agent.skill_bundle',
    api_version: AGENT_API_VERSION,
    schema_version: AGENT_SCHEMA_VERSION,
    skill_id: AGENT_SKILL_ID,
    playbook_key: AGENT_PLAYBOOK_KEY,
    version: AGENT_PLAYBOOK_VERSION,
    title: manifest.title,
    summary: manifest.summary,
    checksum_sha256: checksumSha256,
    markdown,
    workboards: discoverability.workboards,
    ticket_actions: discoverability.ticket_actions,
    discoverability,
    manifest,
    auth: buildAgentAuthContract(),
    request_id: buildRequestIdContract(),
    error_model: buildAgentErrorModel(),
    ref: {
      skill_id: AGENT_SKILL_ID,
      playbook_key: AGENT_PLAYBOOK_KEY,
      version: AGENT_PLAYBOOK_VERSION,
      checksum_sha256: checksumSha256,
      current_url: '/api/v1/agent/skills/current',
      playbook_url: `/api/v1/agent/playbooks/${AGENT_PLAYBOOK_KEY}`,
      legacy_current_url: buildLegacyAlias('/skills/current'),
      legacy_playbook_url: buildLegacyAlias(`/playbooks/${AGENT_PLAYBOOK_KEY}`),
    },
  };
}

export function buildAgentPlaybookRef() {
  const bundle = buildCurrentAgentSkillBundle();
  return bundle.ref;
}

export function buildAssignmentLinks(assignmentId) {
  const base = buildAgentPath(`/assignments/${assignmentId}`);
  return {
    self: base,
    dependencies: `${base}/dependencies`,
    comments: `${base}/comments`,
    live_acceptance: `${base}/live-acceptance`,
    workflow: buildAgentPath('/workflow/schema'),
    runtime: buildAgentPath('/runtime/context'),
    report: `${base}/reports`,
    heartbeat: `${base}/heartbeat`,
    ticket_create: buildAgentPath('/tickets'),
    ticket_pause: buildAgentPath('/tickets/:id/pause'),
    ticket_resume: buildAgentPath('/tickets/:id/resume'),
    ticket_approve: buildAgentPath('/tickets/:id/approve'),
    ticket_reject: buildAgentPath('/tickets/:id/reject'),
    skill_current: buildAgentPath('/skills/current'),
    playbook_current: buildAgentPath(`/playbooks/${AGENT_PLAYBOOK_KEY}`),
    stock_tickets_workboard: buildAgentPath('/workboards/stock-tickets'),
    legacy_aliases: {
      self: buildLegacyAlias(`/assignments/${assignmentId}`),
      dependencies: buildLegacyAlias(`/assignments/${assignmentId}/dependencies`),
      comments: buildLegacyAlias(`/assignments/${assignmentId}/comments`),
      live_acceptance: buildLegacyAlias(`/assignments/${assignmentId}/live-acceptance`),
      workflow: buildLegacyAlias('/workflow/schema'),
      runtime: buildLegacyAlias('/runtime/context'),
      report: buildLegacyAlias(`/assignments/${assignmentId}/reports`),
      heartbeat: buildLegacyAlias(`/assignments/${assignmentId}/heartbeat`),
      ticket_create: buildLegacyAlias('/tickets'),
      ticket_pause: buildLegacyAlias('/tickets/:id/pause'),
      ticket_resume: buildLegacyAlias('/tickets/:id/resume'),
      ticket_approve: buildLegacyAlias('/tickets/:id/approve'),
      ticket_reject: buildLegacyAlias('/tickets/:id/reject'),
      skill_current: buildLegacyAlias('/skills/current'),
      playbook_current: buildLegacyAlias(`/playbooks/${AGENT_PLAYBOOK_KEY}`),
      stock_tickets_workboard: buildLegacyAlias('/workboards/stock-tickets'),
    },
  };
}

export function resolveAssignmentToken(req) {
  return String(
    req.get('x-assignment-token')
      || req.query?.assignment_token
      || req.body?.assignment_token
      || ''
  ).trim();
}

function summarizeComment(comment = {}) {
  const content = String(comment.content || '').trim();
  if (!content) return null;
  return {
    at: comment.timestamp || null,
    by: comment.author || null,
    excerpt: content.slice(0, 240),
    type: comment.type || 'progress',
  };
}

function getLatestMeaningfulComment(ticket = {}) {
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const summary = summarizeComment(comments[i]);
    if (summary) return summary;
  }
  return null;
}

function buildGoal(ticket = {}) {
  return {
    summary: ticket.triage_summary || ticket.title || '',
    instructions_markdown: [
      ticket.description ? `## 背景\n${ticket.description}` : null,
      ticket.implementation_scope ? `## 实现范围\n${ticket.implementation_scope}` : null,
      ticket.constraints ? `## 约束\n${ticket.constraints}` : null,
      ticket.deliverables ? `## 交付物\n${ticket.deliverables}` : null,
      ticket.acceptance_criteria ? `## 验收标准\n${ticket.acceptance_criteria}` : null,
    ].filter(Boolean).join('\n\n'),
  };
}

function buildAssignmentDeliveryState(assignment = {}, ticket = {}) {
  const assignmentStage = assignment.stage || null;
  const liveStatus = ticket.status || null;
  const supplemental = ticket.supplemental_for_ticket?.ticket
    ? {
        relation_type: ticket.supplemental_for_ticket.relation_type,
        relation_label: ticket.supplemental_for_ticket.relation_label,
        primary_ticket: ticket.supplemental_for_ticket.ticket,
      }
    : null;

  if (assignmentStage && liveStatus && assignmentStage !== liveStatus) {
    return {
      stale: true,
      stale_reason: 'ticket_status_changed_after_dispatch',
      live_ticket_status: liveStatus,
      assignment_stage: assignmentStage,
      ...(supplemental ? {
        primary_ticket_id: supplemental.primary_ticket.id,
        primary_ticket_status: supplemental.primary_ticket.status || null,
      } : {}),
    };
  }

  if (supplemental?.primary_ticket?.status === 'complete' && ['done', 'review', 'complete'].includes(liveStatus || assignmentStage || '')) {
    return {
      stale: true,
      stale_reason: 'supplemental_ticket_after_primary_complete',
      live_ticket_status: liveStatus,
      assignment_stage: assignmentStage,
      primary_ticket_id: supplemental.primary_ticket.id,
      primary_ticket_status: supplemental.primary_ticket.status || null,
      relation_type: supplemental.relation_type,
      relation_label: supplemental.relation_label,
    };
  }

  return {
    stale: false,
    stale_reason: null,
    live_ticket_status: liveStatus,
    assignment_stage: assignmentStage,
  };
}

function buildAssignmentExecutionContract(ticket = {}, assignment = {}) {
  const requestedMode = ticket.execution_mode || assignment.execution_mode || 'direct';
  const meta = getExecutionModeMeta(requestedMode) || {};
  const mode = meta.key || requestedMode || 'direct';
  const guidanceList = buildExecutionModeGuidance();
  const guidance = guidanceList.find((item) => item.mode === mode)
    || guidanceList.find((item) => item.mode === 'direct')
    || null;
  const workerEvidence = buildWorkerEvidenceSnapshot(ticket);
  const workerEvidenceRequired = Boolean(guidance?.spawn_required && meta.allow_worker);

  return {
    mode,
    mode_source: ticket.execution_mode_source || null,
    rule_key: ticket.execution_rule_key || null,
    max_active_workers: toNumberOrNull(ticket.max_active_workers) ?? toNumberOrNull(meta.default_max_active_workers) ?? 0,
    worker_type: meta.worker_type || null,
    allow_worker: Boolean(meta.allow_worker),
    worker_evidence_required: workerEvidenceRequired,
    worker_evidence: {
      required: workerEvidenceRequired,
      has_worker_evidence: workerEvidence.has_worker_evidence,
      worker_stats: workerEvidence.worker_stats,
      current_workers: workerEvidence.current_workers,
      execution_workers: workerEvidence.execution_workers,
    },
    description: meta.description || null,
    guidance: guidance ? {
      coordinator_model: guidance.coordinator_model,
      spawn_required: guidance.spawn_required,
      running_requires_worker_evidence: guidance.running_requires_worker_evidence,
      worker_requirement: guidance.worker_requirement,
      preferred_runtime: guidance.preferred_runtime,
      kickoff_summary_template: guidance.kickoff_summary_template,
      progress_summary_template: guidance.progress_summary_template,
      completion_summary_template: guidance.completion_summary_template,
    } : null,
    running_requires_worker_evidence: Boolean(guidance?.running_requires_worker_evidence),
    worker_requirement: guidance?.worker_requirement || null,
    writeback_contract: {
      kickoff_channel: 'heartbeat',
      receipt_report_type: 'dispatch_receipt',
      progress_report_type: 'progress_update',
      completion_report_types: ['execution_completed', 'review_submission'],
      blocked_report_type: 'blocked_report',
      decision_report_type: 'decision_request',
      failure_report_type: 'execution_failed',
    },
  };
}

export function buildAssignmentContract(assignment = {}, ticket = {}) {
  const gateway = getGatewayForAgent(assignment.agent_id) || {};
  const playbookRef = buildAgentPlaybookRef();
  const deliveryState = buildAssignmentDeliveryState(assignment, ticket);
  const runtimeContext = buildRuntimeContext({ assignment });
  const execution = buildAssignmentExecutionContract(ticket, assignment);
  const workerEvidence = buildWorkerEvidenceSnapshot(ticket);
  const actorContract = buildWorkflowActorContract(ticket);
  return {
    kind: 'agent.assignment',
    api_version: AGENT_API_VERSION,
    schema_version: AGENT_SCHEMA_VERSION,
    assignment_id: assignment.assignment_id,
    assignment_status: assignment.assignment_status,
    ticket: {
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority || 'medium',
      platform: ticket.platform || null,
      execution_mode: execution.mode,
      execution_mode_source: execution.mode_source,
      execution_rule_key: execution.rule_key,
      max_active_workers: execution.max_active_workers,
      worker_stats: workerEvidence.worker_stats,
      current_workers: workerEvidence.current_workers,
      execution_workers: workerEvidence.execution_workers,
      execution_guard: ticket.execution_guard || null,
      dispatch_state: ticket.dispatch_state || null,
      awaiting_receipt_from: ticket.awaiting_receipt_from || null,
      dispatch_ack_deadline_at: ticket.dispatch_ack_deadline_at || null,
      dispatch_retry_count: Number(ticket.dispatch_retry_count ?? 0),
      next_dispatch_retry_at: ticket.next_dispatch_retry_at || null,
      dispatch_timeout_reason: ticket.dispatch_timeout_reason || null,
      dispatch_watchers: Array.isArray(ticket.dispatch_watchers) ? ticket.dispatch_watchers : [],
      dispatch_escalation_targets: Array.isArray(ticket.dispatch_escalation_targets) ? ticket.dispatch_escalation_targets : [],
      triage_owner: ticket.triage_owner || null,
      review_owner: ticket.review_owner || null,
      current_actor: actorContract.current_actor,
      current_actor_source: actorContract.current_actor_source,
      next_actor: actorContract.next_actor,
      next_actor_source: actorContract.next_actor_source,
      next_actor_override: actorContract.next_actor_override,
      manual_override_active: actorContract.manual_override_active,
      should_notify: actorContract.should_notify,
      workflow_notify_policy: actorContract.workflow_notify_policy,
      parent_ticket_id: ticket.parent_ticket_id || null,
    },
    execution,
    agent: {
      id: assignment.agent_id,
      role: assignment.role || 'execute',
      gateway_id: assignment.gateway_id || gateway.id || null,
      target_session_key: assignment.target_session_key || null,
      transport: assignment.transport || gateway.transport || null,
    },
    goal: buildGoal(ticket),
    skill_ref: playbookRef,
    playbook_ref: playbookRef,
    permissions: {
      can_report: true,
      can_heartbeat: true,
      can_read_dependencies: true,
      can_read_comments: true,
      can_request_decision: true,
      can_fetch_skill_bundle: true,
      can_direct_ticket_write: false,
    },
    contract: {
      report_schema_version: 'v1',
      workflow_schema_version: AGENT_SCHEMA_VERSION,
      report_types: AGENT_REPORT_TYPES,
      allowed_report_types: AGENT_REPORT_TYPES,
      single_writer: true,
      platform_writer: 'ticket-platform',
      auth: buildAgentAuthContract(),
      request_id: buildRequestIdContract(),
      error_model: buildAgentErrorModel(),
      playbook_ref: playbookRef,
    },
    delivery: {
      intent: assignment.intent || 'dispatch',
      stage: assignment.stage || ticket.status || null,
      created_at: assignment.created_at || null,
      updated_at: assignment.updated_at || null,
      dispatch_event_id: assignment.dispatch_event_id ?? null,
      dispatch_state: ticket.dispatch_state || null,
      awaiting_receipt_from: ticket.awaiting_receipt_from || null,
      dispatch_ack_deadline_at: ticket.dispatch_ack_deadline_at || null,
      dispatch_retry_count: Number(ticket.dispatch_retry_count ?? 0),
      next_dispatch_retry_at: ticket.next_dispatch_retry_at || null,
      dispatch_timeout_reason: ticket.dispatch_timeout_reason || null,
      stale: deliveryState.stale,
      stale_reason: deliveryState.stale_reason,
      live_ticket_status: deliveryState.live_ticket_status,
      assignment_stage: deliveryState.assignment_stage,
      ...(deliveryState.primary_ticket_id ? {
        primary_ticket_id: deliveryState.primary_ticket_id,
        primary_ticket_status: deliveryState.primary_ticket_status,
      } : {}),
      ...(deliveryState.relation_type ? {
        relation_type: deliveryState.relation_type,
        relation_label: deliveryState.relation_label,
      } : {}),
    },
    runtime_context: runtimeContext,
    reply_contract: buildReplyContract({ assignmentId: assignment.assignment_id, apiBaseUrl: runtimeContext.api_base_url }),
    links: buildAssignmentLinks(assignment.assignment_id),
    heartbeat: {
      last_heartbeat_at: assignment.last_heartbeat_at || null,
      last_reported_at: assignment.last_reported_at || null,
      latest_progress: assignment.latest_progress || {},
    },
    latest_meaningful_update: getLatestMeaningfulComment(ticket),
  };
}

export function buildDependencySnapshot(sourceTicket = {}, relation, targetTicket = {}, dependencyType = 'blocks') {
  const status = targetTicket.status || null;
  const satisfied = ['done', 'complete'].includes(status);
  const blocking = dependencyType === 'blocks' ? !satisfied : false;
  return {
    relation,
    dependency_type: dependencyType,
    ticket_id: targetTicket.id,
    title: targetTicket.title,
    status,
    assigned_agent: targetTicket.assigned_agent || null,
    next_actor: targetTicket.next_actor || targetTicket.current_actor || null,
    satisfied,
    blocking,
    summary: targetTicket.result_summary || targetTicket.triage_summary || targetTicket.title || '',
    latest_meaningful_update: getLatestMeaningfulComment(targetTicket),
  };
}

export function classifyCommentActor(comment = {}, ticket = {}, assignment = {}) {
  const author = String(comment.author || '').trim();
  if (!author) return 'unknown';
  if (author === assignment.agent_id) return 'agent';
  if (author === ticket.review_owner) return 'review_owner';
  if (author === ticket.decision_owner) return 'decision_owner';
  if (author === ticket.triage_owner) return 'triage_owner';
  if (['platform', 'system'].includes(author.toLowerCase())) return 'platform';
  return 'other';
}

export function buildAgentWorkflowSchema() {
  return {
    ...getWorkflowSchema(),
    api_version: AGENT_API_VERSION,
    schema_version: AGENT_SCHEMA_VERSION,
    current_skill_bundle: buildAgentPlaybookRef(),
    workboards: buildAgentWorkboards(),
    ticket_actions: buildAgentTicketActionApis(),
    agent_contract: {
      direct_ticket_writes_allowed: false,
      single_writer: true,
      namespace: {
        canonical_prefix: AGENT_API_PREFIX,
        legacy_prefixes: [AGENT_API_LEGACY_PREFIX],
      },
      auth: buildAgentAuthContract(),
      request_id: buildRequestIdContract(),
      error_model: buildAgentErrorModel(),
      token_transport: ['x-assignment-token', 'assignment_token(body/query)'],
      report_types: AGENT_REPORT_TYPES,
      playbook_fetch_supported: true,
      ticket_actions_supported: ['create', 'queue', 'start_work', 'pause', 'resume', 'approve', 'reject'],
    },
  };
}

export function buildRuntimeContext({ assignment = null } = {}) {
  const registry = getAgentTopologyRegistry();
  const gateway = assignment?.agent_id ? getGatewayForAgent(assignment.agent_id) : null;
  const playbookRef = buildAgentPlaybookRef();
  const apiBaseUrl = getAgentApiBaseUrl({ gatewayId: assignment?.gateway_id || gateway?.id });
  const discoverability = buildAgentDiscoverability({ apiBaseUrl });
  return {
    kind: 'agent.runtime_context',
    api_version: AGENT_API_VERSION,
    schema_version: AGENT_SCHEMA_VERSION,
    agent_id: assignment?.agent_id || null,
    gateway_id: assignment?.gateway_id || gateway?.id || null,
    platform_host_gateway_id: registry.main_gateway_id,
    api_base_url: apiBaseUrl,
    namespace: {
      canonical_prefix: AGENT_API_PREFIX,
      legacy_prefixes: [AGENT_API_LEGACY_PREFIX],
    },
    auth: buildAgentAuthContract(),
    request_id: buildRequestIdContract(),
    error_model: buildAgentErrorModel(),
    skill_ref: playbookRef,
    playbook_ref: playbookRef,
    bootstrap: buildBootstrapEndpoints(),
    workboards: discoverability.workboards,
    ticket_actions: discoverability.ticket_actions,
    discoverability,
    report_limits: {
      max_markdown_chars: 10000,
      max_payload_bytes: 262144,
    },
    artifact_limits: {
      max_items: 10,
      max_inline_bytes: 65536,
    },
    clock: {
      now: new Date().toISOString(),
      timezone: 'Asia/Shanghai',
    },
    feature_flags: {
      assignment_read_api: true,
      heartbeat_api: true,
      reports_api: true,
      report_interpreter: true,
      skill_bundle_fetch: true,
      direct_ticket_write_for_agents: false,
      stock_workboard_api: true,
      ticket_action_create_api: true,
      ticket_action_queue_api: true,
      ticket_action_start_work_api: true,
      ticket_action_pause_api: true,
      ticket_action_resume_api: true,
      ticket_action_approve_api: true,
      ticket_action_reject_api: true,
    },
  };
}
