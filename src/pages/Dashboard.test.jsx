import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';
import * as dashboardApi from '../api/dashboard';
import * as ticketsApi from '../api/tickets';

const rechartsProps = vi.hoisted(() => ({
  barProps: [],
  pieProps: [],
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }) => <div data-testid="recharts-responsive-container">{children}</div>,
  BarChart: ({ children }) => <div data-testid="recharts-bar-chart">{children}</div>,
  Bar: (props) => {
    rechartsProps.barProps.push(props);
    return <div data-testid="recharts-bar" />;
  },
  XAxis: () => <div data-testid="recharts-x-axis" />,
  YAxis: () => <div data-testid="recharts-y-axis" />,
  CartesianGrid: () => <div data-testid="recharts-grid" />,
  Tooltip: () => <div data-testid="recharts-tooltip" />,
  Legend: () => <div data-testid="recharts-legend" />,
  PieChart: ({ children }) => <div data-testid="recharts-pie-chart">{children}</div>,
  Pie: (props) => {
    rechartsProps.pieProps.push(props);
    return <div data-testid="recharts-pie">{props.children}</div>;
  },
  Cell: () => <div data-testid="recharts-cell" />,
}));

const mockMetrics = {
  data: {
    stats: { total: 5, active: 3, inProgress: 1, waitingReview: 1, closed: 2 },
    todaySummary: { createdToday: 1, updatedToday: 3, closedToday: 0, date: '2026-03-11' },
    riskSummary: { blocked: 1, pendingDecision: 1, awaitingReceipt: 0, waitingWorker: 0, reviewQueue: 0, triageGap: 0 },
    weeklyTickets: [
      { day: '2026-03-03', tickets: 1 },
      { day: '2026-03-04', tickets: 2 },
      { day: '2026-03-05', tickets: 2 },
    ],
    statusDistribution: [
      { status: 'running', name: '进行中', value: 1, color: '#f59e0b' },
      { status: 'done', name: '待验收', value: 1, color: '#22c55e' },
      { status: 'complete', name: '已关单', value: 2, color: '#10b981' },
      { status: 'queued', name: '待处理', value: 1, color: '#3b82f6' },
    ],
    board: {
      platformBreakdown: [
        { key: 'ticket-platform', label: 'ticket-platform', count: 4 },
        { key: 'stock', label: 'stock', count: 1 },
      ],
      ownerBreakdown: [
        { key: 'beavy', label: 'beavy', count: 3 },
        { key: '荣晖', label: '荣晖', count: 1 },
      ],
      bucketBreakdown: [
        { key: 'active', label: '待推进', count: 2 },
        { key: 'waiting_review', label: '待验收', count: 1 },
        { key: 'waiting_decision', label: '待决策', count: 1 },
        { key: 'deprecated', label: '已废弃', count: 1 },
      ],
      focusBoard: [
        {
          key: 'pending_decision',
          label: '待决策',
          count: 1,
          items: [{ id: 12, title: 'Need boss decision', status: 'pending_decision', platform: 'ticket-platform', owner: '荣晖', detail: '需要确认是否继续开放。' }],
        },
        {
          key: 'blocked',
          label: '阻塞',
          count: 1,
          items: [{ id: 18, title: 'Blocked by upstream', status: 'blocked', platform: 'ticket-platform', owner: 'beavy', detail: '上游接口未开放。' }],
        },
        {
          key: 'deprecated',
          label: '已废弃',
          count: 1,
          items: [{ id: 21, title: 'Legacy leftover', status: 'deprecated', platform: 'stock', owner: 'leoss', detail: '历史残留 / 不再进入当前流程' }],
        },
      ],
      responsibilityBoard: [
        { id: 12, title: 'Need boss decision', status: 'pending_decision', bucket: 'waiting_decision', current_actor: '荣晖', current_actor_source: 'decision_owner', triage_owner: 'leoss', assigned_agent: 'beavy', review_owner: 'leoss', decision_owner: '荣晖' },
        { id: 18, title: 'Blocked by upstream', status: 'blocked', bucket: 'blocked', current_actor: 'beavy', current_actor_source: 'assigned_agent', triage_owner: 'leoss', assigned_agent: 'beavy', review_owner: 'leoss', decision_owner: '荣晖' },
      ],
    },
  },
};

const mockBots = [
  {
    name: 'beavy',
    status: 'active',
    usage: 72,
    queue: [{ id: 1, title: 'Queued task' }],
    currentTask: { id: 12, title: 'Need boss decision', progress: 40 },
    stats: { successRate: 96 },
  },
  {
    name: 'donky',
    status: 'idle',
    usage: 12,
    queue: [],
    currentTask: null,
    stats: { successRate: 99 },
  },
];

const mockTopology = {
  data: {
    gateways: {
      'mac-main': { id: 'mac-main', label: 'Mac 主平台' },
      'pc-stock': { id: 'pc-stock', label: 'PC 远端 Gateway' },
    },
    summary: {
      total_platforms: 2,
      total_gateways: 2,
    },
  },
};

