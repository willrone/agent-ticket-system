import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Search, Plus, Activity, TrendingUp, AlertCircle, Clock, CheckCircle, XCircle, Zap, List, Inbox, RefreshCw } from 'lucide-react';
import { fetchTickets, fetchBots, fetchTicketStatus, createTicket } from '../api/tickets';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';

function normalizeTickets(payload) {
  const raw = Array.isArray(payload) ? payload : (payload?.tickets ?? payload?.data ?? []);
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((t) => ({
    id: t.id,
    title: t.title ?? '',
    status: t.status ?? 'queued',
    priority: t.priority ?? 'medium',
    bot: t.bot ?? t.assigned_agent ?? null,
    assigned_agent: t.assigned_agent ?? t.bot ?? null,
    session_key: t.session_key ?? null,
    created: t.created ?? '',
    progress: typeof t.progress === 'number' ? t.progress : 0,
    error: t.error ?? null,
  }));
}

function normalizeBots(payload) {
  const raw = Array.isArray(payload) ? payload : (payload?.bots ?? payload?.data ?? []);
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((b) => ({
    name: b.name ?? '',
    displayName: b.displayName ?? b.name ?? '',
    status: b.status ?? 'idle',
    tokens: b.tokens ?? '0k/0k',
    usage: typeof b.usage === 'number' ? b.usage : 0,
    emoji: b.emoji ?? '🤖',
    currentTask: b.currentTask ?? null,
    queue: Array.isArray(b.queue) ? b.queue : [],
    stats: {
      todayCompleted: b.stats?.todayCompleted ?? 0,
      avgResponseTime: b.stats?.avgResponseTime ?? '—',
      successRate: b.stats?.successRate ?? 0,
      uptime: b.stats?.uptime ?? '—',
    },
    recentTasks: Array.isArray(b.recentTasks) ? b.recentTasks : [],
  }));
}

function truncate(str, len = 12) {
  if (!str) return '—';
  return str.length <= len ? str : str.slice(0, len) + '…';
}

function truncateSessionKey(s, max = 12) {
  if (!s) return '—';
  return s.length <= max ? s : s.slice(0, max) + '…';
}

