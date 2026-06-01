/**
 * Bot 状态管理 - 从 OpenClaw + 工单系统获取真实 agent 状态
 */
import { spawn } from 'child_process';
import * as store from './store.js';

const OPENCLAW_CLI = process.env.OPENCLAW_CLI || 'openclaw';
const RECENT_ACTIVITY_MS = 5 * 60 * 1000;
const ACTIVE_TICKET_STATUSES = new Set(['queued', 'running', 'done', 'review', 'blocked', 'pending_decision', 'paused']);
const TERMINAL_TICKET_STATUSES = new Set(['complete', 'failed', 'deprecated']);

// Bot 配置（emoji 和显示名）
const BOT_CONFIG = {
  beavy: { emoji: '🦫', displayName: '小李' },
  cowder: { emoji: '🐮', displayName: '小牛' },
  donky: { emoji: '🫏', displayName: '小驴' },
  doggy: { emoji: '🐕', displayName: '小狗' },
  marely: { emoji: '🐴', displayName: '小马' },
  xiaoying: { emoji: '🦅', displayName: '小鹰' },
  xiaoyi: { emoji: '🐜', displayName: '小蚁' },
  auditor: { emoji: '🐑', displayName: '小羊', nickname: 'sheeply' },
};

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIsoOrNull(value) {
  const ms = toMs(value);
  return ms > 0 ? new Date(ms).toISOString() : null;
}

function formatTokens(totalTokens = 0, contextTokens = 200000) {
  return `${Math.round((Number(totalTokens) || 0) / 1000)}k/${Math.round((Number(contextTokens) || 0) / 1000)}k`;
}

function getSessionType(sessionKey = '') {
  if (/^agent:[^:]+:ticket:\d+$/.test(sessionKey)) return 'ticket';
  if (/^agent:[^:]+:audit:\d+$/.test(sessionKey)) return 'audit';
  if (/^agent:[^:]+:subagent:/.test(sessionKey)) return 'subagent';
  if (/^agent:[^:]+:main/.test(sessionKey)) return 'main';
  return 'other';
}

function getTicketIdFromSessionKey(sessionKey = '') {
  const match = /^agent:[^:]+:ticket:(\d+)$/.exec(String(sessionKey || ''));
  return match ? Number(match[1]) : null;
}

function buildTicketMaps(tickets = []) {
  const byId = new Map();
  const byAgent = new Map();

  for (const ticket of tickets) {
    const normalized = {
      id: Number(ticket.id),
      title: ticket.title || '',
      status: ticket.status || '',
      assigned_agent: ticket.assigned_agent || null,
      last_update: ticket.last_update || ticket.updated_at || ticket.created || null,
      session_key: ticket.session_key || null,
      current_workers: Array.isArray(ticket.current_workers) ? ticket.current_workers : [],
      execution_workers: Array.isArray(ticket.execution_workers) ? ticket.execution_workers : [],
      result_summary: ticket.result_summary || null,
      error: ticket.error || null,
    };

    if (Number.isFinite(normalized.id)) byId.set(normalized.id, normalized);
    const agentId = normalized.assigned_agent;
    if (!agentId) continue;
    if (!byAgent.has(agentId)) byAgent.set(agentId, []);
    byAgent.get(agentId).push(normalized);
  }

  return { byId, byAgent };
}

function buildSessionShape(session = {}, ticketById = new Map()) {
  const key = String(session.key || '');
  const updatedAtMs = toMs(session.updatedAt);
  const sessionType = getSessionType(key);
  const ticketId = getTicketIdFromSessionKey(key);
  const relatedTicket = ticketId != null ? ticketById.get(ticketId) || null : null;
  const latestActiveAtMs = Math.max(updatedAtMs, toMs(relatedTicket?.last_update));
  const latestActiveAt = latestActiveAtMs > 0 ? new Date(latestActiveAtMs).toISOString() : null;
  const isRecent = latestActiveAtMs > 0 && (Date.now() - latestActiveAtMs) < RECENT_ACTIVITY_MS;

  return {
    key,
    sessionKey: key,
    sessionType,
    ticketId,
    updatedAt: toIsoOrNull(session.updatedAt),
    latestActiveAt,
    totalTokens: Number(session.totalTokens) || 0,
    contextTokens: Number(session.contextTokens) || 0,
    isRecent,
    isTicketSession: sessionType === 'ticket',
    ticketStatus: relatedTicket?.status || null,
    ticketTitle: relatedTicket?.title || null,
    label: relatedTicket?.title || key,
  };
}

