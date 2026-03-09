import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getTicket, getTicketActions, transitionTicket, addComment, fetchTicketDependencies, addTicketDependency, removeTicketDependency } from '../api/tickets';

const ACTION_LABELS = {
  start_work: '🚀 开工',
  submit_for_review: '✅ 提交验收',
  request_decision: '🤔 请求决策',
  approve: '👍 通过关单',
  reject: '👎 打回重做',
  block: '🚫 标记阻塞',
  unblock: '🔓 解除阻塞',
  fail: '❌ 标记失败',
  resume_from_decision: '▶️ 恢复执行',
};

const ACTION_COLORS = {
  start_work: 'bg-blue-500 hover:bg-blue-600',
  submit_for_review: 'bg-green-500 hover:bg-green-600',
  request_decision: 'bg-yellow-500 hover:bg-yellow-600',
  approve: 'bg-green-600 hover:bg-green-700',
  reject: 'bg-red-500 hover:bg-red-600',
  block: 'bg-gray-500 hover:bg-gray-600',
  unblock: 'bg-blue-400 hover:bg-blue-500',
  fail: 'bg-red-600 hover:bg-red-700',
  resume_from_decision: 'bg-blue-500 hover:bg-blue-600',
};

function TicketDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [ticket, setTicket] = useState(null);
  const [availableActions, setAvailableActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  
  // Action modal state
  const [showActionModal, setShowActionModal] = useState(false);
  const [selectedAction, setSelectedAction] = useState(null);
  const [actionFields, setActionFields] = useState({});

  // Dependencies state
  const [dependencies, setDependencies] = useState([]);
  const [dependents, setDependents] = useState([]);
  const [showAddDependency, setShowAddDependency] = useState(false);
  const [newDependencyId, setNewDependencyId] = useState('');

  useEffect(() => {
    loadTicket();
    loadActions();
    loadDependencies();
  }, [id]);

  async function loadTicket() {
    try {
      setLoading(true);
      const data = await getTicket(id);
      setTicket(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadActions() {
    try {
      const data = await getTicketActions(id);
      setAvailableActions(data.available_actions || []);
    } catch (err) {
      console.error('Failed to load actions:', err);
    }
  }

  async function loadDependencies() {
    try {
      const data = await fetchTicketDependencies(id);
      setDependencies(data.dependencies || []);
      setDependents(data.dependents || []);
    } catch (err) {
      console.error('Failed to load dependencies:', err);
    }
  }

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

  async function handleActionClick(action) {
    setSelectedAction(action);
    setActionFields({});
    setShowActionModal(true);
  }

  async function handleActionSubmit() {
    if (!selectedAction) return;

    try {
      setSubmitting(true);
      const payload = {
        action: selectedAction,
        actor: 'leoss', // TODO: 从当前用户获取
        ...actionFields,
      };

      const result = await transitionTicket(id, payload);
      
      if (result.success) {
        setShowActionModal(false);
        setSelectedAction(null);
        setActionFields({});
        await loadTicket();
        await loadActions();
      } else {
        alert(`操作失败: ${result.error || '未知错误'}`);
      }
    } catch (err) {
      alert(`操作失败: ${err.message}`);
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
        author: 'Current User',
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

  function getRequiredFields(action) {
    const fields = {
      submit_for_review: ['result_summary'],
      request_decision: ['decision_summary', 'decision_context'],
      reject: ['reject_reason'],
      block: ['blocker_summary'],
      fail: ['error'],
    };
    return fields[action] || [];
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-600">加载中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-red-600">错误: {error}</div>
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-600">工单不存在</div>
      </div>
    );
  }

  const requiredFields = getRequiredFields(selectedAction);

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      {/* Header */}
      <div className="mb-6">
        <button
          onClick={() => navigate('/tickets')}
          className="text-[var(--accent-primary)] hover:text-[var(--accent-secondary)] mb-4"
        >
          ← 返回列表
        </button>
        <h1 className="text-3xl font-bold text-[var(--text-primary)]">
          #{ticket.id} {ticket.title}
        </h1>
      </div>

      {/* Status and Actions Bar */}
      <div className="bg-[var(--bg-secondary)] rounded-lg border border-[var(--border-color)] p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <span className="text-sm text-[var(--text-secondary)]">当前状态:</span>
            <span className={`ml-2 px-3 py-1 rounded-full text-sm font-medium ${
              ticket.status === 'complete' ? 'bg-[var(--success)] bg-opacity-20 text-[var(--success)]' :
              ticket.status === 'running' ? 'bg-[var(--accent-primary)] bg-opacity-20 text-[var(--accent-primary)]' :
              ticket.status === 'blocked' ? 'bg-[var(--danger)] bg-opacity-20 text-[var(--danger)]' :
              'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
            }`}>
              {ticket.status}
            </span>
          </div>
          {ticket.locked_by && (
            <div className="text-sm text-[var(--warning)]">
              🔒 已锁定 by {ticket.locked_by}
            </div>
          )}
        </div>

        {/* Available Actions */}
        {availableActions.length > 0 && (
          <div>
            <div className="text-sm text-[var(--text-secondary)] mb-2">可执行操作:</div>
            <div className="flex flex-wrap gap-2">
              {availableActions.map((action) => (
                <button
                  key={action}
                  onClick={() => handleActionClick(action)}
                  className={`px-4 py-2 rounded-lg text-white font-medium transition-colors ${
                    ACTION_COLORS[action] || 'bg-gray-500 hover:bg-gray-600'
                  }`}
                >
                  {ACTION_LABELS[action] || action}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Ticket Details */}
      <div className="bg-[var(--bg-secondary)] rounded-lg border border-[var(--border-color)] p-6 mb-6">
        <h2 className="text-xl font-semibold mb-4 text-[var(--text-primary)]">工单详情</h2>
        <div className="space-y-3">
          <div>
            <span className="text-[var(--text-secondary)]">描述:</span>
            <p className="mt-1 text-[var(--text-primary)]">{ticket.description || '无'}</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="text-[var(--text-secondary)]">执行人:</span>
              <span className="ml-2 text-[var(--text-primary)]">{ticket.assigned_agent || '未分配'}</span>
            </div>
            <div>
        <span className="text-[var(--text-secondary)]">当前责任人:</span>
              <span className="ml-2 text-[var(--text-primary)]">{ticket.next_actor || '无'}</span>
            </div>
            <div>
              <span className="text-[var(--text-secondary)]">优先级:</span>
              <span className="ml-2 text-[var(--text-primary)]">{ticket.priority || 'medium'}</span>
            </div>
            <div>
              <span className="text-[var(--text-secondary)]">平台:</span>
              <span className="ml-2 text-[var(--text-primary)]">{ticket.platform || '无'}</span>
            </div>
          </div>
          {ticket.result_summary && (
            <div>
              <span className="text-[var(--text-secondary)]">结果摘要:</span>
              <p className="mt-1 text-[var(--text-primary)]">{ticket.result_summary}</p>
            </div>
          )}
          {ticket.decision_summary && (
            <div>
              <span className="text-[var(--text-secondary)]">决策摘要:</span>
              <p className="mt-1 text-[var(--text-primary)]">{ticket.decision_summary}</p>
            </div>
          )}
        </div>
      </div>

      {/* Dependencies */}
      <div className="bg-[var(--bg-secondary)] rounded-lg border border-[var(--border-color)] p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-[var(--text-primary)]">依赖关系</h2>
          <button
            onClick={() => setShowAddDependency(!showAddDependency)}
            className="px-3 py-1 bg-[var(--accent-primary)] text-[var(--bg-primary)] text-sm rounded hover:bg-[var(--accent-secondary)]"
          >
            {showAddDependency ? '取消' : '+ 添加依赖'}
          </button>
        </div>

        {/* Add Dependency Form */}
        {showAddDependency && (
          <div className="mb-4 p-4 bg-[var(--bg-tertiary)] rounded-lg">
            <div className="flex gap-2">
              <input
                type="number"
                value={newDependencyId}
                onChange={(e) => setNewDependencyId(e.target.value)}
                placeholder="输入依赖的工单 ID"
                className="flex-1 px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
              />
              <button
                onClick={handleAddDependency}
                disabled={submitting || !newDependencyId}
                className="px-4 py-2 bg-[var(--success)] text-white rounded-lg hover:opacity-80 disabled:bg-[var(--border-color)] disabled:cursor-not-allowed"
              >
                {submitting ? '添加中...' : '确认'}
              </button>
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-2">
              添加后，本工单将依赖指定工单完成后才能开始执行
            </p>
          </div>
        )}

        <div className="space-y-4">
          {/* Dependencies (本工单依赖的其他工单) */}
          <div>
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-2">
              🔗 本工单依赖 ({dependencies.length})
            </h3>
            {dependencies.length > 0 ? (
              <div className="space-y-2">
                {dependencies.map((dep) => (
                  <div
                    key={dep.id}
                    className="flex items-center justify-between p-3 bg-[var(--bg-tertiary)] rounded-lg"
                  >
                    <div className="flex-1">
                      <button
                        onClick={() => navigate(`/tickets/${dep.depends_on_ticket_id}`)}
                        className="text-[var(--accent-primary)] hover:text-[var(--accent-secondary)] font-medium"
                      >
                        #{dep.depends_on_ticket_id}
                      </button>
                      <span className="ml-2 text-sm text-[var(--text-secondary)]">
                        ({dep.dependency_type || 'blocks'})
                      </span>
                    </div>
                    <button
                      onClick={() => handleRemoveDependency(dep.depends_on_ticket_id)}
                      disabled={submitting}
                      className="text-[var(--danger)] hover:opacity-80 text-sm disabled:text-[var(--text-secondary)]"
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

          {/* Dependents (依赖本工单的其他工单) */}
          <div>
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-2">
              ⬅️ 被依赖 ({dependents.length})
            </h3>
            {dependents.length > 0 ? (
              <div className="space-y-2">
                {dependents.map((dep) => (
                  <div
                    key={dep.id}
                    className="flex items-center p-3 bg-[var(--bg-tertiary)] rounded-lg"
                  >
                    <button
                      onClick={() => navigate(`/tickets/${dep.ticket_id}`)}
                      className="text-[var(--accent-primary)] hover:text-[var(--accent-secondary)] font-medium"
                    >
                      #{dep.ticket_id}
                    </button>
                    <span className="ml-2 text-sm text-[var(--text-secondary)]">
                      依赖本工单 ({dep.dependency_type || 'blocks'})
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-[var(--text-secondary)]">无工单依赖本工单</p>
            )}
          </div>
        </div>
      </div>

      {/* Comments */}
      <div className="bg-[var(--bg-secondary)] rounded-lg border border-[var(--border-color)] p-6">
        <h2 className="text-xl font-semibold mb-4 text-[var(--text-primary)]">评论</h2>
        <div className="space-y-4 mb-4">
          {ticket.comments && ticket.comments.length > 0 ? (
            ticket.comments.map((comment) => (
              <div key={comment.id} className="border-l-4 border-[var(--accent-primary)] pl-4 py-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium text-[var(--text-primary)]">{comment.author}</span>
                  <span className="text-sm text-[var(--text-secondary)]">
                    {new Date(comment.timestamp).toLocaleString('zh-CN')}
                  </span>
                </div>
                <p className="text-[var(--text-primary)]">{comment.content}</p>
                {comment.type && (
                  <span className="text-xs text-[var(--text-secondary)] mt-1">类型: {comment.type}</span>
                )}
              </div>
            ))
          ) : (
            <p className="text-[var(--text-secondary)]">暂无评论</p>
          )}
        </div>

        {/* Add Comment */}
        <div className="border-t border-[var(--border-color)] pt-4">
          <textarea
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="添加评论..."
            className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
            rows="3"
          />
          <button
            onClick={handleAddComment}
            disabled={submitting || !commentText.trim()}
            className="mt-2 px-4 py-2 bg-[var(--accent-primary)] text-[var(--bg-primary)] rounded-lg hover:bg-[var(--accent-secondary)] disabled:bg-[var(--border-color)] disabled:cursor-not-allowed"
          >
            {submitting ? '提交中...' : '添加评论'}
          </button>
        </div>
      </div>

      {/* Action Modal */}
      {showActionModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-xl font-semibold mb-4 text-[var(--text-primary)]">
              {ACTION_LABELS[selectedAction] || selectedAction}
            </h3>
            
            <div className="space-y-4">
              {/* Comment field (always shown) */}
              <div>
                <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">
                  评论
                </label>
                <textarea
                  value={actionFields.comment || ''}
                  onChange={(e) => setActionFields({ ...actionFields, comment: e.target.value })}
                  className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                  rows="3"
                  placeholder="描述此操作..."
                />
              </div>

              {/* Required fields */}
              {requiredFields.includes('result_summary') && (
                <div>
                  <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">
                    结果摘要 <span className="text-[var(--danger)]">*</span>
                  </label>
                  <textarea
                    value={actionFields.result_summary || ''}
                    onChange={(e) => setActionFields({ ...actionFields, result_summary: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    rows="2"
                    required
                  />
                </div>
              )}

              {requiredFields.includes('decision_summary') && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">
                      决策摘要 <span className="text-[var(--danger)]">*</span>
                    </label>
                    <textarea
                      value={actionFields.decision_summary || ''}
                      onChange={(e) => setActionFields({ ...actionFields, decision_summary: e.target.value })}
                      className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                      rows="2"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">
                      决策上下文
                    </label>
                    <textarea
                      value={actionFields.decision_context || ''}
                      onChange={(e) => setActionFields({ ...actionFields, decision_context: e.target.value })}
                      className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                      rows="2"
                    />
                  </div>
                </>
              )}

              {requiredFields.includes('reject_reason') && (
                <div>
                  <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">
                    打回原因 <span className="text-[var(--danger)]">*</span>
                  </label>
                  <textarea
                    value={actionFields.reject_reason || ''}
                    onChange={(e) => setActionFields({ ...actionFields, reject_reason: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    rows="2"
                    required
                  />
                </div>
              )}

              {requiredFields.includes('blocker_summary') && (
                <div>
                  <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">
                    阻塞原因 <span className="text-[var(--danger)]">*</span>
                  </label>
                  <textarea
                    value={actionFields.blocker_summary || ''}
                    onChange={(e) => setActionFields({ ...actionFields, blocker_summary: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    rows="2"
                    required
                  />
                </div>
              )}

              {requiredFields.includes('error') && (
                <div>
                  <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">
                    错误信息 <span className="text-[var(--danger)]">*</span>
                  </label>
                  <textarea
                    value={actionFields.error || ''}
                    onChange={(e) => setActionFields({ ...actionFields, error: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    rows="2"
                    required
                  />
                </div>
              )}
            </div>

            <div className="flex gap-2 mt-6">
              <button
                onClick={handleActionSubmit}
                disabled={submitting || requiredFields.some(f => !actionFields[f])}
                className="flex-1 px-4 py-2 bg-[var(--accent-primary)] text-[var(--bg-primary)] rounded-lg hover:bg-[var(--accent-secondary)] disabled:bg-[var(--border-color)] disabled:cursor-not-allowed"
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
                className="flex-1 px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg hover:bg-[var(--border-color)] disabled:cursor-not-allowed"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default TicketDetail;
