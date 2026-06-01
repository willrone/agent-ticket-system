import { getExecutionSchema } from './execution-policy.js';

export const DEFAULT_TRIAGE_OWNER = 'leoss';
export const DEFAULT_DECISION_OWNER = '荣晖';

export const WORKFLOW_ROLE_META = {
  triage_owner: { key: 'triage_owner', label: '分诊负责人' },
  assigned_agent: { key: 'assigned_agent', label: '执行人' },
  review_owner: { key: 'review_owner', label: '验收负责人' },
  decision_owner: { key: 'decision_owner', label: '决策负责人' },
  paused_by: { key: 'paused_by', label: '挂起人' },
  next_actor_override: { key: 'next_actor_override', label: '手动覆盖责任人' },
};

export const WORKFLOW_STATUS_ORDER = [
  'triage',
  'queued',
  'running',
  'paused',
  'done',
  'review',
  'pending_decision',
  'blocked',
  'failed',
  'complete',
  'deprecated',
];

export const WORKFLOW_STATUS_META = {
  triage: {
    key: 'triage',
    label: '待分诊',
    group: 'active',
    finality: 'open',
    is_terminal: false,
    counts_as_closed: false,
    read_only: false,
    allow_create: true,
    board_order: 0,
    badge_class: 'bg-violet-500/20 text-violet-300 border-violet-500/50',
    column_class: 'bg-[var(--bg-secondary)] border-violet-500',
    chart_color: '#8b5cf6',
    default_actor_source: 'triage_owner',
    allow_manual_override: false,
    sla: { key: 'stale_triage', default_minutes: 5 },
    notify_policy: {
      dispatch_ready: true,
      notification_ready: false,
      target: 'current_actor',
    },
  },
  queued: {
    key: 'queued',
    label: '待处理',
    group: 'active',
    finality: 'open',
    is_terminal: false,
    counts_as_closed: false,
    read_only: false,
    allow_create: true,
    board_order: 1,
    badge_class: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
    column_class: 'bg-[var(--bg-secondary)] border-blue-500',
    chart_color: '#3b82f6',
    default_actor_source: 'assigned_agent',
    allow_manual_override: false,
    sla: { key: 'queued_stale', default_minutes: 10 },
    notify_policy: {
      dispatch_ready: true,
      notification_ready: false,
      target: 'current_actor',
    },
  },
  running: {
    key: 'running',
    label: '进行中',
    group: 'active',
    finality: 'open',
    is_terminal: false,
    counts_as_closed: false,
    read_only: false,
    allow_create: true,
    board_order: 2,
    badge_class: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
    column_class: 'bg-[var(--bg-secondary)] border-yellow-500',
    chart_color: '#f59e0b',
    default_actor_source: 'assigned_agent',
    allow_manual_override: false,
    sla: { key: 'stale_running', default_minutes: 30 },
    notify_policy: {
      dispatch_ready: true,
      notification_ready: false,
      target: 'current_actor',
    },
  },
  paused: {
    key: 'paused',
    label: '暂时挂起',
    group: 'paused',
    finality: 'waiting',
    is_terminal: false,
    counts_as_closed: false,
    read_only: false,
    allow_create: true,
    board_order: 3,
    badge_class: 'bg-slate-500/20 text-slate-300 border-slate-500/50',
    column_class: 'bg-[var(--bg-secondary)] border-slate-500',
    chart_color: '#64748b',
    default_actor_source: 'paused_by',
    allow_manual_override: true,
    sla: { key: 'stale_paused', default_minutes: 240 },
    notify_policy: {
      dispatch_ready: false,
      notification_ready: false,
      target: 'none',
    },
  },
  done: {
    key: 'done',
    label: '待验收',
    group: 'waiting_review',
    finality: 'waiting',
    is_terminal: false,
    counts_as_closed: false,
    read_only: false,
    allow_create: true,
    board_order: 4,
    badge_class: 'bg-green-500/20 text-green-400 border-green-500/50',
    column_class: 'bg-[var(--bg-secondary)] border-green-500',
    chart_color: '#22c55e',
    default_actor_source: 'review_owner',
    allow_manual_override: true,
    sla: { key: 'stale_done', default_minutes: 15 },
    notify_policy: {
      dispatch_ready: true,
      notification_ready: true,
      target: 'review_owner',
    },
  },
  review: {
    key: 'review',
    label: '审核中',
    group: 'waiting_review',
    finality: 'waiting',
    is_terminal: false,
    counts_as_closed: false,
    read_only: false,
    allow_create: true,
    board_order: 5,
    badge_class: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/50',
    column_class: 'bg-[var(--bg-secondary)] border-cyan-500',
    chart_color: '#06b6d4',
    default_actor_source: 'review_owner',
    allow_manual_override: true,
    sla: { key: 'stale_review', default_minutes: 60 },
    notify_policy: {
      dispatch_ready: true,
      notification_ready: true,
      target: 'review_owner',
    },
  },
  pending_decision: {
    key: 'pending_decision',
    label: '待决策',
    group: 'waiting_decision',
    finality: 'waiting',
    is_terminal: false,
    counts_as_closed: false,
    read_only: false,
    allow_create: true,
    board_order: 6,
    badge_class: 'bg-purple-500/20 text-purple-300 border-purple-500/50',
    column_class: 'bg-[var(--bg-secondary)] border-purple-500',
    chart_color: '#a855f7',
    default_actor_source: 'decision_owner',
    allow_manual_override: false,
    sla: { key: 'stale_pending_decision', default_minutes: 720 },
    notify_policy: {
      dispatch_ready: false,
      notification_ready: true,
      target: 'main_session',
    },
  },
  blocked: {
    key: 'blocked',
    label: '阻塞',
    group: 'blocked',
    finality: 'waiting',
    is_terminal: false,
    counts_as_closed: false,
    read_only: false,
    allow_create: true,
    board_order: 7,
    badge_class: 'bg-orange-500/20 text-orange-300 border-orange-500/50',
    column_class: 'bg-[var(--bg-secondary)] border-orange-500',
    chart_color: '#f97316',
    default_actor_source: 'triage_owner',
    allow_manual_override: true,
    sla: { key: 'stale_blocked', default_minutes: 240 },
    notify_policy: {
      dispatch_ready: false,
      notification_ready: true,
      target: 'main_session',
    },
  },
  failed: {
    key: 'failed',
    label: '失败',
    group: 'closed',
    finality: 'closed',
    is_terminal: true,
    counts_as_closed: true,
    read_only: true,
    allow_create: true,
    board_order: 8,
    badge_class: 'bg-red-500/20 text-red-400 border-red-500/50',
    column_class: 'bg-[var(--bg-secondary)] border-red-500',
    chart_color: '#ef4444',
    default_actor_source: 'triage_owner',
    allow_manual_override: true,
    sla: null,
    notify_policy: {
      dispatch_ready: false,
      notification_ready: true,
      target: 'main_session',
    },
  },
  complete: {
    key: 'complete',
    label: '已关单',
    group: 'closed',
    finality: 'closed',
    is_terminal: true,
    counts_as_closed: true,
    read_only: true,
    allow_create: true,
    board_order: 9,
    badge_class: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50',
    column_class: 'bg-[var(--bg-secondary)] border-emerald-500',
    chart_color: '#10b981',
    default_actor_source: null,
    allow_manual_override: false,
    sla: null,
    notify_policy: {
      dispatch_ready: false,
      notification_ready: true,
      target: 'main_session',
    },
  },
  deprecated: {
    key: 'deprecated',
    label: '已废弃',
    group: 'deprecated',
    finality: 'closed',
    is_terminal: true,
    counts_as_closed: true,
    read_only: true,
    allow_create: true,
    board_order: 10,
    badge_class: 'bg-zinc-500/20 text-zinc-300 border-zinc-500/50',
    column_class: 'bg-[var(--bg-secondary)] border-zinc-500',
    chart_color: '#71717a',
    default_actor_source: null,
    allow_manual_override: false,
    sla: null,
    notify_policy: {
      dispatch_ready: false,
      notification_ready: false,
      target: 'none',
    },
  },
};

