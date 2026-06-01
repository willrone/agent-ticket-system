import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BotStatus from './BotStatus';
import * as ticketsApi from '../api/tickets';

const mockBots = [
  {
    name: 'cowder',
    agentId: 'cowder',
    displayName: '小牛',
    status: 'active',
    tokens: '43k/200k',
    usage: 22,
    emoji: '🐮',
    currentTask: { id: 2, title: 'Database connection timeout', progress: 65 },
    currentContext: {
      sessionKey: 'agent:cowder:ticket:2',
      sessionType: 'ticket',
      ticketId: 2,
      title: 'Database connection timeout',
      ticketStatus: 'running',
      latestActiveAt: '2026-03-14T15:00:00.000Z',
    },
    contextLatestActiveTime: '2026-03-14T15:00:00.000Z',
    sessions: [{ sessionKey: 'agent:cowder:ticket:2', latestActiveAt: '2026-03-14T15:00:00.000Z' }],
    queue: [{ id: 1, title: 'Login page not loading' }],
    stats: { todayCompleted: 5, avgResponseTime: '2.3min', successRate: 94, uptime: '2d 14h' },
    recentTasks: [{ id: 12, title: 'Fix authentication bug', time: '10:30' }],
  },
  {
    name: 'beavy',
    agentId: 'beavy',
    displayName: '小李',
    status: 'idle',
    tokens: '188k/200k',
    usage: 91,
    emoji: '🦫',
    currentTask: null,
    currentContext: {
      sessionKey: 'agent:beavy:ticket:31',
      sessionType: 'ticket',
      ticketId: 31,
      title: 'Review queue backlog',
      ticketStatus: 'queued',
      latestActiveAt: '2026-03-14T14:50:00.000Z',
    },
    contextLatestActiveTime: '2026-03-14T14:50:00.000Z',
    sessions: [{ sessionKey: 'agent:beavy:ticket:31', latestActiveAt: '2026-03-14T14:50:00.000Z' }],
    queue: [
      { id: 31, title: 'Review queue backlog' },
      { id: 32, title: 'Follow-up runtime drift' },
      { id: 33, title: 'Check flaky worker' },
    ],
    stats: { todayCompleted: 3, avgResponseTime: '2.1min', successRate: 82, uptime: '1d 8h' },
    recentTasks: [],
  },
];

const mockTopology = {
  data: {
    main_gateway_id: 'mac-main',
    gateways: {
      'mac-main': {
        id: 'mac-main',
        label: 'Mac 主平台',
        transport: 'local_cli',
        host_label: 'ronghui’s Mac mini',
        platform_scope: ['ticket-platform', 'stock-platform'],
      },
      'pc-stock': {
        id: 'pc-stock',
        label: 'PC 远端 Gateway',
        transport: 'ssh_gateway_call',
        host_label: 'pc-stock',
        platform_scope: ['stock-platform'],
      },
    },
    agent_gateway_map: {
      beavy: 'mac-main',
      cowder: 'pc-stock',
      leoss: 'mac-main',
      donky: 'pc-stock',
      xiaoying: 'pc-stock',
    },
    agent_directory: {
      leoss: {
        id: 'leoss',
        display_name: '老李',
        emoji: '🧭',
        primary_platform: 'ticket-platform',
        gateway_id: 'mac-main',
        responsibility_summary: '工单平台负责人，承担需求入口、分诊和验收责任。',
        responsibilities: ['platform_owner', 'triage', 'review'],
      },
      beavy: {
        id: 'beavy',
        display_name: '小李',
        emoji: '🦫',
        primary_platform: 'ticket-platform',
        gateway_id: 'mac-main',
        responsibility_summary: '工单平台开发执行人，负责实现、回归与交付。',
        responsibilities: ['development'],
      },
      cowder: {
        id: 'cowder',
        display_name: '小牛',
        emoji: '🐮',
        primary_platform: 'stock-platform',
        gateway_id: 'pc-stock',
        responsibility_summary: '股票平台负责人，承担股票域组织与方向责任。',
        responsibilities: ['platform_owner'],
      },
    },
    platforms: {
      'ticket-platform': {
        id: 'ticket-platform',
        display_name: '工单平台',
        summary: '负责工单生命周期、派单、通知、审计与 agent-facing contract。',
        owner_agent_id: 'leoss',
        triage_owner_agent_id: 'leoss',
        development_agent_ids: ['beavy'],
        review_owner_agent_id: 'leoss',
        delivery_gateway_id: 'mac-main',
      },
      'stock-platform': {
        id: 'stock-platform',
        display_name: '股票平台',
        summary: '负责股票业务实现、远端执行与 reviewer 验收闭环。',
        owner_agent_id: 'cowder',
        triage_owner_agent_id: 'cowder',
        development_agent_ids: ['donky'],
        review_owner_agent_id: 'xiaoying',
        delivery_gateway_id: 'pc-stock',
      },
    },
    responsibility_layers: [
      {
        key: 'platform_owner',
        label: '平台责任',
        summary: '谁对平台方向、责任边界和组织归属负责。',
        assignments: [
          { platform_id: 'ticket-platform', platform_name: '工单平台', actor_id: 'leoss' },
          { platform_id: 'stock-platform', platform_name: '股票平台', actor_id: 'cowder' },
        ],
      },
      {
        key: 'development',
        label: '开发责任',
        summary: '谁真正实现功能、修复问题并完成最小回归。',
        assignments: [
          { platform_id: 'ticket-platform', platform_name: '工单平台', actor_id: 'beavy' },
          { platform_id: 'stock-platform', platform_name: '股票平台', actor_id: 'donky' },
        ],
      },
    ],
    summary: {
      total_agents: 3,
      total_gateways: 2,
      total_platforms: 2,
      total_responsibility_layers: 2,
    },
  },
};

