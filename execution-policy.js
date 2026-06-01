const DIRECT_MODE = 'direct';

export const EXECUTION_MODES = ['direct', 'subagent', 'acp'];
export const EXECUTION_WORKER_STATUSES = [
  'starting',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
];

export const ACTIVE_WORKER_STATUSES = new Set(['starting', 'running']);
export const TERMINAL_WORKER_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);
export const COMPLETED_EVIDENCE_WORKER_STATUSES = new Set(['succeeded']);
/** 终态但不算「完成证据」（不可当作已交付） */
export const FAILED_TERMINAL_WORKER_STATUSES = new Set(['failed', 'timed_out', 'cancelled']);

/** 与 store 层一致：starting 无身份/无新鲜 heartbeat 在读模型中视为 stale（非持久化枚举） */
export const STALE_STARTING_HEARTBEAT_MINUTES = 5;
export const DERIVED_WORKER_LIFECYCLE_STALE = 'stale';

export const EXECUTION_MODE_META = {
  direct: {
    key: 'direct',
    label: '直做',
    worker_type: null,
    allow_worker: false,
    default_max_active_workers: 0,
    description: '由工单责任人直接在当前 ticket session / 主流程内处理，不允许再登记子 worker。',
  },
  subagent: {
    key: 'subagent',
    label: '子代理',
    worker_type: 'subagent',
    allow_worker: true,
    default_max_active_workers: 1,
    description: '由平台登记的子代理异步执行，要求有 worker 回写与并发门禁。',
  },
  acp: {
    key: 'acp',
    label: 'ACP',
    worker_type: 'acp',
    allow_worker: true,
    default_max_active_workers: 1,
    description: '由 ACP harness / Cursor / Codex / Claude Code 等外部编排执行，要求回写运行单元。',
  },
};

export const EXECUTION_POLICY_RULES = [
  {
    key: 'remote_or_acp_orchestrator',
    mode: 'acp',
    description: '远程 SSH/tmux/Cursor/ACP/Claude Code/Codex 等编排任务默认下沉到 ACP。',
    patterns: [
      /\bacp\b/i,
      /cursor/i,
      /claude\s*code/i,
      /codex/i,
      /opencode/i,
      /\bpi\b/i,
      /gemini/i,
      /ssh/i,
      /tmux/i,
      /remote/i,
      /远程/i,
      /willrone/i,
    ],
  },
  {
    key: 'coding_or_browser_long_task',
    mode: 'subagent',
    description: '编码、重构、长浏览器自动化、批处理/训练/回测等长任务默认下沉到 subagent。',
    patterns: [
      /代码|编码|开发|实现|重构|修复|前端|后端|数据库|接口|联调/u,
      /coding|codebase|refactor|implement|build|frontend|backend|database|migration|api/i,
      /browser automation|playwright|puppeteer|selenium/i,
      /浏览器自动化|长任务|批处理|训练|回测|爬取/u,
      /batch|training|backtest|crawl|scrape/i,
    ],
  },
];

function cleanText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

export function normalizeExecutionMode(value) {
  const normalized = cleanText(value).toLowerCase();
  return EXECUTION_MODES.includes(normalized) ? normalized : null;
}

export function normalizeWorkerStatus(value) {
  const normalized = cleanText(value).toLowerCase();
  return EXECUTION_WORKER_STATUSES.includes(normalized) ? normalized : null;
}

export function isExecutionWorkerActiveStatus(status) {
  return ACTIVE_WORKER_STATUSES.has(cleanText(status).toLowerCase());
}

export function isExecutionWorkerTerminalStatus(status) {
  return TERMINAL_WORKER_STATUSES.has(cleanText(status).toLowerCase());
}

export function executionModeRequiresWorker(mode) {
  return Boolean(getExecutionModeMeta(mode)?.allow_worker);
}

/**
 * 读模型生命周期：在持久化 status 之上推导 stale（弱 starting / 过期 heartbeat）。
 * 不入库；供控制台与 API 解释输出。
 */
