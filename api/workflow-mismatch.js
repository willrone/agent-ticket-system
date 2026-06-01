/**
 * workflow_mismatch 检测模块
 * 识别 running 状态 + 等待型评论 的不一致（软告警，不改 ticket status）
 * 优先看评论语义而非仅 type
 */
import { DEFAULT_DECISION_OWNER } from './ticket-routing.js';

// 语义关键词（按检测优先级）
const DECISION_REQUIRED_KEYWORDS = /拍板|决策|授权|确认方向|老大确认|是否继续/i;
const DECISION_RESOLVED_KEYWORDS = /已拍板|已确认|已明确|已同意|已批准|不代表工单仍处于待决策|现阶段应保持 running/i;
const CONTEXT_GAP_KEYWORDS = /token 不足|上下文不足|缺少上下文|信息不足|缺少日志|缺少资料|看不到文件|需要更多信息/i;
const CONTEXT_IMPLEMENTATION_PHRASES = /current context|context latest active time|上下文选择逻辑|展示 context/i;
const EXTERNAL_BLOCKED_KEYWORDS = /依赖|权限|审批|环境|上游|外部接口|资源未到位/i;

const REASON_MAP = {
  decision_required: '评论含决策/授权类表述，与 running 状态不一致',
  context_gap: '评论含 token/上下文/信息不足类表述，与 running 状态不一致',
  external_blocked: '评论含依赖/权限/审批等外部阻塞表述，与 running 状态不一致',
};

/**
 * @param {object} ticket - 工单对象，需含 status、comments、triage_owner、review_owner、decision_owner
 * @returns {object|null} - 有 mismatch 时返回 { category, recommended_status, alert_target, latest_comment, reason }，否则 null
 */
export function detectWorkflowMismatch(ticket = {}) {
  const status = ticket.status || 'queued';
  if (status !== 'running') return null;

  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  const waitingTypes = ['progress', 'blocker', 'decision'];

  // 取最新相关评论（按 timestamp 倒序），仅识别 agent/human 的等待语义，忽略 system/audit 回写噪音
  const relevant = comments
    .filter((c) => waitingTypes.includes(c.type || 'progress'))
    .sort((a, b) => {
      const ta = Date.parse(a.timestamp || 0) || 0;
      const tb = Date.parse(b.timestamp || 0) || 0;
      if (tb !== ta) return tb - ta;
      return Number(b.id || 0) - Number(a.id || 0);
    });

  const latest = relevant[0];
  if (!latest) return null;

  const content = String(latest.content || '');
  let category = null;
  let recommended_status = null;
  let alert_target = null;

  if (DECISION_RESOLVED_KEYWORDS.test(content)) {
    return null;
  }

  if (DECISION_REQUIRED_KEYWORDS.test(content) && !DECISION_RESOLVED_KEYWORDS.test(content)) {
    category = 'decision_required';
    recommended_status = 'pending_decision';
    alert_target = (ticket.decision_owner || '').trim() || DEFAULT_DECISION_OWNER;
  } else if (EXTERNAL_BLOCKED_KEYWORDS.test(content)) {
    category = 'external_blocked';
    recommended_status = 'blocked';
    alert_target = (ticket.review_owner || ticket.triage_owner || '').trim() || null;
  } else if (CONTEXT_GAP_KEYWORDS.test(content) && !CONTEXT_IMPLEMENTATION_PHRASES.test(content)) {
    category = 'context_gap';
    recommended_status = 'review';
    alert_target = (ticket.review_owner || ticket.triage_owner || '').trim() || null;
  }

  if (!category) return null;

  return {
    category,
    recommended_status,
    alert_target,
    latest_comment: { id: latest.id, type: latest.type, content: content.slice(0, 200) },
    reason: REASON_MAP[category],
  };
}
