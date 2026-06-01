import { buildDashboardMetrics, buildTicketQuickViews, buildTicketViewModel } from '../../ticket-selectors.js';
import { KANBAN_COLUMNS, WORKFLOW_STATUS_ORDER } from '../../workflow-schema.js';

export const FRONTEND_ACCEPTANCE_TICKETS = [
  {
    id: 101,
    title: 'Triage baseline ticket',
    status: 'triage',
    priority: 'high',
    triage_owner: 'leoss',
    assigned_agent: 'beavy',
    review_owner: 'leoss',
    next_actor: 'leoss',
    next_actor_source: 'triage_owner',
    platform: 'ticket-platform',
    request_type: 'bug',
    triage_summary: '需要补全 triage 字段后再放行。',
    description: '用于验证待分诊语义。',
    created: '2026-03-05T09:00:00.000Z',
    last_update: '2026-03-05T09:30:00.000Z',
    comments: [],
  },
  {
    id: 102,
    title: 'Queued baseline ticket',
    status: 'queued',
    priority: 'medium',
    triage_owner: 'leoss',
    assigned_agent: 'beavy',
    review_owner: 'leoss',
    next_actor: 'beavy',
    next_actor_source: 'assigned_agent',
    platform: 'ticket-platform',
    request_type: 'feature',
    triage_summary: '已可执行。',
    description: '用于验证待处理语义。',
    created: '2026-03-06T09:00:00.000Z',
    last_update: '2026-03-06T09:30:00.000Z',
    comments: [],
  },
  {
    id: 103,
    title: 'Running baseline ticket',
    status: 'running',
    priority: 'critical',
    triage_owner: 'leoss',
    assigned_agent: 'beavy',
    review_owner: 'leoss',
    next_actor: 'beavy',
    next_actor_source: 'assigned_agent',
    platform: 'ticket-platform',
    request_type: 'task',
    triage_summary: '执行中。',
    description: '用于验证进行中语义。',
    created: '2026-03-07T09:00:00.000Z',
    last_update: '2026-03-07T09:30:00.000Z',
    comments: [],
  },
  {
    id: 104,
    title: 'Paused baseline ticket',
    status: 'paused',
    priority: 'medium',
    triage_owner: 'leoss',
    assigned_agent: 'beavy',
    review_owner: 'leoss',
    paused_by: 'beavy',
    paused_from_status: 'running',
    pause_reason: '等待外部依赖',
    next_actor: 'beavy',
    next_actor_source: 'paused_by',
    platform: 'ticket-platform',
    request_type: 'task',
    triage_summary: '等待恢复。',
    description: '用于验证暂时挂起语义。',
    created: '2026-03-08T09:00:00.000Z',
    last_update: '2026-03-08T09:30:00.000Z',
    comments: [],
  },
  {
    id: 105,
    title: 'Done baseline ticket',
    status: 'done',
    priority: 'medium',
    triage_owner: 'leoss',
    assigned_agent: 'beavy',
    review_owner: 'leoss',
    next_actor: 'leoss',
    next_actor_source: 'review_owner',
    platform: 'ticket-platform',
    request_type: 'feature',
    triage_summary: '待 reviewer 验收。',
    result_summary: '功能已完成，等待验收。',
    description: '用于验证待验收语义。',
    created: '2026-03-09T09:00:00.000Z',
    last_update: '2026-03-09T09:30:00.000Z',
    comments: [],
  },
  {
    id: 106,
    title: 'Review baseline ticket',
    status: 'review',
    priority: 'medium',
    triage_owner: 'leoss',
    assigned_agent: 'beavy',
    review_owner: 'leoss',
    next_actor: 'leoss',
    next_actor_source: 'review_owner',
    platform: 'ticket-platform',
    request_type: 'feature',
    triage_summary: '审核中。',
    description: '用于验证审核中语义。',
    created: '2026-03-10T09:00:00.000Z',
    last_update: '2026-03-10T09:30:00.000Z',
    comments: [],
  },
  {
    id: 107,
    title: 'Decision baseline ticket',
    status: 'pending_decision',
    priority: 'high',
    triage_owner: 'leoss',
    assigned_agent: 'beavy',
    review_owner: 'leoss',
    decision_owner: '荣晖',
    decision_summary: '需要确认是否冻结 baseline。',
    next_actor: '荣晖',
    next_actor_source: 'decision_owner',
    platform: 'ticket-platform',
    request_type: 'feature',
    triage_summary: '待老大决策。',
    description: '用于验证待决策语义。',
    created: '2026-03-11T09:00:00.000Z',
    last_update: '2026-03-11T09:30:00.000Z',
    comments: [],
  },
  {
    id: 108,
    title: 'Blocked baseline ticket',
    status: 'blocked',
    priority: 'high',
    triage_owner: 'leoss',
    assigned_agent: 'beavy',
    review_owner: 'leoss',
    next_actor: 'leoss',
    next_actor_source: 'triage_owner',
    platform: 'ticket-platform',
    request_type: 'bug',
    triage_summary: '阻塞待解除。',
    description: '用于验证阻塞语义。',
    created: '2026-03-04T09:00:00.000Z',
    last_update: '2026-03-11T10:00:00.000Z',
    comments: [],
  },
  {
    id: 109,
    title: 'Failed baseline ticket',
    status: 'failed',
    priority: 'low',
    triage_owner: 'leoss',
    assigned_agent: 'beavy',
    review_owner: 'leoss',
    next_actor: 'leoss',
    next_actor_source: 'triage_owner',
    platform: 'ticket-platform',
    request_type: 'task',
    triage_summary: '失败收口。',
    description: '用于验证失败终态语义。',
    created: '2026-03-03T09:00:00.000Z',
    last_update: '2026-03-11T08:30:00.000Z',
    comments: [],
  },
  {
    id: 110,
    title: 'Complete baseline ticket',
    status: 'complete',
    priority: 'low',
    triage_owner: 'leoss',
    assigned_agent: 'beavy',
    review_owner: 'leoss',
    next_actor: null,
    next_actor_source: null,
    platform: 'ticket-platform',
    request_type: 'task',
    triage_summary: '已完结。',
    description: '用于验证已关单终态语义。',
    created: '2026-03-02T09:00:00.000Z',
    last_update: '2026-03-11T07:30:00.000Z',
    comments: [],
  },
  {
    id: 111,
    title: 'Deprecated baseline ticket',
    status: 'deprecated',
    priority: 'low',
    triage_owner: 'leoss',
    assigned_agent: 'beavy',
    review_owner: 'leoss',
    next_actor: null,
    next_actor_source: null,
    deprecation_reason: '历史残留工单归档为废弃。',
    platform: 'ticket-platform',
    request_type: 'task',
    triage_summary: '历史残留，不再进入执行流。',
    description: '用于验证已废弃终态语义。',
    created: '2026-03-01T09:00:00.000Z',
    last_update: '2026-03-11T06:30:00.000Z',
    comments: [],
  },
  {
    id: 112,
    title: 'Triage incomplete ticket',
    status: 'triage',
    priority: 'medium',
    triage_owner: 'leoss',
    assigned_agent: '',
    review_owner: 'leoss',
    next_actor: 'leoss',
    next_actor_source: 'triage_owner',
    platform: '',
    request_type: '',
    triage_summary: '',
    description: '用于验证分诊待补全 quick view。',
    created: '2026-03-11T11:00:00.000Z',
    last_update: '2026-03-11T11:30:00.000Z',
    comments: [],
  },
];

