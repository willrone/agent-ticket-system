import { apiRequest } from './client';

export function fetchTickets() {
  return apiRequest('/api/tickets');
}

export function fetchBots() {
  return apiRequest('/api/bots');
}

export function fetchTicketDetail(ticketId) {
  return apiRequest(`/api/tickets/${ticketId}`);
}

export function updateTicket(ticketId, updates) {
  return apiRequest(`/api/tickets/${ticketId}`, {
    method: 'PATCH',
    body: updates,
  });
}

/**
 * 获取工单状态：status/session_key/result_summary/last_update/run_id/assigned_agent/error
 */
export function fetchTicketStatus(ticketId) {
  return apiRequest(`/api/tickets/${ticketId}/status`);
}

/**
 * 获取评论列表（支持 type/visibility/thread_id 过滤）
 */
export function fetchTicketComments(ticketId, filters = {}) {
  const params = new URLSearchParams();
  if (filters.type) params.set('type', filters.type);
  if (filters.visibility) params.set('visibility', filters.visibility);
  if (filters.thread_id) params.set('thread_id', filters.thread_id);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return apiRequest(`/api/tickets/${ticketId}/comments${suffix}`);
}

/**
 * 创建工单（Pull 模式：立即返回，status 为 queued）
 * @param {Object} params
 * @param {string} params.title - 工单标题
 * @param {string} [params.description] - 工单描述
 * @param {string} [params.agent='donky'] - 派发给的 agent
 */
export function createTicket({ title, description, agent, status, triage_owner, next_actor }) {
  return apiRequest('/api/tickets', {
    method: 'POST',
    body: { title, description, agent, status, triage_owner, next_actor },
  });
}

/**
 * 手动重派工单，可传 agent（默认 donky）
 */
export function dispatchTicket(ticketId, agent = 'donky') {
  return apiRequest(`/api/tickets/${ticketId}/dispatch`, {
    method: 'POST',
    body: { agent },
  });
}

/**
 * 删除工单
 */
export function deleteTicket(ticketId) {
  return apiRequest(`/api/tickets/${ticketId}`, {
    method: 'DELETE',
  });
}

/**
 * 批量删除工单
 */
export function deleteTickets(ticketIds) {
  return apiRequest('/api/tickets/batch-delete', {
    method: 'POST',
    body: { ids: ticketIds },
  });
}

/**
 * 提交评论（支持 v2 字段）
 * @param {string} ticketId - 工单 ID
 * @param {string} content - 评论内容
 * @param {string} [author='Current User'] - 评论作者
 * @param {Object} [options]
 * @param {'progress'|'blocker'|'decision'|'result'|'system'} [options.type='progress']
 * @param {'internal'|'public'} [options.visibility='internal']
 * @param {string|null} [options.thread_id=null]
 * @param {string[]} [options.mentions=[]]
 */
export async function submitComment(ticketId, content, author = 'Current User', options = {}) {
  const body = await apiRequest(`/api/tickets/${ticketId}/comments`, {
    method: 'POST',
    body: {
      content: content.trim(),
      author,
      type: options.type || 'progress',
      visibility: options.visibility || 'internal',
      thread_id: options.thread_id || null,
      mentions: Array.isArray(options.mentions) ? options.mentions : [],
    },
  });
  return body;
}

/**
 * 获取工单的依赖关系
 * @param {string|number} ticketId - 工单 ID
 * @returns {Promise<{dependencies: Array, dependents: Array}>}
 */
export function fetchTicketDependencies(ticketId) {
  return apiRequest(`/api/tickets/${ticketId}/dependencies`);
}

/**
 * 添加依赖关系
 * @param {string|number} ticketId - 工单 ID
 * @param {string|number} dependsOnTicketId - 依赖的工单 ID
 * @param {string} [dependencyType='blocks'] - 依赖类型
 */
export function addTicketDependency(ticketId, dependsOnTicketId, dependencyType = 'blocks') {
  return apiRequest(`/api/tickets/${ticketId}/dependencies`, {
    method: 'POST',
    body: { depends_on_ticket_id: dependsOnTicketId, dependency_type: dependencyType },
  });
}

/**
 * 删除依赖关系
 * @param {string|number} ticketId - 工单 ID
 * @param {string|number} dependsOnTicketId - 依赖的工单 ID
 */
export function removeTicketDependency(ticketId, dependsOnTicketId) {
  return apiRequest(`/api/tickets/${ticketId}/dependencies/${dependsOnTicketId}`, {
    method: 'DELETE',
  });
}

