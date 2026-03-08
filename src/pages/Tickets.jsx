import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Search, Plus, Activity, TrendingUp, AlertCircle, Clock, CheckCircle, XCircle, Zap, List, Inbox, RefreshCw, Trash2, ArrowUpDown, ChevronUp, ChevronDown } from 'lucide-react';
import { fetchTickets, fetchBots, fetchTicketStatus, createTicket, deleteTicket, deleteTickets } from '../api/tickets';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';

const DEFAULT_SORT = { key: 'created', direction: 'desc' };

function parseTimestamp(value) {
  const ts = Date.parse(value || '');
  return Number.isFinite(ts) ? ts : 0;
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'zh-Hans-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

function compareTickets(a, b, key) {
  switch (key) {
    case 'id':
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    case 'title':
      return compareText(a.title, b.title);
    case 'status': {
      const order = { triage: 0, queued: 1, running: 2, review: 3, blocked: 4, failed: 5, done: 6, complete: 7, pending_decision: 8, open: 1, 'in-progress': 2, resolved: 6, closed: 7 };
      const diff = (order[a.status] ?? 99) - (order[b.status] ?? 99);
      return diff !== 0 ? diff : compareText(a.status, b.status);
    }
    case 'agent':
      return compareText(a.assigned_agent || a.bot, b.assigned_agent || b.bot);
    case 'session_key':
      return compareText(a.session_key, b.session_key);
    case 'last_update':
      return parseTimestamp(a.last_update) - parseTimestamp(b.last_update);
    case 'created':
    default:
      return parseTimestamp(a.created) - parseTimestamp(b.created);
  }
}

function sortTickets(tickets, sortConfig = DEFAULT_SORT) {
  const { key, direction } = sortConfig;
  return [...tickets].sort((a, b) => {
    const diff = compareTickets(a, b, key);
    if (diff !== 0) {
      return direction === 'asc' ? diff : -diff;
    }

    const createdDiff = compareTickets(a, b, 'created');
    if (createdDiff !== 0) return -createdDiff;

    return (Number(b.id) || 0) - (Number(a.id) || 0);
  });
}

function sortTicketsNewestFirst(tickets) {
  return sortTickets(tickets, DEFAULT_SORT);
}

function formatDateTime(value) {
  if (typeof value !== 'string' || value.length === 0) return '—';
  return value.includes('T') ? new Date(value).toLocaleString() : value;
}

function normalizeTickets(payload) {
  const raw = Array.isArray(payload) ? payload : (payload?.tickets ?? payload?.data ?? []);
  const arr = Array.isArray(raw) ? raw : [];
  return sortTicketsNewestFirst(arr.map((t) => ({
    id: t.id,
    title: t.title ?? '',
    status: t.status ?? 'queued',
    priority: t.priority ?? 'medium',
    bot: t.bot ?? t.assigned_agent ?? null,
    triage_owner: t.triage_owner ?? null,
    assigned_agent: t.assigned_agent ?? t.bot ?? null,
    next_actor: t.next_actor ?? null,
    next_actor_override: t.next_actor_override ?? null,
    next_actor_source: t.next_actor_source ?? null,
    should_notify: Boolean(t.should_notify),
    session_key: t.session_key ?? null,
    created: t.created ?? '',
    last_update: t.last_update ?? '',
    progress: typeof t.progress === 'number' ? t.progress : 0,
    error: t.error ?? null,
    platform: t.platform ?? null,
    request_type: t.request_type ?? null,
    triage_summary: t.triage_summary ?? '',
  })));
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

const QUICK_VIEW_CONFIG = {
  all: { label: '全部工单' },
  triagePending: { label: '待分诊' },
  ticketPlatform: { label: '只看工单平台' },
  beavy: { label: '只看 beavy' },
  triageIncomplete: { label: '分诊待补全' },
};

function normalizeFilterValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasTriageGap(ticket) {
  const requiredFields = [
    ticket.triage_owner,
    ticket.platform,
    ticket.request_type,
    ticket.assigned_agent,
    ticket.triage_summary,
  ];
  return requiredFields.some((value) => normalizeFilterValue(value).length === 0);
}

function matchesQuickView(ticket, quickView) {
  switch (quickView) {
    case 'triagePending':
      return ticket.status === 'triage';
    case 'ticketPlatform':
      return ticket.platform === 'ticket-platform';
    case 'beavy':
      return ticket.assigned_agent === 'beavy';
    case 'triageIncomplete':
      return hasTriageGap(ticket);
    case 'all':
    default:
      return true;
  }
}

function buildFilterOptions(values = []) {
  return [...new Set(values.map((value) => normalizeFilterValue(value)).filter(Boolean))]
    .sort((a, b) => compareText(a, b));
}

function renderFieldValue(value) {
  const text = normalizeFilterValue(value);
  return text || '—';
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
  const [sortConfig, setSortConfig] = useState(DEFAULT_SORT);
  const [selectedTickets, setSelectedTickets] = useState([]);
  const [deletingId, setDeletingId] = useState(null);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [platformFilter, setPlatformFilter] = useState('all');
  const [requestTypeFilter, setRequestTypeFilter] = useState('all');
  const [assignedAgentFilter, setAssignedAgentFilter] = useState('all');
  const [quickView, setQuickView] = useState('all');

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
    open: tickets.filter((t) => ['triage', 'queued', 'review', 'blocked', 'failed'].includes(t.status)).length,
    inProgress: tickets.filter((t) => t.status === 'running').length,
    activeBots: bots.filter((b) => b.status === 'active').length,
  }), [tickets, bots]);

  const platformOptions = useMemo(
    () => buildFilterOptions(tickets.map((ticket) => ticket.platform)),
    [tickets]
  );

  const requestTypeOptions = useMemo(
    () => buildFilterOptions(tickets.map((ticket) => ticket.request_type)),
    [tickets]
  );

  const assignedAgentOptions = useMemo(
    () => buildFilterOptions([
      ...tickets.map((ticket) => ticket.assigned_agent),
      ...bots.map((bot) => bot.name),
    ]),
    [tickets, bots]
  );

  const quickViews = useMemo(
    () => Object.entries(QUICK_VIEW_CONFIG).map(([key, config]) => ({
      key,
      label: config.label,
      count: tickets.filter((ticket) => matchesQuickView(ticket, key)).length,
    })),
    [tickets]
  );

  const hasActiveFilters = useMemo(
    () => searchTerm.trim().length > 0 || platformFilter !== 'all' || requestTypeFilter !== 'all' || assignedAgentFilter !== 'all' || quickView !== 'all',
    [searchTerm, platformFilter, requestTypeFilter, assignedAgentFilter, quickView]
  );

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

  const getPriorityIcon = (priority) => {
    if (priority === 'critical') return '🔴';
    if (priority === 'high') return '🟠';
    if (priority === 'medium') return '🟡';
    return '⚪';
  };

  const filteredTickets = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();

    return tickets.filter((ticket) => {
      const matchesSearch = normalizedSearch.length === 0 || [
        ticket.title,
        ticket.platform,
        ticket.request_type,
        ticket.triage_owner,
        ticket.assigned_agent,
        ticket.next_actor,
      ].some((value) => String(value || '').toLowerCase().includes(normalizedSearch));

      const matchesPlatformFilter = platformFilter === 'all' || ticket.platform === platformFilter;
      const matchesRequestTypeFilter = requestTypeFilter === 'all' || ticket.request_type === requestTypeFilter;
      const matchesAssignedAgentFilter = assignedAgentFilter === 'all' || ticket.assigned_agent === assignedAgentFilter;
      const matchesPresetView = matchesQuickView(ticket, quickView);

      return matchesSearch && matchesPlatformFilter && matchesRequestTypeFilter && matchesAssignedAgentFilter && matchesPresetView;
    });
  }, [tickets, searchTerm, platformFilter, requestTypeFilter, assignedAgentFilter, quickView]);

  const visibleTickets = useMemo(
    () => sortTickets(filteredTickets, sortConfig),
    [filteredTickets, sortConfig]
  );

  const allVisibleSelected = useMemo(
    () => visibleTickets.length > 0 && visibleTickets.every((ticket) => selectedTickets.includes(ticket.id)),
    [visibleTickets, selectedTickets]
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
      const created = await createTicket({
        title: createTitle.trim(),
        description: createDesc.trim(),
        agent: createAgent,
        status: 'triage',
        triage_owner: 'leoss',
      });
      setTickets((prev) => sortTicketsNewestFirst([...normalizeTickets([created]), ...prev]));
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

  const handleDeleteTicket = useCallback(async (ticketId) => {
    if (!window.confirm('确定要删除这个工单吗？')) return;
    setDeletingId(ticketId);
    try {
      await deleteTicket(ticketId);
      setTickets((prev) => prev.filter((t) => t.id !== ticketId));
      setSelectedTickets((prev) => prev.filter((id) => id !== ticketId));
    } catch (err) {
      setError(err?.message || '删除失败，请稍后重试');
    } finally {
      setDeletingId(null);
    }
  }, []);

  const handleBatchDelete = useCallback(async () => {
    if (selectedTickets.length === 0) return;
    if (!window.confirm(`确定要删除选中的 ${selectedTickets.length} 个工单吗？`)) return;
    setBatchDeleting(true);
    try {
      await deleteTickets(selectedTickets);
      setTickets((prev) => prev.filter((t) => !selectedTickets.includes(t.id)));
      setSelectedTickets([]);
    } catch (err) {
      setError(err?.message || '批量删除失败，请稍后重试');
    } finally {
      setBatchDeleting(false);
    }
  }, [selectedTickets]);

  const toggleSelectTicket = useCallback((ticketId) => {
    setSelectedTickets((prev) =>
      prev.includes(ticketId) ? prev.filter((id) => id !== ticketId) : [...prev, ticketId]
    );
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (allVisibleSelected) {
      setSelectedTickets((prev) => prev.filter((id) => !visibleTickets.some((ticket) => ticket.id === id)));
    } else {
      setSelectedTickets((prev) => [...new Set([...prev, ...visibleTickets.map((t) => t.id)])]);
    }
  }, [allVisibleSelected, visibleTickets]);

  const handleSort = useCallback((key) => {
    setSortConfig((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      }

      const defaultDirection = ['id', 'created', 'last_update'].includes(key) ? 'desc' : 'asc';
      return { key, direction: defaultDirection };
    });
  }, []);

  const renderSortIcon = useCallback((key) => {
    if (sortConfig.key !== key) {
      return <ArrowUpDown className="w-3.5 h-3.5 opacity-60" />;
    }
    return sortConfig.direction === 'asc'
      ? <ChevronUp className="w-3.5 h-3.5" />
      : <ChevronDown className="w-3.5 h-3.5" />;
  }, [sortConfig]);

  const resetFilters = useCallback(() => {
    setSearchTerm('');
    setPlatformFilter('all');
    setRequestTypeFilter('all');
    setAssignedAgentFilter('all');
    setQuickView('all');
  }, []);

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
              
              <div className="rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-sm text-violet-100">
                新工单默认进入 <span className="font-mono">triage</span>，Sheeply 应先通知 <span className="font-mono">leoss</span> 分诊，再按状态路由给执行人。
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">预指派执行人 *</label>
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
            {selectedTickets.length > 0 && (
              <button
                type="button"
                onClick={handleBatchDelete}
                disabled={batchDeleting}
                className="flex items-center space-x-2 px-4 py-2 bg-red-500/20 text-red-400 border border-red-500/50 font-bold rounded-lg hover:bg-red-500/30 transition-all duration-200 whitespace-nowrap disabled:opacity-50"
              >
                <Trash2 className="w-4 h-4" />
                <span className="text-sm">{batchDeleting ? '删除中...' : `删除 (${selectedTickets.length})`}</span>
              </button>
            )}
            <div className="relative flex-1 md:w-80">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[var(--text-secondary)] w-4 h-4" />
              <input
                type="text"
                placeholder="搜索标题 / 平台 / 类型 / 执行人"
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

        <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-4 space-y-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="space-y-2">
              <p className="text-xs font-mono text-[var(--text-secondary)] uppercase tracking-wider">Quick Views</p>
              <div className="flex flex-wrap gap-2">
                {quickViews.map((view) => {
                  const active = quickView === view.key;
                  return (
                    <button
                      key={view.key}
                      type="button"
                      onClick={() => setQuickView(view.key)}
                      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                        active
                          ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/15 text-[var(--accent-primary)]'
                          : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      <span>{view.label}</span>
                      <span className="text-xs font-mono opacity-80">{view.count}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-3 text-xs font-mono text-[var(--text-secondary)]">
              <span>Visible {visibleTickets.length}/{tickets.length}</span>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="rounded border border-[var(--border-color)] px-3 py-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  清空筛选
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="space-y-2 text-sm text-[var(--text-secondary)]">
              <span className="block font-medium">平台</span>
              <select
                aria-label="按平台筛选"
                value={platformFilter}
                onChange={(e) => setPlatformFilter(e.target.value)}
                className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-2 text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
              >
                <option value="all">全部平台</option>
                {platformOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>

            <label className="space-y-2 text-sm text-[var(--text-secondary)]">
              <span className="block font-medium">需求类型</span>
              <select
                aria-label="按需求类型筛选"
                value={requestTypeFilter}
                onChange={(e) => setRequestTypeFilter(e.target.value)}
                className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-2 text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
              >
                <option value="all">全部类型</option>
                {requestTypeOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>

            <label className="space-y-2 text-sm text-[var(--text-secondary)]">
              <span className="block font-medium">执行人</span>
              <select
                aria-label="按执行人筛选"
                value={assignedAgentFilter}
                onChange={(e) => setAssignedAgentFilter(e.target.value)}
                className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-2 text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
              >
                <option value="all">全部执行人</option>
                {assignedAgentOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
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
          ) : visibleTickets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <Inbox className="w-16 h-16 text-[var(--text-secondary)] opacity-50 mb-4" />
              <p className="text-lg font-bold text-[var(--text-primary)] mb-2">当前筛选条件下暂无工单</p>
              <p className="text-sm text-[var(--text-secondary)] font-mono">可尝试切换快速视图或清空筛选</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead className="bg-[var(--bg-tertiary)] border-b border-[var(--border-color)]">
                  <tr>
                    <th className="px-6 py-3 text-left">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAll}
                        className="w-4 h-4 rounded border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--accent-primary)] focus:ring-[var(--accent-primary)]"
                      />
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">
                      <button type="button" onClick={() => handleSort('id')} className="inline-flex items-center gap-1.5 hover:text-[var(--text-primary)] transition-colors">
                        <span>ID</span>
                        {renderSortIcon('id')}
                      </button>
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">
                      <button type="button" onClick={() => handleSort('title')} className="inline-flex items-center gap-1.5 hover:text-[var(--text-primary)] transition-colors">
                        <span>Title</span>
                        {renderSortIcon('title')}
                      </button>
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">
                      <button type="button" onClick={() => handleSort('status')} className="inline-flex items-center gap-1.5 hover:text-[var(--text-primary)] transition-colors">
                        <span>Status</span>
                        {renderSortIcon('status')}
                      </button>
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">
                      <span>Platform</span>
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">
                      <span>Request Type</span>
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">
                      <button type="button" onClick={() => handleSort('agent')} className="inline-flex items-center gap-1.5 hover:text-[var(--text-primary)] transition-colors">
                        <span>Assigned Agent</span>
                        {renderSortIcon('agent')}
                      </button>
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">
                      <span>Next Actor</span>
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">
                      <button type="button" onClick={() => handleSort('session_key')} className="inline-flex items-center gap-1.5 hover:text-[var(--text-primary)] transition-colors">
                        <span>Session Key</span>
                        {renderSortIcon('session_key')}
                      </button>
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">
                      <button type="button" onClick={() => handleSort('created')} className="inline-flex items-center gap-1.5 hover:text-[var(--text-primary)] transition-colors">
                        <span>Created</span>
                        {renderSortIcon('created')}
                      </button>
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">
                      <button type="button" onClick={() => handleSort('last_update')} className="inline-flex items-center gap-1.5 hover:text-[var(--text-primary)] transition-colors">
                        <span>Updated</span>
                        {renderSortIcon('last_update')}
                      </button>
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-color)]">
                  {visibleTickets.map((ticket) => {
                    const bot = bots.find((b) => b.name === ticket.bot);
                    const isSelected = selectedTickets.includes(ticket.id);
                    return (
                      <tr key={ticket.id} className={`hover:bg-[var(--bg-tertiary)] transition-colors group ${isSelected ? 'bg-[var(--accent-primary)]/5' : ''}`}>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelectTicket(ticket.id)}
                            className="w-4 h-4 rounded border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--accent-primary)] focus:ring-[var(--accent-primary)]"
                          />
                        </td>
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
                          <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${ticket.platform ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300' : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'}`}>
                            {renderFieldValue(ticket.platform)}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${ticket.request_type ? 'border-violet-500/40 bg-violet-500/10 text-violet-300' : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'}`}>
                            {renderFieldValue(ticket.request_type)}
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
                                <p className="text-xs text-[var(--text-secondary)] font-mono">{ticket.assigned_agent}</p>
                              </div>
                            </button>
                          ) : (
                            <span className="text-sm text-[var(--text-secondary)] font-mono">{renderFieldValue(ticket.assigned_agent)}</span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="text-sm text-[var(--text-primary)] font-mono">{renderFieldValue(ticket.next_actor)}</div>
                          <div className="text-xs text-[var(--text-secondary)] font-mono">{renderFieldValue(ticket.next_actor_source)}</div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-[var(--text-secondary)] font-mono" title={ticket.session_key || ''}>
                          {truncateSessionKey(ticket.session_key)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-[var(--text-secondary)] font-mono">
                          {formatDateTime(ticket.created)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-[var(--text-secondary)] font-mono">
                          {formatDateTime(ticket.last_update)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleRefreshStatus(ticket.id)}
                              disabled={refreshingId === ticket.id}
                              className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent-primary)] disabled:opacity-50 transition-colors"
                              title="刷新状态"
                            >
                              <RefreshCw className={`w-4 h-4 ${refreshingId === ticket.id ? 'animate-spin' : ''}`} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteTicket(ticket.id)}
                              disabled={deletingId === ticket.id}
                              className="p-1.5 rounded hover:bg-red-500/20 text-[var(--text-secondary)] hover:text-red-400 disabled:opacity-50 transition-colors"
                              title="删除工单"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
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
          <span>Showing {visibleTickets.length} of {tickets.length} tickets{hasActiveFilters ? ' · filtered view' : ''}</span>
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
                      <span className="text-[var(--success)] font-bold">{bot.stats.todayCompleted} 已完成</span>
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
