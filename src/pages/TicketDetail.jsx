import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  addComment,
  addTicketDependency,
  fetchAgentTopology,
  fetchPlaybookStage,
  fetchTicketDependencies,
  getTicket,
  getTicketActions,
  nudgeTicket,
  removeTicketDependency,
  transitionTicket,
} from '../api/tickets';
import {
  STATUS_BADGE_CLASS,
  WORKFLOW_TRANSITION_META,
  getRequiredFieldsForAction,
  getStatusLabel,
  resolveActionActor,
  resolveCommentAuthor,
} from '../../workflow-schema.js';
import { buildTicketStageGateStatus, buildTicketStageOrchestration, buildTicketViewModel } from '../../ticket-selectors.js';

const ACTION_LABELS = Object.fromEntries(
  Object.entries(WORKFLOW_TRANSITION_META).map(([action, meta]) => [action, meta.label])
);

const ACTION_COLORS = {
  queue: 'bg-indigo-500 hover:bg-indigo-600',
  start_work: 'bg-blue-500 hover:bg-blue-600',
  submit_for_review: 'bg-green-500 hover:bg-green-600',
  start_review: 'bg-cyan-500 hover:bg-cyan-600',
  request_decision: 'bg-yellow-500 hover:bg-yellow-600',
  pause: 'bg-slate-500 hover:bg-slate-600',
  resume: 'bg-blue-500 hover:bg-blue-600',
  reset_to_queued: 'bg-amber-500 hover:bg-amber-600',
  approve: 'bg-green-600 hover:bg-green-700',
  reject: 'bg-red-500 hover:bg-red-600',
  block: 'bg-gray-500 hover:bg-gray-600',
  unblock: 'bg-blue-400 hover:bg-blue-500',
  fail: 'bg-red-600 hover:bg-red-700',
  resume_from_decision: 'bg-blue-500 hover:bg-blue-600',
};

const SURFACE_CLASS = 'rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.055),rgba(255,255,255,0.02))] shadow-[0_24px_80px_-44px_rgba(15,23,42,0.95)] backdrop-blur';
const PANEL_CLASS = 'rounded-2xl border border-white/8 bg-black/10';

function formatDateTime(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN');
}

function buildBulletItems(value, fallback) {
  if (!value) return [fallback];
  return String(value)
    .split(/[\n；;]+/)
    .map((item) => item.replace(/^[-•A-Za-z\d.、()（）\s]+/, '').trim())
    .filter(Boolean);
}

function joinSummaryParts(parts = []) {
  return parts.filter(Boolean).join(' · ');
}