function chooseCurrentContext(sessions = []) {
  const ranked = [...sessions].sort((a, b) => {
    const aPriority = [
      a.isRecent && a.isTicketSession && ACTIVE_TICKET_STATUSES.has(a.ticketStatus) ? 1 : 0,
      a.isTicketSession && ACTIVE_TICKET_STATUSES.has(a.ticketStatus) ? 1 : 0,
      a.isRecent ? 1 : 0,
      a.isTicketSession ? 1 : 0,
      toMs(a.latestActiveAt),
      toMs(a.updatedAt),
    ];
    const bPriority = [
      b.isRecent && b.isTicketSession && ACTIVE_TICKET_STATUSES.has(b.ticketStatus) ? 1 : 0,
      b.isTicketSession && ACTIVE_TICKET_STATUSES.has(b.ticketStatus) ? 1 : 0,
      b.isRecent ? 1 : 0,
      b.isTicketSession ? 1 : 0,
      toMs(b.latestActiveAt),
      toMs(b.updatedAt),
    ];

    for (let i = 0; i < aPriority.length; i += 1) {
      if (bPriority[i] !== aPriority[i]) return bPriority[i] - aPriority[i];
    }
    return String(a.key).localeCompare(String(b.key));
  });

  const selected = ranked[0] || null;
  if (!selected) return null;

  return {
    sessionKey: selected.sessionKey,
    sessionType: selected.sessionType,
    ticketId: selected.ticketId,
    title: selected.ticketTitle || selected.label,
    ticketStatus: selected.ticketStatus || null,
    latestActiveAt: selected.latestActiveAt,
    updatedAt: selected.updatedAt,
  };
}

function deriveCurrentTask(tickets = [], currentContext = null) {
  const running = tickets
    .filter((ticket) => ticket.status === 'running')
    .sort((a, b) => toMs(b.last_update) - toMs(a.last_update));

  const contextMatch = currentContext?.ticketId != null
    ? running.find((ticket) => ticket.id === currentContext.ticketId)
    : null;

  const selected = contextMatch || running[0] || null;
  if (!selected) return null;

  return {
    id: selected.id,
    title: selected.title,
    status: selected.status,
    lastUpdate: selected.last_update,
    latestActiveAt: toIsoOrNull(selected.last_update),
    sessionKey: selected.session_key || currentContext?.sessionKey || null,
  };
}

function deriveQueue(tickets = []) {
  return tickets
    .filter((ticket) => ticket.status === 'queued')
    .sort((a, b) => toMs(b.last_update) - toMs(a.last_update))
    .map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      lastUpdate: ticket.last_update,
      latestActiveAt: toIsoOrNull(ticket.last_update),
      sessionKey: ticket.session_key || null,
    }));
}

function deriveRecentTasks(tickets = []) {
  return tickets
    .filter((ticket) => TERMINAL_TICKET_STATUSES.has(ticket.status))
    .sort((a, b) => toMs(b.last_update) - toMs(a.last_update))
    .slice(0, 5)
    .map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      time: ticket.last_update,
      latestActiveAt: toIsoOrNull(ticket.last_update),
    }));
}

function deriveStats(tickets = [], sessions = []) {
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();

  const completedToday = tickets.filter((ticket) => ticket.status === 'complete' && toMs(ticket.last_update) >= todayStartMs).length;
  const completedOrFailedToday = tickets.filter((ticket) => ['complete', 'failed', 'deprecated'].includes(ticket.status) && toMs(ticket.last_update) >= todayStartMs);
  const successfulToday = completedOrFailedToday.filter((ticket) => ticket.status === 'complete').length;
  const successRate = completedOrFailedToday.length > 0
    ? Math.round((successfulToday / completedOrFailedToday.length) * 100)
    : 100;

  const lastActiveMs = sessions.reduce((max, session) => Math.max(max, toMs(session.latestActiveAt)), 0);
  const uptimeMinutes = lastActiveMs > 0 ? Math.max(0, Math.round((now - lastActiveMs) / 60000)) : null;

  return {
    todayCompleted: completedToday,
    avgResponseTime: '—',
    successRate,
    uptime: uptimeMinutes == null ? '—' : `${uptimeMinutes}m since last context activity`,
  };
}

