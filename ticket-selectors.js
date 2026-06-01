import {
  KANBAN_COLUMNS,
  STATUS_DISTRIBUTION_META,
  STATUS_SORT_ORDER,
  WORKFLOW_BUCKET_META,
  WORKFLOW_METRIC_GROUPS,
  WORKFLOW_STATUS_ORDER,
  enrichTicketWorkflow,
  getActionMeta,
  getStatusLabel,
  getStatusMeta,
  listAvailableActionsForStatus,
} from './workflow-schema.js';
import { getExecutionWorkerEvidence } from './execution-policy.js';

const ACTIVE_STATUS_SET = new Set(WORKFLOW_METRIC_GROUPS.active);
const WAITING_REVIEW_STATUS_SET = new Set(WORKFLOW_METRIC_GROUPS.waiting_review);
const CLOSED_STATUS_SET = new Set(WORKFLOW_METRIC_GROUPS.closed);
const OPEN_STATUS_SET = new Set(
  WORKFLOW_STATUS_ORDER.filter((status) => !CLOSED_STATUS_SET.has(status))
);

// --- Canonical ticket view-model helpers ---

export function getCanonicalStatusMeta(status) {
  return getStatusMeta(status);
}

export function getCanonicalBucketMeta(bucketKey) {
  return WORKFLOW_BUCKET_META[bucketKey] || null;
}

export function resolveTicketBucketKey(status) {
  const meta = getStatusMeta(status);
  return meta.group || 'active';
}

export function buildTicketViewModel(ticket = {}) {
  const workflowTicket = enrichTicketWorkflow(ticket);
  const status = workflowTicket.status || 'queued';
  const statusMeta = getStatusMeta(status);
  const bucketKey = resolveTicketBucketKey(status);
  const bucketMeta = WORKFLOW_BUCKET_META[bucketKey] || { key: bucketKey, label: bucketKey, order: 999 };

  return {
    ...workflowTicket,
    status,
    status_meta: statusMeta,
    bucket: {
      key: bucketMeta.key,
      label: bucketMeta.label,
      order: bucketMeta.order,
      statuses: Array.isArray(bucketMeta.statuses) ? bucketMeta.statuses : [],
    },
  };
}

const TICKET_PROGRESS_BY_STATUS = {
  triage: 10,
  queued: 25,
  running: 50,
  paused: 50,
  blocked: 60,
  pending_decision: 70,
  done: 80,
  review: 90,
  failed: 100,
  complete: 100,
  deprecated: 100,
};

export function getTicketProgress(status) {
  return TICKET_PROGRESS_BY_STATUS[status] ?? 0;
}

export function isActiveWorkflowStatus(status) {
  return ACTIVE_STATUS_SET.has(status);
}

export function isWaitingReviewWorkflowStatus(status) {
  return WAITING_REVIEW_STATUS_SET.has(status);
}

export function isClosedWorkflowStatus(status) {
  return CLOSED_STATUS_SET.has(status);
}

export function isOpenWorkflowStatus(status) {
  return OPEN_STATUS_SET.has(status);
}

export function groupTicketsByStatus(tickets = []) {
  const groups = Object.fromEntries(KANBAN_COLUMNS.map((column) => [column.id, []]));
  for (const ticket of tickets) {
    if (groups[ticket.status]) groups[ticket.status].push(ticket);
  }
  return groups;
}

export function buildWeeklyTicketsSeries(tickets = [], { now = new Date() } = {}) {
  const dayCounts = {};
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dayCounts[key] = { day: key, tickets: 0 };
  }

  for (const ticket of tickets) {
    const created = ticket.created || ticket.last_update || '';
    const match = String(created).match(/^(\d{4}-\d{2}-\d{2})/);
    const key = match ? match[1] : null;
    if (key && dayCounts[key]) dayCounts[key].tickets += 1;
  }

  return Object.values(dayCounts).sort((a, b) => a.day.localeCompare(b.day));
}