function DetailPill({ children, tone = 'neutral' }) {
  const toneClass = {
    neutral: 'border-white/10 bg-white/5 text-[var(--text-secondary)]',
    accent: 'border-cyan-400/25 bg-cyan-400/10 text-cyan-200',
    success: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200',
    warning: 'border-amber-400/25 bg-amber-400/10 text-amber-200',
    danger: 'border-rose-400/25 bg-rose-400/10 text-rose-200',
  }[tone] || 'border-white/10 bg-white/5 text-[var(--text-secondary)]';

  return (
    <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${toneClass}`}>
      {children}
    </span>
  );
}

function SectionCard({ eyebrow, title, description, children, className = '' }) {
  return (
    <section className={`${SURFACE_CLASS} p-5 sm:p-6 ${className}`}>
      {(eyebrow || title || description) && (
        <div className="mb-5">
          {eyebrow ? (
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.24em] text-[var(--accent-primary)]/80">
              {eyebrow}
            </div>
          ) : null}
          {title ? <h2 className="text-xl font-semibold text-[var(--text-primary)] sm:text-[1.35rem]">{title}</h2> : null}
          {description ? <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{description}</p> : null}
        </div>
      )}
      {children}
    </section>
  );
}

function StatCard({ label, value, highlight = false }) {
  return (
    <div className={`rounded-2xl border px-4 py-4 ${highlight ? 'border-cyan-400/25 bg-cyan-400/10' : 'border-white/8 bg-black/10'}`}>
      <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-secondary)]">{label}</div>
      <div className="mt-3 text-sm font-medium leading-6 text-[var(--text-primary)] break-words">{value || '无'}</div>
    </div>
  );
}

function TextPanel({ title, body, children }) {
  return (
    <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
      <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)]">{title}</div>
      {body ? <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-[var(--text-secondary)]">{body}</p> : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}

function BulletPanel({ title, items, tone = 'cyan' }) {
  const dotClass = {
    cyan: 'bg-cyan-300',
    amber: 'bg-amber-300',
    emerald: 'bg-emerald-300',
    rose: 'bg-rose-300',
  }[tone] || 'bg-cyan-300';

  return (
    <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
      <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)]">{title}</div>
      <ul className="mt-4 space-y-3 text-sm leading-6 text-[var(--text-primary)]">
        {items.map((item) => (
          <li key={item} className="flex gap-3">
            <span className={`mt-2 h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyTimeline({ text }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 bg-black/10 px-4 py-6 text-sm text-[var(--text-secondary)]">
      {text}
    </div>
  );
}

function SummaryList({ items }) {
  return (
    <ul className="space-y-3 text-sm leading-6 text-[var(--text-primary)]">
      {items.map((item) => (
        <li key={item} className="flex gap-3">
          <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-cyan-300" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function getLatestWorkerHeartbeat(workers = []) {
  const withHeartbeat = workers.filter((worker) => worker?.last_heartbeat_at);
  if (withHeartbeat.length === 0) return null;

  return [...withHeartbeat].sort((a, b) => {
    const left = new Date(a.last_heartbeat_at).getTime() || 0;
    const right = new Date(b.last_heartbeat_at).getTime() || 0;
    return right - left;
  })[0];
}

function normalizeTopology(payload) {
  const data = payload?.data ?? payload ?? {};
  return {
    mainGatewayId: data.main_gateway_id ?? null,
    gateways: data.gateways ?? {},
    agentGatewayMap: data.agent_gateway_map ?? {},
    agentDirectory: data.agent_directory ?? {},
    platforms: data.platforms ?? {},
    responsibilityLayers: Array.isArray(data.responsibility_layers) ? data.responsibility_layers : [],
    topologyEdges: Array.isArray(data.topology_edges) ? data.topology_edges : [],
    summary: data.summary ?? {},
  };
}

function buildEvidenceTimeline({
  comments = [],
  executionWorkers = [],
  runtimeDigestView = {},
  operationalView = {},
  executionGuardView = {},
  lastActionError = null,
}) {
  const items = [];

  if (runtimeDigestView.state || runtimeDigestView.summary) {
    items.push({
      key: `runtime-${runtimeDigestView.state || 'unknown'}`,
      kind: 'runtime',
      title: `Runtime Digest · ${runtimeDigestView.state || 'unknown'}`,
      timestamp: null,
      summary: runtimeDigestView.summary || '当前未生成 runtime digest。',
      meta: [
        runtimeDigestView.dispatch_state ? `dispatch=${runtimeDigestView.dispatch_state}` : null,
        runtimeDigestView.awaiting_receipt_from ? `awaiting=${runtimeDigestView.awaiting_receipt_from}` : null,
        runtimeDigestView.current_actor ? `actor=${runtimeDigestView.current_actor}` : null,
      ].filter(Boolean),
    });
  }

  if (operationalView.latest_comment_summary) {
    const latest = operationalView.latest_comment_summary;
    items.push({
      key: `operational-comment-${latest.at || latest.by || 'latest'}`,
      kind: 'operational',
      title: '最新评论摘要',
      timestamp: latest.at || null,
      summary: '最新评论已同步到现场快照，详见上方摘要与下方评论区。',
      meta: [latest.by ? `by ${latest.by}` : null, operationalView.latest_report_type ? `report=${operationalView.latest_report_type}` : null].filter(Boolean),
    });
  }

  executionWorkers.forEach((worker) => {
    items.push({
      key: `worker-${worker.id || worker.worker_key}`,
      kind: 'worker',
      title: `Worker · ${worker.label || worker.worker_key || 'unknown worker'}`,
      timestamp: worker.last_heartbeat_at || worker.started_at || null,
      summary: worker.summary || '当前无额外 worker 摘要。',
      meta: [
        worker.worker_type || null,
        worker.status ? `status=${worker.status}` : null,
      ].filter(Boolean),
    });
  });

  if (lastActionError) {
    items.push({
      key: `error-${lastActionError.request_id || 'latest'}`,
      kind: 'error',
      title: '最近一次动作失败',
      timestamp: null,
      summary: lastActionError.detail || '未知错误',
      meta: [lastActionError.request_id ? `request_id=${lastActionError.request_id}` : null].filter(Boolean),
    });
  }

  if (executionGuardView.reason || executionGuardView.requires_worker) {
    items.push({
      key: `guard-${executionGuardView.reason || 'state'}`,
      kind: 'guard',
      title: 'Execution Guard',
      timestamp: null,
      summary: executionGuardView.reason || '当前 guard 未给出额外原因。',
      meta: [
        `requires_worker=${executionGuardView.requires_worker ? 'yes' : 'no'}`,
        `has_worker_evidence=${executionGuardView.has_worker_evidence ? 'yes' : 'no'}`,
      ],
    });
  }

  comments.forEach((comment) => {
    items.push({
      key: `comment-${comment.id}`,
      kind: 'comment',
      title: `评论 · ${comment.author || '未知作者'}`,
      timestamp: comment.timestamp || null,
      summary: comment.content ? '评论已记录，详见下方评论区。' : '评论已记录。',
      meta: [comment.type ? `type=${comment.type}` : null, comment.visibility ? `visibility=${comment.visibility}` : null].filter(Boolean),
    });
  });

  return items.sort((a, b) => {
    const left = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const right = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return right - left;
  });
}

function TicketDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [ticket, setTicket] = useState(null);
  const [availableActions, setAvailableActions] = useState([]);
  const [actionObjects, setActionObjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [nudging, setNudging] = useState(false);
  const [lastActionError, setLastActionError] = useState(null);

  const [showActionModal, setShowActionModal] = useState(false);
  const [selectedAction, setSelectedAction] = useState(null);
  const [actionFields, setActionFields] = useState({});

  const [dependencies, setDependencies] = useState([]);
  const [dependents, setDependents] = useState([]);
  const [showAddDependency, setShowAddDependency] = useState(false);
  const [newDependencyId, setNewDependencyId] = useState('');
  const [topology, setTopology] = useState(() => normalizeTopology({}));
  const [playbookSnapshot, setPlaybookSnapshot] = useState(null);

  function resolvePlaybookRole(ticketView) {
    if (!ticketView) return 'manager';
    if (ticketView.status === 'triage') return 'triage';
    if (['queued', 'running', 'blocked', 'paused'].includes(ticketView.status)) return 'executor';
    if (['done', 'review'].includes(ticketView.status)) return 'reviewer';
    if (ticketView.status === 'pending_decision') return 'manager';
    return 'auditor';
  }

  const loadPlaybook = useCallback(async function loadPlaybook(ticketView) {
    if (!ticketView?.status) {
      setPlaybookSnapshot(null);
      return;
    }

    try {
      const payload = await fetchPlaybookStage(ticketView.status, {
        mode: ticketView.execution_mode || 'direct',
        role: resolvePlaybookRole(ticketView),
      });
      setPlaybookSnapshot(payload?.data || null);
    } catch (err) {
      console.error('Failed to load playbook snapshot:', err);
      setPlaybookSnapshot(null);
    }
  }, []);

  const loadTicket = useCallback(async function loadTicket() {
    try {
      setLoading(true);
      const data = await getTicket(id);
      const viewModel = buildTicketViewModel(data);
      setTicket(viewModel);
      setError(null);
      await loadPlaybook(viewModel);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id, loadPlaybook]);

  const loadActions = useCallback(async function loadActions() {
    try {
      const data = await getTicketActions(id);
      setAvailableActions(data.available_actions || []);
      setActionObjects(data.action_objects || []);
    } catch (err) {
      console.error('Failed to load actions:', err);
    }
  }, [id]);

  const loadDependencies = useCallback(async function loadDependencies() {
    try {
      const data = await fetchTicketDependencies(id);
      setDependencies(data.dependencies || []);
      setDependents(data.dependents || []);
    } catch (err) {
      console.error('Failed to load dependencies:', err);
    }
  }, [id]);

  const loadTopology = useCallback(async function loadTopology() {
    try {
      const data = await fetchAgentTopology();
      setTopology(normalizeTopology(data));
    } catch (err) {
      console.error('Failed to load topology:', err);
    }
  }, []);

  useEffect(() => {
    loadTicket();
    loadActions();
    loadDependencies();
    loadTopology();
  }, [loadTicket, loadActions, loadDependencies, loadTopology]);

  async function handleAddDependency() {
    const dependsOnId = parseInt(newDependencyId, 10);
    if (!dependsOnId || dependsOnId <= 0) {
      alert('请输入有效的工单 ID');
      return;
    }

    try {
      setSubmitting(true);
      await addTicketDependency(id, dependsOnId);
      setNewDependencyId('');
      setShowAddDependency(false);
      await loadDependencies();
    } catch (err) {
      alert(`添加依赖失败: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemoveDependency(dependsOnId) {
    if (!confirm(`确认删除对工单 #${dependsOnId} 的依赖？`)) return;

    try {
      setSubmitting(true);
      await removeTicketDependency(id, dependsOnId);
      await loadDependencies();
    } catch (err) {
      alert(`删除依赖失败: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  }

  function handleActionClick(action) {
    setSelectedAction(action);
    setActionFields({});
    setLastActionError(null);
    setShowActionModal(true);
  }

  async function handleActionSubmit() {
    if (!selectedAction) return;

    try {
      setSubmitting(true);
      setLastActionError(null);
      const payload = {
        action: selectedAction,
        actor: resolveActionActor(ticket, selectedAction),
        ...actionFields,
      };

      const result = await transitionTicket(id, payload);

      if (result.success) {
        setShowActionModal(false);
        setSelectedAction(null);
        setActionFields({});
        setLastActionError(null);
        await loadTicket();
        await loadActions();
      } else {
        const fallbackError = {
          detail: result?.detail || result?.message || result?.error || '未知错误',
          request_id: result?.request_id || null,
          raw: result,
        };
        setLastActionError(fallbackError);
        alert(`操作失败: ${fallbackError.detail}`);
      }
    } catch (err) {
      const details = err?.details || {};
      const failure = {
        detail: details?.detail || err?.message || '未知错误',
        request_id: details?.request_id || null,
        raw: details && Object.keys(details).length > 0 ? details : { message: err?.message },
      };
      setLastActionError(failure);
      alert(`操作失败: ${failure.detail}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAddComment() {
    if (!commentText.trim()) return;

    try {
      setSubmitting(true);
      await addComment(id, {
        content: commentText,
        author: resolveCommentAuthor(ticket),
        type: 'progress',
      });
      setCommentText('');
      await loadTicket();
    } catch (err) {
      alert(`添加评论失败: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleManualNudge() {
    try {
      setNudging(true);
      const result = await nudgeTicket(id);
      const targetActor = result?.ready_item?.agent || ticket?.current_actor || ticket?.next_actor || ticket?.assigned_agent || '当前处理人';
      alert(`已向 ${targetActor} 发出催单消息`);
      await loadTicket();
    } catch (err) {
      alert(`发送催单失败: ${err.message}`);
    } finally {
      setNudging(false);
    }
  }

  function getRequiredFields(action) {
    return getRequiredFieldsForAction(action).filter((field) => field !== 'actor');
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="text-gray-600">加载中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="text-red-600">错误: {error}</div>
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="text-gray-600">工单不存在</div>
      </div>
    );
  }

  const requiredFields = getRequiredFields(selectedAction);
  const selectedActionObject = actionObjects.find((item) => item.key === selectedAction) || null;
  const executionWorkers = Array.isArray(ticket.execution_workers) ? ticket.execution_workers : [];
  const orchestrationView = buildTicketStageOrchestration(ticket, { availableActions });
  const stageGateStatus = buildTicketStageGateStatus(ticket, { orchestration: orchestrationView });
  const playbookChecklistItems = playbookSnapshot?.checklist?.length
    ? playbookSnapshot.checklist.map((item) => `${item.text}${item.owner ? `（责任：${item.owner}）` : ''}`)
    : ['当前暂无结构化检查项'];
  const playbookEvidenceItems = playbookSnapshot?.evidence_requirements?.length
    ? playbookSnapshot.evidence_requirements.map((item) => `${item.text}${item.owner ? `（责任：${item.owner}）` : ''}`)
    : ['当前暂无结构化证据要求'];
  const stageSummary =
    ticket.triage_summary ||
    ticket.result_summary ||
    ticket.decision_summary ||
    ticket.pause_reason ||
    orchestrationView.headline ||
    '当前阶段暂无额外摘要，建议结合动作区、责任链和评论时间线一起查看。';
  const scopeItems = buildBulletItems(
    ticket.implementation_scope,
    '暂无额外范围说明；当前页面按现有工单字段与动作 contract 运行。'
  );
  const constraintItems = buildBulletItems(
    ticket.constraints,
    '暂无额外约束说明。'
  );
  const deliverableItems = buildBulletItems(
    ticket.deliverables,
    '当前阶段暂未声明额外交付物。'
  );
  const acceptanceItems = buildBulletItems(
    ticket.acceptance_criteria,
    '当前阶段暂未声明额外验收标准。'
  );
  const statusSummary = joinSummaryParts([
    `状态：${getStatusLabel(ticket.status)}`,
    ticket.priority ? `优先级：${ticket.priority}` : null,
    ticket.platform ? `平台：${ticket.platform}` : null,
    ticket.request_type ? `类型：${ticket.request_type}` : null,
  ]);
  const relationSummary = joinSummaryParts([
    ticket.supplemental_for_ticket ? `当前票属于 ${ticket.supplemental_for_ticket.relation_label}` : null,
    ticket.supplemental_tickets?.length ? `围绕本单的补充验证 ${ticket.supplemental_tickets.length} 张` : null,
    dependencies.length ? `前置依赖 ${dependencies.length}` : null,
    dependents.length ? `后续依赖 ${dependents.length}` : null,
  ]) || '当前暂无额外关联信息。';
  const canSubmitAction = !requiredFields.some((field) => !String(actionFields[field] || '').trim());
  const isReviewerInboxStatus = ['done', 'review'].includes(ticket.status);
  const isPendingDecision = ticket.status === 'pending_decision';
  const reviewerActions = availableActions.filter((action) => ['start_review', 'approve', 'reject'].includes(action));
  const escalationActions = availableActions.filter((action) => ['request_decision', 'resume_from_decision'].includes(action));
  const otherActions = availableActions.filter((action) => !reviewerActions.includes(action) && !escalationActions.includes(action));
  const nudgeTarget = ticket.current_actor || ticket.next_actor || ticket.assigned_agent || null;
  const canManualNudge = Boolean(nudgeTarget) && !['complete', 'failed', 'deprecated'].includes(ticket.status);
  const controlReadModel = ticket.control_read_model || {};
  const responsibilityView = controlReadModel.responsibility_view || {};
  const operationalView = controlReadModel.ticket_operational_view || {};
  const executionGuardView = controlReadModel.execution_guard_view || {};
  const runtimeDigestView = controlReadModel.runtime_digest_view || {};
  const responsibilitySummary = responsibilityView.summary || '当前未生成责任链摘要。';
  const latestWorkerHeartbeat = getLatestWorkerHeartbeat(executionWorkers);
  const evidenceTimeline = buildEvidenceTimeline({
    comments: ticket.comments || [],
    executionWorkers,
    runtimeDigestView,
    operationalView,
    executionGuardView,
    lastActionError,
  });
  const responsibilityChain = Array.isArray(responsibilityView.chain) ? responsibilityView.chain : [];
  const agentDirectory = topology.agentDirectory || {};
  const platformDirectory = topology.platforms || {};
  const gatewayDirectory = topology.gateways || {};
  const enrichedResponsibilityChain = responsibilityChain.map((item) => {
    const agentId = String(item?.value || '').trim().toLowerCase();
    const agentMeta = agentDirectory[agentId] || null;
    const platformMeta = agentMeta?.primary_platform ? platformDirectory[agentMeta.primary_platform] : null;
    const gatewayMeta = agentMeta?.gateway_id ? gatewayDirectory[agentMeta.gateway_id] : null;
    return {
      ...item,
      agent_id: agentMeta?.id || agentId || null,
      display_name: agentMeta?.display_name || item?.value || '未设置',
      role_type: agentMeta?.role_type || null,
      ownership_layer: agentMeta?.ownership_layer || null,
      primary_platform_name: platformMeta?.display_name || agentMeta?.primary_platform || null,
      gateway_label: gatewayMeta?.label || agentMeta?.gateway_id || null,
      gateway_transport: gatewayMeta?.transport || null,
    };
  });
  const latestControlComment = operationalView.latest_comment_summary || null;
  const latestReportType = operationalView.latest_report_type || '无';
  const controlAvailableActions = Array.isArray(executionGuardView.available_actions)
    ? executionGuardView.available_actions
    : availableActions;
  const reviewSummaryItems = [
    orchestrationView.headline,
    `当前阶段：${getStatusLabel(ticket.status)}，责任人 ${ticket.current_actor || ticket.next_actor || '未解析'}`,
    ticket.result_summary ? `执行交付：${ticket.result_summary}` : null,
    ticket.decision_summary ? `待拍板事项：${ticket.decision_summary}` : null,
    ticket.decision_context ? `决策上下文：${ticket.decision_context}` : null,
    ticket.pause_reason ? `挂起原因：${ticket.pause_reason}` : null,
    (ticket.supplemental_summary?.total || 0) > 0
      ? `补充验证：共 ${ticket.supplemental_summary.total} 张，待收口 ${ticket.supplemental_summary.open || 0} 张，pending review ${ticket.supplemental_summary.pending_review || 0} 张`
      : null,
    dependencies.length ? `前置依赖 ${dependencies.length} 项，需要 reviewer 一并确认依赖链` : null,
    dependents.length ? `后续依赖 ${dependents.length} 项，关单前建议确认影响面` : null,
  ].filter(Boolean);
  const decisionPanelTone = isPendingDecision ? 'warning' : 'accent';
  const decisionPanelTitle = isPendingDecision ? '待老大 / decision owner 拍板' : 'reviewer 可直接收口';
  const decisionPanelDescription = isPendingDecision
    ? '该工单已经进入 pending_decision，当前主动作应围绕 decision_owner 的拍板与恢复路径展开。'
    : '该工单仍在 reviewer 工作台范围内，reviewer 可直接开始验收、通过关单或打回重做。';
  const decisionPanelItems = isPendingDecision
    ? [
        `当前决策人：${ticket.decision_owner || ticket.current_actor || '未设置'}`,
        `决策摘要：${ticket.decision_summary || '尚未填写决策摘要'}`,
        ticket.decision_context ? `决策上下文：${ticket.decision_context}` : '尚未提供决策上下文，建议补充后再拍板。',
        escalationActions.includes('resume_from_decision')
          ? 'decision owner 可直接点击“恢复执行”，平台会把工单拉回执行队列。'
          : '当前页面未暴露 resume_from_decision，说明平台尚未允许直接恢复。',
      ]
    : [
        `reviewer：${ticket.review_owner || '未设置'}，当前阶段 ${getStatusLabel(ticket.status)}`,
        reviewerActions.includes('start_review')
          ? '可先点击“开始验收”，把 done 明确推进到 review。'
          : '当前不需要显式 start_review，可直接在 reviewer 动作区收口。',
        reviewerActions.includes('approve')
          ? '可直接通过关单，无需额外 boss 决策。'
          : null,
        reviewerActions.includes('reject')
          ? '如验收未过，可直接打回 queued 并写明原因。'
          : null,
        escalationActions.includes('request_decision')
          ? '若 reviewer 无法自行拍板，可升级为请求决策，把责任切到 decision owner。'
          : '当前页面未暴露 request_decision，说明此阶段不支持升级为待决策。',
      ].filter(Boolean);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.14),transparent_28%),radial-gradient(circle_at_88%_8%,rgba(16,185,129,0.12),transparent_24%)]">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <button
          onClick={() => navigate('/tickets')}
          className="mb-5 inline-flex items-center gap-2 text-sm font-medium text-[var(--accent-primary)] transition hover:text-[var(--accent-secondary)]"
        >
          ← 返回列表
        </button>

        <section className={`${SURFACE_CLASS} relative overflow-hidden p-6 sm:p-8`}>
          <div className="pointer-events-none absolute inset-x-0 top-0 h-36 bg-[linear-gradient(120deg,rgba(56,189,248,0.18),transparent_55%,rgba(16,185,129,0.12))]" />
          <div className="relative flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 flex-1">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <DetailPill tone="accent">Ticket Detail</DetailPill>
                <DetailPill>#{ticket.id}</DetailPill>
                {ticket.bucket?.label ? <DetailPill>{ticket.bucket.label}</DetailPill> : null}
              </div>

              <h1 className="text-3xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-[2.35rem]">
                #{ticket.id} {ticket.title}
              </h1>
              <p className="mt-4 max-w-3xl text-sm leading-7 text-[var(--text-secondary)] sm:text-base">
                {stageSummary}
              </p>

              <div className="mt-5 flex flex-wrap gap-2">
                <DetailPill tone="success">{`状态：${getStatusLabel(ticket.status)}`}</DetailPill>
                {ticket.priority ? <DetailPill tone="warning">{`优先级：${ticket.priority}`}</DetailPill> : null}
                {ticket.platform ? <DetailPill>{`平台：${ticket.platform}`}</DetailPill> : null}
                {ticket.request_type ? <DetailPill>{`类型：${ticket.request_type}`}</DetailPill> : null}
                {ticket.locked_by ? <DetailPill tone="danger">{`已锁定 by ${ticket.locked_by}`}</DetailPill> : null}
              </div>
            </div>

            <div className="grid w-full gap-3 sm:grid-cols-2 xl:w-[360px] xl:grid-cols-1">
              <div className="rounded-[24px] border border-cyan-400/20 bg-cyan-400/10 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-cyan-200/80">当前状态</div>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <span className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium ${STATUS_BADGE_CLASS[ticket.status] || 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'}`}>
                    {getStatusLabel(ticket.status)}
                  </span>
                  {ticket.locked_by ? <span className="text-sm text-rose-200">🔒 锁定中</span> : null}
                </div>
                <div className="mt-3 text-sm text-cyan-50/90">{statusSummary}</div>
              </div>
              <div className="rounded-[24px] border border-white/10 bg-black/10 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-secondary)]">当前责任链</div>
                <div className="mt-3 text-lg font-semibold text-[var(--text-primary)]">
                  {ticket.current_actor || ticket.next_actor || '无'}
                </div>
                <div className="mt-2 text-sm text-[var(--text-secondary)]">
                  来源：{ticket.current_actor_source || ticket.next_actor_source || '无'}
                </div>
                <div className="mt-1 text-sm text-[var(--text-secondary)]">
                  手动覆盖：{ticket.next_actor_override || '无'}
                </div>
              </div>
            </div>
          </div>

          <div className="relative mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="执行人" value={ticket.assigned_agent || '未分配'} />
            <StatCard label="验收负责人" value={ticket.review_owner || '未设置'} />
            <StatCard label="最近更新时间" value={formatDateTime(ticket.last_update || ticket.updated)} />
            <StatCard label="关联信息" value={relationSummary} highlight />
          </div>
        </section>

        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.95fr)] xl:items-start">
          <div className="space-y-6">
            <SectionCard
              eyebrow="Briefing"
              title="描述 / 范围 / 约束 / 交付 / 验收"
              description="把主叙述、范围边界、约束、交付和验收拆成可扫读的块，避免信息继续堆成一段。"
            >
              <div className="grid gap-4 xl:grid-cols-2">
                <TextPanel title="描述" body={ticket.description || '无'} />
                <TextPanel title="阶段摘要" body={ticket.triage_summary || stageSummary} />
                <BulletPanel title="范围" items={scopeItems} tone="cyan" />
                <BulletPanel title="约束" items={constraintItems} tone="amber" />
                <BulletPanel title="交付物" items={deliverableItems} tone="emerald" />
                <BulletPanel title="验收标准" items={acceptanceItems} tone="emerald" />
              </div>
            </SectionCard>

            <SectionCard
              eyebrow="Timeline"
              title="评论"
              description="把进展、系统回写和 reviewer 留痕放进时间线，提升运行态可读性。"
            >
              <div className="space-y-5">
                {ticket.comments && ticket.comments.length > 0 ? (
                  ticket.comments.map((comment, index) => (
                    <article key={comment.id} className="relative pl-8">
                      {index !== ticket.comments.length - 1 ? (
                        <span className="absolute bottom-[-28px] left-[9px] top-7 w-px bg-white/10" />
                      ) : null}
                      <span className="absolute left-0 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-cyan-400/40 bg-cyan-400/15">
                        <span className="h-2 w-2 rounded-full bg-cyan-300" />
                      </span>
                      <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-base font-semibold text-[var(--text-primary)]">{comment.author}</span>
                              {comment.type ? <DetailPill tone="accent">类型: {comment.type}</DetailPill> : null}
                            </div>
                            <div className="mt-2 text-sm text-[var(--text-secondary)]">{formatDateTime(comment.timestamp)}</div>
                          </div>
                        </div>
                        <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-[var(--text-primary)]">{comment.content}</p>
                      </div>
                    </article>
                  ))
                ) : (
                  <EmptyTimeline text="暂无评论" />
                )}
              </div>

              <div className="mt-6 border-t border-white/10 pt-5">
                <div className="mb-3 text-sm font-medium text-[var(--text-primary)]">继续补充进度</div>
                <textarea
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  placeholder="添加评论..."
                  className="min-h-[120px] w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-[var(--text-primary)] outline-none transition focus:border-cyan-400/50 focus:ring-2 focus:ring-cyan-400/20"
                  rows="3"
                />
                <button
                  onClick={handleAddComment}
                  disabled={submitting || !commentText.trim()}
                  className="mt-3 inline-flex items-center rounded-xl bg-[var(--accent-primary)] px-4 py-2 font-medium text-[var(--bg-primary)] transition hover:bg-[var(--accent-secondary)] disabled:cursor-not-allowed disabled:bg-[var(--border-color)]"
                >
                  {submitting ? '提交中...' : '添加评论'}
                </button>
              </div>
            </SectionCard>
          </div>

          <div className="space-y-6 xl:sticky xl:top-6">
            <SectionCard
              eyebrow="Reviewer Inbox"
              title="Review Inbox"
              description="把 reviewer 真正关心的待验收、待拍板与可直接执行动作收成一个工作台。"
            >
              <div className="space-y-4">
                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-secondary)]">当前状态</div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <span className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium ${STATUS_BADGE_CLASS[ticket.status] || 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'}`}>
                          {getStatusLabel(ticket.status)}
                        </span>
                        {ticket.locked_by ? <DetailPill tone="danger">锁定中</DetailPill> : null}
                        {isReviewerInboxStatus ? <DetailPill tone="success">Reviewer Inbox</DetailPill> : null}
                        {isPendingDecision ? <DetailPill tone="warning">Needs Boss Decision</DetailPill> : null}
                      </div>
                    </div>
                    <DetailPill tone="accent">{`${availableActions.length} 个动作`}</DetailPill>
                  </div>
                </div>

                {canManualNudge ? (
                  <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)]">一键催单</div>
                        <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
                          按当前处理人发送催单消息，不自动改状态。当前目标：{nudgeTarget}
                        </p>
                      </div>
                      <button
                        onClick={handleManualNudge}
                        disabled={nudging}
                        className="inline-flex items-center justify-center rounded-2xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm font-semibold text-amber-100 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {nudging ? '发送中...' : `⚡ 催 ${nudgeTarget}`}
                      </button>
                    </div>
                  </div>
                ) : null}

                {(isReviewerInboxStatus || isPendingDecision) ? (
                  <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
                    <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)]">Review Summary</div>
                    <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
                      reviewer 在收口前先扫一遍交付摘要、依赖、补充验证和待决策信息，减少来回翻评论。
                    </p>
                    <div className="mt-4">
                      <SummaryList items={reviewSummaryItems} />
                    </div>
                  </div>
                ) : null}

                <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)]">Decision Panel</div>
                    <DetailPill tone={decisionPanelTone}>{decisionPanelTitle}</DetailPill>
                  </div>
                  <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">{decisionPanelDescription}</p>
                  <div className="mt-4">
                    <SummaryList items={decisionPanelItems} />
                  </div>
                </div>

                {reviewerActions.length > 0 ? (
                  <div className={`${PANEL_CLASS} p-4`}>
                    <div className="mb-3 text-xs uppercase tracking-[0.18em] text-[var(--text-secondary)]">Reviewer 可直接执行</div>
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                      {reviewerActions.map((action) => (
                        <button
                          key={action}
                          onClick={() => handleActionClick(action)}
                          className={`inline-flex items-center justify-center rounded-2xl px-4 py-3 text-sm font-semibold text-white transition ${ACTION_COLORS[action] || 'bg-gray-500 hover:bg-gray-600'}`}
                        >
                          {ACTION_LABELS[action] || action}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {escalationActions.length > 0 ? (
                  <div className={`${PANEL_CLASS} p-4`}>
                    <div className="mb-3 text-xs uppercase tracking-[0.18em] text-[var(--text-secondary)]">需要升级 / 决策动作</div>
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                      {escalationActions.map((action) => (
                        <button
                          key={action}
                          onClick={() => handleActionClick(action)}
                          className={`inline-flex items-center justify-center rounded-2xl px-4 py-3 text-sm font-semibold text-white transition ${ACTION_COLORS[action] || 'bg-gray-500 hover:bg-gray-600'}`}
                        >
                          {ACTION_LABELS[action] || action}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {otherActions.length > 0 ? (
                  <div className={`${PANEL_CLASS} p-4`}>
                    <div className="mb-3 text-xs uppercase tracking-[0.18em] text-[var(--text-secondary)]">其他动作</div>
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                      {otherActions.map((action) => (
                        <button
                          key={action}
                          onClick={() => handleActionClick(action)}
                          className={`inline-flex items-center justify-center rounded-2xl px-4 py-3 text-sm font-semibold text-white transition ${ACTION_COLORS[action] || 'bg-gray-500 hover:bg-gray-600'}`}
                        >
                          {ACTION_LABELS[action] || action}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {availableActions.length === 0 ? (
                  <EmptyTimeline text="当前阶段没有可执行动作。" />
                ) : null}

                <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)]">Action Preflight</div>
                    <DetailPill tone="accent">最小受控操作面</DetailPill>
                  </div>
                  <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
                    直接复用 /actions contract 展示每个动作的目标状态、角色门禁和必填字段，减少“点了才知道不让做”。
                  </p>
                  <div className="mt-4 space-y-3">
                    {actionObjects.length > 0 ? actionObjects.map((action) => (
                      <div key={action.key} className="rounded-2xl border border-white/8 bg-black/10 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <DetailPill tone="accent">{action.label || ACTION_LABELS[action.key] || action.key}</DetailPill>
                          <DetailPill>{`角色：${action.role_key || 'unknown'}`}</DetailPill>
                          <DetailPill>{`目标：${action.to || 'dynamic'}`}</DetailPill>
                          {action.management_only ? <DetailPill tone="warning">管理动作</DetailPill> : null}
                        </div>
                        <div className="mt-3 text-sm text-[var(--text-secondary)]">
                          前置状态：{Array.isArray(action.from) && action.from.length > 0 ? action.from.join(' / ') : '未声明'}
                        </div>
                        <div className="mt-2 text-sm text-[var(--text-secondary)]">
                          必填字段：{Array.isArray(action.required_fields) && action.required_fields.length > 0 ? action.required_fields.join('、') : '无'}
                        </div>
                      </div>
                    )) : <EmptyTimeline text="当前未返回 action_objects，暂无法展示预检明细。" />}
                  </div>
                </div>
              </div>
            </SectionCard>

            <SectionCard
              eyebrow="Orchestration"
              title="阶段推进与交接编排"
              description="把当前阶段、下一步建议、目标阶段和交接对象收成 machine-readable 的控制台摘要。"
            >
              <div className="space-y-4">
                <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)]">Stage Orchestration</div>
                    <DetailPill tone="accent">{orchestrationView.current_stage_label}</DetailPill>
                    <DetailPill>{orchestrationView.execution_mode}</DetailPill>
                  </div>
                  <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">{orchestrationView.headline}</p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <StatCard label="下一步建议" value={orchestrationView.next_action_label || '等待动作 contract'} />
                    <StatCard label="目标阶段" value={orchestrationView.next_stage_label || '待定'} />
                    <StatCard label="下一责任人" value={orchestrationView.next_owner || '未解析'} />
                    <StatCard label="交接摘要" value={orchestrationView.handoff_summary || '无'} />
                  </div>
                  <div className="mt-4">
                    <SummaryList items={orchestrationView.checklist} />
                  </div>
                </div>
              </div>
            </SectionCard>

            <SectionCard
              eyebrow="Playbook"
              title="Playbook SOP"
              description="按当前 stage / mode / role 从 hosted playbook 抽取结构化 checklist，给执行与验收一个可直接扫读的门禁卡。"
            >
              <div className="space-y-4">
                <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <DetailPill tone="accent">{ticket.status}</DetailPill>
                    <DetailPill>{ticket.execution_mode || 'direct'}</DetailPill>
                    <DetailPill tone={stageGateStatus.state === 'ready' ? 'success' : stageGateStatus.state === 'at_risk' ? 'warning' : stageGateStatus.state === 'gap' ? 'danger' : 'neutral'}>{stageGateStatus.label}</DetailPill>
                  </div>
                  <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">{playbookSnapshot?.goal || stageGateStatus.summary}</p>
                  {playbookSnapshot?.next_stage_options?.length ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {playbookSnapshot.next_stage_options.map((item) => (
                        <DetailPill key={item}>{item}</DetailPill>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="grid gap-4 xl:grid-cols-2">
                  <BulletPanel
                    title="检查项"
                    items={playbookChecklistItems}
                    tone="cyan"
                  />
                  <BulletPanel
                    title="证据要求"
                    items={playbookEvidenceItems}
                    tone="amber"
                  />
                </div>

                {playbookSnapshot?.recommended_paths?.length ? (
                  <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
                    <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)]">建议推进路径</div>
                    <div className="mt-4">
                      <SummaryList items={playbookSnapshot.recommended_paths} />
                    </div>
                  </div>
                ) : null}
              </div>
            </SectionCard>

            <SectionCard
              eyebrow="Ownership"
              title="责任链与元数据"
              description="把执行责任、平台字段和关键时间集中在侧栏。"
            >
              <div className="grid gap-3">
                <StatCard label="当前责任人" value={ticket.current_actor || ticket.next_actor || '无'} />
                <StatCard label="责任来源" value={ticket.current_actor_source || ticket.next_actor_source || '无'} />
                <StatCard label="执行人" value={ticket.assigned_agent || '未分配'} />
                <StatCard label="分诊负责人" value={ticket.triage_owner || '未设置'} />
                <StatCard label="验收负责人" value={ticket.review_owner || '未设置'} />
                <StatCard label="决策负责人" value={ticket.decision_owner || '未设置'} />
                <StatCard label="手动覆盖" value={ticket.next_actor_override || '无'} />
                <StatCard label="平台 / 类型" value={joinSummaryParts([ticket.platform, ticket.request_type]) || '无'} />
                <StatCard label="创建时间" value={formatDateTime(ticket.created)} />
                <StatCard label="更新时间" value={formatDateTime(ticket.last_update || ticket.updated)} />
                {ticket.dispatch_state ? <StatCard label="派单握手状态" value={ticket.dispatch_state} highlight /> : null}
                {ticket.awaiting_receipt_from ? <StatCard label="等待回执" value={ticket.awaiting_receipt_from} /> : null}
                {ticket.dispatch_ack_deadline_at ? <StatCard label="回执截止" value={formatDateTime(ticket.dispatch_ack_deadline_at)} /> : null}
                {ticket.dispatch_retry_count !== undefined ? <StatCard label="派单重试次数" value={String(ticket.dispatch_retry_count ?? 0)} /> : null}
                {ticket.next_dispatch_retry_at ? <StatCard label="下次重派时间" value={formatDateTime(ticket.next_dispatch_retry_at)} /> : null}
                {ticket.dispatch_timeout_reason ? <StatCard label="超时原因" value={ticket.dispatch_timeout_reason} /> : null}
                {ticket.pause_reason ? <StatCard label="挂起原因" value={ticket.pause_reason} /> : null}
                {ticket.paused_from_status ? <StatCard label="挂起前状态" value={getStatusLabel(ticket.paused_from_status)} /> : null}
                {ticket.result_summary ? <StatCard label="结果摘要" value={ticket.result_summary} highlight /> : null}
                {ticket.decision_summary ? <StatCard label="决策摘要" value={ticket.decision_summary} highlight /> : null}
                {ticket.parent_child_summary?.is_parent ? (
                  <>
                    <StatCard label="子单总数" value={String(ticket.parent_child_summary.child_count ?? 0)} />
                    <StatCard label="未闭环子单" value={String(ticket.parent_child_summary.open_child_count ?? 0)} highlight={(ticket.parent_child_summary.open_child_count ?? 0) > 0} />
                  </>
                ) : null}
              </div>
            </SectionCard>

            <SectionCard
              eyebrow="Control"
              title="Control Read Model"
              description="把 responsibility / operational / execution guard 三块最小控制读面直接挂到单票详情。"
            >
              <div className="space-y-4">
                <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)]">Responsibility View</div>
                    <DetailPill tone="accent">{responsibilityView.current_actor || ticket.current_actor || '未解析'}</DetailPill>
                  </div>
                  <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">{responsibilitySummary}</p>
                  {enrichedResponsibilityChain.length > 0 ? (
                    <div className="mt-4 space-y-3">
                      {enrichedResponsibilityChain.map((item) => (
                        <div key={`${item.role}-${item.value}`} className="rounded-2xl border border-white/8 bg-black/10 p-3 text-sm text-[var(--text-primary)]">
                          <div className="flex flex-wrap items-center gap-2">
                            <DetailPill>{item.label || item.role}</DetailPill>
                            <span>{item.display_name || item.value || '未设置'}</span>
                            {item.agent_id ? <span className="text-[var(--text-secondary)]">@{item.agent_id}</span> : null}
                            {item.source ? <span className="text-[var(--text-secondary)]">来源：{item.source}</span> : null}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {item.ownership_layer ? <DetailPill tone="accent">责任层：{item.ownership_layer}</DetailPill> : null}
                            {item.role_type ? <DetailPill>角色：{item.role_type}</DetailPill> : null}
                            {item.primary_platform_name ? <DetailPill>平台：{item.primary_platform_name}</DetailPill> : null}
                            {item.gateway_label ? <DetailPill>Gateway：{item.gateway_label}</DetailPill> : null}
                            {item.gateway_transport ? <DetailPill>Transport：{item.gateway_transport}</DetailPill> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-4 text-sm text-[var(--text-secondary)]">暂无责任链明细。</div>
                  )}
                </div>

                <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
                  <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)]">Operational View</div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <StatCard label="运营状态桶" value={operationalView.bucket || ticket.bucket?.key || '无'} />
                    <StatCard label="执行模式" value={operationalView.execution_mode || ticket.execution_mode || 'direct'} />
                    <StatCard label="最新回写类型" value={latestReportType} />
                    <StatCard label="父单" value={operationalView.parent_ticket_id ? `#${operationalView.parent_ticket_id}` : '无'} />
                  </div>
                  <div className="mt-4 rounded-2xl border border-white/8 bg-black/10 p-4">
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-secondary)]">最新评论摘要</div>
                    <div className="mt-2 text-sm text-[var(--text-primary)]">
                      {latestControlComment ? `${latestControlComment.by || '未知'} · ${formatDateTime(latestControlComment.at)} · ${latestControlComment.excerpt}` : '暂无评论摘要'}
                    </div>
                  </div>
                </div>

                <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
                  <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)]">Execution Guard</div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <StatCard label="需要 worker" value={executionGuardView.requires_worker ? '是' : '否'} />
                    <StatCard label="已有 worker 证据" value={executionGuardView.has_worker_evidence ? '是' : '否'} />
                    <StatCard label="活跃 worker" value={String(executionGuardView.active_workers ?? 0)} />
                    <StatCard label="worker 上限" value={String(executionGuardView.max_active_workers ?? 0)} />
                    <StatCard label="抑制派单" value={executionGuardView.suppress_dispatch ? '是' : '否'} />
                    <StatCard label="门禁原因" value={executionGuardView.reason || '无'} />
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {controlAvailableActions.length > 0 ? controlAvailableActions.map((action) => (
                      <DetailPill key={action}>{ACTION_LABELS[action] || action}</DetailPill>
                    )) : <DetailPill>当前无动作</DetailPill>}
                  </div>
                </div>

                <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)]">Runtime Digest</div>
                    <DetailPill tone="accent">{runtimeDigestView.state || 'idle'}</DetailPill>
                  </div>
                  <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">{runtimeDigestView.summary || '当前未生成 runtime digest。'}</p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <StatCard label="执行模式" value={runtimeDigestView.execution_mode || ticket.execution_mode || 'direct'} />
                    <StatCard label="派单状态" value={runtimeDigestView.dispatch_state || ticket.dispatch_state || '无'} />
                    <StatCard label="待回执对象" value={runtimeDigestView.awaiting_receipt_from || ticket.awaiting_receipt_from || '无'} />
                    <StatCard label="当前责任人" value={runtimeDigestView.current_actor || ticket.current_actor || '无'} />
                    <StatCard label="活跃 worker" value={String(runtimeDigestView.active_workers ?? 0)} />
                    <StatCard label="运行中 worker" value={String(runtimeDigestView.running_workers ?? 0)} />
                  </div>
                </div>
              </div>
            </SectionCard>

            <SectionCard
              eyebrow="Evidence"
              title="Timeline 与现场证据"
              description="把 runtime / worker / 评论 / 最近失败聚成一条证据时间线，并补一个一眼能扫的现场快照。"
            >
              <div className="space-y-4">
                <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)]">Evidence Snapshot</div>
                    <DetailPill tone="accent">现场快照</DetailPill>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <StatCard label="Runtime 状态" value={runtimeDigestView.state || 'idle'} />
                    <StatCard label="派单状态" value={runtimeDigestView.dispatch_state || ticket.dispatch_state || '无'} />
                    <StatCard label="待回执对象" value={runtimeDigestView.awaiting_receipt_from || ticket.awaiting_receipt_from || '无'} />
                    <StatCard label="已有 worker 证据" value={executionGuardView.has_worker_evidence ? '是' : '否'} />
                    <StatCard label="活跃 / 运行中 worker" value={`${runtimeDigestView.active_workers ?? 0} / ${runtimeDigestView.running_workers ?? 0}`} />
                    <StatCard label="最近心跳" value={latestWorkerHeartbeat ? formatDateTime(latestWorkerHeartbeat.last_heartbeat_at || latestWorkerHeartbeat.started_at) : '无'} />
                    <StatCard label="最新评论摘要" value={latestControlComment ? `${latestControlComment.by || '未知'} · ${latestControlComment.excerpt}` : '无'} />
                    <StatCard label="最近失败 request_id" value={lastActionError?.request_id || '无'} />
                  </div>
                </div>

                <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)]">Evidence Timeline</div>
                    <DetailPill tone="accent">系统 + 评论统一视图</DetailPill>
                  </div>
                  <div className="mt-4 space-y-4">
                    {evidenceTimeline.length > 0 ? evidenceTimeline.map((item, index) => (
                      <article key={item.key} className="relative pl-8">
                        {index !== evidenceTimeline.length - 1 ? (
                          <span className="absolute bottom-[-24px] left-[9px] top-7 w-px bg-white/10" />
                        ) : null}
                        <span className="absolute left-0 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-cyan-400/40 bg-cyan-400/15">
                          <span className="h-2 w-2 rounded-full bg-cyan-300" />
                        </span>
                        <div className={`${PANEL_CLASS} p-4`}>
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-base font-semibold text-[var(--text-primary)]">{item.title}</span>
                                <DetailPill>{item.kind}</DetailPill>
                              </div>
                              <div className="mt-2 text-sm text-[var(--text-secondary)]">{item.timestamp ? formatDateTime(item.timestamp) : '当前快照'}</div>
                            </div>
                          </div>
                          <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-[var(--text-primary)]">{item.summary || '无'}</p>
                          {item.meta?.length > 0 ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {item.meta.map((meta) => (
                                <DetailPill key={`${item.key}-${meta}`}>{meta}</DetailPill>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </article>
                    )) : <EmptyTimeline text="当前暂无可展示的证据时间线。" />}
                  </div>
                </div>
              </div>
            </SectionCard>

            <SectionCard
              eyebrow="Execution"
              title="执行记录与错误原文"
              description="把 execution_workers、最近一次动作失败 request_id 与 raw error 直接挂到详情页，减少再翻控制台和接口返回。"
            >
              <div className="space-y-4">
                <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)]">Execution Records</div>
                    <DetailPill tone="accent">{`${executionWorkers.length} 条`}</DetailPill>
                  </div>
                  {executionWorkers.length > 0 ? (
                    <div className="mt-4 space-y-3">
                      {executionWorkers.map((worker) => (
                        <div key={worker.id || worker.worker_key} className="rounded-2xl border border-white/8 bg-black/10 p-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <DetailPill tone="accent">{worker.label || worker.worker_key || `worker-${worker.id}`}</DetailPill>
                            <DetailPill>{worker.worker_type || 'unknown'}</DetailPill>
                            <DetailPill tone={worker.status === 'running' ? 'warning' : 'success'}>{worker.status || 'unknown'}</DetailPill>
                          </div>
                          <div className="mt-3 space-y-2 text-sm text-[var(--text-secondary)]">
                            <div>session_key：{worker.session_key || '无'}</div>
                            <div>run_id：{worker.run_id || '无'}</div>
                            <div>started_at：{formatDateTime(worker.started_at)}</div>
                            <div>last_heartbeat_at：{formatDateTime(worker.last_heartbeat_at)}</div>
                            <div>summary：{worker.summary || '无'}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyTimeline text="当前没有 execution worker 记录。" />
                  )}
                </div>

                <div className={`${PANEL_CLASS} p-4 sm:p-5`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)]">Last Action Error</div>
                    {lastActionError?.request_id ? <DetailPill tone="warning">request_id: {lastActionError.request_id}</DetailPill> : <DetailPill>暂无失败记录</DetailPill>}
                  </div>
                  {lastActionError ? (
                    <>
                      <div className="mt-4 rounded-2xl border border-rose-400/20 bg-rose-400/5 p-4 text-sm text-rose-100">
                        <div className="font-medium">detail</div>
                        <div className="mt-2 whitespace-pre-wrap break-words">{lastActionError.detail || '未知错误'}</div>
                      </div>
                      <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 p-4">
                        <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-secondary)]">错误原文</div>
                        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-6 text-[var(--text-primary)]">{JSON.stringify(lastActionError.raw || {}, null, 2)}</pre>
                      </div>
                    </>
                  ) : (
                    <div className="mt-4 text-sm text-[var(--text-secondary)]">最近一次动作尚未失败，暂无 raw error。</div>
                  )}
                </div>
              </div>
            </SectionCard>

            <SectionCard
              eyebrow="Relations"
              title="补充验证关系"
              description="把 smoke / validation / review sample 与主单关系放到侧栏。"
            >
              <div className="space-y-4">
                {ticket.parent_child_summary?.is_parent ? (
                  <div className={`${PANEL_CLASS} p-4`}>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-secondary)]">子单汇总</div>
                        <div className="mt-1 text-xs text-[var(--text-secondary)]">母单 / 子单收口</div>
                        <div className="mt-2 text-sm text-[var(--text-primary)]">
                          子单 {ticket.parent_child_summary.child_count || 0} 张 · 已终态 {ticket.parent_child_summary.terminal_child_count || 0} 张 · 未闭环 {ticket.parent_child_summary.open_child_count || 0} 张
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {ticket.parent_child_summary.attention_required ? <DetailPill tone="warning">需关注</DetailPill> : null}
                        <DetailPill tone={(ticket.parent_child_summary.open_child_count || 0) > 0 ? 'warning' : 'success'}>
                          {(ticket.parent_child_summary.open_child_count || 0) > 0 ? '仍有子单未闭环' : '子单已收口'}
                        </DetailPill>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--text-secondary)]">
                      {Object.entries(ticket.parent_child_summary.by_status || {}).map(([status, count]) => (
                        <span key={status} className="rounded-full border border-[var(--border-color)] px-2.5 py-1">
                          {getStatusLabel(status)} × {count}
                        </span>
                      ))}
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div className="rounded-xl border border-[var(--border-color)] bg-black/10 px-3 py-3 text-sm text-[var(--text-secondary)]">
                        最近完成时间：{ticket.parent_child_summary.latest_completed_at ? formatDateTime(ticket.parent_child_summary.latest_completed_at) : '暂无'}
                      </div>
                      <div className="rounded-xl border border-[var(--border-color)] bg-black/10 px-3 py-3 text-sm text-[var(--text-secondary)]">
                        风险信号：blocked {ticket.parent_child_summary.blocked_child_count || 0} · failed {ticket.parent_child_summary.failed_child_count || 0}
                      </div>
                    </div>
                    {(ticket.parent_child_summary.blocking_children || []).length > 0 ? (
                      <div className="mt-3 space-y-2">
                        {ticket.parent_child_summary.blocking_children.map((child) => (
                          <div key={child.id} className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-3">
                            <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-primary)]">
                              <button
                                onClick={() => navigate(`/tickets/${child.id}`)}
                                className="text-[var(--accent-primary)] hover:text-[var(--accent-secondary)] font-medium"
                              >
                                #{child.id}
                              </button>
                              <span>{child.title}</span>
                              <DetailPill tone="warning">{getStatusLabel(child.status)}</DetailPill>
                            </div>
                            {child.result_summary ? (
                              <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{child.result_summary}</p>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {ticket.supplemental_for_ticket ? (
                  <div className={`${PANEL_CLASS} p-4`}>
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-secondary)]">当前票定位</div>
                    <div className="mt-3 text-sm leading-6 text-[var(--text-primary)]">
                      这是一张 <span className="font-semibold">{ticket.supplemental_for_ticket.relation_label}</span> 单，围绕主单
                      <button
                        onClick={() => navigate(`/tickets/${ticket.supplemental_for_ticket.ticket.id}`)}
                        className="ml-1 text-[var(--accent-primary)] hover:text-[var(--accent-secondary)] font-medium"
                      >
                        #{ticket.supplemental_for_ticket.ticket.id}
                      </button>
                      <span className="ml-2 text-[var(--text-secondary)]">{ticket.supplemental_for_ticket.ticket.title}</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-[var(--text-secondary)]">当前票不是补充 smoke/validation/review-sample 单</p>
                )}

                <div>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium text-[var(--text-primary)]">
                      围绕本单的补充验证 ({ticket.supplemental_summary?.total || 0})
                    </h3>
                    {(ticket.supplemental_summary?.total || 0) > 0 ? (
                      <span className="text-xs text-[var(--text-secondary)]">
                        待收口 {ticket.supplemental_summary?.open || 0} · 已 complete {ticket.supplemental_summary?.complete || 0}
                      </span>
                    ) : null}
                  </div>
                  {(ticket.supplemental_tickets || []).length > 0 ? (
                    <div className="space-y-2">
                      {ticket.supplemental_tickets.map((relation) => (
                        <div key={`${relation.relation_type}-${relation.ticket.id}`} className={`${PANEL_CLASS} p-4`}>
                          <div className="flex flex-wrap items-center gap-2">
                            <DetailPill>{relation.relation_label}</DetailPill>
                            <button
                              onClick={() => navigate(`/tickets/${relation.ticket.id}`)}
                              className="text-[var(--accent-primary)] hover:text-[var(--accent-secondary)] font-medium"
                            >
                              #{relation.ticket.id}
                            </button>
                            <span className="text-sm text-[var(--text-primary)]">{relation.ticket.title}</span>
                          </div>
                          <div className="mt-2 text-sm text-[var(--text-secondary)]">状态：{getStatusLabel(relation.ticket.status)}</div>
                          {relation.ticket.result_summary ? (
                            <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{relation.ticket.result_summary}</p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-[var(--text-secondary)]">暂无围绕本单的补充验证单</p>
                  )}
                </div>
              </div>
            </SectionCard>

            <SectionCard
              eyebrow="Dependencies"
              title="依赖关系"
              description="保持原有依赖读写行为不变，只调整布局层次。"
            >
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="text-sm text-[var(--text-secondary)]">维护前置依赖和被依赖关系。</div>
                <button
                  onClick={() => setShowAddDependency(!showAddDependency)}
                  className="rounded-xl bg-[var(--accent-primary)] px-3 py-2 text-sm font-medium text-[var(--bg-primary)] hover:bg-[var(--accent-secondary)]"
                >
                  {showAddDependency ? '取消' : '+ 添加依赖'}
                </button>
              </div>

              {showAddDependency ? (
                <div className={`${PANEL_CLASS} mb-4 p-4`}>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={newDependencyId}
                      onChange={(e) => setNewDependencyId(e.target.value)}
                      placeholder="输入依赖的工单 ID"
                      className="flex-1 rounded-xl border border-white/10 bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    />
                    <button
                      onClick={handleAddDependency}
                      disabled={submitting || !newDependencyId}
                      className="rounded-xl bg-[var(--success)] px-4 py-2 text-white hover:opacity-80 disabled:cursor-not-allowed disabled:bg-[var(--border-color)]"
                    >
                      {submitting ? '添加中...' : '确认'}
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-[var(--text-secondary)]">
                    添加后，本工单将依赖指定工单完成后才能开始执行
                  </p>
                </div>
              ) : null}

              <div className="space-y-4">
                <div>
                  <h3 className="mb-2 text-sm font-medium text-[var(--text-primary)]">🔗 本工单依赖 ({dependencies.length})</h3>
                  {dependencies.length > 0 ? (
                    <div className="space-y-2">
                      {dependencies.map((dep) => (
                        <div key={dep.id} className={`${PANEL_CLASS} flex items-center justify-between gap-3 p-4`}>
                          <div className="min-w-0 flex-1">
                            <button
                              onClick={() => navigate(`/tickets/${dep.depends_on_ticket_id}`)}
                              className="text-[var(--accent-primary)] hover:text-[var(--accent-secondary)] font-medium"
                            >
                              #{dep.depends_on_ticket_id}
                            </button>
                            <span className="ml-2 text-sm text-[var(--text-secondary)]">({dep.dependency_type || 'blocks'})</span>
                          </div>
                          <button
                            onClick={() => handleRemoveDependency(dep.depends_on_ticket_id)}
                            disabled={submitting}
                            className="text-sm text-[var(--danger)] hover:opacity-80 disabled:text-[var(--text-secondary)]"
                          >
                            删除
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-[var(--text-secondary)]">无依赖</p>
                  )}
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-medium text-[var(--text-primary)]">⬅️ 被依赖 ({dependents.length})</h3>
                  {dependents.length > 0 ? (
                    <div className="space-y-2">
                      {dependents.map((dep) => (
                        <div key={dep.id} className={`${PANEL_CLASS} flex items-center gap-3 p-4`}>
                          <button
                            onClick={() => navigate(`/tickets/${dep.ticket_id}`)}
                            className="text-[var(--accent-primary)] hover:text-[var(--accent-secondary)] font-medium"
                          >
                            #{dep.ticket_id}
                          </button>
                          <span className="text-sm text-[var(--text-secondary)]">依赖本工单 ({dep.dependency_type || 'blocks'})</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-[var(--text-secondary)]">无工单依赖本工单</p>
                  )}
                </div>
              </div>
            </SectionCard>
          </div>
        </div>
      </div>

      {showActionModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 px-4">
          <div className="w-full max-w-md rounded-2xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-6">
            <h3 className="mb-4 text-xl font-semibold text-[var(--text-primary)]">
              {ACTION_LABELS[selectedAction] || selectedAction}
            </h3>

            <div className="space-y-4">
              {selectedActionObject ? (
                <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-4">
                  <div className="text-sm font-semibold text-[var(--text-primary)]">执行前预检</div>
                  <div className="mt-2 space-y-1 text-sm text-[var(--text-secondary)]">
                    <div>当前状态：{getStatusLabel(ticket.status)}</div>
                    <div>目标状态：{selectedActionObject.to || 'dynamic'}</div>
                    <div>角色门禁：{selectedActionObject.role_key || 'unknown'}</div>
                    <div>必填字段：{requiredFields.length > 0 ? requiredFields.join('、') : '无'}</div>
                  </div>
                </div>
              ) : null}

              {lastActionError ? (
                <div className="rounded-xl border border-rose-400/20 bg-rose-400/5 p-4">
                  <div className="text-sm font-semibold text-rose-100">上次失败返回</div>
                  <div className="mt-2 text-sm text-rose-100/90">detail：{lastActionError.detail || '未知错误'}</div>
                  <div className="mt-1 text-xs text-rose-100/70">request_id：{lastActionError.request_id || '无'}</div>
                </div>
              ) : null}

              <div>
                <label className="mb-1 block text-sm font-medium text-[var(--text-primary)]">评论</label>
                <textarea
                  value={actionFields.comment || ''}
                  onChange={(e) => setActionFields({ ...actionFields, comment: e.target.value })}
                  className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                  rows="3"
                  placeholder="描述此操作..."
                />
              </div>

              {requiredFields.includes('result_summary') ? (
                <div>
                  <label className="mb-1 block text-sm font-medium text-[var(--text-primary)]">
                    结果摘要 <span className="text-[var(--danger)]">*</span>
                  </label>
                  <textarea
                    value={actionFields.result_summary || ''}
                    onChange={(e) => setActionFields({ ...actionFields, result_summary: e.target.value })}
                    className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    rows="2"
                    required
                  />
                </div>
              ) : null}

              {requiredFields.includes('decision_summary') ? (
                <>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-[var(--text-primary)]">
                      决策摘要 <span className="text-[var(--danger)]">*</span>
                    </label>
                    <textarea
                      value={actionFields.decision_summary || ''}
                      onChange={(e) => setActionFields({ ...actionFields, decision_summary: e.target.value })}
                      className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                      rows="2"
                      required
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-[var(--text-primary)]">决策上下文</label>
                    <textarea
                      value={actionFields.decision_context || ''}
                      onChange={(e) => setActionFields({ ...actionFields, decision_context: e.target.value })}
                      className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                      rows="2"
                    />
                  </div>
                </>
              ) : null}

              {requiredFields.includes('reject_reason') ? (
                <div>
                  <label className="mb-1 block text-sm font-medium text-[var(--text-primary)]">
                    打回原因 <span className="text-[var(--danger)]">*</span>
                  </label>
                  <textarea
                    value={actionFields.reject_reason || ''}
                    onChange={(e) => setActionFields({ ...actionFields, reject_reason: e.target.value })}
                    className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    rows="2"
                    required
                  />
                </div>
              ) : null}

              {requiredFields.includes('blocker_summary') ? (
                <div>
                  <label className="mb-1 block text-sm font-medium text-[var(--text-primary)]">
                    阻塞原因 <span className="text-[var(--danger)]">*</span>
                  </label>
                  <textarea
                    value={actionFields.blocker_summary || ''}
                    onChange={(e) => setActionFields({ ...actionFields, blocker_summary: e.target.value })}
                    className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    rows="2"
                    required
                  />
                </div>
              ) : null}

              {requiredFields.includes('pause_reason') ? (
                <div>
                  <label className="mb-1 block text-sm font-medium text-[var(--text-primary)]">
                    挂起原因 <span className="text-[var(--danger)]">*</span>
                  </label>
                  <textarea
                    value={actionFields.pause_reason || ''}
                    onChange={(e) => setActionFields({ ...actionFields, pause_reason: e.target.value })}
                    className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    rows="2"
                    required
                  />
                </div>
              ) : null}

              {requiredFields.includes('error') ? (
                <div>
                  <label className="mb-1 block text-sm font-medium text-[var(--text-primary)]">
                    错误信息 <span className="text-[var(--danger)]">*</span>
                  </label>
                  <textarea
                    value={actionFields.error || ''}
                    onChange={(e) => setActionFields({ ...actionFields, error: e.target.value })}
                    className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    rows="2"
                    required
                  />
                </div>
              ) : null}

              {requiredFields.includes('reason') ? (
                <div>
                  <label className="mb-1 block text-sm font-medium text-[var(--text-primary)]">
                    撤销原因 <span className="text-[var(--danger)]">*</span>
                  </label>
                  <textarea
                    value={actionFields.reason || ''}
                    onChange={(e) => setActionFields({ ...actionFields, reason: e.target.value })}
                    className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    rows="2"
                    required
                  />
                </div>
              ) : null}
            </div>

            <div className="mt-6 flex gap-2">
              <button
                onClick={handleActionSubmit}
                disabled={submitting || !canSubmitAction}
                className="flex-1 rounded-lg bg-[var(--accent-primary)] px-4 py-2 text-[var(--bg-primary)] hover:bg-[var(--accent-secondary)] disabled:cursor-not-allowed disabled:bg-[var(--border-color)]"
              >
                {submitting ? '提交中...' : '确认'}
              </button>
              <button
                onClick={() => {
                  setShowActionModal(false);
                  setSelectedAction(null);
                  setActionFields({});
                }}
                disabled={submitting}
                className="flex-1 rounded-lg bg-[var(--bg-tertiary)] px-4 py-2 text-[var(--text-primary)] hover:bg-[var(--border-color)] disabled:cursor-not-allowed"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default TicketDetail;
