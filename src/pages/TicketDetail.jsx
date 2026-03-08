import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Clock, User, MessageSquare, Paperclip, GitBranch, Save } from 'lucide-react';
import { fetchTicketDetail, fetchTicketComments, submitComment, updateTicket } from '../api/tickets';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import { COMMENT_TYPES as COMMENT_TYPE_OPTIONS, COMMENT_VISIBILITY as VISIBILITY_OPTIONS } from '../../constants/comments.js';

const PLATFORM_OPTIONS = ['ticket-platform', 'stock-platform'];
const REQUEST_TYPE_OPTIONS = ['feature', 'bug', 'optimization', 'ops'];
const ASSIGNED_AGENT_OPTIONS = ['beavy', 'cowder', 'donky', 'doggy', 'marely', 'auditor'];
const STATUS_OPTIONS = ['triage', 'queued', 'running', 'review', 'blocked', 'done', 'failed', 'complete', 'pending_decision'];

const EMPTY_TRIAGE_FORM = {
  status: 'triage',
  triage_owner: 'leoss',
  review_owner: 'leoss',
  decision_owner: '荣晖',
  decision_summary: '',
  decision_context: '',
  assigned_agent: 'beavy',
  next_actor_override: '',
  platform: '',
  request_type: '',
  triage_summary: '',
  implementation_scope: '',
  constraints: '',
  deliverables: '',
  acceptance_criteria: '',
  parent_ticket_id: '',
};

function buildTriageForm(ticket) {
  if (!ticket) return EMPTY_TRIAGE_FORM;
  return {
    status: ticket.status || 'triage',
    triage_owner: ticket.triage_owner || 'leoss',
    review_owner: ticket.review_owner || ticket.triage_owner || 'leoss',
    decision_owner: ticket.decision_owner || '荣晖',
    decision_summary: ticket.decision_summary || '',
    decision_context: ticket.decision_context || '',
    assigned_agent: ticket.assigned_agent || 'beavy',
    next_actor_override: ticket.next_actor_override || '',
    platform: ticket.platform || '',
    request_type: ticket.request_type || '',
    triage_summary: ticket.triage_summary || '',
    implementation_scope: ticket.implementation_scope || '',
    constraints: ticket.constraints || '',
    deliverables: ticket.deliverables || '',
    acceptance_criteria: ticket.acceptance_criteria || '',
    parent_ticket_id: ticket.parent_ticket_id ? String(ticket.parent_ticket_id) : '',
  };
}

