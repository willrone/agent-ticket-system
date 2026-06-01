import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { TrendingUp, Clock, CheckCircle, AlertCircle, Activity, Shield, ArrowRightLeft } from 'lucide-react';
import { fetchDashboardMetrics } from '../api/dashboard';
import { fetchAgentTopology, fetchBots } from '../api/tickets';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import StatsCard from '../components/StatsCard';
import { summarizeBotHealth } from './botHealth';

const STATUS_BADGE_CLASS = {
  triage: 'status-triage',
  queued: 'status-queued',
  running: 'status-running',
  paused: 'status-paused',
  done: 'status-done',
  review: 'status-review',
  blocked: 'status-blocked',
  pending_decision: 'status-pending_decision',
  failed: 'status-failed',
  complete: 'status-complete',
  deprecated: 'status-deprecated',
};

function normalizeMetrics(payload) {
  const data = payload?.data || payload || {};
  const stats = data.stats || {};
  const board = data.board || {};
  const todaySummary = data.todaySummary || {};
  const riskSummary = data.riskSummary || {};

  return {
    stats: {
      total: Number(stats.total || 0),
      inProgress: Number(stats.inProgress || 0),
      waitingReview: Number(stats.waitingReview || 0),
      closed: Number(stats.closed || 0),
    },
    todaySummary: {
      createdToday: Number(todaySummary.createdToday || 0),
      updatedToday: Number(todaySummary.updatedToday || 0),
      closedToday: Number(todaySummary.closedToday || 0),
      date: todaySummary.date || '',
    },
    riskSummary: {
      blocked: Number(riskSummary.blocked || 0),
      pendingDecision: Number(riskSummary.pendingDecision || 0),
      awaitingReceipt: Number(riskSummary.awaitingReceipt || 0),
      waitingWorker: Number(riskSummary.waitingWorker || 0),
      reviewQueue: Number(riskSummary.reviewQueue || 0),
      waitingDecision: Number(riskSummary.waitingDecision || 0),
      triageGap: Number(riskSummary.triageGap || 0),
    },
    weeklyTickets: Array.isArray(data.weeklyTickets) ? data.weeklyTickets : [],
    statusDistribution: Array.isArray(data.statusDistribution) ? data.statusDistribution : [],
    board: {
      bucketBreakdown: Array.isArray(board.bucketBreakdown) ? board.bucketBreakdown : [],
      platformBreakdown: Array.isArray(board.platformBreakdown) ? board.platformBreakdown : [],
      ownerBreakdown: Array.isArray(board.ownerBreakdown) ? board.ownerBreakdown : [],
      focusBoard: Array.isArray(board.focusBoard) ? board.focusBoard : [],
      responsibilityBoard: Array.isArray(board.responsibilityBoard) ? board.responsibilityBoard : [],
      runtimeDigestBoard: {
        summary: Array.isArray(board.runtimeDigestBoard?.summary) ? board.runtimeDigestBoard.summary : [],
        sections: Array.isArray(board.runtimeDigestBoard?.sections) ? board.runtimeDigestBoard.sections : [],
      },
    },
  };
}

function CompactBreakdown({ title, items, testId }) {
  return (
    <div className="bg-[var(--bg-secondary)] p-6 rounded-lg border border-[var(--border-color)] min-w-0" data-testid={testId}>
      <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">{title}</h2>
      {items.length > 0 ? (
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.key} className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-4 py-3">
              <span className="text-sm text-[var(--text-primary)]">{item.label}</span>
              <span className="text-sm font-semibold text-[var(--accent-primary)]">{item.count}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-[var(--text-secondary)]">暂无数据</div>
      )}
    </div>
  );
}

