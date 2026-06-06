import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Inbox as InboxIcon, Clock3, RefreshCw, ExternalLink } from 'lucide-react';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import { fetchInbox } from '../api/tickets';
import { getStatusLabel } from '../../workflow-schema.js';

const TABS = [
  { key: 'triage', label: 'Triage Inbox' },
  { key: 'execution', label: 'Execution Inbox' },
  { key: 'review', label: 'Review Inbox' },
  { key: 'decision', label: 'Decision Inbox' },
];

function normalizeItems(payload) {
  const raw = Array.isArray(payload)
    ? payload
    : (payload?.items ?? payload?.data?.items ?? payload?.data ?? []);
  return (Array.isArray(raw) ? raw : []).filter((item) => item && typeof item === 'object');
}

function normalizeLanes(payload) {
  const lanes = payload?.lanes || payload?.data?.lanes || {};
  return Object.fromEntries(TABS.map((tab) => [tab.key, normalizeItems(lanes[tab.key] || [])]));
}

function formatRemaining(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '无 SLA';
  const overdue = ms < 0;
  const abs = Math.abs(ms);
  const minutes = Math.round(abs / 60000);
  if (minutes < 60) return `${overdue ? '超时' : '剩余'} ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${overdue ? '超时' : '剩余'} ${hours} 小时${restMinutes ? ` ${restMinutes} 分钟` : ''}`;
}

function urgencyTone(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return 'border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]';
  if (ms < 0) return 'border-red-500/40 bg-red-500/10 text-red-300';
  if (ms <= 60 * 60 * 1000) return 'border-amber-500/40 bg-amber-500/10 text-amber-300';
  return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
}

function laneMeta(item, laneKey) {
  switch (laneKey) {
    case 'triage':
      return {
        badge: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
        label: '待分诊',
        ownerLabel: item.triage_owner || item.owner_label || item.next_actor || '未指定',
      };
    case 'execution':
      return {
        badge: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
        label: item.status === 'running' ? '执行中' : '待开工',
        ownerLabel: item.assigned_agent || item.owner_label || item.next_actor || '未指定',
      };
    case 'decision':
      return {
        badge: 'border-purple-500/40 bg-purple-500/10 text-purple-200',
        label: '待老大决策',
        ownerLabel: item.decision_owner || item.owner_label || item.next_actor || '未指定',
      };
    case 'review':
    default:
      return {
        badge: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200',
        label: item.status === 'review' ? 'reviewer 验收中' : 'reviewer 待收口',
        ownerLabel: item.review_owner || item.owner_label || item.next_actor || '未指定',
      };
  }
}

function formatAction(action) {
  if (!action) return '—';
  return String(action).replaceAll('_', ' ');
}

function formatTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function Inbox() {
  const [activeTab, setActiveTab] = useState('triage');
  const [lanes, setLanes] = useState({ triage: [], execution: [], review: [], decision: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const payload = await fetchInbox();
      setLanes(normalizeLanes(payload));
    } catch (err) {
      setError(err?.message || '加载 Inbox 失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void Promise.resolve().then(loadData);
  }, []);

  const items = useMemo(() => lanes[activeTab] || [], [activeTab, lanes]);

  if (loading) return <LoadingState message="加载 Inbox 中..." />;
  if (error) return <ErrorState message={error} onRetry={loadData} />;

  return (
    <div className="space-y-6 animate-slide-in">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-[var(--text-primary)]">Inbox</h1>
          <p className="mt-1 text-sm font-mono text-[var(--text-secondary)]">基于责任链聚合 triage / execution / review / decision 四类只读待办，按 SLA 剩余时间最紧急优先。</p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/tickets"
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-color)] px-4 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            <span>返回 Tickets</span>
            <ExternalLink className="h-4 w-4" />
          </Link>
          <button
            type="button"
            onClick={loadData}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-color)] px-4 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            <RefreshCw className="h-4 w-4" />
            <span>刷新</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {TABS.map((tab) => {
          const count = lanes[tab.key]?.length || 0;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`rounded-xl border p-4 text-left transition-colors ${
                active
                  ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10'
                  : 'border-[var(--border-color)] bg-[var(--bg-secondary)] hover:border-[var(--accent-primary)]/50'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-mono uppercase tracking-wider text-[var(--text-secondary)]">{tab.key}</p>
                  <h2 className="mt-2 text-lg font-bold text-[var(--text-primary)]">{tab.label}</h2>
                </div>
                <span className="inline-flex rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-xs font-medium text-cyan-200">
                  {count} 张
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="space-y-4 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border-color)] bg-[var(--bg-tertiary)] px-6 py-16 text-center">
            <InboxIcon className="mb-4 h-14 w-14 text-[var(--text-secondary)] opacity-50" />
            <p className="text-lg font-bold text-[var(--text-primary)]">当前收件箱为空</p>
            <p className="mt-2 text-sm font-mono text-[var(--text-secondary)]">暂无需要处理的 {activeTab} 工单。</p>
          </div>
        ) : (
          items.map((item) => {
            const lane = laneMeta(item, activeTab);
            const currentActor = item.current_actor || item.owner_label || item.next_actor || lane.ownerLabel || '未指定';
            return (
              <Link
                key={item.id}
                to={`/tickets/${item.id}`}
                className="block rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4 transition-colors hover:border-[var(--accent-primary)]"
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${lane.badge}`}>
                        {lane.label}
                      </span>
                      <span className="inline-flex rounded-full border border-[var(--border-color)] px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)]">
                        状态：{getStatusLabel(item.status) || item.status}
                      </span>
                    </div>
                    <div>
                      <div className="text-base font-semibold text-[var(--text-primary)]">#{item.id} {item.title}</div>
                    </div>
                    <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
                      <div className="rounded-lg border border-[var(--border-color)]/80 bg-[var(--bg-secondary)]/60 px-3 py-2">
                        <dt className="text-xs font-mono uppercase tracking-wide text-[var(--text-tertiary)]">当前责任人</dt>
                        <dd className="mt-1 text-sm font-medium text-[var(--text-primary)]">{currentActor}</dd>
                      </div>
                      <div className="rounded-lg border border-[var(--border-color)]/80 bg-[var(--bg-secondary)]/60 px-3 py-2">
                        <dt className="text-xs font-mono uppercase tracking-wide text-[var(--text-tertiary)]">推荐动作</dt>
                        <dd className="mt-1 text-sm font-medium text-[var(--text-primary)]">{formatAction(item.recommended_action)}</dd>
                      </div>
                      <div className="rounded-lg border border-[var(--border-color)]/80 bg-[var(--bg-secondary)]/60 px-3 py-2 md:col-span-2">
                        <dt className="text-xs font-mono uppercase tracking-wide text-[var(--text-tertiary)]">进入原因</dt>
                        <dd className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">{item.inbox_reason || '—'}</dd>
                      </div>
                      <div className="rounded-lg border border-[var(--border-color)]/80 bg-[var(--bg-secondary)]/60 px-3 py-2">
                        <dt className="text-xs font-mono uppercase tracking-wide text-[var(--text-tertiary)]">更新时间</dt>
                        <dd className="mt-1 text-sm font-medium text-[var(--text-primary)]">{formatTimestamp(item.last_update || item.updated || item.created)}</dd>
                      </div>
                      <div className="rounded-lg border border-[var(--border-color)]/80 bg-[var(--bg-secondary)]/60 px-3 py-2">
                        <dt className="text-xs font-mono uppercase tracking-wide text-[var(--text-tertiary)]">下一责任人</dt>
                        <dd className="mt-1 text-sm font-medium text-[var(--text-primary)]">{item.next_actor || '—'}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 self-start">
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${urgencyTone(item.sla_remaining_ms)}`}>
                      <Clock3 className="h-3.5 w-3.5" />
                      {formatRemaining(item.sla_remaining_ms)}
                    </span>
                  </div>
                </div>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