const TicketDetail = () => {
  const { id } = useParams();
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [commentInput, setCommentInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitFeedback, setSubmitFeedback] = useState(null); // { type: 'success'|'error', message }
  const [triageForm, setTriageForm] = useState(EMPTY_TRIAGE_FORM);
  const [triageSaving, setTriageSaving] = useState(false);
  const [triageFeedback, setTriageFeedback] = useState(null);

  const [commentType, setCommentType] = useState('progress');
  const [commentVisibility, setCommentVisibility] = useState('internal');
  const [commentThreadId, setCommentThreadId] = useState('');
  const [commentMentions, setCommentMentions] = useState('');

  const [filterType, setFilterType] = useState('all');
  const [filterVisibility, setFilterVisibility] = useState('all');
  const [filterThreadId, setFilterThreadId] = useState('');
  const [filteredComments, setFilteredComments] = useState([]);

  const applyTemplate = (kind) => {
    if (kind === 'start') {
      setCommentType('progress');
      setCommentVisibility('internal');
      setCommentInput('接单开始\n- 已完成: 已接单并完成任务理解\n- 下一步: 拆解执行步骤并开始处理\n- 阻塞: 无\n- ETA: 预计 30 分钟\n- 需要谁决策: 暂无');
      return;
    }
    if (kind === 'progress') {
      setCommentType('progress');
      setCommentVisibility('internal');
      setCommentInput('进度更新\n- 已完成: （填写已完成项）\n- 下一步: （填写下一步）\n- 阻塞: （无则写无）\n- ETA: （预计完成时间）\n- 需要谁决策: （若有 @人）');
      return;
    }
    if (kind === 'result') {
      setCommentType('result');
      setCommentVisibility('public');
      setCommentInput('处理完成\n- 结论: （一句话结论）\n- 已完成: （关键交付）\n- 风险: （至少 1 条）\n- 路径: （文档/产物路径）\n- 后续建议: （可选）');
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTicketDetail(id)
      .then((data) => {
        if (!cancelled) {
          setTicket(data);
          setTriageForm(buildTriageForm(data));
          setFilteredComments(data?.comments || []);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err?.message || '加载工单失败，请稍后重试');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [id]);

  const comments = ticket?.comments || [];

  useEffect(() => {
    let cancelled = false;
    if (!ticket) return () => {};

    const filters = {
      type: filterType === 'all' ? undefined : filterType,
      visibility: filterVisibility === 'all' ? undefined : filterVisibility,
      thread_id: filterThreadId.trim() || undefined,
    };

    fetchTicketComments(id, filters)
      .then((res) => {
        if (!cancelled) setFilteredComments(res?.comments || []);
      })
      .catch(() => {
        if (!cancelled) setFilteredComments([]);
      });

    return () => { cancelled = true; };
  }, [id, ticket, filterType, filterVisibility, filterThreadId]);

  const handleTriageFieldChange = (field) => (e) => {
    const { value } = e.target;
    setTriageFeedback(null);
    setTriageForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSaveTriage = async () => {
    if (!ticket || triageSaving) return;

    const parentValue = triageForm.parent_ticket_id.trim();
    if (parentValue && (!/^\d+$/.test(parentValue) || Number(parentValue) <= 0)) {
      setTriageFeedback({ type: 'error', message: '父工单 ID 必须是正整数' });
      return;
    }

    setTriageSaving(true);
    setTriageFeedback(null);
    try {
      const saved = await updateTicket(id, {
        status: triageForm.status,
        triage_owner: triageForm.triage_owner || null,
        review_owner: triageForm.review_owner || null,
        decision_owner: triageForm.decision_owner || null,
        decision_summary: triageForm.decision_summary || null,
        decision_context: triageForm.decision_context || null,
        assigned_agent: triageForm.assigned_agent || null,
        next_actor: triageForm.next_actor_override || null,
        platform: triageForm.platform || null,
        request_type: triageForm.request_type || null,
        triage_summary: triageForm.triage_summary,
        implementation_scope: triageForm.implementation_scope,
        constraints: triageForm.constraints,
        deliverables: triageForm.deliverables,
        acceptance_criteria: triageForm.acceptance_criteria,
        parent_ticket_id: parentValue ? Number(parentValue) : null,
      });

      setTicket((prev) => ({
        ...prev,
        ...saved,
        assignee: saved.assigned_agent || null,
        updated: saved.last_update || prev?.updated,
      }));
      setTriageForm(buildTriageForm(saved));
      setTriageFeedback({ type: 'success', message: '分诊信息已保存' });
    } catch (err) {
      setTriageFeedback({ type: 'error', message: err?.message || '保存失败，请稍后重试' });
    } finally {
      setTriageSaving(false);
    }
  };

  const handleSubmitComment = async (e) => {
    e.preventDefault();
    const trimmed = commentInput.trim();
    if (!trimmed || isSubmitting || !ticket) return;
    setIsSubmitting(true);
    setSubmitFeedback(null);
    try {
      const mentionList = commentMentions
        .split(',')
        .map((x) => x.trim().replace(/^@/, ''))
        .filter(Boolean);

      const newComment = await submitComment(id, trimmed, 'Current User', {
        type: commentType,
        visibility: commentVisibility,
        thread_id: commentThreadId.trim() || null,
        mentions: mentionList,
      });

      setTicket((prev) => ({
        ...prev,
        comments: [...(prev.comments || []), newComment],
      }));
      const matchedType = filterType === 'all' || (newComment.type || 'progress') === filterType;
      const matchedVisibility = filterVisibility === 'all' || (newComment.visibility || 'internal') === filterVisibility;
      const matchedThread = !filterThreadId.trim() || String(newComment.thread_id || '') === filterThreadId.trim();
      if (matchedType && matchedVisibility && matchedThread) {
        setFilteredComments((prev) => [...prev, newComment]);
      }
      setCommentInput('');
      setCommentThreadId('');
      setCommentMentions('');
      setCommentType('progress');
      setCommentVisibility('internal');
      setSubmitFeedback({ type: 'success', message: '评论已发布' });
    } catch (err) {
      const msg = err?.message || '提交失败，请稍后重试';
      setSubmitFeedback({ type: 'error', message: msg });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="px-4 py-6">
        <Link to="/tickets" className="inline-flex items-center text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors mb-4">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Tickets
        </Link>
        <LoadingState title="加载工单中..." description="正在获取工单详情" />
      </div>
    );
  }

  if (error || !ticket) {
    return (
      <div className="px-4 py-6">
        <Link to="/tickets" className="inline-flex items-center text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors mb-4">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Tickets
        </Link>
        <ErrorState title="加载失败" message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  const getStatusColor = (status) => {
    const colors = {
      triage: 'bg-violet-500/20 text-violet-300 border-violet-500/50',
      queued: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
      running: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
      review: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/50',
      blocked: 'bg-orange-500/20 text-orange-300 border-orange-500/50',
      done: 'bg-green-500/20 text-green-400 border-green-500/50',
      failed: 'bg-red-500/20 text-red-400 border-red-500/50',
      complete: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50',
      pending_decision: 'bg-purple-500/20 text-purple-300 border-purple-500/50',
      open: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
      'in-progress': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
      resolved: 'bg-green-500/20 text-green-400 border-green-500/50',
      closed: 'bg-gray-500/20 text-gray-400 border-gray-500/50',
    };
    return colors[status] || 'bg-gray-500/20 text-gray-400 border-gray-500/50';
  };

  const getPriorityColor = (priority) => {
    const colors = {
      critical: 'bg-red-500/20 text-red-400 border-red-500/50',
      high: 'bg-orange-500/20 text-orange-400 border-orange-500/50',
      medium: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
      low: 'bg-gray-500/20 text-gray-400 border-gray-500/50',
    };
    return colors[priority] || 'bg-gray-500/20 text-gray-400 border-gray-500/50';
  };

  return (
    <div className="px-4 py-6 space-y-6 animate-slide-in">
      <Link to="/tickets" className="inline-flex items-center text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to Tickets
      </Link>

      <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6">
        <div className="flex justify-between items-start mb-4 gap-4">
          <div>
            <h1 className="text-3xl font-bold text-[var(--text-primary)] mb-2">
              #{ticket.id} {ticket.title}
            </h1>
            <div className="flex gap-2 flex-wrap">
              <span className={`px-3 py-1 inline-flex text-xs leading-5 font-semibold rounded border ${getStatusColor(ticket.status)}`}>
                {ticket.status}
              </span>
              <span className={`px-3 py-1 inline-flex text-xs leading-5 font-semibold rounded border ${getPriorityColor(ticket.priority)}`}>
                {ticket.priority}
              </span>
              {ticket.platform && (
                <span className="px-3 py-1 inline-flex text-xs leading-5 font-semibold rounded border border-cyan-500/40 text-cyan-300 bg-cyan-500/10">
                  {ticket.platform}
                </span>
              )}
              {ticket.request_type && (
                <span className="px-3 py-1 inline-flex text-xs leading-5 font-semibold rounded border border-fuchsia-500/40 text-fuchsia-300 bg-fuchsia-500/10">
                  {ticket.request_type}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-[var(--border-color)]">
          <div className="flex items-center text-sm">
            <User className="w-5 h-5 text-[var(--text-secondary)] mr-2" />
            <span className="text-[var(--text-secondary)]">Triage Owner:</span>
            <span className="ml-2 font-medium text-[var(--text-primary)]">{ticket.triage_owner || '—'}</span>
          </div>
          <div className="flex items-center text-sm">
            <User className="w-5 h-5 text-[var(--text-secondary)] mr-2" />
            <span className="text-[var(--text-secondary)]">Assigned Agent:</span>
            <span className="ml-2 font-medium text-[var(--text-primary)]">{ticket.assigned_agent || '—'}</span>
          </div>
          <div className="flex items-center text-sm">
            <User className="w-5 h-5 text-[var(--text-secondary)] mr-2" />
            <span className="text-[var(--text-secondary)]">Next Actor:</span>
            <span className="ml-2 font-medium text-[var(--text-primary)]">{ticket.next_actor || '—'}</span>
            {ticket.next_actor_source && (
              <span className="ml-2 text-xs text-[var(--text-secondary)] font-mono">via {ticket.next_actor_source}</span>
            )}
          </div>
          <div className="flex items-center text-sm">
            <User className="w-5 h-5 text-[var(--text-secondary)] mr-2" />
            <span className="text-[var(--text-secondary)]">Reporter:</span>
            <span className="ml-2 font-medium text-[var(--text-primary)]">{ticket.reporter || '—'}</span>
          </div>
          <div className="flex items-center text-sm">
            <Clock className="w-5 h-5 text-[var(--text-secondary)] mr-2" />
            <span className="text-[var(--text-secondary)]">Created:</span>
            <span className="ml-2 text-[var(--text-primary)]">{ticket.created}</span>
          </div>
          <div className="flex items-center text-sm">
            <Clock className="w-5 h-5 text-[var(--text-secondary)] mr-2" />
            <span className="text-[var(--text-secondary)]">Updated:</span>
            <span className="ml-2 text-[var(--text-primary)]">{ticket.updated}</span>
          </div>
        </div>
      </div>

      <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <GitBranch className="w-5 h-5 text-[var(--text-secondary)]" />
              分诊与派单
            </h2>
            <p className="text-sm text-[var(--text-secondary)]">结构化记录平台、范围、约束、交付物和验收标准。</p>
          </div>
          <button
            type="button"
            onClick={handleSaveTriage}
            disabled={triageSaving}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent-primary)] text-[var(--bg-primary)] font-bold rounded-lg hover:bg-[var(--accent-primary)]/80 transition-all disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            {triageSaving ? '保存中...' : '保存分诊'}
          </button>
        </div>

        {triageFeedback && (
          <div
            role="alert"
            className={`px-3 py-2 rounded-lg text-sm ${
              triageFeedback.type === 'success'
                ? 'bg-green-500/20 text-green-400 border border-green-500/50'
                : 'bg-red-500/20 text-red-400 border border-red-500/50'
            }`}
          >
            {triageFeedback.message}
          </div>
        )}

        <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
          <div className="font-medium">当前路由</div>
          <div className="mt-1">
            状态 <span className="font-mono">{ticket.status}</span>
            {' '}→ 下一步责任人 <span className="font-mono">{ticket.next_actor || '—'}</span>
            {ticket.next_actor_source ? (
              <span className="text-cyan-200/80">（来源：{ticket.next_actor_source}）</span>
            ) : (
              <span className="text-cyan-200/80">（当前无可通知对象）</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="space-y-2">
            <span className="block text-sm font-medium text-[var(--text-secondary)]">当前状态</span>
            <select
              aria-label="当前状态"
              value={triageForm.status}
              onChange={handleTriageFieldChange('status')}
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)]"
            >
              {STATUS_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>

          <label className="space-y-2">
            <span className="block text-sm font-medium text-[var(--text-secondary)]">分诊负责人</span>
            <input
              aria-label="分诊负责人"
              value={triageForm.triage_owner}
              onChange={handleTriageFieldChange('triage_owner')}
              placeholder="例如 leoss"
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)]"
            />
          </label>

          <label className="space-y-2">
            <span className="block text-sm font-medium text-[var(--text-secondary)]">Review 负责人</span>
            <input
              aria-label="Review 负责人"
              value={triageForm.review_owner}
              onChange={handleTriageFieldChange('review_owner')}
              placeholder="默认同分诊负责人"
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)]"
            />
          </label>

          <label className="space-y-2">
            <span className="block text-sm font-medium text-[var(--text-secondary)]">决策负责人</span>
            <input
              aria-label="决策负责人"
              value={triageForm.decision_owner}
              onChange={handleTriageFieldChange('decision_owner')}
              placeholder="默认老大"
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)]"
            />
          </label>

          <label className="space-y-2">
            <span className="block text-sm font-medium text-[var(--text-secondary)]">指派给</span>
            <select
              aria-label="指派给"
              value={triageForm.assigned_agent}
              onChange={handleTriageFieldChange('assigned_agent')}
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)]"
            >
              {ASSIGNED_AGENT_OPTIONS.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
            </select>
          </label>

          <label className="space-y-2">
            <span className="block text-sm font-medium text-[var(--text-secondary)]">手动下一步责任人（可选）</span>
            <input
              aria-label="手动下一步责任人"
              value={triageForm.next_actor_override}
              onChange={handleTriageFieldChange('next_actor_override')}
              placeholder="blocked / review / failed 时可覆盖默认路由"
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)]"
            />
          </label>

          <label className="space-y-2">
            <span className="block text-sm font-medium text-[var(--text-secondary)]">父工单 ID（可选）</span>
            <input
              aria-label="父工单 ID"
              value={triageForm.parent_ticket_id}
              onChange={handleTriageFieldChange('parent_ticket_id')}
              placeholder="例如 12"
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)]"
            />
          </label>

          <label className="space-y-2">
            <span className="block text-sm font-medium text-[var(--text-secondary)]">平台归属</span>
            <select
              aria-label="平台归属"
              value={triageForm.platform}
              onChange={handleTriageFieldChange('platform')}
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)]"
            >
              <option value="">未设置</option>
              {PLATFORM_OPTIONS.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
            </select>
          </label>

          <label className="space-y-2">
            <span className="block text-sm font-medium text-[var(--text-secondary)]">需求类型</span>
            <select
              aria-label="需求类型"
              value={triageForm.request_type}
              onChange={handleTriageFieldChange('request_type')}
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)]"
            >
              <option value="">未设置</option>
              {REQUEST_TYPE_OPTIONS.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <label className="space-y-2">
            <span className="block text-sm font-medium text-[var(--text-secondary)]">分诊结论</span>
            <textarea
              aria-label="分诊结论"
              rows="3"
              value={triageForm.triage_summary}
              onChange={handleTriageFieldChange('triage_summary')}
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)]"
            />
          </label>
          <label className="space-y-2">
            <span className="block text-sm font-medium text-[var(--text-secondary)]">决策摘要（pending_decision 时填写）</span>
            <textarea
              aria-label="决策摘要"
              rows="2"
              value={triageForm.decision_summary}
              onChange={handleTriageFieldChange('decision_summary')}
              placeholder="需要老大决策的问题摘要"
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)]"
            />
          </label>
          <label className="space-y-2">
            <span className="block text-sm font-medium text-[var(--text-secondary)]">决策上下文（可选）</span>
            <textarea
              aria-label="决策上下文"
              rows="2"
              value={triageForm.decision_context}
              onChange={handleTriageFieldChange('decision_context')}
              placeholder="决策相关背景信息"
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)]"
            />
          </label>
          <label className="space-y-2">
            <span className="block text-sm font-medium text-[var(--text-secondary)]">实施范围</span>
            <textarea
              aria-label="实施范围"
              rows="3"
              value={triageForm.implementation_scope}
              onChange={handleTriageFieldChange('implementation_scope')}
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)]"
            />
          </label>
          <label className="space-y-2">
            <span className="block text-sm font-medium text-[var(--text-secondary)]">约束条件</span>
            <textarea
              aria-label="约束条件"
              rows="3"
              value={triageForm.constraints}
              onChange={handleTriageFieldChange('constraints')}
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)]"
            />
          </label>
          <label className="space-y-2">
            <span className="block text-sm font-medium text-[var(--text-secondary)]">交付物</span>
            <textarea
              aria-label="交付物"
              rows="3"
              value={triageForm.deliverables}
              onChange={handleTriageFieldChange('deliverables')}
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)]"
            />
          </label>
          <label className="space-y-2">
            <span className="block text-sm font-medium text-[var(--text-secondary)]">验收标准</span>
            <textarea
              aria-label="验收标准"
              rows="3"
              value={triageForm.acceptance_criteria}
              onChange={handleTriageFieldChange('acceptance_criteria')}
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)]"
            />
          </label>
        </div>

        {(ticket.parent_ticket || (ticket.child_tickets || []).length > 0) && (
          <div className="pt-4 border-t border-[var(--border-color)] space-y-3">
            {ticket.parent_ticket && (
              <div className="text-sm text-[var(--text-primary)]">
                <span className="text-[var(--text-secondary)]">父工单：</span>
                <Link to={`/tickets/${ticket.parent_ticket.id}`} className="text-[var(--accent-primary)] hover:underline">
                  #{ticket.parent_ticket.id} {ticket.parent_ticket.title}
                </Link>
              </div>
            )}
            {(ticket.child_tickets || []).length > 0 && (
              <div>
                <div className="text-sm text-[var(--text-secondary)] mb-2">子工单</div>
                <div className="flex flex-wrap gap-2">
                  {ticket.child_tickets.map((child) => (
                    <Link
                      key={child.id}
                      to={`/tickets/${child.id}`}
                      className="px-3 py-1 text-xs rounded border border-amber-500/40 text-amber-300 bg-amber-500/10 hover:bg-amber-500/20"
                    >
                      #{child.id} {child.title}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6">
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Description</h2>
        <p className="text-[var(--text-primary)] whitespace-pre-wrap">{ticket.description}</p>
      </div>

      {(ticket.attachments || []).length > 0 && (
        <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6">
          <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4 flex items-center">
            <Paperclip className="w-5 h-5 mr-2 text-[var(--text-secondary)]" />
            Attachments
          </h2>
          <div className="space-y-2">
            {(ticket.attachments || []).map((attachment) => (
              <div key={attachment.id} className="flex items-center justify-between p-3 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-md hover:border-[var(--accent-primary)] transition-colors">
                <div className="flex items-center">
                  <Paperclip className="w-4 h-4 text-[var(--text-secondary)] mr-2" />
                  <span className="text-sm font-medium text-[var(--text-primary)]">{attachment.name}</span>
                  <span className="ml-2 text-xs text-[var(--text-secondary)]">({attachment.size})</span>
                </div>
                <button className="text-sm text-[var(--accent-primary)] hover:underline">Download</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold text-[var(--text-primary)] flex items-center">
            <MessageSquare className="w-5 h-5 mr-2 text-[var(--text-secondary)]" />
            Comments ({filteredComments.length}/{comments.length})
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="px-2 py-1 text-sm bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded text-[var(--text-primary)]"
            >
              <option value="all">All Type</option>
              {COMMENT_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select
              value={filterVisibility}
              onChange={(e) => setFilterVisibility(e.target.value)}
              className="px-2 py-1 text-sm bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded text-[var(--text-primary)]"
            >
              <option value="all">All Visibility</option>
              {VISIBILITY_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <input
              value={filterThreadId}
              onChange={(e) => setFilterThreadId(e.target.value)}
              placeholder="Thread filter"
              className="px-2 py-1 text-sm bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded text-[var(--text-primary)] placeholder-[var(--text-secondary)]"
            />
          </div>
        </div>

        <div className="space-y-4">
          {filteredComments.length === 0 && (
            <div className="px-3 py-6 text-sm text-center text-[var(--text-secondary)] border border-dashed border-[var(--border-color)] rounded-lg">
              暂无符合筛选条件的评论
            </div>
          )}
          {filteredComments.map((comment) => {
            const isSystem = String(comment.author || '').toLowerCase() === 'system';
            return (
              <div
                key={comment.id}
                className={`pl-4 py-3 rounded-r-lg border-l-4 ${
                  isSystem
                    ? 'border-slate-500/40 bg-slate-500/5'
                    : 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/8'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between mb-2 gap-2">
                  <div className="flex items-center gap-2">
                    <span className={`font-medium ${isSystem ? 'text-slate-400' : 'text-[var(--accent-primary)]'}`}>
                      {comment.author}
                    </span>
                    <span className="px-2 py-0.5 text-xs rounded border border-cyan-500/40 text-cyan-300">{comment.type || 'progress'}</span>
                    <span className="px-2 py-0.5 text-xs rounded border border-fuchsia-500/40 text-fuchsia-300">{comment.visibility || 'internal'}</span>
                    {comment.thread_id && (
                      <span className="px-2 py-0.5 text-xs rounded border border-amber-500/40 text-amber-300">thread:{comment.thread_id}</span>
                    )}
                  </div>
                  <span className="text-xs text-[var(--text-secondary)] font-mono">{comment.timestamp}</span>
                </div>
                <p className={`whitespace-pre-wrap leading-relaxed ${isSystem ? 'text-slate-300' : 'text-[var(--text-primary)]'}`}>
                  {comment.content}
                </p>
                {Array.isArray(comment.mentions) && comment.mentions.length > 0 && (
                  <p className="mt-2 text-xs text-[var(--text-secondary)]">Mentions: @{comment.mentions.join(' @')}</p>
                )}
                {Array.isArray(comment.notify_targets) && comment.notify_targets.length > 0 && (
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">Notify: @{comment.notify_targets.join(' @')}</p>
                )}
              </div>
            );
          })}
        </div>

        <form className="mt-6 pt-6 border-t border-[var(--border-color)]" onSubmit={handleSubmitComment}>
          {submitFeedback && (
            <div
              role="alert"
              className={`mb-3 px-3 py-2 rounded-lg text-sm ${
                submitFeedback.type === 'success'
                  ? 'bg-green-500/20 text-green-400 border border-green-500/50'
                  : 'bg-red-500/20 text-red-400 border border-red-500/50'
              }`}
            >
              {submitFeedback.message}
            </div>
          )}

          <div className="flex flex-wrap gap-2 mb-2">
            <button
              type="button"
              onClick={() => applyTemplate('start')}
              disabled={isSubmitting}
              className="px-3 py-1.5 text-xs rounded border border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
            >
              模板：开始
            </button>
            <button
              type="button"
              onClick={() => applyTemplate('progress')}
              disabled={isSubmitting}
              className="px-3 py-1.5 text-xs rounded border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-50"
            >
              模板：进展
            </button>
            <button
              type="button"
              onClick={() => applyTemplate('result')}
              disabled={isSubmitting}
              className="px-3 py-1.5 text-xs rounded border border-fuchsia-500/50 text-fuchsia-300 hover:bg-fuchsia-500/10 disabled:opacity-50"
            >
              模板：结果
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-2">
            <select
              value={commentType}
              onChange={(e) => setCommentType(e.target.value)}
              disabled={isSubmitting}
              className="px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)]"
            >
              {COMMENT_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select
              value={commentVisibility}
              onChange={(e) => setCommentVisibility(e.target.value)}
              disabled={isSubmitting}
              className="px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)]"
            >
              {VISIBILITY_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <input
              value={commentThreadId}
              onChange={(e) => setCommentThreadId(e.target.value)}
              placeholder="Thread ID (optional)"
              disabled={isSubmitting}
              className="px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)]"
            />
            <input
              value={commentMentions}
              onChange={(e) => setCommentMentions(e.target.value)}
              placeholder="Mentions: ops,qa"
              disabled={isSubmitting}
              className="px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)]"
            />
          </div>

          <textarea
            rows="4"
            value={commentInput}
            onChange={(e) => setCommentInput(e.target.value)}
            placeholder="Add a comment..."
            disabled={isSubmitting}
            className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:border-[var(--accent-primary)] focus:outline-none transition-colors"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="submit"
              disabled={isSubmitting || !commentInput.trim()}
              className="px-4 py-2 bg-[var(--accent-primary)] text-[var(--bg-primary)] font-bold rounded-lg hover:bg-[var(--accent-primary)]/80 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Submitting...' : 'Post Comment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default TicketDetail;