export const FRONTEND_ACCEPTANCE_VIEW_MODELS = FRONTEND_ACCEPTANCE_TICKETS.map((ticket) => buildTicketViewModel(ticket));

export const FRONTEND_ACCEPTANCE_DASHBOARD_PAYLOAD = {
  data: buildDashboardMetrics(FRONTEND_ACCEPTANCE_VIEW_MODELS, {
    now: new Date('2026-03-11T12:00:00.000Z'),
  }),
};

export const FRONTEND_ACCEPTANCE_QUICK_VIEWS = buildTicketQuickViews(FRONTEND_ACCEPTANCE_VIEW_MODELS);

export const FRONTEND_ACCEPTANCE_BOTS = [
  {
    name: 'beavy',
    displayName: '小李',
    status: 'active',
    tokens: '32k/200k',
    usage: 16,
    emoji: '🦫',
    currentTask: { id: 103, title: 'Running baseline ticket', progress: 50 },
    queue: [{ id: 102, title: 'Queued baseline ticket' }],
    stats: { todayCompleted: 2, avgResponseTime: '2.1min', successRate: 99, uptime: '1d 4h' },
    recentTasks: [{ id: 111, title: 'Deprecated baseline ticket', status: 'deprecated', time: '10:30' }],
  },
  {
    name: 'donky',
    displayName: '小驴',
    status: 'idle',
    tokens: '44k/200k',
    usage: 22,
    emoji: '🫏',
    currentTask: null,
    queue: [],
    stats: { todayCompleted: 1, avgResponseTime: '2.8min', successRate: 97, uptime: '3d 2h' },
    recentTasks: [],
  },
];

