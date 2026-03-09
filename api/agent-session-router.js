/**
 * Agent -> OpenClaw sessionKey 路由
 * 平台直驱：
 * - dispatch: 每张工单进入独立 ticket session，避免堆爆 agent 主会话
 * - notify: 固定发往 agent:main:main
 */

const AGENT_SESSION_BASES = {
  beavy: 'agent:beavy',
  donky: 'agent:donky',
  cowder: 'agent:cowder',
  doggy: 'agent:doggy',
  marely: 'agent:marely',
  leoss: 'agent:main',
};

/** 通知目标：老大/主会话（固定） */
export const NOTIFY_MAIN_SESSION = 'agent:main:main';

function getSessionBaseForAgent(agent) {
  if (!agent || typeof agent !== 'string') return 'agent:main';
  const normalized = String(agent).trim().toLowerCase();
  return AGENT_SESSION_BASES[normalized] || 'agent:main';
}

/**
 * 解析 agent 名得到其主会话 sessionKey（主要用于 notify / fallback）
 * @param {string} agent
 * @returns {string}
 */
export function getSessionKeyForAgent(agent) {
  return `${getSessionBaseForAgent(agent)}:main`;
}

/**
 * 为某张工单生成独立 ticket sessionKey。
 * 例如：
 * - beavy + 26 -> agent:beavy:ticket:26
 * - leoss + 26 -> agent:main:ticket:26
 * - 荣晖 + 26 -> agent:main:ticket:26
 */
export function getDispatchSessionKeyForTicket(agent, ticketId) {
  const base = getSessionBaseForAgent(agent);
  const normalizedTicketId = Number.parseInt(String(ticketId ?? ''), 10);
  if (!Number.isFinite(normalizedTicketId) || normalizedTicketId <= 0) {
    return `${base}:main`;
  }
  return `${base}:ticket:${normalizedTicketId}`;
}

/** Sheeply 审计会话：agent:auditor:audit:<ticket_id> */
export const AUDIT_SESSION_BASE = 'agent:auditor';

export function getAuditSessionKeyForTicket(ticketId) {
  const normalizedTicketId = Number.parseInt(String(ticketId ?? ''), 10);
  if (!Number.isFinite(normalizedTicketId) || normalizedTicketId <= 0) {
    return `${AUDIT_SESSION_BASE}:main`;
  }
  return `${AUDIT_SESSION_BASE}:audit:${normalizedTicketId}`;
}