export const TICKET_STATUSES = WORKFLOW_STATUS_ORDER;

export const WORKFLOW_METRIC_GROUPS = {
  active: WORKFLOW_STATUS_ORDER.filter((status) => !WORKFLOW_STATUS_META[status].counts_as_closed && !['paused'].includes(status)),
  waiting_review: WORKFLOW_STATUS_ORDER.filter((status) => WORKFLOW_STATUS_META[status].group === 'waiting_review'),
  closed: WORKFLOW_STATUS_ORDER.filter((status) => WORKFLOW_STATUS_META[status].counts_as_closed),
};

export const WORKFLOW_TRANSITION_META = {
  queue: {
    key: 'queue',
    label: '📥 放行执行',
    from: ['triage'],
    to: 'queued',
    required_fields: ['actor'],
    role_key: 'triage_owner',
  },
  start_work: {
    key: 'start_work',
    label: '🚀 开工',
    from: ['queued'],
    to: 'running',
    required_fields: ['actor'],
    role_key: 'assigned_agent',
  },
  submit_for_review: {
    key: 'submit_for_review',
    label: '✅ 提交验收',
    from: ['running'],
    to: 'done',
    required_fields: ['actor', 'result_summary'],
    role_key: 'assigned_agent',
  },
  start_review: {
    key: 'start_review',
    label: '🧾 开始验收',
    from: ['done'],
    to: 'review',
    required_fields: ['actor'],
    role_key: 'review_owner',
  },
  request_decision: {
    key: 'request_decision',
    label: '🤔 请求决策',
    from: ['queued', 'running', 'review'],
    to: 'pending_decision',
    required_fields: ['actor', 'decision_summary'],
    role_key: 'assigned_agent',
  },
  pause: {
    key: 'pause',
    label: '⏸️ 暂时挂起',
    from: ['triage', 'queued', 'running', 'done', 'review', 'blocked', 'pending_decision'],
    to: 'paused',
    required_fields: ['actor', 'pause_reason'],
    role_key: 'current_actor',
  },
  resume: {
    key: 'resume',
    label: '▶️ 恢复执行',
    from: ['paused'],
    to: 'dynamic',
    required_fields: ['actor'],
    role_key: 'paused_by',
  },
  reset_to_queued: {
    key: 'reset_to_queued',
    label: '↩️ 撤销开工回队列',
    from: ['running', 'paused'],
    to: 'queued',
    required_fields: ['actor', 'reason'],
    role_key: 'triage_owner',
    management_only: true,
  },
  approve: {
    key: 'approve',
    label: '👍 通过关单',
    from: ['done', 'review'],
    to: 'complete',
    required_fields: ['actor'],
    role_key: 'review_owner',
  },
  reject: {
    key: 'reject',
    label: '👎 打回重做',
    from: ['done', 'review'],
    to: 'queued',
    required_fields: ['actor', 'reject_reason'],
    role_key: 'review_owner',
  },
  block: {
    key: 'block',
    label: '🚫 标记阻塞',
    from: ['queued', 'running'],
    to: 'blocked',
    required_fields: ['actor', 'blocker_summary'],
    role_key: 'assigned_agent',
  },
  unblock: {
    key: 'unblock',
    label: '🔓 解除阻塞',
    from: ['blocked'],
    to: 'queued',
    required_fields: ['actor'],
    role_key: 'triage_owner',
  },
  fail: {
    key: 'fail',
    label: '❌ 标记失败',
    from: ['queued', 'running'],
    to: 'failed',
    required_fields: ['actor', 'error'],
    role_key: 'assigned_agent',
  },
  deprecate: {
    key: 'deprecate',
    label: '🗃️ 标记废弃',
    from: ['triage', 'queued', 'running', 'paused', 'done', 'review', 'pending_decision', 'blocked', 'failed', 'complete'],
    to: 'deprecated',
    required_fields: ['actor', 'deprecation_reason'],
    role_key: 'triage_owner',
    management_only: true,
  },
  resume_from_decision: {
    key: 'resume_from_decision',
    label: '▶️ 恢复执行',
    from: ['pending_decision'],
    to: 'queued',
    required_fields: ['actor'],
    role_key: 'decision_owner',
  },
  formal_reassign: {
    key: 'formal_reassign',
    label: '🔄 正式改派',
    from: ['queued', 'running', 'paused'],
    to: 'dynamic',
    required_fields: ['actor', 'target_agent'],
    role_key: 'current_actor',
    management_only: false,
  },
  handoff: {
    key: 'handoff',
    label: '🤝 交接',
    from: ['queued', 'running', 'paused'],
    to: 'dynamic',
    required_fields: ['actor', 'target_agent'],
    role_key: 'current_actor',
    management_only: false,
  },
};

