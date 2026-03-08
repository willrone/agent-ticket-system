/**
 * State Machine - 工单状态转换引擎
 * 
 * 核心职责：
 * 1. 定义合法的状态转换规则
 * 2. 自动路由 next_actor
 * 3. 执行副作用（锁定、解锁、清空通知）
 * 4. 拒绝非法转换
 */

import * as store from './store.js';
import * as dispatch from './dispatch.js';

/**
 * 状态转换定义
 * 
 * 每个 action 定义：
 * - from: 允许的起始状态列表
 * - to: 目标状态
 * - required_fields: 必填字段
 * - side_effects: 副作用函数（自动路由、锁定等）
 */
export const TRANSITIONS = {
  // 开工：queued → running
  start_work: {
    from: ['queued'],
    to: 'running',
    required_fields: ['actor'],
    side_effects: (ticket, context) => {
      return {
        locked_by: context.actor,
        locked_at: new Date().toISOString(),
        next_actor: context.actor,
      };
    },
  },

  // 提交 review：running → done
  submit_for_review: {
    from: ['running'],
    to: 'done',
    required_fields: ['actor', 'result_summary'],
    side_effects: (ticket, context) => {
      const reviewer = ticket.review_owner || ticket.triage_owner;
      return {
        result_summary: context.result_summary,
        next_actor: reviewer,
        locked_by: null,
        locked_at: null,
      };
    },
  },

  // 请求决策：running/review → pending_decision
  request_decision: {
    from: ['running', 'review'],
    to: 'pending_decision',
    required_fields: ['actor', 'decision_summary'],
    side_effects: (ticket, context) => {
      return {
        decision_summary: context.decision_summary,
        decision_context: context.decision_context || null,
        next_actor: ticket.decision_owner || '荣晖',
        locked_by: null,
        locked_at: null,
      };
    },
  },

  // Review 通过：done/review → complete
  approve: {
    from: ['done', 'review'],
    to: 'complete',
    required_fields: ['actor'],
    side_effects: (ticket, context) => {
      return {
        next_actor: null,
        locked_by: null,
        locked_at: null,
      };
    },
  },

  // Review 不通过：done/review → queued
  reject: {
    from: ['done', 'review'],
    to: 'queued',
    required_fields: ['actor', 'reject_reason'],
    side_effects: (ticket, context) => {
      return {
        next_actor: ticket.assigned_agent,
        result_summary: null, // 清空旧结果
        locked_by: null,
        locked_at: null,
      };
    },
  },

  // 标记阻塞：running → blocked
  block: {
    from: ['running'],
    to: 'blocked',
    required_fields: ['actor', 'blocker_summary'],
    side_effects: (ticket, context) => {
      return {
        next_actor: ticket.triage_owner,
        locked_by: null,
        locked_at: null,
      };
    },
  },

  // 解除阻塞：blocked → queued
  unblock: {
    from: ['blocked'],
    to: 'queued',
    required_fields: ['actor'],
    side_effects: (ticket, context) => {
      return {
        next_actor: ticket.assigned_agent,
        locked_by: null,
        locked_at: null,
      };
    },
  },

  // 标记失败：running → failed
  fail: {
    from: ['running'],
    to: 'failed',
    required_fields: ['actor', 'error'],
    side_effects: (ticket, context) => {
      return {
        error: context.error,
        next_actor: ticket.triage_owner,
        locked_by: null,
        locked_at: null,
      };
    },
  },

  // 从决策恢复：pending_decision → queued/running
  resume_from_decision: {
    from: ['pending_decision'],
    to: 'queued', // 或 'running'，由调用方指定
    required_fields: ['actor'],
    side_effects: (ticket, context) => {
      return {
        next_actor: ticket.assigned_agent,
        decision_summary: null,
        decision_context: null,
        locked_by: null,
        locked_at: null,
      };
    },
  },
};

/**
 * 执行状态转换
 * 
 * @param {number} ticketId - 工单 ID
 * @param {string} action - 转换动作（如 'start_work'）
 * @param {object} context - 上下文（actor, result_summary 等）
 * @returns {object} { success, ticket?, error? }
 */
export function transition(ticketId, action, context = {}) {
  const ticket = store.getTicketById(ticketId);
  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }

  const transitionDef = TRANSITIONS[action];
  if (!transitionDef) {
    return {
      success: false,
      error: `Invalid action: ${action}`,
      allowed_actions: Object.keys(TRANSITIONS),
    };
  }

  // 检查当前状态是否允许此转换
  if (!transitionDef.from.includes(ticket.status)) {
    return {
      success: false,
      error: `Cannot ${action} from status ${ticket.status}`,
      current_status: ticket.status,
      allowed_from: transitionDef.from,
    };
  }

  // 检查必填字段
  for (const field of transitionDef.required_fields) {
    if (!context[field]) {
      return {
        success: false,
        error: `Missing required field: ${field}`,
        required_fields: transitionDef.required_fields,
      };
    }
  }

  // 检查工单锁定
  if (ticket.locked_by && ticket.locked_by !== context.actor) {
    return {
      success: false,
      error: `Ticket locked by ${ticket.locked_by}`,
      locked_by: ticket.locked_by,
      locked_at: ticket.locked_at,
    };
  }

  // 执行状态转换
  const updates = {
    status: transitionDef.to,
    last_update: new Date().toISOString(),
  };

  // 执行副作用
  const sideEffects = transitionDef.side_effects(ticket, context);
  Object.assign(updates, sideEffects);

  // 写入数据库
  store.updateTicket(ticketId, updates);

  // 清空该工单的旧 notification events（状态变了，旧通知作废）
  dispatch.clearNotificationEvents(ticketId);

  // 如果有新的 next_actor，创建 dispatch event
  if (updates.next_actor) {
    dispatch.recordDispatchEvent(ticketId, updates.next_actor, updates.status);
  }

  const updatedTicket = store.getTicketById(ticketId);
  return { success: true, ticket: updatedTicket };
}

/**
 * 获取工单当前可执行的 actions
 * 
 * @param {number} ticketId - 工单 ID
 * @returns {string[]} 可执行的 action 列表
 */
export function getAvailableActions(ticketId) {
  const ticket = store.getTicketById(ticketId);
  if (!ticket) return [];

  return Object.entries(TRANSITIONS)
    .filter(([action, def]) => def.from.includes(ticket.status))
    .map(([action]) => action);
}