export function deriveExecutionWorkerLifecycleStatus(worker = {}, options = {}) {
  const staleMinutes = Number(options.staleStartingHeartbeatMinutes ?? STALE_STARTING_HEARTBEAT_MINUTES);
  const normalized = normalizeWorkerStatus(worker?.status);
  if (!normalized) return null;
  if (TERMINAL_WORKER_STATUSES.has(normalized)) return normalized;

  const hasIdentity = String(worker?.session_key || '').trim() || String(worker?.run_id || '').trim();
  const hb = worker?.last_heartbeat_at;
  const hbMs = hb ? Date.parse(hb) : NaN;
  const cutoff = Date.now() - (Number.isFinite(staleMinutes) ? staleMinutes : STALE_STARTING_HEARTBEAT_MINUTES) * 60 * 1000;
  const freshHb = Number.isFinite(hbMs) && hbMs >= cutoff;

  if (normalized === 'starting') {
    if (!hasIdentity || !Number.isFinite(hbMs) || !freshHb) return DERIVED_WORKER_LIFECYCLE_STALE;
    return 'starting';
  }
  return normalized;
}

export const DERIVED_COMMENT_ACTIVE_WORKER_MAX_AGE_MINUTES = 180;

const ACTIVE_REPORT_TYPES = new Set([
  'dispatch_receipt',
  'progress_update',
  'analysis_result',
  'workflow_warning',
  'handoff_note',
  'decision_request',
  'blocked_report',
]);
const COMPLETED_REPORT_TYPES = new Set(['execution_completed', 'review_submission']);
const FAILED_REPORT_TYPES = new Set(['execution_failed']);

function normalizeWorkerType(value) {
  const normalized = cleanText(value).toLowerCase();
  return normalized === 'subagent' || normalized === 'acp' || normalized === 'direct'
    ? normalized
    : null;
}

function buildWorkerIdentity(worker = {}) {
  const sessionKey = cleanText(worker?.session_key);
  const runId = cleanText(worker?.run_id);
  const workerKey = cleanText(worker?.worker_key);
  if (sessionKey || runId) return `identity:${sessionKey}::${runId}`;
  if (workerKey) return `worker_key:${workerKey}`;
  return null;
}

