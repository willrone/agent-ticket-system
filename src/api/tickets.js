import { apiRequest } from './client';

export function fetchTickets() {
  return apiRequest('/api/tickets');
}

export function fetchInbox() {
  return apiRequest('/api/inbox');
}

export function fetchTriageInbox() {
  return apiRequest('/api/inbox/triage');
}

export function fetchExecutionInbox() {
  return apiRequest('/api/inbox/execution');
}

export function fetchReviewInbox() {
  return apiRequest('/api/inbox/review');
}

export function fetchDecisionInbox() {
  return apiRequest('/api/inbox/decisions');
}

export function fetchBots() {
  return apiRequest('/api/bots');
}

export function fetchAgentTopology() {
  return apiRequest('/api/agent-topology');
}

export function fetchPlaybookStage(stage, params = {}) {
  const search = new URLSearchParams();
  if (params.mode) search.set('mode', params.mode);
  if (params.role) search.set('role', params.role);
  const suffix = search.toString() ? `?${search.toString()}` : '';
  return apiRequest(`/api/playbooks/${encodeURIComponent(stage)}${suffix}`);
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
 * 创建工单（立即返回新 ticket；create 路径默认进入 triage）
 * @param {Object} params
 * @param {string} params.title - 工单标题
 * @param {string} [params.description] - 工单描述
 * @param {string} [params.agent] - 兼容旧字段，预指派执行人
 * @param {string} [params.assigned_agent] - canonical 预指派执行人
 */
export function createTicket({ title, description, agent, assigned_agent, status, triage_owner, review_owner, next_actor, platform }) {
  return apiRequest('/api/tickets', {
    method: 'POST',
    body: {
      title,
      description,
      agent,
      assigned_agent,
      status,
      triage_owner,
      review_owner,
      next_actor,
      platform,
    },
  });
}

export function fetchStockAdminTickets(agentAdminToken) {
  return apiRequest('/api/v1/admin/stock-tickets', {
    headers: {
      Authorization: `Bearer ${agentAdminToken}`,
    },
  });
}

export function createStockAdminTicket(agentAdminToken, { title, description, assigned_agent, triage_owner, review_owner }) {
  return apiRequest('/api/v1/admin/stock-tickets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agentAdminToken}`,
    },
    body: {
      title,
      description,
      assigned_agent,
      triage_owner,
      review_owner,
      platform: 'stock-platform',
    },
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

export function nudgeTicket(ticketId) {
  return apiRequest(`/api/tickets/${ticketId}/nudge`, {
    method: 'POST',
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

// --- Compatibility helpers for newer pages ---
export function getTicket(ticketId) {
  return fetchTicketDetail(ticketId);
}

export function getTicketActions(ticketId) {
  return apiRequest(`/api/tickets/${ticketId}/actions`);
}

export function transitionTicket(ticketId, payload) {
  return apiRequest(`/api/tickets/${ticketId}/transition`, {
    method: 'POST',
    body: payload,
  });
}

export function addComment(ticketId, contentOrPayload, author = 'Current User', options = {}) {
  if (typeof contentOrPayload === 'object' && contentOrPayload !== null) {
    return apiRequest(`/api/tickets/${ticketId}/comments`, {
      method: 'POST',
      body: {
        content: String(contentOrPayload.content || '').trim(),
        author: contentOrPayload.author || author,
        type: contentOrPayload.type || options.type || 'progress',
        visibility: contentOrPayload.visibility || options.visibility || 'internal',
        thread_id: contentOrPayload.thread_id || options.thread_id || null,
        mentions: Array.isArray(contentOrPayload.mentions)
          ? contentOrPayload.mentions
          : Array.isArray(options.mentions)
            ? options.mentions
            : [],
      },
    });
  }

  return submitComment(ticketId, contentOrPayload, author, options);
}