function TodayProgressBoard({ summary }) {
  const items = [
    { key: 'created', label: '今日新建', value: summary.createdToday },
    { key: 'updated', label: '今日有推进', value: summary.updatedToday },
    { key: 'closed', label: '今日收口', value: summary.closedToday },
  ];

  return (
    <div className="bg-[var(--bg-secondary)] p-6 rounded-lg border border-[var(--border-color)] min-w-0" data-testid="today-progress-board">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">今日推进摘要</h2>
          <p className="text-sm text-[var(--text-secondary)]">今天系统里新进来的票、被推进的票，以及已经收口的票。</p>
        </div>
        <span className="text-xs text-[var(--text-tertiary)]">{summary.date || 'today'}</span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {items.map((item) => (
          <div key={item.key} className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-4 py-4">
            <div className="text-xs text-[var(--text-secondary)]">{item.label}</div>
            <div className="mt-2 text-2xl font-semibold text-[var(--accent-primary)]">{item.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RiskSummaryBoard({ summary }) {
  const items = [
    { key: 'blocked', label: '阻塞票', value: summary.blocked },
    { key: 'pendingDecision', label: '待决策票', value: summary.pendingDecision },
    { key: 'awaitingReceipt', label: '待回执', value: summary.awaitingReceipt },
    { key: 'waitingWorker', label: '待 worker', value: summary.waitingWorker },
    { key: 'reviewQueue', label: '待验收收口', value: summary.reviewQueue },
    { key: 'triageGap', label: '分诊缺口', value: summary.triageGap },
  ];

  return (
    <div className="bg-[var(--bg-secondary)] p-6 rounded-lg border border-[var(--border-color)] min-w-0" data-testid="risk-summary-board">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Risk Trends</h2>
        <p className="text-sm text-[var(--text-secondary)]">把最容易拖慢节奏的风险信号压成一屏摘要，便于先拍板、再下钻。</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <div key={item.key} className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-4 py-4">
            <div className="text-xs text-[var(--text-secondary)]">{item.label}</div>
            <div className="mt-2 text-xl font-semibold text-[var(--accent-primary)]">{item.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FocusBoard({ sections = [] }) {
  return (
    <div className="bg-[var(--bg-secondary)] p-6 rounded-lg border border-[var(--border-color)] min-w-0" data-testid="focus-board">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">统一看盘</h2>
          <p className="text-sm text-[var(--text-secondary)]">按待决策 / 阻塞 / deprecated 聚合当前最需要盯盘的工单。</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {sections.map((section) => (
          <div key={section.key} className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-[var(--text-primary)]">{section.label}</span>
              <span className="text-xs text-[var(--accent-primary)]">{section.count}</span>
            </div>
            {section.items.length > 0 ? (
              <div className="space-y-3">
                {section.items.map((item) => (
                  <div key={item.id} className="rounded-lg border border-[var(--border-color)] px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-[var(--text-primary)]">#{item.id} {item.title}</span>
                      <span className={`status-badge ${STATUS_BADGE_CLASS[item.status] || 'status-queued'}`}>{item.status}</span>
                    </div>
                    <p className="mt-2 text-xs text-[var(--text-secondary)]">{item.detail}</p>
                    <p className="mt-1 text-xs text-[var(--text-tertiary)]">{item.platform || '未分类平台'} · {item.owner || '未指定责任人'}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-[var(--text-secondary)]">当前为空</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ResponsibilityBoard({ items = [] }) {
  return (
    <div className="bg-[var(--bg-secondary)] p-6 rounded-lg border border-[var(--border-color)] min-w-0" data-testid="responsibility-board">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">责任链盘面</h2>
        <p className="text-sm text-[var(--text-secondary)]">把 triage / 执行 / review / decision 责任链与当前 actor 放到同一张盘里。</p>
      </div>
      {items.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border-color)] text-[var(--text-secondary)]">
                <th className="px-3 py-2 font-medium">Ticket</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">当前责任人</th>
                <th className="px-3 py-2 font-medium">Triage</th>
                <th className="px-3 py-2 font-medium">执行</th>
                <th className="px-3 py-2 font-medium">Review</th>
                <th className="px-3 py-2 font-medium">Decision</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-[var(--border-color)] align-top">
                  <td className="px-3 py-3 text-[var(--text-primary)]">#{item.id} {item.title}</td>
                  <td className="px-3 py-3"><span className={`status-badge ${STATUS_BADGE_CLASS[item.status] || 'status-queued'}`}>{item.bucket}</span></td>
                  <td className="px-3 py-3 text-[var(--text-primary)]">
                    <div>{item.current_actor || '未解析'}</div>
                    <div className="text-xs text-[var(--text-secondary)]">{item.current_actor_source || 'source=n/a'}</div>
                  </td>
                  <td className="px-3 py-3 text-[var(--text-secondary)]">{item.triage_owner || '—'}</td>
                  <td className="px-3 py-3 text-[var(--text-secondary)]">{item.assigned_agent || '—'}</td>
                  <td className="px-3 py-3 text-[var(--text-secondary)]">{item.review_owner || '—'}</td>
                  <td className="px-3 py-3 text-[var(--text-secondary)]">{item.decision_owner || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-sm text-[var(--text-secondary)]">暂无责任链数据</div>
      )}
    </div>
  );
}

function RuntimeDigestBoard({ digest = {} }) {
  const summary = Array.isArray(digest.summary) ? digest.summary : [];
  const sections = Array.isArray(digest.sections) ? digest.sections : [];

  return (
    <div className="bg-[var(--bg-secondary)] p-6 rounded-lg border border-[var(--border-color)] min-w-0" data-testid="runtime-digest-board">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Agent Runtime Digest</h2>
        <p className="text-sm text-[var(--text-secondary)]">把待 worker / 待回执 / 待验收收口 / 待决策聚成最小 runtime digest，方便 dashboard 一眼盯闭环风险。</p>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {summary.map((item) => (
          <div key={item.key} className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-4 py-3">
            <div className="text-xs text-[var(--text-secondary)]">{item.label}</div>
            <div className="mt-2 text-xl font-semibold text-[var(--accent-primary)]">{item.count}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        {sections.map((section) => (
          <div key={section.key} className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-[var(--text-primary)]">{section.label}</span>
              <span className="text-xs text-[var(--accent-primary)]">{section.count}</span>
            </div>
            {section.items?.length > 0 ? (
              <div className="space-y-3">
                {section.items.map((item) => (
                  <div key={item.id} className="rounded-lg border border-[var(--border-color)] px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-[var(--text-primary)]">#{item.id} {item.title}</span>
                      <span className={`status-badge ${STATUS_BADGE_CLASS[item.status] || 'status-queued'}`}>{item.status}</span>
                    </div>
                    <p className="mt-2 text-xs text-[var(--text-secondary)]">{item.summary}</p>
                    <p className="mt-1 text-xs text-[var(--text-tertiary)]">{item.execution_mode || 'direct'} · {item.owner || '未指定责任人'}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-[var(--text-secondary)]">当前为空</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function HealthBoard({ platformBreakdown = [], runtimeDigest = {}, botHealth = null, topology = null }) {
  const summary = Array.isArray(runtimeDigest.summary) ? runtimeDigest.summary : [];
  const waitingWorker = summary.find((item) => item.key === 'waiting_worker')?.count || 0;
  const awaitingReceipt = summary.find((item) => item.key === 'awaiting_receipt')?.count || 0;
  const reviewQueue = summary.find((item) => item.key === 'review_queue')?.count || 0;
  const trackedPlatforms = topology?.summary?.total_platforms || platformBreakdown.length;
  const totalGateways = topology?.summary?.total_gateways || Object.keys(topology?.gateways || {}).length || 0;
  const criticalBots = Number(botHealth?.critical || 0);
  const warningBots = Number(botHealth?.warning || 0);
  const healthyBots = Number(botHealth?.healthy || 0);
  const healthLevel = criticalBots > 0 || waitingWorker + awaitingReceipt > 0 ? '需介入' : (warningBots > 0 ? '重点关注' : '稳态');

  const items = [
    { key: 'health', label: 'Gateway / Platform Health', value: healthLevel },
    { key: 'platforms', label: '在盘平台数', value: trackedPlatforms },
    { key: 'gateways', label: 'Gateway 数', value: totalGateways },
    { key: 'bots', label: '健康 Bot / 关注 Bot / 风险 Bot', value: `${healthyBots} / ${warningBots} / ${criticalBots}` },
    { key: 'awaitingReceipt', label: '待回执风险', value: awaitingReceipt },
    { key: 'reviewQueue', label: '待验收积压', value: reviewQueue },
  ];

  return (
    <div className="bg-[var(--bg-secondary)] p-6 rounded-lg border border-[var(--border-color)] min-w-0" data-testid="health-board">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Shield className="h-5 w-5 text-[var(--accent-primary)]" />
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">Gateway / Platform Health</h2>
            <p className="text-sm text-[var(--text-secondary)]">复用 bot/topology + runtime digest，给出控制面的最小健康态摘要。</p>
          </div>
        </div>
        <Link to="/bot-status" className="text-xs font-semibold text-[var(--accent-primary)] hover:underline">查看 Bot / Gateway</Link>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <div key={item.key} className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-4 py-4">
            <div className="text-xs text-[var(--text-secondary)]">{item.label}</div>
            <div className="mt-2 text-xl font-semibold text-[var(--accent-primary)]">{item.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityDigestBoard({ ownerBreakdown = [], runtimeDigest = {} }) {
  const topOwners = ownerBreakdown.slice(0, 5);
  const runtimeSummary = Array.isArray(runtimeDigest.summary) ? runtimeDigest.summary : [];

  return (
    <div className="bg-[var(--bg-secondary)] p-6 rounded-lg border border-[var(--border-color)] min-w-0" data-testid="activity-digest-board">
      <div className="mb-4 flex items-center gap-3">
        <Activity className="h-5 w-5 text-[var(--accent-primary)]" />
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Agent Activity Digest</h2>
          <p className="text-sm text-[var(--text-secondary)]">先用责任人负载 + runtime 信号做 activity digest，作为热力图的可验收等价物。</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] p-4">
          <div className="mb-3 text-sm font-semibold text-[var(--text-primary)]">当前责任人负载</div>
          {topOwners.length > 0 ? (
            <div className="space-y-3">
              {topOwners.map((item) => (
                <div key={item.key} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-[var(--text-primary)]">{item.label}</span>
                  <span className="text-sm font-semibold text-[var(--accent-primary)]">{item.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-[var(--text-secondary)]">暂无 activity 数据</div>
          )}
        </div>

        <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] p-4">
          <div className="mb-3 text-sm font-semibold text-[var(--text-primary)]">运行态热区</div>
          {runtimeSummary.length > 0 ? (
            <div className="space-y-3">
              {runtimeSummary.map((item) => (
                <div key={item.key} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-[var(--text-primary)]">{item.label}</span>
                  <span className="text-sm font-semibold text-[var(--accent-primary)]">{item.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-[var(--text-secondary)]">暂无 runtime 摘要</div>
          )}
        </div>
      </div>
    </div>
  );
}

function DrilldownBoard() {
  const links = [
    { key: 'tickets', label: '工单列表', href: '/tickets', desc: '看全量票和 quick views' },
    { key: 'kanban', label: '工单看板', href: '/kanban', desc: '看状态流转与堆积' },
    { key: 'bots', label: 'Bot / Gateway', href: '/bot-status', desc: '看 bot、gateway 与拓扑健康' },
    { key: 'running', label: '待推进列表', href: '/tickets?quickView=active', desc: '直接下钻到执行面' },
  ];

  return (
    <div className="bg-[var(--bg-secondary)] p-6 rounded-lg border border-[var(--border-color)] min-w-0" data-testid="drilldown-board">
      <div className="mb-4 flex items-center gap-3">
        <ArrowRightLeft className="h-5 w-5 text-[var(--accent-primary)]" />
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">下钻入口</h2>
          <p className="text-sm text-[var(--text-secondary)]">驾驶舱只保留高价值摘要；需要追根时，直接跳到对应操作页。</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {links.map((item) => (
          <Link key={item.key} to={item.href} className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-4 py-4 transition hover:border-[var(--accent-primary)]" data-testid={`drilldown-link-${item.key}`}>
            <div className="text-sm font-semibold text-[var(--text-primary)]">{item.label}</div>
            <div className="mt-2 text-xs text-[var(--text-secondary)]">{item.desc}</div>
            <div className="mt-3 text-xs font-semibold text-[var(--accent-primary)]">进入查看</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function normalizeTopology(payload) {
  const data = payload?.data ?? payload ?? {};
  return {
    gateways: data.gateways ?? {},
    summary: data.summary ?? {},
  };
}

const Dashboard = () => {
  const [metrics, setMetrics] = useState(null);
  const [botHealth, setBotHealth] = useState({ total: 0, healthy: 0, warning: 0, critical: 0 });
  const [topology, setTopology] = useState({ gateways: {}, summary: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadMetrics = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [metricsPayload, botsResult, topologyResult] = await Promise.allSettled([
        fetchDashboardMetrics(),
        fetchBots(),
        fetchAgentTopology(),
      ]);

      if (metricsPayload.status !== 'fulfilled') {
        throw metricsPayload.reason;
      }

      setMetrics(normalizeMetrics(metricsPayload.value));
      setBotHealth(botsResult.status === 'fulfilled' ? summarizeBotHealth(botsResult.value) : { total: 0, healthy: 0, warning: 0, critical: 0 });
      setTopology(topologyResult.status === 'fulfilled' ? normalizeTopology(topologyResult.value) : { gateways: {}, summary: {} });
    } catch (err) {
      setError(err?.message || 'Dashboard 数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  const stats = useMemo(() => {
    if (!metrics) return [];
    return [
      { title: '总工单', value: String(metrics.stats.total), icon: TrendingUp },
      { title: '进行中', value: String(metrics.stats.inProgress), icon: Clock },
      { title: '待验收 / 审核中', value: String(metrics.stats.waitingReview), icon: AlertCircle },
      { title: '已结束', value: String(metrics.stats.closed), icon: CheckCircle },
    ];
  }, [metrics]);

  if (loading) {
    return <LoadingState title="Dashboard 加载中" description="正在拉取指标和趋势数据" />;
  }

  if (error) {
    return <ErrorState title="Dashboard 加载失败" message={error} onRetry={loadMetrics} />;
  }

  return (
    <div className="space-y-6 animate-slide-in">
      <h1 className="text-3xl font-bold text-[var(--text-primary)]">Dashboard</h1>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <StatsCard
            key={stat.title}
            title={stat.title}
            value={stat.value}
            icon={stat.icon}
          />
        ))}
      </div>

      <section className="space-y-6" data-testid="management-summary-section">
        <div>
          <h2 className="text-2xl font-semibold text-[var(--text-primary)]">Management Summary</h2>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">把今日推进、待决策、top blockers、风险趋势、控制面健康和下钻入口收在一屏。</p>
        </div>
        <TodayProgressBoard summary={metrics.todaySummary} />
        <RiskSummaryBoard summary={metrics.riskSummary} />
        <HealthBoard platformBreakdown={metrics.board.platformBreakdown} runtimeDigest={metrics.board.runtimeDigestBoard} botHealth={botHealth} topology={topology} />
        <ActivityDigestBoard ownerBreakdown={metrics.board.ownerBreakdown} runtimeDigest={metrics.board.runtimeDigestBoard} />
        <DrilldownBoard />
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <CompactBreakdown
          title="按平台"
          items={metrics.board.platformBreakdown}
          testId="platform-breakdown"
        />
        <CompactBreakdown
          title="按责任人"
          items={metrics.board.ownerBreakdown}
          testId="owner-breakdown"
        />
        <CompactBreakdown
          title="按 bucket"
          items={metrics.board.bucketBreakdown}
          testId="bucket-breakdown"
        />
      </div>

      <FocusBoard sections={metrics.board.focusBoard} />
      <RuntimeDigestBoard digest={metrics.board.runtimeDigestBoard} />
      <ResponsibilityBoard items={metrics.board.responsibilityBoard} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[var(--bg-secondary)] p-6 rounded-lg border border-[var(--border-color)] min-w-0">
          <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">最近 7 天新增工单</h2>
          {metrics.weeklyTickets.length > 0 ? (
            <div className="h-[300px] min-w-0" data-testid="weekly-tickets-chart">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={metrics.weeklyTickets} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
                  <XAxis dataKey="day" stroke="#8b949e" />
                  <YAxis allowDecimals={false} stroke="#8b949e" />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#151a23',
                      border: '1px solid #30363d',
                      color: '#e6edf3',
                    }}
                  />
                  <Legend wrapperStyle={{ color: '#e6edf3' }} />
                  <Bar name="新增工单" dataKey="tickets" fill="#00d9ff" isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-[var(--text-secondary)]">
              暂无数据
            </div>
          )}
        </div>

        <div className="bg-[var(--bg-secondary)] p-6 rounded-lg border border-[var(--border-color)] min-w-0">
          <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">真实状态分布</h2>
          {metrics.statusDistribution.length > 0 ? (
            <div className="h-[300px] min-w-0" data-testid="status-distribution-chart">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart margin={{ top: 8, right: 16, bottom: 8, left: 16 }}>
                  <Pie
                    data={metrics.statusDistribution}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, value }) => `${name} ${value}`}
                    outerRadius={100}
                    dataKey="value"
                    isAnimationActive={false}
                  >
                    {metrics.statusDistribution.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color || '#00d9ff'} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value, _name, item) => [`${value}`, item?.payload?.name || '状态']}
                    contentStyle={{
                      backgroundColor: '#151a23',
                      border: '1px solid #30363d',
                      color: '#e6edf3',
                    }}
                  />
                  <Legend wrapperStyle={{ color: '#e6edf3' }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-[var(--text-secondary)]">
              暂无数据
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