const Tickets = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedBot, setSelectedBot] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [bots, setBots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshingId, setRefreshingId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createAgent, setCreateAgent] = useState('donky');
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ticketsRes, botsRes] = await Promise.all([
        fetchTickets(),
        fetchBots(),
      ]);
      setTickets(normalizeTickets(ticketsRes));
      setBots(normalizeBots(botsRes));
    } catch (err) {
      setError(err?.message || '加载工单列表失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const stats = useMemo(() => ({
    total: tickets.length,
    open: tickets.filter((t) => t.status === 'queued' || t.status === 'failed').length,
    inProgress: tickets.filter((t) => t.status === 'running').length,
    activeBots: bots.filter((b) => b.status === 'active').length,
  }), [tickets, bots]);

  const getStatusColor = (status) => {
    const colors = {
      queued: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
      running: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
      done: 'bg-green-500/20 text-green-400 border-green-500/50',
      failed: 'bg-red-500/20 text-red-400 border-red-500/50',
      open: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
      'in-progress': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
      resolved: 'bg-green-500/20 text-green-400 border-green-500/50',
      closed: 'bg-gray-500/20 text-gray-400 border-gray-500/50',
    };
    return colors[status] || 'bg-gray-500/20 text-gray-400 border-gray-500/50';
  };

  const getPriorityIcon = (priority) => {
    if (priority === 'critical') return '🔴';
    if (priority === 'high') return '🟠';
    if (priority === 'medium') return '🟡';
    return '⚪';
  };

  const filteredTickets = useMemo(
    () => tickets.filter((ticket) =>
      ticket.title.toLowerCase().includes(searchTerm.toLowerCase())
    ),
    [tickets, searchTerm]
  );

  const handleRefreshStatus = useCallback(async (ticketId) => {
    setRefreshingId(ticketId);
    try {
      const status = await fetchTicketStatus(ticketId);
      setTickets((prev) =>
        prev.map((t) =>
          t.id === ticketId
            ? { ...t, ...status, bot: status.assigned_agent, created: t.created }
            : t
        )
      );
    } catch (err) {
      setError(err?.message || '刷新状态失败，请稍后重试');
    } finally {
      setRefreshingId(null);
    }
  }, []);

  const handleCreateTicket = useCallback(async () => {
    if (!createTitle.trim()) return;
    setCreateLoading(true);
    setCreateError(null);
    try {
      const created = await createTicket({ title: createTitle.trim(), description: createDesc.trim(), agent: createAgent });
      setTickets((prev) => [...prev, ...normalizeTickets([created])]);
      setShowCreate(false);
      setCreateTitle('');
      setCreateDesc('');
      setCreateAgent('donky');
    } catch (err) {
      setCreateError(err?.message || '创建工单失败，请稍后重试');
    } finally {
      setCreateLoading(false);
    }
  }, [createTitle, createDesc, createAgent]);

  if (loading) {
    return (
      <div className="flex gap-6 animate-slide-in">
        <div className="flex-1">
          <LoadingState title="加载工单中..." description="正在获取工单列表与 Bot 状态" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex gap-6 animate-slide-in">
        <div className="flex-1">
          <ErrorState title="加载失败" message={error} onRetry={loadData} />
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Create Ticket Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4">创建新工单</h2>
            
            {createError && (
              <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded text-red-400 text-sm">
                {createError}
              </div>
            )}
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">标题 *</label>
                <input
                  type="text"
                  value={createTitle}
                  onChange={(e) => setCreateTitle(e.target.value)}
                  placeholder="输入工单标题"
                  className="w-full px-4 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:border-[var(--accent-primary)] focus:outline-none"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">描述</label>
                <textarea
                  value={createDesc}
                  onChange={(e) => setCreateDesc(e.target.value)}
                  placeholder="输入工单描述（可选）"
                  rows={4}
                  className="w-full px-4 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:border-[var(--accent-primary)] focus:outline-none resize-none"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">派发给 *</label>
                <select
                  value={createAgent}
                  onChange={(e) => setCreateAgent(e.target.value)}
                  className="w-full px-4 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
                >
                  {bots.map((bot) => (
                    <option key={bot.name} value={bot.name}>
                      {bot.emoji} {bot.displayName} ({bot.name})
                    </option>
                  ))}
                </select>
              </div>
              
              <div className="flex justify-end space-x-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreate(false);
                    setCreateTitle('');
                    setCreateDesc('');
                    setCreateAgent('donky');
                    setCreateError(null);
                  }}
                  className="px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded-lg hover:text-[var(--text-primary)] transition-colors"
                  disabled={createLoading}
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleCreateTicket}
                  disabled={createLoading || !createTitle.trim()}
                  className="px-4 py-2 bg-[var(--accent-primary)] text-[var(--bg-primary)] font-bold rounded-lg hover:bg-[var(--accent-primary)]/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {createLoading ? '创建中...' : '创建工单'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-6 animate-slide-in">
        {/* Main Content */}
        <div className="flex-1 space-y-6">
        {/* Top Stats Bar */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-[var(--text-secondary)] font-mono mb-1">TOTAL</p>
                <p className="text-2xl font-bold text-[var(--text-primary)]">{stats.total}</p>
              </div>
              <TrendingUp className="w-8 h-8 text-[var(--accent-primary)] opacity-50" />
            </div>
          </div>

          <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-[var(--text-secondary)] font-mono mb-1">OPEN</p>
                <p className="text-2xl font-bold text-blue-400">{stats.open}</p>
              </div>
              <AlertCircle className="w-8 h-8 text-blue-400 opacity-50" />
            </div>
          </div>

          <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-[var(--text-secondary)] font-mono mb-1">IN_PROGRESS</p>
                <p className="text-2xl font-bold text-yellow-400">{stats.inProgress}</p>
              </div>
              <Clock className="w-8 h-8 text-yellow-400 opacity-50" />
            </div>
          </div>

          <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-[var(--text-secondary)] font-mono mb-1">ACTIVE_BOTS</p>
                <p className="text-2xl font-bold text-[var(--success)]">{stats.activeBots}/{bots.length}</p>
              </div>
              <Activity className="w-8 h-8 text-[var(--success)] opacity-50" />
            </div>
          </div>
        </div>

        {/* Header & Search */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-[var(--text-primary)] mb-1">Tickets</h1>
            <p className="text-sm text-[var(--text-secondary)] font-mono">Manage and track agent tasks</p>
          </div>

          <div className="flex gap-3">
            <div className="relative flex-1 md:w-80">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[var(--text-secondary)] w-4 h-4" />
              <input
                type="text"
                placeholder="Search tickets..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] text-sm placeholder-[var(--text-secondary)] focus:border-[var(--accent-primary)] focus:outline-none transition-colors"
              />
            </div>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="flex items-center space-x-2 px-4 py-2 bg-[var(--accent-primary)] text-[var(--bg-primary)] font-bold rounded-lg hover:bg-[var(--accent-primary)]/80 transition-all duration-200 whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              <span className="text-sm">New</span>
            </button>
          </div>
        </div>

        {/* Tickets Table */}
        <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg overflow-hidden">
          {tickets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6">
              <Inbox className="w-16 h-16 text-[var(--text-secondary)] opacity-50 mb-4" />
              <p className="text-lg font-bold text-[var(--text-primary)] mb-2">暂无工单</p>
              <p className="text-sm text-[var(--text-secondary)] font-mono">当前没有工单数据，创建新工单开始使用</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead className="bg-[var(--bg-tertiary)] border-b border-[var(--border-color)]">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">ID</th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">Title</th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">Status</th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">Agent</th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">Session Key</th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">Created</th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-color)]">
                  {filteredTickets.map((ticket) => {
                    const bot = bots.find((b) => b.name === ticket.bot);
                    return (
                      <tr key={ticket.id} className="hover:bg-[var(--bg-tertiary)] transition-colors group">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <Link
                            to={`/tickets/${ticket.id}`}
                            className="text-sm font-bold text-[var(--accent-primary)] hover:underline"
                          >
                            #{ticket.id.toString().padStart(4, '0')}
                          </Link>
                        </td>
                        <td className="px-6 py-4">
                          <Link
                            to={`/tickets/${ticket.id}`}
                            className="flex items-center space-x-2 text-sm text-[var(--text-primary)] group-hover:text-[var(--accent-primary)] transition-colors"
                          >
                            <span>{getPriorityIcon(ticket.priority)}</span>
                            <span>{ticket.title}</span>
                          </Link>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className={`px-3 py-1 text-xs font-bold rounded border ${getStatusColor(ticket.status)}`}>
                            {ticket.status.toUpperCase().replace('-', '_')}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {bot ? (
                            <button
                              type="button"
                              onClick={() => setSelectedBot(selectedBot === bot.name ? null : bot.name)}
                              className="flex items-center space-x-2 hover:opacity-80 transition-opacity"
                            >
                              <span className="text-lg">{bot.emoji}</span>
                              <div>
                                <p className="text-sm font-medium text-[var(--text-primary)]">{bot.displayName}</p>
                                <p className="text-xs text-[var(--text-secondary)] font-mono">{bot.tokens}</p>
                              </div>
                            </button>
                          ) : (
                            <span className="text-sm text-[var(--text-secondary)] font-mono">{ticket.assigned_agent || '—'}</span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-[var(--text-secondary)] font-mono" title={ticket.session_key || ''}>
                          {truncateSessionKey(ticket.session_key)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-[var(--text-secondary)] font-mono">
                          {typeof ticket.created === 'string' && ticket.created.includes('T') ? new Date(ticket.created).toLocaleString() : ticket.created}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => handleRefreshStatus(ticket.id)}
                            disabled={refreshingId === ticket.id}
                            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent-primary)] disabled:opacity-50 transition-colors"
                            title="刷新状态"
                          >
                            <RefreshCw className={`w-4 h-4 ${refreshingId === ticket.id ? 'animate-spin' : ''}`} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between text-sm text-[var(--text-secondary)] font-mono">
          <span>Showing {filteredTickets.length} of {tickets.length} tickets</span>
          <div className="flex items-center space-x-4">
            {bots.filter((b) => b.status === 'active').map((bot) => (
              <div key={bot.name} className="flex items-center space-x-2">
                <span className="w-2 h-2 rounded-full bg-[var(--success)] animate-pulse-slow" />
                <span>{bot.emoji} {bot.displayName}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bot Details Sidebar */}
      <div className="w-96 space-y-4">
        {selectedBot ? (
          (() => {
            const bot = bots.find((b) => b.name === selectedBot);
            if (!bot) return null;
            return (
              <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-5 space-y-4">
                {/* Header */}
                <div className="flex items-center justify-between pb-4 border-b border-[var(--border-color)]">
                  <div className="flex items-center space-x-3">
                    <span className="text-3xl">{bot.emoji}</span>
                    <div>
                      <h2 className="text-xl font-bold text-[var(--text-primary)]">{bot.displayName}</h2>
                      <p className="text-xs text-[var(--text-secondary)] font-mono">{bot.name}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedBot(null)}
                    className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    <XCircle className="w-5 h-5" />
                  </button>
                </div>

                {/* Current Task */}
                {bot.currentTask && (
                  <div className="space-y-2">
                    <div className="flex items-center space-x-2 text-sm font-bold text-[var(--accent-primary)]">
                      <Zap className="w-4 h-4" />
                      <span>CURRENT_TASK</span>
                    </div>
                    <div className="bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg p-3">
                      <Link
                        to={`/tickets/${bot.currentTask.id}`}
                        className="text-sm text-[var(--text-primary)] hover:text-[var(--accent-primary)] transition-colors"
                      >
                        #{bot.currentTask.id.toString().padStart(4, '0')} {bot.currentTask.title}
                      </Link>
                      <div className="mt-2">
                        <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1">
                          <span>Progress</span>
                          <span className="font-mono">{bot.currentTask.progress}%</span>
                        </div>
                        <div className="w-full bg-[var(--bg-primary)] rounded-full h-2 overflow-hidden border border-[var(--border-color)]">
                          <div
                            className="h-2 bg-[var(--accent-primary)] transition-all duration-500"
                            style={{ width: `${bot.currentTask.progress}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Task Queue */}
                {bot.queue.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center space-x-2 text-sm font-bold text-[var(--text-primary)]">
                      <List className="w-4 h-4" />
                      <span>QUEUE ({bot.queue.length})</span>
                    </div>
                    <div className="space-y-2">
                      {bot.queue.map((task, index) => (
                        <Link
                          key={task.id}
                          to={`/tickets/${task.id}`}
                          className="block bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded p-2 hover:border-[var(--accent-primary)] transition-colors"
                        >
                          <div className="flex items-center space-x-2">
                            <span className="text-xs font-mono text-[var(--text-secondary)]">#{index + 1}</span>
                            <span className="text-xs text-[var(--text-primary)]">{task.title}</span>
                          </div>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}

                {/* Stats */}
                <div className="space-y-2">
                  <div className="text-sm font-bold text-[var(--text-primary)]">TODAY_STATS</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded p-3">
                      <p className="text-xs text-[var(--text-secondary)] font-mono mb-1">COMPLETED</p>
                      <p className="text-xl font-bold text-[var(--success)]">{bot.stats.todayCompleted}</p>
                    </div>
                    <div className="bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded p-3">
                      <p className="text-xs text-[var(--text-secondary)] font-mono mb-1">AVG_TIME</p>
                      <p className="text-xl font-bold text-[var(--text-primary)]">{bot.stats.avgResponseTime}</p>
                    </div>
                    <div className="bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded p-3">
                      <p className="text-xs text-[var(--text-secondary)] font-mono mb-1">SUCCESS</p>
                      <p className="text-xl font-bold text-[var(--accent-primary)]">{bot.stats.successRate}%</p>
                    </div>
                    <div className="bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded p-3">
                      <p className="text-xs text-[var(--text-secondary)] font-mono mb-1">UPTIME</p>
                      <p className="text-xl font-bold text-[var(--text-primary)]">{bot.stats.uptime}</p>
                    </div>
                  </div>
                </div>

                {/* Recent Tasks */}
                <div className="space-y-2">
                  <div className="text-sm font-bold text-[var(--text-primary)]">RECENT_TASKS</div>
                  <div className="space-y-2">
                    {bot.recentTasks.map((task) => (
                      <div
                        key={task.id}
                        className="flex items-center justify-between bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded p-2"
                      >
                        <div className="flex items-center space-x-2 flex-1 min-w-0">
                          <CheckCircle className="w-3 h-3 text-[var(--success)] flex-shrink-0" />
                          <span className="text-xs text-[var(--text-primary)] truncate">{task.title}</span>
                        </div>
                        <span className="text-xs text-[var(--text-secondary)] font-mono ml-2">{task.time}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Token Usage */}
                <div className="space-y-2">
                  <div className="text-sm font-bold text-[var(--text-primary)]">TOKEN_USAGE</div>
                  <div className="bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded p-3">
                    <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-2">
                      <span className="font-mono">USAGE</span>
                      <span className="font-mono">{bot.tokens}</span>
                    </div>
                    <div className="w-full bg-[var(--bg-primary)] rounded-full h-2 overflow-hidden border border-[var(--border-color)]">
                      <div
                        className={`h-2 transition-all duration-500 ${
                          bot.usage > 70 ? 'bg-[var(--danger)]' :
                          bot.usage > 40 ? 'bg-[var(--warning)]' :
                          'bg-[var(--success)]'
                        }`}
                        style={{ width: `${bot.usage}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            );
          })()
        ) : (
          /* Bot List View */
          <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-[var(--text-primary)] flex items-center space-x-2">
                <Activity className="w-5 h-5 text-[var(--accent-primary)]" />
                <span>BOT_STATUS</span>
              </h2>
              <div className="flex items-center space-x-2">
                <span className="w-2 h-2 rounded-full bg-[var(--success)] animate-pulse-slow" />
                <span className="text-xs text-[var(--text-secondary)] font-mono">LIVE</span>
              </div>
            </div>

            <div className="space-y-3">
              {bots.map((bot) => (
                <button
                  key={bot.name}
                  type="button"
                  onClick={() => setSelectedBot(bot.name)}
                  className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg p-4 hover:border-[var(--accent-primary)] transition-all duration-200 text-left"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center space-x-3">
                      <span className="text-2xl">{bot.emoji}</span>
                      <div>
                        <div className="font-bold text-[var(--text-primary)]">{bot.displayName}</div>
                        <div className="text-xs text-[var(--text-secondary)] font-mono">{bot.name}</div>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className={`w-2 h-2 rounded-full ${bot.status === 'active' ? 'bg-[var(--success)]' : 'bg-[var(--text-secondary)]'}`} />
                      <span className="text-xs font-bold text-[var(--text-secondary)]">
                        {bot.status === 'active' ? 'ACTIVE' : 'IDLE'}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2 text-xs">
                    <div className="flex items-center justify-between text-[var(--text-secondary)]">
                      <span className="font-mono">TODAY</span>
                      <span className="text-[var(--success)] font-bold">{bot.stats.todayCompleted} completed</span>
                    </div>
                    <div className="flex items-center justify-between text-[var(--text-secondary)]">
                      <span className="font-mono">TOKENS</span>
                      <span className="text-[var(--text-primary)] font-mono">{bot.tokens}</span>
                    </div>
                    {bot.currentTask && (
                      <div className="pt-2 border-t border-[var(--border-color)]">
                        <p className="text-[var(--accent-primary)] font-bold mb-1">WORKING ON:</p>
                        <p className="text-[var(--text-primary)] truncate">{bot.currentTask.title}</p>
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
    </>
  );
};

export default Tickets;
