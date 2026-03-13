/**
 * Agent -> OpenClaw sessionKey 路由
 * 平台直驱：
 * - dispatch: 每张工单进入独立 ticket session，避免堆爆 agent 主会话
 * - notify: 仅 pending_decision/complete/failed 发主会话；reviewer 主交接统一走 dispatch
 */

const AGENT_SESSION_BASES = {
  beavy: 'agent:beavy',
  donky: 'agent:donky',
  cowder: 'agent:cowder',
  doggy: 'agent:doggy',
  marely: 'agent:marely',
  leoss: 'agent:main',
};

const HUMAN_PRINCIPAL_ALIASES = new Set(['ronghui', '荣晖']);

/** 通知目标：老大/主会话（固定） - 直发 Telegram */
export const NOTIFY_MAIN_SESSION = 'agent:main:telegram:direct:8290057699';

export function isHumanPrincipal(agent) {
  if (!agent || typeof agent !== 'string') return false;
  const normalized = String(agent).trim().toLowerCase();
  return HUMAN_PRINCIPAL_ALIASES.has(normalized) || HUMAN_PRINCIPAL_ALIASES.has(String(agent).trim());
}

function getSessionBaseForAgent(agent) {
  if (!agent || typeof agent !== 'string') return 'agent:main';
  if (isHumanPrincipal(agent)) return 'agent:main';
  const normalized = String(agent).trim().toLowerCase();
  return AGENT_SESSION_BASES[normalized] || 'agent:main';
}

/**
 * 解析 agent 名得到其主会话 sessionKey（主要用于 notify / fallback）
 * @param {string} agent
 * @returns {string}
 */
export function getSessionKeyForAgent(agent) {
  if (isHumanPrincipal(agent)) return NOTIFY_MAIN_SESSION;
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
  if (isHumanPrincipal(agent)) return NOTIFY_MAIN_SESSION;
  const base = getSessionBaseForAgent(agent);
  const normalizedTicketId = Number.parseInt(String(ticketId ?? ''), 10);
  if (!Number.isFinite(normalizedTicketId) || normalizedTicketId <= 0) {
    return `${base}:main`;
  }
  return `${base}:ticket:${normalizedTicketId}`;
}


/**
 * 通知 sessionKey 路由：
 * - pending_decision/complete/failed：发给主会话（老大）
 * - done/review 若被调用，仍回落到 review_owner ticket session（仅兼容遗留调用；主交接不应再走 notify）
 */
export function getNotificationSessionKey({ status, reviewOwner, ticketId }) {
  const normalizedStatus = String(status ?? '').trim().toLowerCase();
  if (normalizedStatus === 'done' || normalizedStatus === 'review') {
    return getDispatchSessionKeyForTicket(reviewOwner, ticketId);
  }
  return NOTIFY_MAIN_SESSION;
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