export function buildStatusDistribution(tickets = []) {
  const countsByStatus = tickets.reduce((acc, ticket) => {
    const key = ticket.status;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return Object.entries(STATUS_DISTRIBUTION_META)
    .map(([status, meta]) => ({
      status,
      name: meta.name,
      value: countsByStatus[status] || 0,
      color: meta.color,
      group: getStatusMeta(status).group,
    }))
    .filter((item) => item.value > 0);
}

function countTickets(tickets = [], predicate) {
  return tickets.filter(predicate).length;
}

function sortByCountDescThenLabel(items = []) {
  return [...items].sort((a, b) => {
    if ((b.count || 0) !== (a.count || 0)) return (b.count || 0) - (a.count || 0);
    return String(a.label || a.key || '').localeCompare(String(b.label || b.key || ''), 'zh-Hans-CN');
  });
}

function buildBucketBreakdown(tickets = []) {
  const counts = tickets.reduce((acc, ticket) => {
    const bucketKey = resolveTicketBucketKey(ticket.status);
    acc[bucketKey] = (acc[bucketKey] || 0) + 1;
    return acc;
  }, {});

  return Object.values(WORKFLOW_BUCKET_META)
    .map((meta) => ({
      key: meta.key,
      label: meta.label,
      count: counts[meta.key] || 0,
      statuses: Array.isArray(meta.statuses) ? meta.statuses : [],
      order: meta.order ?? 999,
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}

function buildNamedBreakdown(tickets = [], resolveValue, fallbackLabel) {
  const counts = tickets.reduce((acc, ticket) => {
    const rawValue = resolveValue(ticket);
    const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
    const key = value || fallbackLabel;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return sortByCountDescThenLabel(
    Object.entries(counts).map(([key, count]) => ({ key, label: key, count }))
  );
}

function buildFocusBoard(tickets = []) {
  const focusDefinitions = [
    {
      key: 'pending_decision',
      label: '待决策',
      predicate: (ticket) => ticket.status === 'pending_decision',
      detail: (ticket) => ticket.decision_summary || ticket.current_actor || '等待拍板',
    },
    {
      key: 'blocked',
      label: '阻塞',
      predicate: (ticket) => ticket.status === 'blocked',
      detail: (ticket) => ticket.blocker_summary || ticket.current_actor || '存在阻塞待解除',
    },
    {
      key: 'deprecated',
      label: '已废弃',
      predicate: (ticket) => ticket.status === 'deprecated',
      detail: (ticket) => ticket.deprecation_reason || '历史残留 / 不再进入当前流程',
    },
  ];

  return focusDefinitions.map((definition) => {
    const items = tickets
      .filter(definition.predicate)
      .slice(0, 5)
      .map((ticket) => ({
        id: ticket.id,
        title: ticket.title,
        status: ticket.status,
        platform: ticket.platform || null,
        owner: ticket.current_actor || ticket.assigned_agent || ticket.review_owner || ticket.triage_owner || null,
        detail: definition.detail(ticket),
      }));

    return {
      key: definition.key,
      label: definition.label,
      count: items.length ? tickets.filter(definition.predicate).length : 0,
      items,
    };
  });
}

function buildResponsibilityBoard(tickets = []) {
  return tickets
    .filter((ticket) => ['queued', 'running', 'done', 'review', 'pending_decision', 'blocked', 'deprecated'].includes(ticket.status))
    .map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      bucket: resolveTicketBucketKey(ticket.status),
      platform: ticket.platform || '未分类',
      current_actor: ticket.current_actor || null,
      current_actor_source: ticket.current_actor_source || null,
      triage_owner: ticket.triage_owner || null,
      assigned_agent: ticket.assigned_agent || null,
      review_owner: ticket.review_owner || null,
      decision_owner: ticket.decision_owner || null,
    }))
    .sort((a, b) => (STATUS_SORT_ORDER[a.status] ?? 999) - (STATUS_SORT_ORDER[b.status] ?? 999) || (Number(a.id) || 0) - (Number(b.id) || 0));
}

function buildTicketRuntimeDigest(ticket = {}) {
  const executionMode = String(ticket.execution_mode || 'direct').trim().toLowerCase() || 'direct';
  const workerStats = ticket.worker_stats && typeof ticket.worker_stats === 'object' ? ticket.worker_stats : {};
  const workerEvidence = getExecutionWorkerEvidence(ticket);
  const activeWorkers = Number(workerStats.active_workers ?? workerEvidence.active_workers ?? 0);
  const runningWorkers = Number(workerStats.running_workers ?? workerEvidence.running_workers ?? 0);
  const totalWorkers = Number(workerStats.total_workers ?? workerEvidence.total_workers ?? 0);
  const succeededWorkers = Number(workerStats.succeeded_workers ?? workerEvidence.succeeded_workers ?? 0);
  const failedTerminalWorkers = Number(workerStats.failed_terminal_workers ?? workerEvidence.failed_terminal_workers ?? 0);
  const hasActiveExecutionEvidence = Boolean(
    workerEvidence.has_active_execution_evidence
      ?? (activeWorkers > 0 || runningWorkers > 0 || (Array.isArray(ticket.current_workers) && ticket.current_workers.length > 0)),
  );
  const dispatchState = ticket.dispatch_state || ticket.execution_guard?.reservation?.state || null;
  const runtimeRiskEligible = ['queued', 'running', 'done', 'review'].includes(ticket.status);

  let runtimeState = 'idle';
  let summary = '当前运行态平稳。';

  if (ticket.status === 'pending_decision') {
    runtimeState = 'waiting_decision';
    summary = ticket.decision_summary || '等待 decision owner 拍板。';
  } else if (ticket.status === 'blocked') {
    runtimeState = 'blocked';
    summary = ticket.blocker_summary || '存在阻塞待解除。';
  } else if (ticket.status === 'paused') {
    runtimeState = 'paused';
    summary = ticket.pause_reason || '工单已暂时挂起。';
  } else if (ticket.status === 'failed') {
    runtimeState = 'failed';
    summary = ticket.error || '执行失败，等待后续处理。';
  } else if (runtimeRiskEligible && dispatchState === 'receipt_accepted' && !hasActiveExecutionEvidence) {
    runtimeState = 'waiting_worker';
    summary = succeededWorkers > 0 && !hasActiveExecutionEvidence
      ? '已 receipt accepted；仅有历史 completed worker 记录，尚无新的活跃执行证据。'
      : '已 receipt accepted，但尚未出现真实 worker/running 证据。';
  } else if (runtimeRiskEligible && dispatchState === 'awaiting_receipt') {
    runtimeState = 'awaiting_receipt';
    summary = `等待 ${ticket.awaiting_receipt_from || ticket.current_actor || '目标 agent'} 回执。`;
  } else if (runtimeRiskEligible && dispatchState === 'receipt_overdue') {
    runtimeState = 'receipt_overdue';
    summary = '派单回执超时，需人工介入或重试。';
  } else if (activeWorkers > 0 || runningWorkers > 0 || ticket.status === 'running') {
    runtimeState = 'running';
    summary = activeWorkers > 0 || runningWorkers > 0
      ? `已有 ${Math.max(activeWorkers, runningWorkers)} 个活跃 worker 在跑。`
      : '当前 ticket 正在执行中。';
  } else if (['done', 'review'].includes(ticket.status)) {
    runtimeState = 'review_queue';
    summary = ticket.result_summary || '执行已完成，等待 reviewer 收口。';
  }

  return {
    state: runtimeState,
    label: runtimeState,
    summary,
    ticket_id: ticket.id ?? null,
    status: ticket.status ?? null,
    execution_mode: executionMode,
    dispatch_state: dispatchState,
    awaiting_receipt_from: ticket.awaiting_receipt_from || null,
    current_actor: ticket.current_actor || null,
    current_actor_source: ticket.current_actor_source || null,
    active_workers: activeWorkers,
    running_workers: runningWorkers,
    total_workers: totalWorkers,
    succeeded_workers: succeededWorkers,
    failed_terminal_workers: failedTerminalWorkers,
    has_worker_evidence: workerEvidence.has_worker_evidence,
    has_active_execution_evidence: hasActiveExecutionEvidence,
    has_completed_execution_evidence: Boolean(workerEvidence.has_completed_execution_evidence ?? succeededWorkers > 0),
    needs_decision: ticket.status === 'pending_decision',
    needs_review: ['done', 'review'].includes(ticket.status),
    blocker_summary: ticket.blocker_summary || null,
    decision_summary: ticket.decision_summary || null,
    pause_reason: ticket.pause_reason || null,
    error: ticket.error || null,
  };
}

function getTodayKey(now = new Date()) {
  const d = new Date(now);
  return d.toISOString().slice(0, 10);
}

export function buildTodayProgressSummary(tickets = [], options = {}) {
  const now = options.now != null ? new Date(options.now) : new Date();
  const todayKey = getTodayKey(now);

  let createdToday = 0;
  let updatedToday = 0;
  let closedToday = 0;

  for (const ticket of tickets) {
    const createdMatch = String(ticket.created || ticket.last_update || '').match(/^(\d{4}-\d{2}-\d{2})/);
    if (createdMatch && createdMatch[1] === todayKey) createdToday += 1;

    const updateMatch = String(ticket.last_update || ticket.created || '').match(/^(\d{4}-\d{2}-\d{2})/);
    if (updateMatch && updateMatch[1] === todayKey) updatedToday += 1;

    if (CLOSED_STATUS_SET.has(ticket.status)) {
      const closeMatch = String(ticket.last_update || ticket.created || '').match(/^(\d{4}-\d{2}-\d{2})/);
      if (closeMatch && closeMatch[1] === todayKey) closedToday += 1;
    }
  }

  return { createdToday, updatedToday, closedToday, date: todayKey };
}

function buildRiskTrendsSummary(tickets = []) {
  const runtime = buildRuntimeDigestBoard(tickets);
  const focus = buildFocusBoard(tickets);

  const awaitingReceipt = (runtime.summary.find((s) => s.key === 'awaiting_receipt')?.count ?? 0);
  const waitingWorker = (runtime.summary.find((s) => s.key === 'waiting_worker')?.count ?? 0);
  const waitingDecision = (runtime.summary.find((s) => s.key === 'waiting_decision')?.count ?? 0);
  const reviewQueue = (runtime.summary.find((s) => s.key === 'review_queue')?.count ?? 0);

  const blockedSection = focus.find((s) => s.key === 'blocked');
  const pendingSection = focus.find((s) => s.key === 'pending_decision');
  const blocked = blockedSection?.count ?? 0;
  const pendingDecision = pendingSection?.count ?? 0;
  const triageGap = countTickets(tickets, (t) => hasTriageGap(t));

  return {
    blocked,
    pendingDecision,
    awaitingReceipt,
    waitingWorker,
    reviewQueue,
    waitingDecision,
    triageGap,
  };
}

function buildRuntimeDigestBoard(tickets = []) {
  const definitions = [
    { key: 'waiting_worker', label: '待 worker', predicate: (item) => item.state === 'waiting_worker' },
    { key: 'awaiting_receipt', label: '待回执', predicate: (item) => item.state === 'awaiting_receipt' || item.state === 'receipt_overdue' },
    { key: 'review_queue', label: '待验收收口', predicate: (item) => item.state === 'review_queue' },
    { key: 'waiting_decision', label: '待决策', predicate: (item) => item.state === 'waiting_decision' },
  ];

  const digests = tickets.map((ticket) => ({
    id: ticket.id,
    title: ticket.title,
    platform: ticket.platform || null,
    owner: ticket.current_actor || ticket.assigned_agent || ticket.review_owner || ticket.triage_owner || null,
    ...buildTicketRuntimeDigest(ticket),
  }));

  return {
    summary: definitions.map((definition) => ({
      key: definition.key,
      label: definition.label,
      count: digests.filter(definition.predicate).length,
    })),
    sections: definitions.map((definition) => ({
      key: definition.key,
      label: definition.label,
      count: digests.filter(definition.predicate).length,
      items: digests.filter(definition.predicate).slice(0, 5),
    })),
  };
}

export function buildDashboardMetrics(tickets = [], options = {}) {
  return {
    stats: {
      total: tickets.length,
      active: countTickets(tickets, (ticket) => isActiveWorkflowStatus(ticket.status)),
      inProgress: countTickets(tickets, (ticket) => ticket.status === 'running'),
      waitingReview: countTickets(tickets, (ticket) => isWaitingReviewWorkflowStatus(ticket.status)),
      closed: countTickets(tickets, (ticket) => isClosedWorkflowStatus(ticket.status)),
    },
    todaySummary: buildTodayProgressSummary(tickets, options),
    riskSummary: buildRiskTrendsSummary(tickets),
    weeklyTickets: buildWeeklyTicketsSeries(tickets, options),
    statusDistribution: buildStatusDistribution(tickets),
    board: {
      bucketBreakdown: buildBucketBreakdown(tickets),
      platformBreakdown: buildNamedBreakdown(tickets, (ticket) => ticket.platform, '未分类平台'),
      ownerBreakdown: buildNamedBreakdown(
        tickets,
        (ticket) => ticket.current_actor || ticket.assigned_agent || ticket.review_owner || ticket.triage_owner || ticket.decision_owner,
        '未指定责任人'
      ),
      focusBoard: buildFocusBoard(tickets),
      responsibilityBoard: buildResponsibilityBoard(tickets),
      runtimeDigestBoard: buildRuntimeDigestBoard(tickets),
    },
  };
}

export { buildTicketRuntimeDigest };

function normalizeFilterValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function hasTriageGap(ticket = {}) {
  const requiredFields = [
    ticket.triage_owner,
    ticket.platform,
    ticket.request_type,
    ticket.assigned_agent,
    ticket.triage_summary,
  ];
  return requiredFields.some((value) => normalizeFilterValue(value).length === 0);
}

const TICKET_QUICK_VIEW_DEFINITIONS = [
  { key: 'all', label: '全部工单', predicate: () => true },
  { key: 'active', label: '执行中 / 待推进', predicate: (ticket) => isActiveWorkflowStatus(ticket.status) },
  { key: 'waitingReview', label: '待验收 / 审核中', predicate: (ticket) => isWaitingReviewWorkflowStatus(ticket.status) },
  { key: 'paused', label: '暂时挂起', predicate: (ticket) => ticket.status === 'paused' },
  { key: 'closed', label: '已结束', predicate: (ticket) => isClosedWorkflowStatus(ticket.status) },
  { key: 'triagePending', label: '待分诊', predicate: (ticket) => ticket.status === 'triage' },
  { key: 'ticketPlatform', label: '只看工单平台', predicate: (ticket) => ticket.platform === 'ticket-platform' },
  { key: 'beavy', label: '只看 beavy', predicate: (ticket) => ticket.assigned_agent === 'beavy' },
  { key: 'triageIncomplete', label: '分诊待补全', predicate: (ticket) => hasTriageGap(ticket) },
];

export function matchesTicketQuickView(ticket, quickView = 'all') {
  const definition = TICKET_QUICK_VIEW_DEFINITIONS.find((item) => item.key === quickView)
    || TICKET_QUICK_VIEW_DEFINITIONS[0];
  return definition.predicate(ticket);
}

export function buildTicketQuickViews(tickets = []) {
  return TICKET_QUICK_VIEW_DEFINITIONS.map((definition) => ({
    key: definition.key,
    label: definition.label,
    count: countTickets(tickets, definition.predicate),
  }));
}

export function buildTicketStageOrchestration(ticket = {}, options = {}) {
  const workflowTicket = buildTicketViewModel(ticket);
  const actions = Array.isArray(options.availableActions)
    ? options.availableActions
    : Array.isArray(ticket.available_actions)
      ? ticket.available_actions
      : listAvailableActionsForStatus(workflowTicket.status || 'queued');
  const statusMeta = workflowTicket.status_meta || getStatusMeta(workflowTicket.status);
  const executionMode = String(workflowTicket.execution_mode || 'direct').trim().toLowerCase() || 'direct';
  const currentStageLabel = statusMeta?.label || workflowTicket.status || '未知阶段';
  const currentActor = workflowTicket.current_actor || workflowTicket.next_actor || workflowTicket.assigned_agent || workflowTicket.review_owner || workflowTicket.triage_owner || '未解析';
  const nextOwner = ['done', 'review'].includes(workflowTicket.status)
    ? (workflowTicket.review_owner || currentActor)
    : workflowTicket.status === 'pending_decision'
      ? (workflowTicket.decision_owner || currentActor)
      : currentActor;

  const nextAction = actions.includes('start_work')
    ? 'start_work'
    : actions.includes('submit_for_review')
      ? 'submit_for_review'
      : actions.includes('start_review')
        ? 'start_review'
        : actions.includes('approve')
          ? 'approve'
          : actions.includes('resume_from_decision')
            ? 'resume_from_decision'
            : actions.includes('request_decision')
              ? 'request_decision'
              : actions[0] || null;
  const nextActionMeta = nextAction ? getActionMeta(nextAction) : null;
  const nextStageLabel = nextActionMeta?.to === 'dynamic'
    ? '动态阶段'
    : nextActionMeta?.to
      ? getStatusLabel(nextActionMeta.to)
      : null;

  let headline = `当前处于${currentStageLabel}，由 ${currentActor} 持续推进。`;
  if (workflowTicket.status === 'running') {
    headline = nextActionMeta?.to === 'done'
      ? `当前处于进行中，由 ${currentActor} 继续实现与验证；完成后应提交到待验收。`
      : `当前处于进行中，由 ${currentActor} 继续实现、验证并收口。`;
  } else if (workflowTicket.status === 'queued') {
    headline = `当前处于待处理，由 ${currentActor} 接手开工。`;
  } else if (['done', 'review'].includes(workflowTicket.status)) {
    headline = `当前已进入 reviewer 收口阶段，下一责任人是 ${workflowTicket.review_owner || currentActor}。`;
  } else if (workflowTicket.status === 'pending_decision') {
    headline = `当前等待 ${workflowTicket.decision_owner || currentActor} 拍板后再恢复推进。`;
  } else if (workflowTicket.status === 'blocked') {
    headline = `当前存在阻塞，需由 ${currentActor} 或上游责任人先解除阻塞。`;
  }

  const handoffSummary = ['done', 'review'].includes(workflowTicket.status)
    ? `reviewer 交接：${workflowTicket.review_owner || '未设置 reviewer'} 收口验收。`
    : workflowTicket.status === 'pending_decision'
      ? `决策交接：${workflowTicket.decision_owner || '未设置 decision owner'} 负责拍板。`
      : nextActionMeta?.to === 'done'
        ? `执行完成后交给 reviewer ${workflowTicket.review_owner || '未设置'}。`
        : `当前继续由 ${currentActor} 持有，执行模式 ${executionMode}。`;

  const checklist = [
    `当前阶段：${currentStageLabel}`,
    `执行模式：${executionMode}`,
    `当前责任人：${currentActor}`,
    nextActionMeta ? `下一步建议：${nextActionMeta.label || nextAction}` : '下一步建议：等待补充动作 contract',
    nextStageLabel ? `目标阶段：${nextStageLabel}` : null,
    handoffSummary,
    workflowTicket.dispatch_state ? `派单握手：${workflowTicket.dispatch_state}` : null,
    executionMode !== 'direct' && workflowTicket.execution_guard
      ? (() => {
          const g = workflowTicket.execution_guard;
          const parts = [`执行模式：${executionMode}`];
          if (g.has_active_execution_evidence) parts.push('活跃执行证据已具备');
          else if (g.has_historical_started_worker) parts.push('存在 historical starting 记录（请核对是否 stale）');
          else if (g.has_completed_execution_evidence || (g.succeeded_workers ?? 0) > 0) {
            parts.push('仅有历史 completed worker 记录，无当前活跃执行');
          }
          if ((g.failed_terminal_workers ?? 0) > 0) parts.push(`失败终态 worker：${g.failed_terminal_workers}（不计入完成证据）`);
          if (g.requires_worker && !g.has_active_execution_evidence && workflowTicket.status === 'queued') {
            parts.push('准入：需登记 worker 后才算真正开工（direct 无此要求）');
          }
          return parts.join(' · ');
        })()
      : null,
    workflowTicket.workflow_mismatch?.reason ? `异常告警：${workflowTicket.workflow_mismatch.reason}` : null,
  ].filter(Boolean);

  return {
    current_stage_key: workflowTicket.status || null,
    current_stage_label: currentStageLabel,
    execution_mode: executionMode,
    current_actor: currentActor,
    next_action: nextAction,
    next_action_label: nextActionMeta?.label || nextAction || null,
    next_stage_key: nextActionMeta?.to || null,
    next_stage_label: nextStageLabel,
    next_owner: nextOwner,
    headline,
    handoff_summary: handoffSummary,
    checklist,
  };
}

export function buildTicketStageGateStatus(ticket = {}, options = {}) {
  const workflowTicket = buildTicketViewModel(ticket);
  const orchestration = options.orchestration || buildTicketStageOrchestration(workflowTicket, options);
  const missingOwners = [];

  if (!workflowTicket.triage_owner) missingOwners.push('triage_owner');
  if (!workflowTicket.assigned_agent) missingOwners.push('assigned_agent');
  if (['done', 'review'].includes(workflowTicket.status) && !workflowTicket.review_owner) missingOwners.push('review_owner');
  if (workflowTicket.status === 'pending_decision' && !workflowTicket.decision_owner) missingOwners.push('decision_owner');

  const hasActionPath = Boolean(orchestration.next_action || orchestration.next_stage_key);
  const blockedByWorkerEvidence = workflowTicket.status === 'queued'
    && String(workflowTicket.execution_mode || 'direct').toLowerCase() === 'subagent'
    && workflowTicket.dispatch_state === 'receipt_accepted'
    && !(workflowTicket.execution_guard?.has_active_execution_evidence
      ?? workflowTicket.execution_guard?.has_worker_evidence);

  let state = 'ready';
  let label = '门禁就绪';
  let summary = '当前阶段已有责任人和下一步路径，可继续推进。';

  if (missingOwners.length > 0) {
    state = 'gap';
    label = '责任链缺口';
    summary = `缺少 ${missingOwners.join(' / ')}，建议先补齐责任链。`;
  } else if (blockedByWorkerEvidence) {
    state = 'at_risk';
    label = '缺 worker 证据';
    summary = 'subagent queued 已 receipt，但还没有活跃 worker 执行证据（历史 succeeded 不算新的开工）。';
  } else if (!hasActionPath) {
    state = 'unknown';
    label = '待补动作';
    summary = '当前未解析到明确下一步动作或目标阶段。';
  }

  return {
    state,
    label,
    summary,
    missing_owners: missingOwners,
    next_action: orchestration.next_action || null,
    next_stage_label: orchestration.next_stage_label || null,
  };
}

export function buildTicketListSummary(tickets = []) {
  const orchestrated = tickets.map((ticket) => buildTicketStageOrchestration(ticket));
  return {
    total: tickets.length,
    open: countTickets(tickets, (ticket) => isOpenWorkflowStatus(ticket.status)),
    active: countTickets(tickets, (ticket) => isActiveWorkflowStatus(ticket.status)),
    waitingReview: countTickets(tickets, (ticket) => isWaitingReviewWorkflowStatus(ticket.status)),
    inProgress: countTickets(tickets, (ticket) => ticket.status === 'running'),
    closed: countTickets(tickets, (ticket) => isClosedWorkflowStatus(ticket.status)),
    pendingDecision: countTickets(tickets, (ticket) => ticket.status === 'pending_decision'),
    blocked: countTickets(tickets, (ticket) => ticket.status === 'blocked'),
    handoffToReviewer: orchestrated.filter((item) => item.next_stage_key === 'done' || item.current_stage_key === 'done' || item.current_stage_key === 'review').length,
  };
}
