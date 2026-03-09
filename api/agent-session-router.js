/**
 * Agent -> OpenClaw 主会话 sessionKey 路由
 * 平台直驱：dispatch 按目标 agent 投递到对应主会话；notify 固定发往 agent:main:main
 */

const KNOWN_AGENTS = new Set(['beavy', 'donky', 'cowder', 'doggy', 'marely', 'leoss']);

/** 通知目标：老大/主会话（固定） */
export const NOTIFY_MAIN_SESSION = 'agent:main:main';

/**
 * 解析 agent 名得到其主会话 sessionKey
 * @param {string} agent - 例如 beavy, donky, leoss, 荣晖
 * @returns {string|null} - 如 agent:beavy:main；未知 agent 或非 dispatch 用 fallback 时返回 agent:main:main；若需严格仅已知 agent 可返回 null
 */
export function getSessionKeyForAgent(agent) {
  if (!agent || typeof agent !== 'string') return NOTIFY_MAIN_SESSION;
  const normalized = String(agent).trim().toLowerCase();
  if (KNOWN_AGENTS.has(normalized)) return `agent:${normalized}:main`;
  return NOTIFY_MAIN_SESSION;
}
