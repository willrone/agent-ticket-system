import { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchTickets, transitionTicket } from '../api/tickets';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import { KANBAN_COLUMNS, getStatusLabel, resolveActionActor } from '../../workflow-schema.js';
import { groupTicketsByStatus, buildTicketViewModel } from '../../ticket-selectors.js';

const COLUMNS = KANBAN_COLUMNS.map((column) => ({ id: column.id, label: column.label, color: column.color }));

const DRAG_TRANSITIONS = {
  'queued->running': { action: 'start_work' },
  'running->done': { action: 'submit_for_review', extra: { result_summary: 'Kanban 拖拽提交验收' } },
  'done->complete': { action: 'approve' },
  'review->complete': { action: 'approve' },
  'blocked->queued': { action: 'unblock' },
  'pending_decision->queued': { action: 'resume_from_decision' },
  'queued->paused': { action: 'pause', extra: { pause_reason: 'Kanban 拖拽暂时挂起' } },
  'running->paused': { action: 'pause', extra: { pause_reason: 'Kanban 拖拽暂时挂起' } },
  'running->queued': { action: 'reset_to_queued', extra: { reason: 'Kanban 拖拽撤销误触开工' } },
  'paused->queued': { action: 'reset_to_queued', extra: { reason: 'Kanban 拖拽撤销误触开工' } },
  'paused->running': { action: 'resume' },
  'paused->done': { action: 'resume' },
  'paused->review': { action: 'resume' },
};

function KanbanBoard() {
  const navigate = useNavigate();
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draggedTicket, setDraggedTicket] = useState(null);
  const [dragOverColumn, setDragOverColumn] = useState(null);

  useEffect(() => {
    loadTickets();
  }, []);

  async function loadTickets() {
    try {
      setLoading(true);
      setError('');
      const data = await fetchTickets();
      const rawTickets = Array.isArray(data) ? data : (Array.isArray(data?.tickets) ? data.tickets : []);
      setTickets(rawTickets.map((t) => buildTicketViewModel(t)));
    } catch (err) {
      console.error('Failed to load tickets:', err);
      setError(err?.message || '工单加载失败');
    } finally {
      setLoading(false);
    }
  }

  const ticketsByStatus = useMemo(
    () => groupTicketsByStatus(tickets),
    [tickets]
  );

  function handleDragStart(e, ticket) {
    setDraggedTicket(ticket);
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragOver(e, columnId) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverColumn(columnId);
  }

  function handleDragLeave() {
    setDragOverColumn(null);
  }

  async function handleDrop(e, targetStatus) {
    e.preventDefault();
    setDragOverColumn(null);

    if (!draggedTicket || draggedTicket.status === targetStatus) {
      setDraggedTicket(null);
      return;
    }

    const transitionKey = `${draggedTicket.status}->${targetStatus}`;
    const transition = DRAG_TRANSITIONS[transitionKey];
    if (!transition) {
      alert(`当前不支持从 ${getStatusLabel(draggedTicket.status) || draggedTicket.status} 拖到 ${getStatusLabel(targetStatus) || targetStatus}。请去详情页执行需要补充字段的操作。`);
      setDraggedTicket(null);
      return;
    }

    try {
      const payload = {
        action: transition.action,
        actor: resolveActionActor(draggedTicket, transition.action),
        comment: `Kanban 拖拽：${draggedTicket.status} → ${targetStatus}`,
        ...(transition.extra || {}),
      };

      const result = await transitionTicket(draggedTicket.id, payload);
      if (result.success) {
        await loadTickets();
      } else {
        alert(`转换失败: ${result.error}`);
      }
    } catch (err) {
      alert(`转换失败: ${err.message}`);
    } finally {
      setDraggedTicket(null);
    }
  }

  if (loading) {
    return <LoadingState title="Kanban 加载中" description="正在拉取真实工单状态" />;
  }

  if (error) {
    return <ErrorState title="Kanban 加载失败" message={error} onRetry={loadTickets} />;
  }

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-[var(--text-primary)]">工单看板</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">按真实状态分列；不再把 done/review/complete 混成“已完成”。</p>
        </div>
        <button
          onClick={() => navigate('/tickets')}
          className="px-4 py-2 bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border-color)] rounded-lg hover:bg-[var(--bg-tertiary)]"
        >
          切换到列表视图
        </button>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-4">
        {COLUMNS.map((column) => {
          const columnTickets = ticketsByStatus[column.id] || [];
          const isDragOver = dragOverColumn === column.id;

          return (
            <div
              key={column.id}
              className={`flex-shrink-0 w-80 ${column.color} rounded-lg border-2 p-4 transition-all ${
                isDragOver ? 'ring-4 ring-[var(--accent-primary)] scale-105' : ''
              }`}
              onDragOver={(e) => handleDragOver(e, column.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, column.id)}
            >
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-semibold text-[var(--text-primary)]">{column.label}</h2>
                  <p className="text-xs text-[var(--text-secondary)] font-mono">{column.id}</p>
                </div>
                <span className="px-2 py-1 bg-[var(--bg-tertiary)] rounded-full text-sm font-medium text-[var(--text-primary)]">
                  {columnTickets.length}
                </span>
              </div>

              <div className="space-y-3 min-h-[200px]">
                {columnTickets.map((ticket) => (
                  <div
                    key={ticket.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, ticket)}
                    onClick={() => navigate(`/tickets/${ticket.id}`)}
                    className={`bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg p-4 cursor-move hover:border-[var(--accent-primary)] transition-all ${
                      draggedTicket?.id === ticket.id ? 'opacity-50' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <span className="text-sm font-medium text-[var(--text-secondary)]">#{ticket.id}</span>
                      {ticket.locked_by && <span className="text-xs text-[var(--warning)]">🔒</span>}
                    </div>
                    <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2 line-clamp-2">{ticket.title}</h3>
                    <div className="space-y-1 text-xs text-[var(--text-secondary)]">
                      <div className="flex items-center justify-between">
                        <span>执行人</span>
                        <span>{ticket.assigned_agent || '未分配'}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>当前责任人</span>
                        <span>{ticket.current_actor || ticket.next_actor || '无'}</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mt-3">
                      {ticket.priority && (
                        <span className={`px-2 py-1 rounded ${
                          ticket.priority === 'high' ? 'bg-[var(--danger)] bg-opacity-20 text-[var(--danger)]' :
                          ticket.priority === 'medium' ? 'bg-[var(--warning)] bg-opacity-20 text-[var(--warning)]' :
                          'bg-[var(--bg-secondary)] text-[var(--text-secondary)]'
                        }`}>
                          {ticket.priority}
                        </span>
                      )}
                      <span className="font-mono">{ticket.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="p-4 bg-[var(--bg-secondary)] rounded-lg border border-[var(--accent-primary)]">
        <h3 className="font-semibold text-[var(--accent-primary)] mb-2">💡 使用提示</h3>
        <ul className="text-sm text-[var(--text-secondary)] space-y-1">
          <li>• 看板严格按真实状态分列：done=待验收，review=审核中，paused=暂时挂起，complete=已关单。</li>
          <li>• 仅支持无需额外填写字段的拖拽流转；需要补充原因/摘要时请进入详情页操作。</li>
          <li>• 点击卡片查看详情；🔒 表示工单已锁定。</li>
        </ul>
      </div>
    </div>
  );
}

export default KanbanBoard;