vi.mock('../api/dashboard', () => ({
  fetchDashboardMetrics: vi.fn(),
}));

vi.mock('../api/tickets', () => ({
  fetchBots: vi.fn(),
  fetchAgentTopology: vi.fn(),
}));

describe('Dashboard', () => {
  beforeEach(() => {
    rechartsProps.barProps.length = 0;
    rechartsProps.pieProps.length = 0;
    vi.mocked(dashboardApi.fetchDashboardMetrics).mockResolvedValue(mockMetrics);
    vi.mocked(ticketsApi.fetchBots).mockResolvedValue(mockBots);
    vi.mocked(ticketsApi.fetchAgentTopology).mockResolvedValue(mockTopology);
  });

  it('shows loading state initially', () => {
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    expect(screen.getByText(/Dashboard 加载中/)).toBeInTheDocument();
  });

  it('renders dashboard with runtime-semantic stats on success', async () => {
    const { container } = render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText(/Dashboard/)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('today-progress-board')).toBeInTheDocument();
    });
    expect(screen.getByText('总工单')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(screen.getByText('待验收 / 审核中')).toBeInTheDocument();
    expect(screen.getByText('已结束')).toBeInTheDocument();

    const statCards = Array.from(container.querySelectorAll('.stat-card')).map((card) => card.textContent || '');
    expect(statCards).toEqual(expect.arrayContaining([
      expect.stringContaining('总工单5'),
      expect.stringContaining('进行中1'),
      expect.stringContaining('待验收 / 审核中1'),
      expect.stringContaining('已结束2'),
    ]));

    expect(screen.getByText('最近 7 天新增工单')).toBeInTheDocument();
    expect(screen.getByText('真实状态分布')).toBeInTheDocument();
    expect(screen.getByText('统一看盘')).toBeInTheDocument();
    expect(screen.getByText('Agent Runtime Digest')).toBeInTheDocument();
    expect(screen.getByText('责任链盘面')).toBeInTheDocument();
    expect(screen.getByTestId('platform-breakdown')).toBeInTheDocument();
    expect(screen.getByTestId('owner-breakdown')).toBeInTheDocument();
    expect(screen.getByTestId('bucket-breakdown')).toBeInTheDocument();
    expect(screen.getByTestId('focus-board')).toBeInTheDocument();
    expect(screen.getByTestId('runtime-digest-board')).toBeInTheDocument();
    expect(screen.getByTestId('responsibility-board')).toBeInTheDocument();
    expect(screen.getByText('ticket-platform')).toBeInTheDocument();
    expect(screen.getAllByText(/Need boss decision/).length).toBeGreaterThan(0);
    expect(screen.getByText('当前责任人')).toBeInTheDocument();
    expect(screen.getByTestId('weekly-tickets-chart')).toBeInTheDocument();
    expect(screen.getByTestId('status-distribution-chart')).toBeInTheDocument();
    expect(screen.getByTestId('management-summary-section')).toBeInTheDocument();
    expect(screen.getByTestId('today-progress-board')).toBeInTheDocument();
    expect(screen.getByTestId('risk-summary-board')).toBeInTheDocument();
    expect(screen.getByTestId('health-board')).toBeInTheDocument();
    expect(screen.getByTestId('activity-digest-board')).toBeInTheDocument();
    expect(screen.getByTestId('drilldown-board')).toBeInTheDocument();
    expect(screen.getByText('Management Summary')).toBeInTheDocument();
    expect(screen.getByText('今日推进摘要')).toBeInTheDocument();
    expect(screen.getByText('Risk Trends')).toBeInTheDocument();
    expect(screen.getAllByText(/Gateway \/ Platform Health/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Agent Activity Digest/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /工单列表/ })).toHaveAttribute('href', '/tickets');
    expect(screen.getByRole('link', { name: /工单看板/ })).toHaveAttribute('href', '/kanban');
    expect(screen.getByRole('link', { name: /查看 Bot \/ Gateway/ })).toHaveAttribute('href', '/bot-status');
    expect(rechartsProps.barProps[0]).toMatchObject({
      dataKey: 'tickets',
      isAnimationActive: false,
      name: '新增工单',
    });
    expect(rechartsProps.pieProps[0]).toMatchObject({
      dataKey: 'value',
      isAnimationActive: false,
    });
    expect(dashboardApi.fetchDashboardMetrics).toHaveBeenCalled();
  });

  it('shows error state and retry on fetch failure', async () => {
    vi.mocked(dashboardApi.fetchDashboardMetrics)
      .mockRejectedValueOnce(new Error('Request failed with 404'))
      .mockResolvedValueOnce(mockMetrics);

    const { container } = render(<MemoryRouter><Dashboard /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByText(/Dashboard 加载失败/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Request failed with 404/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /重试/ }));

    await waitFor(() => {
      const statCards = Array.from(container.querySelectorAll('.stat-card')).map((card) => card.textContent || '');
      expect(statCards).toEqual(expect.arrayContaining([
        expect.stringContaining('总工单5'),
        expect.stringContaining('已结束2'),
      ]));
    });
  });
});
