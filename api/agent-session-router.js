/**
 * participant -> OpenClaw sessionKey 路由
 * 平台直驱：
 * - dispatch: 每张工单进入独立 ticket session，避免堆爆 agent 主会话
 * - notify: pending_decision/blocked/complete/failed 发主会话；done/review 回 reviewer ticket session
 */

import { getParticipantById } from './participant-registry.js';

const HUMAN_PRINCIPAL_ALIASES = new Set(['ronghui', '荣晖', 'example-human-operator']);
const NOTIFY_MAIN_HUMAN_ALIASES = new Set(['ronghui', '荣晖']);

const NOTIFICATION_SESSION_POLICY = {
  done: 'reviewer_ticket',
  review: 'reviewer_ticket',
  complete: 'main',
  failed: 'main',
  pending_decision: 'main',
  blocked: 'main',
};

/** 通知目标：老大/主会话（固定） - 直发 Telegram */
export const NOTIFY_MAIN_SESSION = 'agent:main:telegram:direct:8290057699';

export function getNotifyMainSessionKey() {
  return NOTIFY_MAIN_SESSION;
}

export function isHumanPrincipal(agent) {
  if (!agent || typeof agent !== 'string') return false;
  const normalized = String(agent).trim().toLowerCase();
  return HUMAN_PRINCIPAL_ALIASES.has(normalized) || HUMAN_PRINCIPAL_ALIASES.has(String(agent).trim());
}

function shouldRouteHumanPrincipalToNotifyMain(agent) {
  if (!agent || typeof agent !== 'string') return false;
  const raw = String(agent).trim();
  const normalized = raw.toLowerCase();
  return NOTIFY_MAIN_HUMAN_ALIASES.has(normalized) || NOTIFY_MAIN_HUMAN_ALIASES.has(raw);
}

function getSessionBaseForParticipant(agent) {
  if (!agent || typeof agent !== 'string') return 'agent:main';
  if (isHumanPrincipal(agent)) return 'agent:main';
  const participant = getParticipantById(agent);
  return participant?.binding?.session_base || participant?.session_base || 'agent:main';
}

/**
 * 解析 participant 得到其主会话 sessionKey（主要用于 notify / fallback）
 * @param {string} agent
 * @returns {string}
 */
export function getSessionKeyForAgent(agent) {
  if (isHumanPrincipal(agent)) {
    return shouldRouteHumanPrincipalToNotifyMain(agent)
      ? NOTIFY_MAIN_SESSION
      : `${getSessionBaseForParticipant(agent)}:main`;
  }
  return `${getSessionBaseForParticipant(agent)}:main`;
}

/**
 * 为某张工单生成独立 ticket sessionKey。
 */
export function getDispatchSessionKeyForTicket(agent, ticketId) {
  if (isHumanPrincipal(agent) && shouldRouteHumanPrincipalToNotifyMain(agent)) return NOTIFY_MAIN_SESSION;
  const base = getSessionBaseForParticipant(agent);
  const normalizedTicketId = Number.parseInt(String(ticketId ?? ''), 10);
  if (!Number.isFinite(normalizedTicketId) || normalizedTicketId <= 0) {
    return `${base}:main`;
  }
  return `${base}:ticket:${normalizedTicketId}`;
}

/**
 * 通知 sessionKey 路由：
 * - pending_decision/blocked/complete/failed：发给主会话（老大）
 * - done/review：回 reviewer ticket session
 */
export function getNotificationSessionKey({ status, reviewOwner, ticketId }) {
  const normalizedStatus = String(status ?? '').trim().toLowerCase();
  const policy = NOTIFICATION_SESSION_POLICY[normalizedStatus] || 'main';
  if (policy === 'reviewer_ticket') {
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