export const FRONTEND_ACCEPTANCE_TICKET_DETAIL = {
  ...FRONTEND_ACCEPTANCE_TICKETS.find((ticket) => ticket.id === 104),
  locked_by: 'beavy',
  comments: [
    {
      id: 5001,
      author: 'leoss',
      timestamp: '2026-03-11T08:00:00.000Z',
      content: '先暂停，等 fixture parity 收口后再继续。',
      type: 'progress',
      visibility: 'internal',
      mentions: [],
      notify_targets: [],
    },
  ],
  supplemental_for_ticket: {
    relation_type: 'smoke_of',
    relation_label: 'Smoke 验证',
    ticket: { id: 88, title: 'Primary baseline ticket', status: 'review' },
  },
  supplemental_tickets: [
    {
      relation_type: 'validation_of',
      relation_label: '补充验证',
      ticket: { id: 89, title: 'Validation baseline ticket', status: 'done', result_summary: '待 reviewer 收口' },
    },
  ],
  supplemental_summary: { total: 1, open: 1, complete: 0, pending_review: 1, by_status: { done: 1 } },
};

export const FRONTEND_ACCEPTANCE_AGENT_ACTION_MATRIX = {
  triage: ['queue', 'pause'],
  queued: ['start_work', 'pause'],
  running: ['pause'],
  paused: ['resume'],
  done: ['pause', 'approve', 'reject'],
  review: ['pause', 'approve', 'reject'],
  blocked: ['pause'],
  pending_decision: ['pause'],
};

export const FRONTEND_ACCEPTANCE_ACTION_SCENARIOS = {
  paused: {
    ticket: FRONTEND_ACCEPTANCE_TICKETS.find((ticket) => ticket.status === 'paused'),
    available_actions: FRONTEND_ACCEPTANCE_AGENT_ACTION_MATRIX.paused,
  },
  review: {
    ticket: FRONTEND_ACCEPTANCE_TICKETS.find((ticket) => ticket.status === 'review'),
    available_actions: FRONTEND_ACCEPTANCE_AGENT_ACTION_MATRIX.review,
  },
  pending_decision: {
    ticket: FRONTEND_ACCEPTANCE_TICKETS.find((ticket) => ticket.status === 'pending_decision'),
    available_actions: ['resume_from_decision'],
  },
};

export const FRONTEND_ACCEPTANCE_ACTIONS = {
  available_actions: FRONTEND_ACCEPTANCE_ACTION_SCENARIOS.paused.available_actions,
};

export function listAcceptanceAgentActionStatuses() {
  return Object.keys(FRONTEND_ACCEPTANCE_AGENT_ACTION_MATRIX);
}

export const FRONTEND_ACCEPTANCE_DEPENDENCIES = {
  dependencies: [
    {
      id: 7001,
      ticket_id: 104,
      depends_on_ticket_id: 103,
      dependency_type: 'blocks',
      created_at: '2026-03-11T08:10:00.000Z',
    },
  ],
  dependents: [
    {
      id: 7002,
      ticket_id: 105,
      depends_on_ticket_id: 104,
      dependency_type: 'blocks',
      created_at: '2026-03-11T08:20:00.000Z',
    },
  ],
};

export function buildExpectedKanbanColumns() {
  return KANBAN_COLUMNS.map((column) => column.label);
}

export function buildAcceptanceStatusSet() {
  return new Set(FRONTEND_ACCEPTANCE_TICKETS.map((ticket) => ticket.status));
}

export function listMissingAcceptanceStatuses() {
  const covered = buildAcceptanceStatusSet();
  return WORKFLOW_STATUS_ORDER.filter((status) => !covered.has(status));
}
