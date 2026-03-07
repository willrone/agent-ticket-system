import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Clock, User, Tag, MessageSquare, Paperclip } from 'lucide-react';
import { fetchTicketDetail, fetchTicketComments, submitComment } from '../api/tickets';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import { COMMENT_TYPES as COMMENT_TYPE_OPTIONS, COMMENT_VISIBILITY as VISIBILITY_OPTIONS } from '../../constants/comments.js';

const TicketDetail = () => {
  const { id } = useParams();
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [commentInput, setCommentInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitFeedback, setSubmitFeedback] = useState(null); // { type: 'success'|'error', message }

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
        <div className="flex justify-between items-start mb-4">
          <div>
            <h1 className="text-3xl font-bold text-[var(--text-primary)] mb-2">
              #{ticket.id} {ticket.title}
            </h1>
            <div className="flex gap-2">
              <span className={`px-3 py-1 inline-flex text-xs leading-5 font-semibold rounded border ${getStatusColor(ticket.status)}`}>
                {ticket.status}
              </span>
              <span className={`px-3 py-1 inline-flex text-xs leading-5 font-semibold rounded border ${getPriorityColor(ticket.priority)}`}>
                {ticket.priority}
              </span>
            </div>
          </div>
          <button className="px-4 py-2 bg-[var(--accent-primary)] text-[var(--bg-primary)] font-bold rounded-lg hover:bg-[var(--accent-primary)]/80 transition-all">
            Edit Ticket
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-[var(--border-color)]">
          <div className="flex items-center text-sm">
            <User className="w-5 h-5 text-[var(--text-secondary)] mr-2" />
            <span className="text-[var(--text-secondary)]">Assignee:</span>
            <span className="ml-2 font-medium text-[var(--text-primary)]">{ticket.assignee}</span>
          </div>
          <div className="flex items-center text-sm">
            <User className="w-5 h-5 text-[var(--text-secondary)] mr-2" />
            <span className="text-[var(--text-secondary)]">Reporter:</span>
            <span className="ml-2 font-medium text-[var(--text-primary)]">{ticket.reporter}</span>
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

        <div className="flex items-center gap-2 pt-4 border-t border-[var(--border-color)] mt-4">
          <Tag className="w-5 h-5 text-[var(--text-secondary)]" />
          {(ticket.tags || []).map((tag) => (
            <span key={tag} className="px-2 py-1 bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-xs rounded border border-[var(--border-color)]">
              {tag}
            </span>
          ))}
        </div>
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