export const WORKFLOW_ACTION_ORDER = Object.keys(WORKFLOW_TRANSITION_META);

function cleanActor(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

export function isPlaceholderIdentity(value) {
  const actor = cleanActor(value);
  if (!actor) return true;
  return ['current user', '当前用户', 'unknown', '未知用户'].includes(actor.toLowerCase());
}

export function resolveRoleActor(ticket = {}, roleKey) {
  const triageOwner = cleanActor(ticket.triage_owner) || DEFAULT_TRIAGE_OWNER;
  const assignedAgent = cleanActor(ticket.assigned_agent);
  const reviewOwner = cleanActor(ticket.review_owner) || triageOwner;
  const decisionOwner = cleanActor(ticket.decision_owner) || DEFAULT_DECISION_OWNER;
  const pausedBy = cleanActor(ticket.paused_by);

  switch (roleKey) {
    case 'triage_owner':
      return triageOwner;
    case 'assigned_agent':
      return assignedAgent || triageOwner;
    case 'review_owner':
      return reviewOwner;
    case 'decision_owner':
      return decisionOwner;
    case 'paused_by':
      return pausedBy || assignedAgent || reviewOwner || triageOwner || decisionOwner;
    case 'current_actor': {
      const routing = resolveCurrentActorRouting(ticket);
      return routing.current_actor || assignedAgent || reviewOwner || triageOwner || decisionOwner || null;
    }
    case 'next_actor_override':
      return cleanActor(ticket.next_actor_override);
    default:
      return null;
  }
}

export function resolveActionActor(ticket = {}, action, preferredActor = null) {
  const explicitActor = isPlaceholderIdentity(preferredActor) ? null : cleanActor(preferredActor);
  if (explicitActor) return explicitActor;

  const roleKey = getActionMeta(action)?.role_key || null;
  const roleActor = resolveRoleActor(ticket, roleKey);
  if (roleActor) return roleActor;

  const routing = resolveCurrentActorRouting(ticket);
  return routing.current_actor || resolveRoleActor(ticket, 'assigned_agent') || resolveRoleActor(ticket, 'triage_owner') || null;
}

export function resolveCommentAuthor(ticket = {}, preferredAuthor = null) {
  const explicitAuthor = isPlaceholderIdentity(preferredAuthor) ? null : cleanActor(preferredAuthor);
  if (explicitAuthor) return explicitAuthor;

  const routing = resolveCurrentActorRouting(ticket);
  return routing.current_actor
    || resolveRoleActor(ticket, 'assigned_agent')
    || resolveRoleActor(ticket, 'review_owner')
    || resolveRoleActor(ticket, 'triage_owner')
    || resolveRoleActor(ticket, 'decision_owner')
    || 'Current User';
}

export function resolveResumeStatus(ticket = {}) {
  const pausedFrom = String(ticket.paused_from_status || '').trim();
  if (WORKFLOW_TRANSITION_META.pause.from.includes(pausedFrom)) return pausedFrom;
  return cleanActor(ticket.assigned_agent) ? 'queued' : 'triage';
}

function computeCurrentActorWithoutOverride(ticket = {}) {
  const status = ticket.status || 'queued';
  const triageOwner = cleanActor(ticket.triage_owner);
  const reviewOwner = cleanActor(ticket.review_owner) || triageOwner;
  const decisionOwner = cleanActor(ticket.decision_owner) || DEFAULT_DECISION_OWNER;
  const assignedAgent = cleanActor(ticket.assigned_agent);
  const pausedBy = cleanActor(ticket.paused_by);

  switch (status) {
    case 'complete':
    case 'deprecated':
      return { current_actor: null, current_actor_source: null };
    case 'triage':
      return { current_actor: triageOwner, current_actor_source: triageOwner ? 'triage_owner' : null };
    case 'queued':
    case 'running':
      return { current_actor: assignedAgent, current_actor_source: assignedAgent ? 'assigned_agent' : null };
    case 'done':
    case 'review':
      return { current_actor: reviewOwner, current_actor_source: reviewOwner ? (cleanActor(ticket.review_owner) ? 'review_owner' : 'review_owner_fallback') : null };
    case 'pending_decision':
      return { current_actor: decisionOwner, current_actor_source: cleanActor(ticket.decision_owner) ? 'decision_owner' : 'decision_owner_default' };
    case 'blocked':
    case 'failed':
      return { current_actor: triageOwner, current_actor_source: triageOwner ? 'triage_owner' : null };
    case 'paused':
      if (pausedBy) return { current_actor: pausedBy, current_actor_source: 'paused_by' };
      if (assignedAgent) return { current_actor: assignedAgent, current_actor_source: 'assigned_agent_fallback' };
      if (reviewOwner) return { current_actor: reviewOwner, current_actor_source: 'review_owner_fallback' };
      return { current_actor: triageOwner, current_actor_source: triageOwner ? 'triage_owner_fallback' : null };
    default:
      return { current_actor: assignedAgent || triageOwner || null, current_actor_source: assignedAgent ? 'assigned_agent_fallback' : triageOwner ? 'triage_owner_fallback' : null };
  }
}

export function resolveManualNextActorOverride(ticket = {}) {
  const explicitOverride = cleanActor(ticket.next_actor_override);
  if (explicitOverride) return explicitOverride;

  const legacyValue = cleanActor(ticket.next_actor_legacy ?? ticket.next_actor);
  if (!legacyValue) return null;

  const statusMeta = WORKFLOW_STATUS_META[ticket.status || 'queued'] || WORKFLOW_STATUS_META.queued;
  if (!statusMeta.allow_manual_override) return null;

  const computed = computeCurrentActorWithoutOverride(ticket).current_actor;
  return legacyValue && legacyValue !== computed ? legacyValue : null;
}

export function resolveCurrentActorRouting(ticket = {}) {
  const status = ticket.status || 'queued';
  const statusMeta = WORKFLOW_STATUS_META[status] || WORKFLOW_STATUS_META.queued;
  const base = computeCurrentActorWithoutOverride(ticket);
  const overrideActor = statusMeta.allow_manual_override ? resolveManualNextActorOverride(ticket) : null;
  const current_actor = overrideActor || base.current_actor;
  const current_actor_source = overrideActor ? 'next_actor' : base.current_actor_source;
  const notifyPolicy = statusMeta.notify_policy || { dispatch_ready: false, notification_ready: false, target: 'none' };

  return {
    current_actor,
    current_actor_source,
    next_actor_override: overrideActor,
    manual_override_active: Boolean(overrideActor),
    should_notify: Boolean(notifyPolicy.notification_ready || (notifyPolicy.dispatch_ready && current_actor)),
    notify_policy: notifyPolicy,
  };
}

export function enrichTicketWorkflow(ticket = {}) {
  const statusMeta = getStatusMeta(ticket.status);
  const routing = resolveCurrentActorRouting(ticket);
  return {
    ...ticket,
    current_actor: routing.current_actor,
    current_actor_source: routing.current_actor_source,
    next_actor: routing.current_actor,
    next_actor_source: routing.current_actor_source,
    next_actor_override: routing.next_actor_override,
    manual_override_active: routing.manual_override_active,
    should_notify: routing.should_notify,
    workflow_status_meta: statusMeta,
    workflow_notify_policy: routing.notify_policy,
  };
}

export function buildWorkflowActorContract(ticket = {}) {
  const enriched = enrichTicketWorkflow(ticket);
  return {
    current_actor: enriched.current_actor,
    current_actor_source: enriched.current_actor_source,
    next_actor: enriched.next_actor,
    next_actor_source: enriched.next_actor_source,
    next_actor_override: enriched.next_actor_override,
    manual_override_active: Boolean(enriched.manual_override_active),
    should_notify: Boolean(enriched.should_notify),
    workflow_notify_policy: enriched.workflow_notify_policy || null,
  };
}

export function getStatusMeta(status) {
  return WORKFLOW_STATUS_META[status] || WORKFLOW_STATUS_META.queued;
}

export function getStatusLabel(status) {
  return getStatusMeta(status).label;
}

export function getActionMeta(action) {
  return WORKFLOW_TRANSITION_META[action] || null;
}

export function getRequiredFieldsForAction(action) {
  return getActionMeta(action)?.required_fields || [];
}

export function listAvailableActionsForStatus(status) {
  return WORKFLOW_ACTION_ORDER.filter((action) => {
    const meta = getActionMeta(action);
    return Array.isArray(meta?.from) && meta.from.includes(status);
  });
}

export function getAvailableActionObjects(status) {
  return listAvailableActionsForStatus(status)
    .map((action) => getActionMeta(action))
    .filter(Boolean);
}

export function getWorkflowSchema() {
  return {
    roles: WORKFLOW_ROLE_META,
    statuses: WORKFLOW_STATUS_ORDER.map((status) => ({ status, ...WORKFLOW_STATUS_META[status] })),
    actions: WORKFLOW_ACTION_ORDER.map((action) => ({ action, ...WORKFLOW_TRANSITION_META[action] })),
    metric_groups: WORKFLOW_METRIC_GROUPS,
    execution: getExecutionSchema(),
    dispatch_receipt: {
      report_type: 'dispatch_receipt',
      fields: ['dispatch_id', 'ticket_id', 'stage', 'agent', 'decision', 'message'],
      decisions: ['accepted', 'busy', 'blocked', 'rejected', 'invalid'],
      state_projection_fields: ['dispatch_state', 'awaiting_receipt_from', 'dispatch_ack_deadline_at', 'dispatch_retry_count', 'next_dispatch_retry_at'],
      transition_rules: [
        { stage: 'queued', decision: 'accepted', action: 'start_work', to: 'running' },
        { stage: 'done', decision: 'accepted', action: 'start_review', to: 'review' },
        { stage: 'review', decision: 'accepted', action: null, to: 'review', semantics: 'receipt_only' },
      ],
    },
  };
}

export const KANBAN_COLUMNS = WORKFLOW_STATUS_ORDER
  .map((status) => ({ id: status, label: getStatusLabel(status), color: getStatusMeta(status).column_class, order: getStatusMeta(status).board_order }))
  .sort((a, b) => a.order - b.order);

export const STATUS_DISTRIBUTION_META = Object.fromEntries(
  WORKFLOW_STATUS_ORDER.map((status) => [
    status,
    {
      name: getStatusLabel(status),
      color: getStatusMeta(status).chart_color,
    },
  ])
);

export const STATUS_BADGE_CLASS = Object.fromEntries(
  WORKFLOW_STATUS_ORDER.map((status) => [status, getStatusMeta(status).badge_class])
);

export const STATUS_SORT_ORDER = Object.fromEntries(
  WORKFLOW_STATUS_ORDER.map((status, index) => [status, index])
);

// Canonical bucket meta: map workflow status groups to board buckets
export const WORKFLOW_BUCKET_LABELS = {
  active: '待推进',
  waiting_review: '待验收',
  waiting_decision: '待决策',
  blocked: '阻塞',
  paused: '暂时挂起',
  deprecated: '已废弃',
  closed: '已结束',
};

export const WORKFLOW_BUCKET_ORDER = {
  active: 0,
  waiting_review: 1,
  waiting_decision: 2,
  blocked: 3,
  paused: 4,
  deprecated: 5,
  closed: 6,
};

export const WORKFLOW_BUCKET_META = (() => {
  const buckets = {};
  for (const meta of Object.values(WORKFLOW_STATUS_META)) {
    const bucket = meta.group || 'active';
    if (!buckets[bucket]) {
      buckets[bucket] = {
        key: bucket,
        label: WORKFLOW_BUCKET_LABELS[bucket] || bucket,
        order: WORKFLOW_BUCKET_ORDER[bucket] ?? 999,
        statuses: [],
      };
    }
    buckets[bucket].statuses.push(meta.key);
  }
  return buckets;
})();
