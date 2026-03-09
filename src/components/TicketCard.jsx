import { Clock, MessageSquare, User, AlertCircle, CheckCircle, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';

// 状态映射
const statusConfig = {
  triage: { label: '待分诊', className: 'status-triage', icon: AlertCircle },
  queued: { label: '排队中', className: 'status-queued', icon: Clock },
  running: { label: '进行中', className: 'status-running', icon: Zap },
  review: { label: '审核中', className: 'status-review', icon: MessageSquare },
  done: { label: '已完成', className: 'status-done', icon: CheckCircle },
  complete: { label: '已关闭', className: 'status-complete', icon: CheckCircle },
  blocked: { label: '阻塞', className: 'status-blocked', icon: AlertCircle },
  failed: { label: '失败', className: 'status-failed', icon: AlertCircle },
  pending_decision: { label: '待决策', className: 'status-pending_decision', icon: Clock },
};

// 优先级配置
const priorityConfig = {
  high: { label: 'P0', className: 'priority-high' },
  medium: { label: 'P1', className: 'priority-medium' },
  low: { label: 'P2', className: 'priority-low' },
};

// 格式化时间
function formatTime(timestamp) {
  if (!timestamp) return '未知';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;
  
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export default function TicketCard({ ticket }) {
  const status = statusConfig[ticket.status] || statusConfig.triage;
  const StatusIcon = status.icon;
  const priority = priorityConfig[ticket.priority] || priorityConfig.low;
  
  return (
    <Link to={`/tickets/${ticket.id}`} className="block">
      <div className="ticket-item animate-slide-in">
        {/* 头部：标题 + 状态 */}
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-mono text-[var(--text-tertiary)]">
                #{ticket.id}
              </span>
              {ticket.priority && (
                <span className={`text-xs font-bold ${priority.className}`}>
                  {priority.label}
                </span>
              )}
            </div>
            <h3 className="text-base font-semibold text-[var(--text-primary)] truncate">
              {ticket.title}
            </h3>
          </div>
          
          <span className={`status-badge ${status.className} flex-shrink-0`}>
            <StatusIcon className="w-3.5 h-3.5" />
            <span>{status.label}</span>
          </span>
        </div>
        
        {/* 描述 */}
        {ticket.description && (
          <p className="text-sm text-[var(--text-secondary)] line-clamp-2 mb-3">
            {ticket.description}
          </p>
        )}
        
        {/* 底部元信息 */}
        <div className="flex items-center justify-between text-xs text-[var(--text-tertiary)]">
          <div className="flex items-center gap-4">
            {/* 负责人 */}
            {(ticket.assigned_agent || ticket.bot) && (
              <div className="flex items-center gap-1.5">
                <User className="w-3.5 h-3.5" />
                <span>{ticket.assigned_agent || ticket.bot}</span>
              </div>
            )}
            
            {/* 更新时间 */}
            <div className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              <span>{formatTime(ticket.last_update || ticket.created)}</span>
            </div>
            
            {/* 评论数 */}
            {ticket.comments && ticket.comments.length > 0 && (
              <div className="flex items-center gap-1.5">
                <MessageSquare className="w-3.5 h-3.5" />
                <span>{ticket.comments.length}</span>
              </div>
            )}
          </div>
          
          {/* 平台标签 */}
          {ticket.platform && (
            <span className="px-2 py-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] font-mono">
              {ticket.platform}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
