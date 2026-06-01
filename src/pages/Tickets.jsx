import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Search, Plus, Activity, TrendingUp, AlertCircle, Clock, Inbox, RefreshCw, Trash2, ArrowUpDown, ChevronUp, ChevronDown, ExternalLink, CheckCircle2 } from 'lucide-react';
import { fetchTickets, fetchStockAdminTickets, fetchTicketStatus, createTicket, createStockAdminTicket, deleteTicket, deleteTickets } from '../api/tickets';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import { STATUS_BADGE_CLASS, STATUS_SORT_ORDER, getStatusLabel } from '../../workflow-schema.js';
import { buildTicketListSummary, buildTicketQuickViews, buildTicketStageGateStatus, buildTicketStageOrchestration, buildTicketViewModel, matchesTicketQuickView } from '../../ticket-selectors.js';

const DEFAULT_SORT = { key: 'created', direction: 'desc' };
const STOCK_ADMIN_TOKEN_STORAGE_KEY = 'stock-admin-token';
const FALLBACK_AGENT_OPTIONS = ['beavy', 'cowder', 'donky', 'marely', 'auditor', 'doggy'];
const AGENT_META = {
  beavy: { emoji: '🦫', displayName: '小李' },
  cowder: { emoji: '🐮', displayName: '小牛' },
  donky: { emoji: '🫏', displayName: '小驴' },
  marely: { emoji: '🐴', displayName: '小马' },
  auditor: { emoji: '🧭', displayName: '审计员' },
  doggy: { emoji: '🐶', displayName: '小狗' },
};

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
      const diff = (STATUS_SORT_ORDER[a.status] ?? 99) - (STATUS_SORT_ORDER[b.status] ?? 99);
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
  const raw = Array.isArray(payload)
    ? payload
    : (payload?.tickets ?? payload?.data?.items ?? payload?.data ?? []);
  const arr = (Array.isArray(raw) ? raw : []).filter((item) => item && typeof item === 'object');
  const normalized = arr.map((t) => ({
    id: t.id,
    title: t.title ?? '',
    status: t.status ?? 'queued',
    priority: t.priority ?? 'medium',
    bot: t.bot ?? t.assigned_agent ?? null,
    triage_owner: t.triage_owner ?? null,
    review_owner: t.review_owner ?? null,
    decision_owner: t.decision_owner ?? null,
    assigned_agent: t.assigned_agent ?? t.bot ?? null,
    current_actor: t.current_actor ?? null,
    current_actor_source: t.current_actor_source ?? null,
    next_actor: t.next_actor ?? null,
    next_actor_override: t.next_actor_override ?? null,
    next_actor_source: t.next_actor_source ?? null,
    manual_override_active: Boolean(t.manual_override_active),
    should_notify: Boolean(t.should_notify),
    session_key: t.session_key ?? null,
    created: t.created ?? '',
    last_update: t.last_update ?? '',
    progress: typeof t.progress === 'number' ? t.progress : 0,
    error: t.error ?? null,
    platform: t.platform ?? null,
    request_type: t.request_type ?? null,
    triage_summary: t.triage_summary ?? '',
    result_summary: t.result_summary ?? null,
    execution_mode: t.execution_mode ?? null,
    dispatch_state: t.dispatch_state ?? null,
    awaiting_receipt_from: t.awaiting_receipt_from ?? null,
    execution_guard: t.execution_guard ?? null,
    paused_by: t.paused_by ?? null,
    paused_from_status: t.paused_from_status ?? null,
    pause_reason: t.pause_reason ?? null,
    dependency_summary: {
      dependency_count: t.dependency_summary?.dependency_count ?? 0,
      dependent_count: t.dependency_summary?.dependent_count ?? 0,
    },
  }));

  return sortTicketsNewestFirst(normalized.map((t) => buildTicketViewModel(t)));
}

function truncate(str, len = 12) {
  if (!str) return '—';
  return str.length <= len ? str : str.slice(0, len) + '…';
}

function truncateSessionKey(s, max = 12) {
  if (!s) return '—';
  return s.length <= max ? s : s.slice(0, max) + '…';
}

const STATUS_LABELS = {
  open: 'OPEN',
  'in-progress': 'IN_PROGRESS',
  resolved: 'RESOLVED',
  closed: 'CLOSED',
};

function normalizeFilterValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildFilterOptions(values = []) {
  return [...new Set(values.map((value) => normalizeFilterValue(value)).filter(Boolean))]
    .sort((a, b) => compareText(a, b));
}

