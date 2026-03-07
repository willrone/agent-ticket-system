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
export function createTicket({ title, description, agent }) {
  return apiRequest('/api/tickets', {
    method: 'POST',
    body: { title, description, agent },
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
