import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  ChevronRight,
  Clock3,
  Gauge,
  GitBranch,
  List,
  Network,
  RefreshCw,
  Server,
  ShieldAlert,
  Sparkles,
  TerminalSquare,
  TrendingUp,
  Users,
  Workflow,
  Wrench,
  XCircle,
  Zap,
} from 'lucide-react';
import { fetchAgentTopology, fetchBots } from '../api/tickets';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import { clampUsage, getBotHealth, getBotLoad } from './botHealth';

function normalizeBots(payload) {
  const raw = Array.isArray(payload) ? payload : (payload?.bots ?? payload?.data ?? []);
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((b) => ({
    name: b.name ?? '',
    agentId: b.agentId ?? b.name ?? '',
    displayName: b.displayName ?? b.name ?? '',
    status: b.status ?? 'idle',
    tokens: b.tokens ?? '0k/0k',
    usage: typeof b.usage === 'number' ? b.usage : 0,
    emoji: b.emoji ?? '🤖',
    currentTask: b.currentTask ?? null,
    currentContext: b.currentContext ?? null,
    contextLatestActiveTime: b.contextLatestActiveTime ?? b.currentContext?.latestActiveAt ?? null,
    sessions: Array.isArray(b.sessions) ? b.sessions : [],
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

function normalizeTopology(payload) {
  const data = payload?.data ?? payload ?? {};
  return {
    mainGatewayId: data.main_gateway_id ?? null,
    gateways: data.gateways ?? {},
    agentGatewayMap: data.agent_gateway_map ?? {},
    agentDirectory: data.agent_directory ?? {},
    platforms: data.platforms ?? {},
    responsibilityLayers: Array.isArray(data.responsibility_layers) ? data.responsibility_layers : [],
    topologyEdges: Array.isArray(data.topology_edges) ? data.topology_edges : [],
    summary: data.summary ?? {},
  };
}

function buildActivityTimeline(bot) {
  const items = [];

  if (bot.currentTask) {
    items.push({
      key: `current-${bot.currentTask.id}`,
      tone: 'accent',
      label: '当前执行',
      title: bot.currentTask.title,
      meta: `Ticket #${bot.currentTask.id} · Progress ${bot.currentTask.progress ?? 0}%`,
    });
  }

  bot.queue.slice(0, 3).forEach((task, index) => {
    items.push({
      key: `queue-${task.id}-${index}`,
      tone: 'queue',
      label: `队列 ${index + 1}`,
      title: task.title,
      meta: `Ticket #${task.id} · Waiting`,
    });
  });

  bot.recentTasks.slice(0, 3).forEach((task) => {
    items.push({
      key: `recent-${task.id}`,
      tone: 'done',
      label: '最近完成',
      title: task.title,
      meta: `Ticket #${task.id} · ${task.time || '完成时间未知'}`,
    });
  });

  if (items.length === 0) {
    items.push({
      key: 'idle',
      tone: 'neutral',
      label: '空闲窗口',
      title: '暂无执行、排队或近期完成记录',
      meta: '可用于接单或人工检查配置',
    });
  }

  return items;
}

function buildBotDerived(bot) {
  const health = getBotHealth(bot);
  const { usage, queueDepth, hasCurrentTask, hasObservationTokenPressure } = getBotLoad(bot);
  const currentProgress = bot.currentTask?.progress ?? 0;

  const runtimeSummary = hasCurrentTask
    ? `正在执行 #${bot.currentTask.id}，进度 ${currentProgress}%`
    : queueDepth > 0
      ? `当前空闲，但有 ${queueDepth} 张待处理工单`
      : '当前空闲，可立即接单';

  const interventionReasons = [];
  const observationSignals = [];
  if (queueDepth >= 3) interventionReasons.push('队列堆积');
  if (bot.status === 'idle' && queueDepth > 0) interventionReasons.push('存在待处理但 Bot 未激活');
  if ((Number(bot.stats.successRate) || 0) < 85) interventionReasons.push('成功率偏低');
  if (hasObservationTokenPressure) observationSignals.push('token watermark 偏高（观察项）');

  return {
    ...bot,
    usage,
    queueDepth,
    hasCurrentTask,
    currentProgress,
    health,
    runtimeSummary,
    interventionReasons,
    observationSignals,
    needsAttention: interventionReasons.length > 0,
    timeline: buildActivityTimeline(bot),
  };
}

function StatCard({ label, value, helper, tone = 'text-[var(--text-primary)]', icon: Icon }) {
  return (
    <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-mono uppercase tracking-wider text-[var(--text-secondary)]">{label}</div>
          <div className={`mt-2 text-2xl font-bold ${tone}`}>{value}</div>
          {helper ? <div className="mt-2 text-sm text-[var(--text-secondary)]">{helper}</div> : null}
        </div>
        {Icon ? <Icon className="h-5 w-5 text-[var(--text-secondary)] opacity-80" /> : null}
      </div>
    </div>
  );
}

function SectionCard({ title, eyebrow, icon: Icon, children, aside }) {
  return (
    <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {eyebrow ? <div className="text-xs font-mono uppercase tracking-wider text-[var(--text-secondary)]">{eyebrow}</div> : null}
          <div className="mt-1 flex items-center gap-2 text-base font-bold text-[var(--text-primary)]">
            {Icon ? <Icon className="h-4.5 w-4.5 text-[var(--accent-primary)]" /> : null}
            <span>{title}</span>
          </div>
        </div>
        {aside}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function EmptyPanel({ title, description }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--border-color)] bg-[var(--bg-tertiary)] px-4 py-6 text-sm text-[var(--text-secondary)]">
      <div className="font-medium text-[var(--text-primary)]">{title}</div>
      <div className="mt-1">{description}</div>
    </div>
  );
}

function BotOverview({ bot }) {
  return (
    <SectionCard
      eyebrow="Overview"
      title="运行总览"
      icon={Sparkles}
      aside={<span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium ${bot.health.tone}`}><span className={`h-2.5 w-2.5 rounded-full ${bot.health.dot}`} />{bot.health.label}</span>}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Today Completed" value={bot.stats.todayCompleted} tone="text-[var(--success)]" icon={CheckCircle} />
        <StatCard label="Avg Response" value={bot.stats.avgResponseTime} icon={Clock3} />
        <StatCard label="Success Rate" value={`${bot.stats.successRate}%`} tone="text-[var(--accent-primary)]" icon={TrendingUp} />
        <StatCard label="Uptime" value={bot.stats.uptime} icon={Server} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)]">
        <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-[var(--text-secondary)]">
            <Gauge className="h-3.5 w-3.5" />
            Runtime Summary
          </div>
          <div className="mt-3 text-base font-semibold text-[var(--text-primary)]">{bot.runtimeSummary}</div>
          <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{bot.health.summary}</div>
        </div>

        <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-[var(--text-secondary)]">
            <Users className="h-3.5 w-3.5" />
            Capacity Snapshot
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            <div>
              <div className="text-xs font-mono text-[var(--text-secondary)]">STATUS</div>
              <div className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{bot.status === 'active' ? 'ACTIVE' : 'IDLE'}</div>
            </div>
            <div>
              <div className="text-xs font-mono text-[var(--text-secondary)]">QUEUE</div>
              <div className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{bot.queueDepth}</div>
            </div>
            <div>
              <div className="text-xs font-mono text-[var(--text-secondary)]">TOKENS</div>
              <div className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{bot.tokens}</div>
            </div>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

function TopologySection({ topology, bots }) {
  const gatewayEntries = Object.values(topology.gateways || {});
  const platformEntries = Object.values(topology.platforms || {});
  const agentEntries = Object.values(topology.agentDirectory || {});
  const botIndex = new Map(bots.map((bot) => [bot.agentId, bot]));

  return (
    <SectionCard
      eyebrow="Organization / Routing"
      title="组织拓扑与宿主路由"
      icon={Network}
      aside={<span className="rounded-full border border-[var(--border-color)] px-2.5 py-1 text-xs font-mono text-[var(--text-secondary)]">{topology.summary?.total_agents || agentEntries.length} agents</span>}
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2" data-testid="topology-platform-grid">
            {platformEntries.map((platform) => (
              <div key={platform.id} className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4">
                <div className="text-xs font-mono uppercase tracking-wider text-[var(--text-secondary)]">PLATFORM</div>
                <div className="mt-2 text-base font-semibold text-[var(--text-primary)]">{platform.display_name}</div>
                <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{platform.summary}</div>
                <div className="mt-3 space-y-1 text-xs text-[var(--text-secondary)]">
                  <div>Owner：{platform.owner_agent_id || '—'}</div>
                  <div>Triage：{platform.triage_owner_agent_id || '—'}</div>
                  <div>Develop：{Array.isArray(platform.development_agent_ids) ? platform.development_agent_ids.join(', ') || '—' : '—'}</div>
                  <div>Review：{platform.review_owner_agent_id || '—'}</div>
                  <div>Gateway：{platform.delivery_gateway_id || '—'}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4" data-testid="topology-gateway-list">
            <div className="mb-3 flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]">
              <Server className="h-4 w-4" />
              <span>Host / Gateway 连接关系</span>
            </div>
            <div className="space-y-3">
              {gatewayEntries.map((gateway) => (
                <div key={gateway.id} className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-[var(--text-primary)]">{gateway.label}</div>
                      <div className="mt-1 text-xs font-mono text-[var(--text-secondary)]">{gateway.id} · {gateway.transport}</div>
                    </div>
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-mono ${topology.mainGatewayId === gateway.id ? 'border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]' : 'border-[var(--border-color)] text-[var(--text-secondary)]'}`}>
                      {topology.mainGatewayId === gateway.id ? 'MAIN' : 'REMOTE'}
                    </span>
                  </div>
                  <div className="mt-3 text-sm text-[var(--text-secondary)]">
                    Host：{gateway.host_label || '—'} · Scope：{Array.isArray(gateway.platform_scope) ? gateway.platform_scope.join(', ') : '—'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4" data-testid="topology-agent-list">
          <div className="mb-3 flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]">
            <GitBranch className="h-4 w-4" />
            <span>Agent 节点与责任归属</span>
          </div>
          <div className="space-y-3">
            {agentEntries.map((agent) => {
              const bot = botIndex.get(agent.id);
              return (
                <div key={agent.id} className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-[var(--text-primary)]">{agent.emoji || '🤖'} {agent.display_name}</div>
                      <div className="mt-1 text-xs font-mono text-[var(--text-secondary)]">{agent.id} · {agent.primary_platform || 'unscoped'}</div>
                    </div>
                    <span className="rounded-full border border-[var(--border-color)] px-2.5 py-1 text-xs font-mono text-[var(--text-secondary)]">{agent.gateway_id || '—'}</span>
                  </div>
                  <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{agent.responsibility_summary || '暂无责任摘要。'}</div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {(agent.responsibilities || []).map((item) => (
                      <span key={`${agent.id}-${item}`} className="rounded-full border border-[var(--border-color)] px-2 py-0.5 text-[var(--text-secondary)]">{item}</span>
                    ))}
                    {bot ? <span className={`rounded-full border px-2 py-0.5 ${bot.health.tone}`}>{bot.health.label}</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

function ResponsibilityMapSection({ topology }) {
  return (
    <SectionCard
      eyebrow="Ownership / Responsibility"
      title="四层责任地图"
      icon={GitBranch}
      aside={<span className="rounded-full border border-[var(--border-color)] px-2.5 py-1 text-xs font-mono text-[var(--text-secondary)]">{topology.responsibilityLayers.length} layers</span>}
    >
      <div className="grid gap-4 lg:grid-cols-2" data-testid="responsibility-map-grid">
        {topology.responsibilityLayers.map((layer) => (
          <div key={layer.key} className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4">
            <div className="text-xs font-mono uppercase tracking-wider text-[var(--text-secondary)]">{layer.key}</div>
            <div className="mt-2 text-base font-semibold text-[var(--text-primary)]">{layer.label}</div>
            <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{layer.summary}</div>
            <div className="mt-4 space-y-2">
              {(layer.assignments || []).map((assignment) => (
                <div key={`${layer.key}-${assignment.platform_id}`} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-sm">
                  <span className="text-[var(--text-primary)]">{assignment.platform_name}</span>
                  <span className="font-mono text-[var(--text-secondary)]">{assignment.actor_id}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function BotCurrentWork({ bot }) {
  return (
    <SectionCard
      eyebrow="Current Work"
      title="当前工作与待办队列"
      icon={Workflow}
      aside={<span className="rounded-full border border-[var(--border-color)] px-2.5 py-1 text-xs font-mono text-[var(--text-secondary)]">Queue {bot.queueDepth}</span>}
    >
      <div className="space-y-4">
        {bot.currentTask ? (
          <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-xs font-mono text-[var(--text-secondary)]">CURRENT TASK</div>
                <Link to={`/tickets/${bot.currentTask.id}`} className="mt-1 inline-block text-base font-semibold text-[var(--text-primary)] transition-colors hover:text-[var(--accent-primary)]">
                  #{bot.currentTask.id.toString().padStart(4, '0')} {bot.currentTask.title}
                </Link>
              </div>
              <span className="rounded-full border border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 px-2.5 py-1 text-xs font-mono text-[var(--accent-primary)]">
                {bot.currentProgress}%
              </span>
            </div>

            <div className="mt-4 flex items-center justify-between text-xs text-[var(--text-secondary)]">
              <span className="font-mono">PROGRESS</span>
              <span className="font-mono">{bot.currentProgress}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full border border-[var(--border-color)] bg-[var(--bg-primary)]">
              <div className="h-2 bg-[var(--accent-primary)] transition-all duration-500" style={{ width: `${bot.currentProgress}%` }} />
            </div>
          </div>
        ) : (
          <EmptyPanel title="当前无在执行工单" description="Bot 当前没有 running 中的票，可以结合队列与异常面板判断是否需要人工接单或刷新状态。" />
        )}

        <div>
          <div className="mb-3 flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]">
            <List className="h-4 w-4" />
            <span>队列详情</span>
          </div>

          {bot.queue.length > 0 ? (
            <div className="space-y-3">
              {bot.queue.map((task, index) => (
                <Link
                  key={task.id}
                  to={`/tickets/${task.id}`}
                  className="flex items-start justify-between gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4 transition-colors hover:border-[var(--accent-primary)]"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-mono text-[var(--text-secondary)]">QUEUE #{index + 1}</div>
                    <div className="mt-1 text-sm font-medium text-[var(--text-primary)]">{task.title}</div>
                  </div>
                  <div className="text-xs font-mono text-[var(--accent-primary)]">#{task.id}</div>
                </Link>
              ))}
            </div>
          ) : (
            <EmptyPanel title="队列为空" description="当前没有排队工单，Bot 处于可继续接单或等待调度状态。" />
          )}
        </div>
      </div>
    </SectionCard>
  );
}

function BotRuntime({ bot }) {
  return (
    <SectionCard eyebrow="Runtime / Sessions" title="运行时与资源会话" icon={TerminalSquare}>
      <div className="space-y-4">
        <div>
          <div className="mb-2 flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span className="font-mono">TOKENS</span>
            <span className="font-mono">{bot.tokens}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full border border-[var(--border-color)] bg-[var(--bg-primary)]">
            <div
              className={`h-2 transition-all duration-500 ${bot.usage > 70 ? 'bg-[var(--danger)]' : bot.usage > 40 ? 'bg-[var(--warning)]' : 'bg-[var(--success)]'}`}
              style={{ width: `${bot.usage}%` }}
            />
          </div>
          <div className="mt-2 text-xs text-[var(--text-secondary)]">当前使用率 {bot.usage}%</div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
          <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4">
            <div className="flex items-center gap-2 text-xs font-mono text-[var(--text-secondary)]"><TrendingUp className="h-3.5 w-3.5" /> SUCCESS</div>
            <div className="mt-2 text-lg font-bold text-[var(--text-primary)]">{bot.stats.successRate}%</div>
            <div className="mt-1 text-xs text-[var(--text-secondary)]">用于判断执行稳定性</div>
          </div>
          <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4">
            <div className="flex items-center gap-2 text-xs font-mono text-[var(--text-secondary)]"><Clock3 className="h-3.5 w-3.5" /> UPTIME</div>
            <div className="mt-2 text-lg font-bold text-[var(--text-primary)]">{bot.stats.uptime}</div>
            <div className="mt-1 text-xs text-[var(--text-secondary)]">结合长跑稳定性做排障</div>
          </div>
          <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4 sm:col-span-2 xl:col-span-1">
            <div className="flex items-center gap-2 text-xs font-mono text-[var(--text-secondary)]"><TerminalSquare className="h-3.5 w-3.5" /> CURRENT CONTEXT</div>
            <div className="mt-2 text-sm font-semibold text-[var(--text-primary)] break-all">{bot.currentContext?.sessionKey || '—'}</div>
            <div className="mt-1 text-xs text-[var(--text-secondary)]">{bot.currentContext?.title ? `${bot.currentContext.title}${bot.currentContext?.ticketId ? ` · Ticket #${bot.currentContext.ticketId}` : ''}` : '按 session 真值选出的当前上下文'}</div>
          </div>
          <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4 sm:col-span-2 xl:col-span-1">
            <div className="flex items-center gap-2 text-xs font-mono text-[var(--text-secondary)]"><Activity className="h-3.5 w-3.5" /> LATEST ACTIVE</div>
            <div className="mt-2 text-lg font-bold text-[var(--text-primary)]">{bot.contextLatestActiveTime || '—'}</div>
            <div className="mt-1 text-xs text-[var(--text-secondary)]">当前 context latest active time</div>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

function BotTimeline({ bot }) {
  return (
    <SectionCard eyebrow="Activity Timeline" title="活动时间线" icon={Activity}>
      <div className="space-y-3">
        {bot.timeline.map((item) => {
          const toneClass = item.tone === 'accent'
            ? 'border-[var(--accent-primary)]/30 bg-[var(--accent-primary)]/10'
            : item.tone === 'done'
              ? 'border-emerald-500/30 bg-emerald-500/10'
              : item.tone === 'queue'
                ? 'border-amber-500/30 bg-amber-500/10'
                : 'border-[var(--border-color)] bg-[var(--bg-tertiary)]';

          return (
            <div key={item.key} className={`rounded-xl border p-4 ${toneClass}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-mono uppercase tracking-wider text-[var(--text-secondary)]">{item.label}</div>
                <div className="text-xs font-mono text-[var(--text-secondary)]">{item.meta}</div>
              </div>
              <div className="mt-2 text-sm font-medium text-[var(--text-primary)]">{item.title}</div>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

function BotHealthPanel({ bot }) {
  return (
    <SectionCard
      eyebrow="Health / Errors"
      title="健康度与异常提示"
      icon={ShieldAlert}
      aside={bot.needsAttention ? <span className="inline-flex items-center gap-2 rounded-full border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-200"><AlertTriangle className="h-3.5 w-3.5" />需要人工介入</span> : null}
    >
      {bot.needsAttention ? (
        <div className="space-y-3">
          {bot.interventionReasons.map((reason) => (
            <div key={reason} className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              {reason}
            </div>
          ))}
        </div>
      ) : (
        <EmptyPanel title="当前未发现明显异常" description="从现有 fetchBots 数据看，Bot 暂无高负载、堆积或成功率异常信号。" />
      )}
    </SectionCard>
  );
}

function BotActions({ bot, onBack, onRefresh }) {
  return (
    <SectionCard eyebrow="Actions" title="人工介入动作" icon={Wrench}>
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-4 py-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent-primary)]"
        >
          <RefreshCw className="h-4 w-4" />
          刷新运营台数据
        </button>

        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-4 py-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent-primary)]"
        >
          <ArrowLeft className="h-4 w-4" />
          返回 Bot 列表
        </button>

        {bot.currentTask ? (
          <Link
            to={`/tickets/${bot.currentTask.id}`}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 px-4 py-3 text-sm font-medium text-[var(--accent-primary)] transition-opacity hover:opacity-90"
          >
            <Zap className="h-4 w-4" />
            打开当前工单
          </Link>
        ) : (
          <Link
            to="/tickets"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-4 py-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent-primary)]"
          >
            <Workflow className="h-4 w-4" />
            去 Tickets 查看待分配工单
          </Link>
        )}

        <Link
          to="/tickets"
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-4 py-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent-primary)]"
        >
          <ChevronRight className="h-4 w-4" />
          回到 Tickets 主链路
        </Link>
      </div>
    </SectionCard>
  );
}

function BotDetail({ bot, onBack, onRefresh }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-5">
        <div className="flex items-center gap-4">
          <span className="text-4xl">{bot.emoji}</span>
          <div>
            <div className="text-2xl font-bold text-[var(--text-primary)]">{bot.displayName}</div>
            <div className="text-sm font-mono text-[var(--text-secondary)]">{bot.name}</div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium ${bot.status === 'active' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'}`}>
            <span className={`h-2.5 w-2.5 rounded-full ${bot.status === 'active' ? 'bg-emerald-400' : 'bg-[var(--text-secondary)]'}`} />
            {bot.status === 'active' ? 'ACTIVE' : 'IDLE'}
          </span>
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-color)] px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            <ArrowLeft className="h-4 w-4" />
            返回列表
          </button>
        </div>
      </div>

      <BotOverview bot={bot} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <div className="space-y-4">
          <BotCurrentWork bot={bot} />
          <BotTimeline bot={bot} />
        </div>

        <div className="space-y-4">
          <BotRuntime bot={bot} />
          <BotHealthPanel bot={bot} />
          <BotActions bot={bot} onBack={onBack} onRefresh={onRefresh} />
        </div>
      </div>
    </div>
  );
}

export default function BotStatus() {
  const [bots, setBots] = useState([]);
  const [topology, setTopology] = useState(() => normalizeTopology({}));
  const [selectedBot, setSelectedBot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadBots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [botResponse, topologyResponse] = await Promise.all([
        fetchBots(),
        fetchAgentTopology(),
      ]);
      const normalized = normalizeBots(botResponse).map(buildBotDerived);
      setBots(normalized);
      setTopology(normalizeTopology(topologyResponse));
      setSelectedBot((prev) => normalized.find((bot) => bot.name === prev)?.name ?? null);
    } catch (err) {
      setError(err?.message || '加载 Bot 状态失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBots();
  }, [loadBots]);

  const selected = useMemo(
    () => bots.find((bot) => bot.name === selectedBot) ?? null,
    [bots, selectedBot]
  );

  const fleetStats = useMemo(() => ({
    total: bots.length,
    active: bots.filter((bot) => bot.status === 'active').length,
    busy: bots.filter((bot) => bot.hasCurrentTask).length,
    queued: bots.reduce((sum, bot) => sum + bot.queueDepth, 0),
    attention: bots.filter((bot) => bot.needsAttention).length,
    idleReady: bots.filter((bot) => bot.status === 'idle' && !bot.hasCurrentTask && bot.queueDepth === 0).length,
    avgSuccessRate: bots.length ? Math.round(bots.reduce((sum, bot) => sum + (Number(bot.stats.successRate) || 0), 0) / bots.length) : 0,
  }), [bots]);

  const attentionBots = useMemo(
    () => bots.filter((bot) => bot.needsAttention || bot.health.level !== 'healthy'),
    [bots]
  );

  const selectedHint = selected ? `当前焦点：${selected.displayName}` : '从左侧列表选择一个 Bot 进入详情面板';

  if (loading) {
    return <LoadingState title="加载 Bot 状态中..." description="正在获取最新执行与资源信息" />;
  }

  if (error) {
    return <ErrorState title="加载失败" message={error} onRetry={loadBots} />;
  }

  return (
    <div className="space-y-6 animate-slide-in">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--accent-primary)]">Control Plane</div>
          <h1 className="mt-2 text-3xl font-bold text-[var(--text-primary)]">Bot Status</h1>
          <p className="mt-1 text-sm font-mono text-[var(--text-secondary)]">独立运营台：从舰队总览、组织拓扑、责任地图到 Bot 详情与人工介入，全程不改 Tickets 主链路语义。</p>
        </div>

        <div className="flex gap-3">
          <Link
            to="/tickets"
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-color)] px-4 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            <ArrowLeft className="h-4 w-4" />
            返回 Tickets
          </Link>
          <button
            type="button"
            onClick={loadBots}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent-primary)] px-4 py-2 text-sm font-bold text-[var(--bg-primary)] transition-opacity hover:opacity-90"
          >
            <RefreshCw className="h-4 w-4" />
            刷新
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Total Bots" value={fleetStats.total} helper="运营台纳管 Bot 数" icon={Users} />
        <StatCard label="Active Now" value={fleetStats.active} helper="当前激活实例" tone="text-[var(--success)]" icon={Activity} />
        <StatCard label="Working Now" value={fleetStats.busy} helper="有执行中任务" tone="text-[var(--accent-primary)]" icon={Workflow} />
        <StatCard label="Queued Tasks" value={fleetStats.queued} helper="累计排队工单" tone="text-yellow-300" icon={List} />
        <StatCard label="Need Attention" value={fleetStats.attention} helper={`平均成功率 ${fleetStats.avgSuccessRate}%`} tone="text-red-300" icon={AlertTriangle} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <SectionCard eyebrow="Overview Layer" title="舰队总览" icon={Sparkles}>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4">
              <div className="text-xs font-mono uppercase tracking-wider text-[var(--text-secondary)]">Control Summary</div>
              <div className="mt-3 text-base font-semibold text-[var(--text-primary)]">{fleetStats.active} 个活跃 / {fleetStats.idleReady} 个待命</div>
              <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">帮助快速判断当前是偏执行高峰、待命富余，还是需要人工分流。</div>
            </div>
            <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4">
              <div className="text-xs font-mono uppercase tracking-wider text-[var(--text-secondary)]">Queue Pressure</div>
              <div className="mt-3 text-base font-semibold text-[var(--text-primary)]">累计 {fleetStats.queued} 张排队</div>
              <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">仅基于现有 fetchBots.queue 做前端聚合，不引入任何新后端 contract。</div>
            </div>
            <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4">
              <div className="text-xs font-mono uppercase tracking-wider text-[var(--text-secondary)]">Manual Intervention</div>
              <div className="mt-3 text-base font-semibold text-[var(--text-primary)]">{fleetStats.attention > 0 ? `${fleetStats.attention} 个 Bot 需关注` : '当前无明显异常'}</div>
              <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">只把可行动风险收口到 Need Attention；idle 且无任务/队列的 token watermark 仅保留为观察信号。</div>
            </div>
          </div>
        </SectionCard>

        <SectionCard
          eyebrow="Exception / Human in the Loop"
          title="异常与人工介入层"
          icon={ShieldAlert}
          aside={<span className="rounded-full border border-[var(--border-color)] px-2.5 py-1 text-xs font-mono text-[var(--text-secondary)]">{attentionBots.length} bots</span>}
        >
          {attentionBots.length > 0 ? (
            <div className="space-y-3">
              {attentionBots.map((bot) => (
                <button
                  key={bot.name}
                  type="button"
                  onClick={() => setSelectedBot(bot.name)}
                  className="w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-4 text-left transition-colors hover:border-[var(--accent-primary)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                        <span>{bot.emoji}</span>
                        <span>{bot.displayName}</span>
                      </div>
                      <div className="mt-1 text-xs font-mono text-[var(--text-secondary)]">{bot.name}</div>
                    </div>
                    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${bot.health.tone}`}>{bot.health.label}</span>
                  </div>
                  <div className="mt-3 text-sm text-[var(--text-secondary)]">
                    {bot.interventionReasons.length > 0 ? bot.interventionReasons.join(' / ') : bot.health.summary}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <EmptyPanel title="暂时没有异常 Bot" description="目前 Bot 运行平稳，人工介入层保持空态。" />
          )}
        </SectionCard>
      </div>

      <TopologySection topology={topology} bots={bots} />
      <ResponsibilityMapSection topology={topology} />

      <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-bold text-[var(--text-primary)]">
                <Activity className="h-5 w-5 text-[var(--accent-primary)]" />
                <span>Bot Fleet</span>
              </h2>
              <p className="mt-1 text-xs font-mono text-[var(--text-secondary)]">列表层：按 Bot 选择详情视角</p>
            </div>
            <span className="text-xs font-mono text-[var(--text-secondary)]">LIVE</span>
          </div>

          <div className="mt-4 rounded-xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs font-mono text-[var(--text-secondary)]">
            {selectedHint}
          </div>

          <div className="mt-4 space-y-3">
            {bots.map((bot) => (
              <button
                key={bot.name}
                type="button"
                onClick={() => setSelectedBot(bot.name)}
                className={`w-full rounded-xl border p-4 text-left transition-all duration-200 ${selectedBot === bot.name ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10' : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] hover:border-[var(--accent-primary)]'}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="text-2xl">{bot.emoji}</span>
                    <div className="min-w-0">
                      <div className="truncate font-bold text-[var(--text-primary)]">{bot.displayName}</div>
                      <div className="text-xs font-mono text-[var(--text-secondary)]">{bot.name}</div>
                    </div>
                  </div>
                  <span className={`inline-flex h-2.5 w-2.5 rounded-full ${bot.status === 'active' ? 'bg-[var(--success)]' : 'bg-[var(--text-secondary)]'}`} />
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[var(--text-secondary)]">
                  <div className="rounded-lg border border-[var(--border-color)] px-2.5 py-2">
                    <div className="font-mono">TODAY</div>
                    <div className="mt-1 text-sm text-[var(--text-primary)]">{bot.stats.todayCompleted}</div>
                  </div>
                  <div className="rounded-lg border border-[var(--border-color)] px-2.5 py-2">
                    <div className="font-mono">QUEUE</div>
                    <div className="mt-1 text-sm text-[var(--text-primary)]">{bot.queueDepth}</div>
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[var(--text-secondary)]">
                  <span className="font-mono">{bot.tokens}</span>
                  <span className={`inline-flex rounded-full border px-2 py-0.5 ${bot.health.tone}`}>{bot.health.label}</span>
                </div>

                {bot.currentTask ? (
                  <div className="mt-3 border-t border-[var(--border-color)] pt-2">
                    <div className="font-semibold text-[var(--accent-primary)]">WORKING ON</div>
                    <div className="mt-1 truncate text-[var(--text-primary)]">{bot.currentTask.title}</div>
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        </aside>

        <section>
          {selected ? (
            <BotDetail bot={selected} onBack={() => setSelectedBot(null)} onRefresh={loadBots} />
          ) : (
            <div className="rounded-2xl border border-dashed border-[var(--border-color)] bg-[var(--bg-secondary)] px-6 py-16 text-center">
              <XCircle className="mx-auto h-12 w-12 text-[var(--text-secondary)] opacity-70" />
              <h2 className="mt-4 text-xl font-bold text-[var(--text-primary)]">选择一个 Bot 查看控制面板详情</h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">详情层已拆成 Overview / Current Work / Runtime / Activity Timeline / Health / Actions，方便独立运营和人工介入。</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