function renderFieldValue(value) {
  const text = normalizeFilterValue(value);
  return text || '—';
}

function getAgentMeta(agentName) {
  const normalized = normalizeFilterValue(agentName);
  if (!normalized) return null;
  return {
    name: normalized,
    displayName: AGENT_META[normalized]?.displayName || normalized,
    emoji: AGENT_META[normalized]?.emoji || '🤖',
  };
}

function TicketDependencies({ summary }) {
  const depCount = Number(summary?.dependency_count) || 0;
  const dependentCount = Number(summary?.dependent_count) || 0;

  if (depCount === 0 && dependentCount === 0) {
    return <span className="text-xs text-[var(--text-secondary)]">—</span>;
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      {depCount > 0 && (
        <span className="inline-flex items-center gap-1 rounded border border-orange-500/40 bg-orange-500/10 px-2 py-1 text-orange-300" title={`依赖 ${depCount} 个工单`}>
          🔗 {depCount}
        </span>
      )}
      {dependentCount > 0 && (
        <span className="inline-flex items-center gap-1 rounded border border-blue-500/40 bg-blue-500/10 px-2 py-1 text-blue-300" title={`被 ${dependentCount} 个工单依赖`}>
          ⬅️ {dependentCount}
        </span>
      )}
    </div>
  );
}

function isReviewerInboxTicket(ticket) {
  return ['done', 'review', 'pending_decision'].includes(ticket.status);
}

function getInitialStockAdminToken() {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(STOCK_ADMIN_TOKEN_STORAGE_KEY) || '';
}

function persistStockAdminToken(token) {
  if (typeof window === 'undefined') return;
  if (token) {
    window.localStorage.setItem(STOCK_ADMIN_TOKEN_STORAGE_KEY, token);
    return;
  }
  window.localStorage.removeItem(STOCK_ADMIN_TOKEN_STORAGE_KEY);
}

function getReviewerLaneMeta(ticket) {
  if (ticket.status === 'pending_decision') {
    return {
      tone: 'border-purple-500/40 bg-purple-500/10 text-purple-200',
      label: '待老大决策',
      hint: ticket.decision_summary || ticket.triage_summary || '等待 decision owner 拍板',
    };
  }

  return {
    tone: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200',
    label: ticket.status === 'review' ? 'reviewer 验收中' : 'reviewer 待收口',
    hint: ticket.result_summary || ticket.triage_summary || '等待 reviewer 收口',
  };
}