/**
 * 从 OpenClaw 获取所有 agent 的会话状态
 */
async function fetchAgentSessions() {
  return new Promise((resolve, reject) => {
    const args = ['sessions', '--all-agents', '--json'];
    const proc = spawn(OPENCLAW_CLI, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });

    proc.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    proc.on('error', (err) => {
      reject(new Error(`OpenClaw CLI 不可达: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `OpenClaw 退出码 ${code}`));
        return;
      }

      try {
        const data = JSON.parse(stdout.trim());
        resolve(data.sessions || []);
      } catch (e) {
        reject(new Error(`解析 sessions 失败: ${e.message}`));
      }
    });
  });
}

/**
 * 获取所有 Bot 的状态
 */
export async function getBots() {
  try {
    const [sessions, tickets] = await Promise.all([
      fetchAgentSessions(),
      Promise.resolve(store.getAllTickets()),
    ]);
    const { byId: ticketById, byAgent: ticketsByAgent } = buildTicketMaps(Array.isArray(tickets) ? tickets : []);

    const agentStats = Object.fromEntries(
      Object.entries(BOT_CONFIG).map(([agentId, config]) => [agentId, {
        agentId,
        name: agentId,
        displayName: config.displayName,
        emoji: config.emoji,
        sessions: [],
        totalTokens: 0,
        contextTokens: 200000,
      }])
    );

    for (const session of sessions) {
      const agentId = session.key?.split(':')[1]; // agent:beavy:main -> beavy
      if (!agentId || !BOT_CONFIG[agentId]) continue;

      const normalizedSession = buildSessionShape(session, ticketById);
      agentStats[agentId].sessions.push(normalizedSession);
      agentStats[agentId].totalTokens += normalizedSession.totalTokens || 0;
      agentStats[agentId].contextTokens = Math.max(agentStats[agentId].contextTokens, normalizedSession.contextTokens || 0, 200000);
    }

    const bots = Object.values(agentStats).map((agent) => {
      const currentContext = chooseCurrentContext(agent.sessions);
      const agentTickets = ticketsByAgent.get(agent.agentId) || [];
      const currentTask = deriveCurrentTask(agentTickets, currentContext);
      const queue = deriveQueue(agentTickets);
      const recentTasks = deriveRecentTasks(agentTickets);
      const latestContextActiveMs = Math.max(
        0,
        ...agent.sessions.map((session) => toMs(session.latestActiveAt)),
      );
      const hasRecentActivity = latestContextActiveMs > 0 && (Date.now() - latestContextActiveMs) < RECENT_ACTIVITY_MS;
      const usage = agent.contextTokens > 0
        ? Math.round((agent.totalTokens / agent.contextTokens) * 100)
        : 0;

      return {
        name: BOT_CONFIG[agent.name]?.nickname || agent.name,
        agentId: agent.agentId,
        displayName: agent.displayName,
        status: hasRecentActivity ? 'active' : 'idle',
        tokens: formatTokens(agent.totalTokens, agent.contextTokens),
        usage: Math.min(usage, 100),
        emoji: agent.emoji,
        currentTask,
        currentContext,
        contextLatestActiveTime: currentContext?.latestActiveAt || null,
        queue,
        sessions: agent.sessions,
        stats: deriveStats(agentTickets, agent.sessions),
        recentTasks,
      };
    });

    return bots;
  } catch (err) {
    console.error('[Bots] 获取状态失败:', err.message);
    // 返回默认的 bot 列表（降级方案）
    return Object.entries(BOT_CONFIG).map(([name, config]) => ({
      name: config.nickname || name,
      agentId: name,
      displayName: config.displayName,
      status: 'idle',
      tokens: '0k/200k',
      usage: 0,
      emoji: config.emoji,
      currentTask: null,
      currentContext: null,
      contextLatestActiveTime: null,
      queue: [],
      sessions: [],
      stats: { todayCompleted: 0, avgResponseTime: '—', successRate: 0, uptime: '—' },
      recentTasks: [],
    }));
  }
}
