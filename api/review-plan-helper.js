/**
 * 多轮/多 reviewer 验收合约：解析 review_plan、review_state，计算 approve 后是否完成或进入下一轮。
 * 无 review_plan 时保持单 reviewer 语义（由调用方直接 complete）。
 */

function parseJson(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    const p = JSON.parse(value);
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} ticket - 工单，含 review_plan (object 或 JSON string)
 * @returns {{ rounds: Array<{ required_reviewers: string[] }>, valid: boolean }}
 */
export function parseReviewPlan(ticket) {
  const raw = parseJson(ticket.review_plan);
  if (!raw || !Array.isArray(raw.rounds)) return { rounds: [], valid: false };
  const rounds = raw.rounds.map((r, index) => ({
    round: Number(r.round ?? index + 1),
    required_reviewers: Array.isArray(r.required_reviewers)
      ? r.required_reviewers.map(String)
      : Array.isArray(r.reviewers)
        ? r.reviewers.map(String)
        : [],
  }));
  const valid = rounds.length > 0 && rounds.every((r) => r.required_reviewers.length > 0);
  return { rounds, valid };
}

/**
 * @param {object} ticket - 工单，含 review_state (object 或 JSON string)
 * @returns {{ current_round: number, approvals: Record<string, string[]> }}
 */
export function parseReviewState(ticket) {
  const raw = parseJson(ticket.review_state);
  if (!raw || typeof raw !== 'object') return { current_round: 0, approvals: {} };
  const current_round = Math.max(0, parseInt(raw.current_round, 10) || 0);
  const approvals = raw.approvals && typeof raw.approvals === 'object' ? raw.approvals : {};
  return { current_round, approvals };
}

/**
 * 初始 review_state（用于 reject 后重置）
 */
export function getInitialReviewState() {
  return { current_round: 0, approvals: {} };
}

/**
 * 当前轮是否已全部通过
 */
function isRoundComplete(round, approvalsForRound) {
  const required = new Set(round.required_reviewers);
  const approved = new Set(approvalsForRound || []);
  return required.size > 0 && [...required].every((r) => approved.has(r));
}

/**
 * 记录当前 reviewer 通过，并计算下一状态。
 * 仍由 review_owner 守门（调用方校验 actor）；此处只做状态推进。
 * @param {object} ticket - 当前工单
 * @param {string} reviewerId - 实际记录为通过者（approve_reviewer ?? actor）
 * @returns {{ done: boolean, review_state: object, status?: string }} done 为 true 表示全部轮次通过可 complete
 */
export function applyApproveToReviewState(ticket, reviewerId) {
  const plan = parseReviewPlan(ticket);
  if (!plan.valid) return { done: true, review_state: null };

  const state = parseReviewState(ticket);
  const roundIndex = state.current_round;
  const round = plan.rounds[roundIndex];
  if (!round) return { done: true, review_state: null };

  const key = String(roundIndex);
  const list = Array.isArray(state.approvals[key]) ? [...state.approvals[key]] : [];
  const id = String(reviewerId).trim();
  if (id && !list.includes(id)) list.push(id);
  const nextApprovals = { ...state.approvals, [key]: list };

  if (!isRoundComplete(round, nextApprovals[key])) {
    return {
      done: false,
      review_state: { current_round: roundIndex, approvals: nextApprovals },
    };
  }

  const nextRound = roundIndex + 1;
  if (nextRound >= plan.rounds.length) {
    return { done: true, review_state: { current_round: nextRound, approvals: nextApprovals } };
  }
  return {
    done: false,
    review_state: { current_round: nextRound, approvals: nextApprovals },
  };
}