const Tickets = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshingId, setRefreshingId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [stockAdminMode, setStockAdminMode] = useState(false);
  const [stockAdminToken, setStockAdminToken] = useState(getInitialStockAdminToken);
  const [createTitle, setCreateTitle] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createAgent, setCreateAgent] = useState('donky');
  const [createTriageOwner, setCreateTriageOwner] = useState('leoss');
  const [createReviewOwner, setCreateReviewOwner] = useState('leoss');
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
      const ticketsRes = stockAdminMode
        ? await fetchStockAdminTickets(stockAdminToken)
        : await fetchTickets();
      setTickets(normalizeTickets(ticketsRes));
    } catch (err) {
      setError(err?.message || '加载工单列表失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, [stockAdminMode, stockAdminToken]);

  useEffect(() => {
    persistStockAdminToken(stockAdminToken.trim());
  }, [stockAdminToken]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const stats = useMemo(
    () => buildTicketListSummary(tickets),
    [tickets]
  );

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
      ...FALLBACK_AGENT_OPTIONS,
    ]),
    [tickets]
  );

  const quickViews = useMemo(
    () => buildTicketQuickViews(tickets),
    [tickets]
  );

  const reviewerInboxTickets = useMemo(
    () => tickets.filter((ticket) => isReviewerInboxTicket(ticket)),
    [tickets]
  );

  const hasActiveFilters = useMemo(
    () => searchTerm.trim().length > 0 || platformFilter !== 'all' || requestTypeFilter !== 'all' || assignedAgentFilter !== 'all' || quickView !== 'all',
    [searchTerm, platformFilter, requestTypeFilter, assignedAgentFilter, quickView]
  );

  const getStatusColor = (ticket) => {
    const status = ticket.status;
    const metaClass = ticket.status_meta?.badge_class;
    const fallback = {
      open: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
      'in-progress': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
      resolved: 'bg-green-500/20 text-green-400 border-green-500/50',
      closed: 'bg-gray-500/20 text-gray-400 border-gray-500/50',
    };
    return metaClass || STATUS_BADGE_CLASS[status] || fallback[status] || 'bg-gray-500/20 text-gray-400 border-gray-500/50';
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
      const matchesPresetView = matchesTicketQuickView(ticket, quickView);

      return matchesSearch && matchesPlatformFilter && matchesRequestTypeFilter && matchesAssignedAgentFilter && matchesPresetView;
    });
  }, [tickets, searchTerm, platformFilter, requestTypeFilter, assignedAgentFilter, quickView]);

  const visibleTickets = useMemo(
    () => sortTickets(filteredTickets, sortConfig),
    [filteredTickets, sortConfig]
  );

  const visibleTicketOrchestrations = useMemo(
    () => Object.fromEntries(visibleTickets.map((ticket) => [ticket.id, buildTicketStageOrchestration(ticket)])),
    [visibleTickets]
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
    if (stockAdminMode && !stockAdminToken.trim()) {
      setCreateError('请先填写 cowder 的 stock admin token');
      return;
    }
    setCreateLoading(true);
    setCreateError(null);
    try {
      const created = stockAdminMode
        ? await createStockAdminTicket(stockAdminToken.trim(), {
            title: createTitle.trim(),
            description: createDesc.trim(),
            assigned_agent: createAgent,
            triage_owner: createTriageOwner.trim() || undefined,
            review_owner: createReviewOwner.trim() || undefined,
          })
        : await createTicket({
            title: createTitle.trim(),
            description: createDesc.trim(),
            assigned_agent: createAgent,
            status: 'triage',
            triage_owner: createTriageOwner.trim() || undefined,
            review_owner: createReviewOwner.trim() || undefined,
          });
      const createdTicket = stockAdminMode ? created?.ticket : created;
      setTickets((prev) => sortTicketsNewestFirst([...normalizeTickets([createdTicket]), ...prev]));
      setShowCreate(false);
      setCreateTitle('');
      setCreateDesc('');
      setCreateAgent(stockAdminMode ? 'cowder' : 'donky');
      setCreateTriageOwner(stockAdminMode ? 'cowder' : 'leoss');
      setCreateReviewOwner(stockAdminMode ? 'cowder' : 'leoss');
    } catch (err) {
      setCreateError(err?.message || '创建工单失败，请稍后重试');
    } finally {
      setCreateLoading(false);
    }
  }, [createTitle, createDesc, createAgent, createTriageOwner, createReviewOwner, stockAdminMode, stockAdminToken]);

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

  if (loading && tickets.length === 0) {
    return (
      <div className="flex gap-6 animate-slide-in">
        <div className="flex-1">
          <LoadingState title="加载工单中..." description="正在获取工单列表与 Bot 状态" />
        </div>
      </div>
    );
  }

  if (error && tickets.length === 0) {
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
                  aria-label="标题 *"
                  value={createTitle}
                  onChange={(e) => setCreateTitle(e.target.value)}
                  placeholder="输入工单标题"
                  className="w-full px-4 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:border-[var(--accent-primary)] focus:outline-none"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">描述</label>
                <textarea
                  aria-label="描述"
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
                  aria-label="预指派执行人 *"
                  value={createAgent}
                  onChange={(e) => setCreateAgent(e.target.value)}
                  className="w-full px-4 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
                >
                  {assignedAgentOptions.map((agentName) => {
                    const agentMeta = getAgentMeta(agentName);
                    return (
                      <option key={agentName} value={agentName}>
                        {agentMeta ? `${agentMeta.emoji} ${agentMeta.displayName} (${agentName})` : agentName}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">分诊负责人</label>
                <input
                  type="text"
                  aria-label="分诊负责人"
                  value={createTriageOwner}
                  onChange={(e) => setCreateTriageOwner(e.target.value)}
                  placeholder="留空则按平台默认路由"
                  className="w-full px-4 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:border-[var(--accent-primary)] focus:outline-none"
                />
                <p className="mt-2 text-xs text-[var(--text-secondary)] font-mono">human/control-ui create 可受控指定 triage_owner；未填写时回退到平台默认责任人。</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">验收负责人</label>
                <input
                  type="text"
                  aria-label="验收负责人"
                  value={createReviewOwner}
                  onChange={(e) => setCreateReviewOwner(e.target.value)}
                  placeholder="留空则回退到 triage_owner"
                  className="w-full px-4 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:border-[var(--accent-primary)] focus:outline-none"
                />
                <p className="mt-2 text-xs text-[var(--text-secondary)] font-mono">done / review 阶段的 routing 与通知会显式指向 review_owner。</p>
              </div>
              
              <div className="flex justify-end space-x-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreate(false);
                    setCreateTitle('');
                    setCreateDesc('');
                    setCreateAgent(stockAdminMode ? 'cowder' : 'donky');
                    setCreateTriageOwner(stockAdminMode ? 'cowder' : 'leoss');
                    setCreateReviewOwner(stockAdminMode ? 'cowder' : 'leoss');
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
                <p className="text-xs text-[var(--text-secondary)] font-mono mb-1">ACTIVE</p>
                <p className="text-2xl font-bold text-blue-400">{stats.active}</p>
              </div>
              <AlertCircle className="w-8 h-8 text-blue-400 opacity-50" />
            </div>
          </div>

          <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-[var(--text-secondary)] font-mono mb-1">WAITING_REVIEW</p>
                <p className="text-2xl font-bold text-yellow-400">{stats.waitingReview}</p>
              </div>
              <Clock className="w-8 h-8 text-yellow-400 opacity-50" />
            </div>
          </div>

          <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-[var(--text-secondary)] font-mono mb-1">CLOSED</p>
                <p className="text-2xl font-bold text-[var(--success)]">{stats.closed}</p>
              </div>
              <CheckCircle2 className="w-8 h-8 text-[var(--success)] opacity-50" />
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
              onClick={() => {
                setCreateAgent(stockAdminMode ? 'cowder' : 'donky');
                setCreateTriageOwner(stockAdminMode ? 'cowder' : 'leoss');
                setCreateReviewOwner(stockAdminMode ? 'cowder' : 'leoss');
                setCreateError(null);
                setShowCreate(true);
              }}
              className="flex items-center space-x-2 px-4 py-2 bg-[var(--accent-primary)] text-[var(--bg-primary)] font-bold rounded-lg hover:bg-[var(--accent-primary)]/80 transition-all duration-200 whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              <span className="text-sm">New</span>
            </button>
          </div>
        </div>

        <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-4 space-y-4">
          <div className="flex flex-col gap-3 rounded-lg border border-violet-500/30 bg-violet-500/10 p-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1">
              <p className="text-xs font-mono uppercase tracking-wider text-violet-200">Control UI · Stock Admin</p>
              <p className="text-sm text-violet-50">仅对持有 cowder 受控 stock admin token 的操作者开放 stock-platform 建单与盘面读取，不放开全局超管能力。</p>
            </div>
            <div className="flex flex-col gap-3 lg:min-w-[420px]">
              <label className="inline-flex items-center gap-3 text-sm text-violet-50">
                <input
                  type="checkbox"
                  aria-label="启用受控 stock admin 模式"
                  checked={stockAdminMode}
                  onChange={(e) => setStockAdminMode(e.target.checked)}
                  className="h-4 w-4 rounded border-violet-300 bg-[var(--bg-tertiary)] text-violet-400 focus:ring-violet-400"
                />
                <span>启用受控 stock admin 模式</span>
              </label>
              <label htmlFor="stock-admin-token" className="space-y-1 text-sm text-violet-50">
                <span className="block">Stock admin token</span>
                <input
                  id="stock-admin-token"
                  type="password"
                  aria-label="Stock admin token"
                  value={stockAdminToken}
                  onChange={(e) => setStockAdminToken(e.target.value)}
                  placeholder="仅输入 cowder 的 stock admin token"
                  disabled={!stockAdminMode}
                  className="w-full rounded-lg border border-violet-500/40 bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-secondary)] focus:border-violet-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                />
              </label>
            </div>
          </div>

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
              <span>handoff→review {stats.handoffToReviewer || 0}</span>
              <span>待决策 {stats.pendingDecision || 0}</span>
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

        <div className="space-y-4">
          <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-xs font-mono uppercase tracking-wider text-[var(--text-secondary)]">Bot Status</p>
                <h2 className="mt-1 text-lg font-bold text-[var(--text-primary)]">Bot 运行状态已拆到独立页</h2>
                <p className="mt-2 text-sm text-[var(--text-secondary)]">Tickets 主列表只保留工单主流程；Bot 详情、队列和资源占用请到独立 Bot Status 页面查看。当前页首屏不再请求 Bot 状态副路。</p>
              </div>
              <Link
                to="/bot-status"
                className="inline-flex items-center gap-2 self-start rounded-lg border border-[var(--border-color)] px-4 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
              >
                <Activity className="w-4 h-4 text-[var(--accent-primary)]" />
                <span>打开 Bot Status</span>
                <ExternalLink className="w-4 h-4" />
              </Link>
            </div>
          </div>

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
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider">
                      <span>Dependencies</span>
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-bold text-[var(--accent-primary)] uppercase tracking-wider"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-color)]">
                  {visibleTickets.map((ticket) => {
                    const agentMeta = getAgentMeta(ticket.assigned_agent || ticket.bot);
                    const isSelected = selectedTickets.includes(ticket.id);
                    const orchestration = visibleTicketOrchestrations[ticket.id] || buildTicketStageOrchestration(ticket);
                    const gateStatus = buildTicketStageGateStatus(ticket, { orchestration });
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
                          <div className="mt-2 space-y-1 text-xs text-[var(--text-secondary)]">
                            <div className="flex flex-wrap items-center gap-2">
                              <span>阶段编排：{orchestration.headline}</span>
                              <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${gateStatus.state === 'ready' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : gateStatus.state === 'at_risk' ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : gateStatus.state === 'gap' ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' : 'border-white/15 bg-white/5 text-[var(--text-secondary)]'}`}>{gateStatus.label}</span>
                            </div>
                            <div>门禁：{gateStatus.summary}</div>
                            <div>下一步：{orchestration.next_action_label || '待定'} → {orchestration.next_stage_label || '待定'}</div>
                            <div>交接：{orchestration.handoff_summary}</div>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className={`px-3 py-1 text-xs font-bold rounded border ${getStatusColor(ticket)}`}>
                            {ticket.status_meta?.label || getStatusLabel(ticket.status) || ticket.status.toUpperCase().replace('-', '_')}
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
                          {agentMeta ? (
                            <div className="flex items-center space-x-2">
                              <span className="text-lg">{agentMeta.emoji}</span>
                              <div>
                                <p className="text-sm font-medium text-[var(--text-primary)]">{agentMeta.displayName}</p>
                                <div className="flex items-center gap-2 text-xs font-mono text-[var(--text-secondary)]">
                                  <span>{ticket.assigned_agent}</span>
                                  <Link to="/bot-status" className="inline-flex items-center gap-1 hover:text-[var(--text-primary)]">
                                    <span>Bot Status</span>
                                    <ExternalLink className="w-3 h-3" />
                                  </Link>
                                </div>
                              </div>
                            </div>
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
                          <TicketDependencies summary={ticket.dependency_summary} />
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

          <aside className="space-y-4">
            <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-mono uppercase tracking-wider text-[var(--text-secondary)]">Reviewer Inbox</p>
                  <h2 className="mt-2 text-lg font-bold text-[var(--text-primary)]">review inbox / decision split</h2>
                  <p className="mt-2 text-sm text-[var(--text-secondary)]">把待验收、审核中、待老大拍板的工单单独拎出来，reviewer 不用在全量列表里捞票。</p>
                </div>
                <span className="inline-flex rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-xs font-medium text-cyan-200">
                  {reviewerInboxTickets.length} 张
                </span>
              </div>

              <div className="mt-4 space-y-3">
                {reviewerInboxTickets.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[var(--border-color)] bg-[var(--bg-tertiary)] px-4 py-6 text-sm text-[var(--text-secondary)]">
                    当前没有 reviewer 相关工单。
                  </div>
                ) : reviewerInboxTickets.slice(0, 6).map((ticket) => {
                  const lane = getReviewerLaneMeta(ticket);
                  return (
                    <Link
                      key={ticket.id}
                      to={`/tickets/${ticket.id}`}
                      className="block rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4 transition-colors hover:border-[var(--accent-primary)]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-[var(--text-primary)]">#{ticket.id} {ticket.title}</div>
                          <div className="mt-1 text-xs font-mono text-[var(--text-secondary)]">
                            reviewer {renderFieldValue(ticket.review_owner)} · next {renderFieldValue(ticket.next_actor)}
                          </div>
                        </div>
                        <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${lane.tone}`}>
                          {lane.label}
                        </span>
                      </div>
                      <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">{lane.hint}</p>
                    </Link>
                  );
                })}
              </div>
            </div>
          </aside>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between text-sm text-[var(--text-secondary)] font-mono">
          <span>Showing {visibleTickets.length} of {tickets.length} tickets{hasActiveFilters ? ' · filtered view' : ''}</span>
          <span>首屏仅请求 Tickets 主列表 DTO；详情与依赖明细改为按需加载</span>
        </div>
      </div>
    </div>
    </>
  );
};

export default Tickets;