function uniqueWorkers(...groups) {
  const seen = new Set();
  const merged = [];
  groups.flat().forEach((worker) => {
    if (!worker || typeof worker !== 'object') return;
    const key = buildWorkerIdentity(worker) || `anonymous:${merged.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(worker);
  });
  return merged;
}

function normalizeCount(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function extractFirstMatch(text, patterns = []) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return cleanText(match[1]);
  }
  return '';
}

function extractAgentReportType(text = '') {
  const match = /【agent_report】([^\n]+)/u.exec(text);
  return cleanText(match?.[1]).toLowerCase() || null;
}

function inferDerivedWorkerStatus(explicitStatus, reportType) {
  const normalizedExplicit = normalizeWorkerStatus(explicitStatus);
  if (normalizedExplicit) return normalizedExplicit;
  if (COMPLETED_REPORT_TYPES.has(reportType)) return 'succeeded';
  if (FAILED_REPORT_TYPES.has(reportType)) return 'failed';
  if (ACTIVE_REPORT_TYPES.has(reportType)) return 'running';
  return 'running';
}

function buildDerivedWorkerKey(workerType, sessionKey, runId) {
  const base = cleanText(sessionKey || runId || 'worker')
    .replace(/[^a-zA-Z0-9:_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `derived-${workerType || 'worker'}-${base || 'comment'}`;
}

function buildDerivedCommentWorkers(ticket = {}, options = {}) {
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  if (comments.length === 0) {
    return { execution_workers: [], current_workers: [] };
  }

  const expectedWorkerType = getExecutionModeMeta(ticket.execution_mode)?.worker_type || null;
  const activeAgeMinutes = Number(options.activeAgeMinutes ?? DERIVED_COMMENT_ACTIVE_WORKER_MAX_AGE_MINUTES);
  const activeCutoffMs = Date.now() - (Number.isFinite(activeAgeMinutes) ? activeAgeMinutes : DERIVED_COMMENT_ACTIVE_WORKER_MAX_AGE_MINUTES) * 60 * 1000;
  const derivedByIdentity = new Map();

  comments.forEach((comment, index) => {
    const text = cleanText(comment?.content, 10000);
    if (!text) return;
    if (!/worker_session|worker_run_id|worker_status|worker_type|worker_label|worker_summary|run_id/u.test(text)) return;

    const sessionKey = extractFirstMatch(text, [
      /(?:^|\n)[\-*•]?\s*worker_session_key\s*[:=]\s*([^\s]+)\s*(?=\n|$)/imu,
      /(?:^|\n)[\-*•]?\s*worker_session\s*[:=]\s*([^\s]+)\s*(?=\n|$)/imu,
    ]);
    const runId = extractFirstMatch(text, [
      /(?:^|\n)[\-*•]?\s*worker_run_id\s*[:=]\s*([^\s]+)\s*(?=\n|$)/imu,
      /(?:^|\n)[\-*•]?\s*run_id\s*[:=]\s*([^\s]+)\s*(?=\n|$)/imu,
    ]);
    if (!sessionKey && !runId) return;

    const reportType = extractAgentReportType(text);
    const workerType = normalizeWorkerType(extractFirstMatch(text, [
      /(?:^|\n)[\-*•]?\s*worker_type\s*[:=]\s*(subagent|acp|direct)\s*(?=\n|$)/imu,
    ])) || expectedWorkerType;
    if (expectedWorkerType && workerType && workerType !== expectedWorkerType) return;

    const timestamp = cleanText(comment?.timestamp || comment?.created_at || comment?.updated_at) || new Date().toISOString();
    const status = inferDerivedWorkerStatus(
      extractFirstMatch(text, [
        /(?:^|\n)[\-*•]?\s*worker_status\s*[:=]\s*(starting|running|succeeded|failed|timed_out|cancelled)\s*(?=\n|$)/imu,
      ]),
      reportType,
    );
    const worker = {
      id: `derived-comment-${comment?.id ?? index}`,
      ticket_id: ticket.id ?? null,
      worker_key: buildDerivedWorkerKey(workerType, sessionKey, runId),
      worker_type: workerType || expectedWorkerType || null,
      status,
      session_key: sessionKey || null,
      run_id: runId || null,
      label: extractFirstMatch(text, [
        /(?:^|\n)[\-*•]?\s*worker_label\s*[:=]\s*(.+?)\s*(?=\n|$)/imu,
      ]) || buildDerivedWorkerKey(workerType, sessionKey, runId),
      summary: extractFirstMatch(text, [
        /(?:^|\n)[\-*•]?\s*worker_summary\s*[:=]\s*(.+?)\s*(?=\n|$)/imu,
      ]) || `Derived from agent_report ${reportType || 'comment'}`,
      started_at: timestamp,
      last_heartbeat_at: timestamp,
      finished_at: TERMINAL_WORKER_STATUSES.has(status) ? timestamp : null,
      metadata: {
        source: 'agent_report_comment',
        comment_id: comment?.id ?? null,
        comment_type: comment?.type ?? null,
        report_type: reportType,
        inferred: true,
      },
      created_at: timestamp,
      updated_at: timestamp,
    };

    const identity = buildWorkerIdentity(worker);
    if (!identity) return;
    const prev = derivedByIdentity.get(identity);
    const prevTs = Date.parse(prev?.updated_at || prev?.last_heartbeat_at || prev?.started_at || '') || 0;
    const nextTs = Date.parse(worker.updated_at || worker.last_heartbeat_at || worker.started_at || '') || 0;
    if (!prev || nextTs >= prevTs) {
      derivedByIdentity.set(identity, worker);
    }
  });

  const executionWorkers = Array.from(derivedByIdentity.values());
  const currentWorkers = executionWorkers.filter((worker) => {
    if (!isExecutionWorkerActiveStatus(worker?.status)) return false;
    const hbMs = Date.parse(worker?.last_heartbeat_at || worker?.started_at || '');
    return Number.isFinite(hbMs) && hbMs >= activeCutoffMs;
  });

  return {
    execution_workers: executionWorkers,
    current_workers: currentWorkers,
  };
}

export function mergeExecutionWorkerProjection(ticket = {}, options = {}) {
  const rawCurrentWorkers = Array.isArray(ticket.current_workers) ? ticket.current_workers : [];
  const rawExecutionWorkers = Array.isArray(ticket.execution_workers) ? ticket.execution_workers : [];
  const rawWorkerStats = ticket.worker_stats && typeof ticket.worker_stats === 'object'
    ? ticket.worker_stats
    : {};

  const derivedWorkers = buildDerivedCommentWorkers(ticket, options);
  const executionWorkers = uniqueWorkers(rawExecutionWorkers, derivedWorkers.execution_workers);
  const currentWorkers = uniqueWorkers(rawCurrentWorkers, derivedWorkers.current_workers);
  const runningWorkersFromCurrent = currentWorkers.filter((worker) => normalizeWorkerStatus(worker?.status) === 'running').length;
  const historicalStartedWorkers = executionWorkers.filter((worker) => {
    const status = normalizeWorkerStatus(worker?.status);
    if (!status || TERMINAL_WORKER_STATUSES.has(status)) return false;
    const hasIdentity = String(worker?.session_key || '').trim() || String(worker?.run_id || '').trim();
    return Boolean(hasIdentity && (worker?.last_heartbeat_at || worker?.started_at));
  }).length;

  return {
    execution_workers: executionWorkers,
    current_workers: currentWorkers,
    worker_stats: {
      ...rawWorkerStats,
      total_workers: Math.max(normalizeCount(rawWorkerStats.total_workers, 0), executionWorkers.length),
      active_workers: Math.max(normalizeCount(rawWorkerStats.active_workers, 0), currentWorkers.length),
      running_workers: Math.max(normalizeCount(rawWorkerStats.running_workers, 0), runningWorkersFromCurrent),
      historical_started_workers: Math.max(normalizeCount(rawWorkerStats.historical_started_workers, 0), historicalStartedWorkers),
    },
  };
}

export function getExecutionWorkerEvidence(ticket = {}) {
  const projection = mergeExecutionWorkerProjection(ticket);
  const currentWorkers = Array.isArray(projection.current_workers) ? projection.current_workers : [];
  const executionWorkers = Array.isArray(projection.execution_workers) ? projection.execution_workers : [];
  const workerStats = projection.worker_stats && typeof projection.worker_stats === 'object'
    ? projection.worker_stats
    : {};

  const currentWorkersCount = currentWorkers.length;
  const activeWorkers = normalizeCount(workerStats.active_workers, currentWorkersCount);
  const totalWorkers = normalizeCount(workerStats.total_workers, executionWorkers.length || currentWorkersCount || 0);
  const runningWorkers = normalizeCount(workerStats.running_workers, currentWorkers.filter((worker) => worker?.status === 'running').length || 0);
  const succeededWorkersFromWorkers = executionWorkers.filter((worker) => COMPLETED_EVIDENCE_WORKER_STATUSES.has(normalizeWorkerStatus(worker?.status))).length;
  const succeededWorkersFromStats = normalizeCount(workerStats.succeeded_workers, 0);
  const succeededWorkers = Math.max(succeededWorkersFromWorkers, succeededWorkersFromStats);
  const failedTerminalWorkersFromWorkers = executionWorkers.filter((worker) => FAILED_TERMINAL_WORKER_STATUSES.has(normalizeWorkerStatus(worker?.status))).length;
  const failedTerminalWorkersFromStats = normalizeCount(workerStats.failed_terminal_workers, 0);
  const failedTerminalWorkers = Math.max(failedTerminalWorkersFromWorkers, failedTerminalWorkersFromStats);
  const historicalStartedWorkers = normalizeCount(
    workerStats.historical_started_workers,
    executionWorkers.filter((worker) => {
      const status = normalizeWorkerStatus(worker?.status);
      if (!status || TERMINAL_WORKER_STATUSES.has(status)) return false;
      const hasIdentity = String(worker?.session_key || '').trim() || String(worker?.run_id || '').trim();
      return Boolean(hasIdentity && worker?.last_heartbeat_at);
    }).length,
  );

  const hasActiveExecutionEvidence = currentWorkersCount > 0 || activeWorkers > 0 || runningWorkers > 0;

  return {
    requires_worker: executionModeRequiresWorker(ticket.execution_mode),
    current_workers: currentWorkersCount,
    active_workers: activeWorkers,
    running_workers: runningWorkers,
    total_workers: totalWorkers,
    succeeded_workers: succeededWorkers,
    failed_terminal_workers: failedTerminalWorkers,
    historical_started_workers: historicalStartedWorkers,
    /** 任意正向 worker 痕迹；失败终态不计入（避免误当完成证据放行门禁） */
    has_worker_evidence: hasActiveExecutionEvidence || succeededWorkers > 0,
    /** 当前可阻塞派单/握手灰态的「真实在执行」证据（不含仅历史 succeeded） */
    has_active_execution_evidence: hasActiveExecutionEvidence,
    has_completed_execution_evidence: succeededWorkers > 0,
    has_historical_started_worker: historicalStartedWorkers > 0,
  };
}

export function hasExecutionWorkerEvidence(ticket = {}) {
  return getExecutionWorkerEvidence(ticket).has_worker_evidence;
}

export function normalizeMaxActiveWorkers(value, mode = DIRECT_MODE) {
  const meta = EXECUTION_MODE_META[mode] || EXECUTION_MODE_META.direct;
  if (!meta.allow_worker) return 0;
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return meta.default_max_active_workers;
  return Math.min(parsed, 3);
}

export function collectExecutionSourceText(ticket = {}) {
  return [
    ticket.title,
    ticket.description,
    ticket.platform,
    ticket.request_type,
    ticket.triage_summary,
    ticket.implementation_scope,
    ticket.constraints,
    ticket.deliverables,
    ticket.acceptance_criteria,
  ].map(cleanText).filter(Boolean).join('\n');
}

export function inferExecutionPolicy(ticket = {}) {
  const haystack = collectExecutionSourceText(ticket);
  for (const rule of EXECUTION_POLICY_RULES) {
    const matchedPatterns = rule.patterns
      .filter((pattern) => pattern.test(haystack))
      .map((pattern) => pattern.toString());
    if (matchedPatterns.length > 0) {
      const maxActiveWorkers = normalizeMaxActiveWorkers(ticket.max_active_workers, rule.mode);
      return {
        execution_mode: rule.mode,
        execution_mode_source: 'policy',
        execution_rule_key: rule.key,
        max_active_workers: maxActiveWorkers,
        matched_signals: matchedPatterns,
        worker_type: EXECUTION_MODE_META[rule.mode].worker_type,
        allow_worker: EXECUTION_MODE_META[rule.mode].allow_worker,
      };
    }
  }

  return {
    execution_mode: DIRECT_MODE,
    execution_mode_source: 'policy',
    execution_rule_key: 'direct_default',
    max_active_workers: 0,
    matched_signals: [],
    worker_type: null,
    allow_worker: false,
  };
}

export function resolveExecutionPolicy(ticket = {}, options = {}) {
  const explicitMode = normalizeExecutionMode(ticket.execution_mode);
  if (explicitMode) {
    const meta = EXECUTION_MODE_META[explicitMode] || EXECUTION_MODE_META.direct;
    return {
      execution_mode: explicitMode,
      execution_mode_source: cleanText(ticket.execution_mode_source) || 'manual',
      execution_rule_key: cleanText(ticket.execution_rule_key) || `manual_${explicitMode}`,
      max_active_workers: normalizeMaxActiveWorkers(ticket.max_active_workers, explicitMode),
      matched_signals: Array.isArray(ticket.execution_matched_signals) ? ticket.execution_matched_signals : [],
      worker_type: meta.worker_type,
      allow_worker: meta.allow_worker,
    };
  }

  if (options.forcePolicy) {
    return inferExecutionPolicy(ticket);
  }

  return {
    execution_mode: DIRECT_MODE,
    execution_mode_source: 'legacy_default',
    execution_rule_key: 'legacy_direct_default',
    max_active_workers: 0,
    matched_signals: [],
    worker_type: null,
    allow_worker: false,
  };
}

export function getExecutionModeMeta(mode) {
  return EXECUTION_MODE_META[normalizeExecutionMode(mode) || DIRECT_MODE];
}

export function validateWorkerTypeForMode(mode, workerType) {
  const normalizedMode = normalizeExecutionMode(mode) || DIRECT_MODE;
  const normalizedWorkerType = cleanText(workerType).toLowerCase();
  const meta = EXECUTION_MODE_META[normalizedMode] || EXECUTION_MODE_META.direct;

  if (!meta.allow_worker) {
    return {
      ok: false,
      message: `execution_mode=${normalizedMode} 不允许登记 worker`,
    };
  }

  if (normalizedWorkerType !== meta.worker_type) {
    return {
      ok: false,
      message: `execution_mode=${normalizedMode} 仅允许 worker_type=${meta.worker_type}`,
      expected_worker_type: meta.worker_type,
    };
  }

  return { ok: true, worker_type: normalizedWorkerType };
}

export function getExecutionSchema() {
  return {
    modes: EXECUTION_MODES.map((mode) => EXECUTION_MODE_META[mode]),
    worker_statuses: EXECUTION_WORKER_STATUSES,
    derived_worker_lifecycle_statuses: [DERIVED_WORKER_LIFECYCLE_STALE],
    stale_starting_heartbeat_minutes: STALE_STARTING_HEARTBEAT_MINUTES,
    evidence_tiers: {
      active_execution: '活跃执行证据（current_workers / active / running）',
      historical_started: '曾启动的 starting 记录（可能含过期 heartbeat，需结合 lifecycle 解读）',
      completed: '终态 succeeded，可作为完成交付证据',
      failed_terminal: 'failed / timed_out / cancelled，不计入完成证据',
    },
    rules: EXECUTION_POLICY_RULES.map((rule) => ({
      key: rule.key,
      mode: rule.mode,
      description: rule.description,
    })),
  };
}
