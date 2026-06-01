import { AGENT_API_LEGACY_PREFIX, AGENT_API_PREFIX, AGENT_PLAYBOOK_KEY, getAgentApiBaseUrl } from './agent-facing.js';

export function buildStageAdvanceGuidance(ticket = {}) {
  const stage = String(ticket?.status || '').trim();
  const sharedPrefix = '重要：先按 hosted contract 回一条 dispatch_receipt（通过 report API，不要直接写 comment/transition）；receipt 不是终点，你的目标是把【当前阶段】推进到【下一阶段】。';
  const sharedMemory = '完成当前阶段前，请先把关键进展/决策/结论写入你自己工作区的 memory/YYYY-MM-DD.md（必要时更新相关长期记忆），后续继续用 heartbeat / reports 让平台代写状态推进。';
  const stageMap = {
    triage: '当前阶段=triage：请补齐结构化分诊结论与责任链，优先推进到 queued；若责任链仍不完整或范围未定，可继续停在 triage 并用 triage_structured_report 明确缺口，必要时用 decision_request 请求拍板。',
    queued: '当前阶段=queued：receipt 后要尽快进入实际执行；direct 模式就继续实现并用 execution_completed / blocked_report / decision_request 等把 queued 推进到 done / blocked / pending_decision。subagent/acp 模式先登记真实 worker，再继续推进。',
    running: '当前阶段=running：继续实现、验证并收口；优先推进到 done（execution_completed / review_submission），若受阻则推进到 blocked / pending_decision / failed，必要时也可 pause，但不能只停在 running。',
    done: '当前阶段=done：这是 reviewer 接单前态；reviewer receipt 后应推进到 review，并在完成验收后先提交 review_submission，再决定 approve（推进到 complete）或 reject（打回 queued）。',
    review: '当前阶段=review：reviewer 已正式接单；下一步必须给出验收结论。先提交 review_submission 写清依据，再 approve（complete）或 reject（queued）；若缺上下文可 pause / decision_request，但不能只停在 receipt。',
    blocked: '当前阶段=blocked：目标是解除阻塞并恢复推进；若阻塞已解除，推动回 queued/继续执行；若仍无法继续，至少用 heartbeat / decision_request 明确阻塞来源、所需外部动作与下一步。',
    paused: '当前阶段=paused：目标是恢复到挂起前状态并继续推进；若恢复条件已满足就 resume，若仍不满足则通过 heartbeat / decision_request 说明为什么继续保持 paused。',
    pending_decision: '当前阶段=pending_decision：目标是把待拍板问题讲清楚并等决策收口；请用 decision_request 明确可选方案、风险和建议，决策落定后再恢复推进，不要让 ticket 长期停在无结论状态。',
  };
  const fallback = '请先确认当前 stage 的 allowed actions / report contract，并选择一个明确的下一阶段或收口动作推进，不要只完成 receipt。';
  return [sharedPrefix, stageMap[stage] || fallback, sharedMemory].join(' ');
}

export function buildAgentDispatchMessage({ ticket, agent, assignment }) {
  const apiBaseUrl = assignment ? getAgentApiBaseUrl({ gatewayId: assignment.gateway_id }) : null;
  const stageGuidance = buildStageAdvanceGuidance(ticket);
  const base = [
    '🔔 你有 1 个当前阶段待处理工单',
    '',
    `#${ticket.id} ${ticket.title}`,
    `状态：${ticket.status}`,
    `当前责任人：${agent}`,
    '',
    '请立即使用 ticket-handler skill 处理，并把【当前阶段】自行闭环推进到【下一阶段】。',
    '',
    stageGuidance,
    ...(String(ticket.execution_mode || '').trim() && ['subagent', 'acp'].includes(String(ticket.execution_mode || '').trim()) ? ['', '重要：若本单目标是实现 / 修复 / 回归闭环，不允许只派一次性 analysis 子代理；必须用 Loop skill（或等价迭代控制）持续驱动子代理，多次尝试直到达到当前阶段走单标准、显式达到迭代上限，或确认需要人工决策。'] : []),
    '',
    '不要等老大再追问。若遇到需要老大决策的关键问题，先写工单评论，再主动通知老大。',
  ];

  if (!assignment) return base.join('\n');

  base.push(
    '',
    '【Agent-Facing Assignment Contract】',
    `assignment_id: ${assignment.assignment_id}`,
    `assignment_token: ${assignment.assignment_token}`,
    `api_base_url: ${apiBaseUrl || 'UNCONFIGURED_REMOTE_API_BASE_URL'}`,
    `read: GET ${AGENT_API_PREFIX}/assignments/${assignment.assignment_id}`,
    `skill fetch: GET ${AGENT_API_PREFIX}/skills/current`,
    `playbook: GET ${AGENT_API_PREFIX}/playbooks/${AGENT_PLAYBOOK_KEY}`,
    `heartbeat: POST ${AGENT_API_PREFIX}/assignments/${assignment.assignment_id}/heartbeat`,
    `report: POST ${AGENT_API_PREFIX}/assignments/${assignment.assignment_id}/reports`,
    `legacy aliases: ${AGENT_API_LEGACY_PREFIX}/...`,
    '说明：agent 优先走 runtime/assignment/skill fetch/report API；assignment_token 优先放 X-Assignment-Token，body/query 仅保留兼容。不要直接写 ticket comment/transition。',
    ...(apiBaseUrl ? [] : ['注意：当前远端 agent-facing HTTP 地址尚未配置，请在平台侧设置 TICKET_AGENT_API_BASE_URL 后再让远端 agent 直接调 API。']),
  );

  return base.join('\n');
}
