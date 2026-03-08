import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchTickets, transitionTicket } from '../api/tickets';

const COLUMNS = [
  { id: 'triage', label: '待分诊', color: 'bg-violet-100 border-violet-300' },
  { id: 'queued', label: '待处理', color: 'bg-blue-100 border-blue-300' },
  { id: 'running', label: '进行中', color: 'bg-yellow-100 border-yellow-300' },
  { id: 'review', label: '待验收', color: 'bg-cyan-100 border-cyan-300' },
  { id: 'done', label: '已完成', color: 'bg-green-100 border-green-300' },
  { id: 'blocked', label: '阻塞', color: 'bg-red-100 border-red-300' },
  { id: 'complete', label: '已关单', color: 'bg-emerald-100 border-emerald-300' },
];

const STATUS_TRANSITIONS = {
  triage: ['queued'],
  queued: ['running'],
  running: ['done', 'blocked', 'pending_decision'],
  review: ['complete', 'queued'],
  done: ['complete', 'queued'],
  blocked: ['queued'],
  pending_decision: ['queued'],
};

function KanbanBoard() {
  const navigate = useNavigate();
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draggedTicket, setDraggedTicket] = useState(null);
  const [dragOverColumn, setDragOverColumn] = useState(null);

  useEffect(() => {
    loadTickets();
  }, []);

  async function loadTickets() {
    try {
      setLoading(true);
      const data = await fetchTickets();
      setTickets(data);
    } catch (err) {
      console.error('Failed to load tickets:', err);
    } finally {
      setLoading(false);
    }
  }

  function getTicketsByStatus(status) {
    return tickets.filter(t => t.status === status);
  }

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

    // 检查是否允许此转换
    const allowedTransitions = STATUS_TRANSITIONS[draggedTicket.status] || [];
    if (!allowedTransitions.includes(targetStatus)) {
      alert(`不能从 ${draggedTicket.status} 直接拖到 ${targetStatus}`);
      setDraggedTicket(null);
      return;
    }

    // 确定 action
    const action = getActionForTransition(draggedTicket.status, targetStatus);
    if (!action) {
      alert('无法确定转换操作');
      setDraggedTicket(null);
      return;
    }

    try {
      const result = await transitionTicket(draggedTicket.id, {
        action,
        actor: 'leoss', // TODO: 从当前用户获取
        comment: `拖拽: ${draggedTicket.status} → ${targetStatus}`,
      });

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

  function getActionForTransition(from, to) {
    const map = {
      'queued->running': 'start_work',
      'running->done': 'submit_for_review',
      'done->complete': 'approve',
      'done->queued': 'reject',
      'review->complete': 'approve',
      'review->queued': 'reject',
      'running->blocked': 'block',
      'blocked->queued': 'unblock',
      'pending_decision->queued': 'resume_from_decision',
    };
    return map[`${from}->${to}`];
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-600">加载中...</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-gray-900">工单看板</h1>
        <button
          onClick={() => navigate('/tickets')}
          className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300"
        >
          切换到列表视图
        </button>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-4">
        {COLUMNS.map((column) => {
          const columnTickets = getTicketsByStatus(column.id);
          const isDragOver = dragOverColumn === column.id;

          return (
            <div
              key={column.id}
              className={`flex-shrink-0 w-80 ${column.color} rounded-lg border-2 p-4 transition-all ${
                isDragOver ? 'ring-4 ring-blue-400 scale-105' : ''
              }`}
              onDragOver={(e) => handleDragOver(e, column.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, column.id)}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-900">
                  {column.label}
                </h2>
                <span className="px-2 py-1 bg-white rounded-full text-sm font-medium text-gray-700">
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
                    className={`bg-white rounded-lg shadow p-4 cursor-move hover:shadow-lg transition-shadow ${
                      draggedTicket?.id === ticket.id ? 'opacity-50' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <span className="text-sm font-medium text-gray-500">
                        #{ticket.id}
                      </span>
                      {ticket.locked_by && (
                        <span className="text-xs text-orange-600">🔒</span>
                      )}
                    </div>
                    <h3 className="text-sm font-semibold text-gray-900 mb-2 line-clamp-2">
                      {ticket.title}
                    </h3>
                    <div className="flex items-center justify-between text-xs text-gray-600">
                      <span>{ticket.assigned_agent || '未分配'}</span>
                      {ticket.priority && (
                        <span className={`px-2 py-1 rounded ${
                          ticket.priority === 'high' ? 'bg-red-100 text-red-700' :
                          ticket.priority === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                          'bg-gray-100 text-gray-700'
                        }`}>
                          {ticket.priority}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
        <h3 className="font-semibold text-blue-900 mb-2">💡 使用提示</h3>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>• 拖拽工单卡片到目标列即可转换状态</li>
          <li>• 只能拖拽到合法的目标状态</li>
          <li>• 点击卡片查看详情</li>
          <li>• 🔒 表示工单已锁定</li>
        </ul>
      </div>
    </div>
  );
}

export default KanbanBoard;