vi.mock('../api/tickets', () => ({
  fetchBots: vi.fn(),
  fetchAgentTopology: vi.fn(),
}));

describe('BotStatus', () => {
  beforeEach(() => {
    vi.mocked(ticketsApi.fetchBots).mockResolvedValue(mockBots);
    vi.mocked(ticketsApi.fetchAgentTopology).mockResolvedValue(mockTopology);
  });

  it('shows loading state initially', () => {
    render(
      <MemoryRouter>
        <BotStatus />
      </MemoryRouter>
    );
    expect(screen.getByText(/加载 Bot 状态中/)).toBeInTheDocument();
  });

  it('renders control-plane overview, topology, responsibility map, exception layer and bot list on success', async () => {
    render(
      <MemoryRouter>
        <BotStatus />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Bot Status/i })).toBeInTheDocument();
    });

    expect(screen.getByText(/Control Plane/i)).toBeInTheDocument();
    expect(screen.getByText('舰队总览', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('异常与人工介入层', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('组织拓扑与宿主路由', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('四层责任地图', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByTestId('topology-platform-grid')).toBeInTheDocument();
    expect(screen.getByTestId('responsibility-map-grid')).toBeInTheDocument();
    expect(screen.getByText('工单平台负责人，承担需求入口、分诊和验收责任。')).toBeInTheDocument();
    expect(screen.getByText('股票平台负责人，承担股票域组织与方向责任。')).toBeInTheDocument();
    expect(screen.getByText('Mac 主平台')).toBeInTheDocument();
    expect(screen.getByText(/token 使用率过高/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /返回 Tickets/i })).toHaveAttribute('href', '/tickets');
  });

  it('shows selected bot detail with overview, current work, runtime, timeline, health and actions', async () => {
    render(
      <MemoryRouter>
        <BotStatus />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getAllByText('小牛').length).toBeGreaterThanOrEqual(1);
    });

    const cowButton = screen.getAllByRole('button').find((b) => b.textContent?.includes('小牛'));
    fireEvent.click(cowButton);

    await waitFor(() => {
      expect(screen.getByText('运行总览')).toBeInTheDocument();
    });

    expect(screen.getByText('当前工作与待办队列')).toBeInTheDocument();
    expect(screen.getByText('运行时与资源会话')).toBeInTheDocument();
    expect(screen.getByText('活动时间线')).toBeInTheDocument();
    expect(screen.getByText('健康度与异常提示')).toBeInTheDocument();
    expect(screen.getByText('人工介入动作')).toBeInTheDocument();
    expect(screen.getAllByText(/Database connection timeout/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('队列详情')).toBeInTheDocument();
    expect(screen.getByText(/Fix authentication bug/)).toBeInTheDocument();
    expect(screen.getAllByText('43k/200k').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('CURRENT CONTEXT')).toBeInTheDocument();
    expect(screen.getByText('LATEST ACTIVE')).toBeInTheDocument();
    expect(screen.getByText(/agent:cowder:ticket:2/)).toBeInTheDocument();
    expect(screen.getByText(/2026-03-14T15:00:00.000Z/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /打开当前工单/ })).toHaveAttribute('href', '/tickets/2');
  });
});
