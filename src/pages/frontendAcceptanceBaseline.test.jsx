import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Dashboard from './Dashboard';
import Tickets from './Tickets';
import KanbanBoard from './KanbanBoard';
import TicketDetail from './TicketDetail';
import * as dashboardApi from '../api/dashboard';
import * as ticketsApi from '../api/tickets';
import {
  buildExpectedKanbanColumns,
  FRONTEND_ACCEPTANCE_ACTIONS,
  FRONTEND_ACCEPTANCE_ACTION_SCENARIOS,
  FRONTEND_ACCEPTANCE_DASHBOARD_PAYLOAD,
  FRONTEND_ACCEPTANCE_TICKET_DETAIL,
  FRONTEND_ACCEPTANCE_TICKETS,
} from '../test/frontend-acceptance-fixtures.js';

vi.mock('../api/dashboard', () => ({
  fetchDashboardMetrics: vi.fn(),
}));

vi.mock('../api/tickets', () => ({
  fetchTickets: vi.fn(),
  fetchTicketStatus: vi.fn(),
  createTicket: vi.fn(),
  deleteTicket: vi.fn(),
  deleteTickets: vi.fn(),
  fetchTicketDependencies: vi.fn(),
  transitionTicket: vi.fn(),
  getTicket: vi.fn(),
  getTicketActions: vi.fn(),
  addComment: vi.fn(),
  addTicketDependency: vi.fn(),
  removeTicketDependency: vi.fn(),
  fetchBots: vi.fn(),
  fetchAgentTopology: vi.fn(),
  fetchPlaybookStage: vi.fn(),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }) => <div data-testid="recharts-responsive-container">{children}</div>,
  BarChart: ({ children }) => <div data-testid="recharts-bar-chart">{children}</div>,
  Bar: () => <div data-testid="recharts-bar" />,
  XAxis: () => <div data-testid="recharts-x-axis" />,
  YAxis: () => <div data-testid="recharts-y-axis" />,
  CartesianGrid: () => <div data-testid="recharts-grid" />,
  Tooltip: () => <div data-testid="recharts-tooltip" />,
  Legend: () => <div data-testid="recharts-legend" />,
  PieChart: ({ children }) => <div data-testid="recharts-pie-chart">{children}</div>,
  Pie: ({ children }) => <div data-testid="recharts-pie">{children}</div>,
  Cell: () => <div data-testid="recharts-cell" />,
}));

function renderTicketDetail() {
  return render(
    <MemoryRouter initialEntries={[`/tickets/${FRONTEND_ACCEPTANCE_TICKET_DETAIL.id}`]}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('frontend acceptance baseline contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('confirm', vi.fn(() => true));

    vi.mocked(dashboardApi.fetchDashboardMetrics).mockResolvedValue(FRONTEND_ACCEPTANCE_DASHBOARD_PAYLOAD);
    vi.mocked(ticketsApi.fetchTickets).mockResolvedValue(FRONTEND_ACCEPTANCE_TICKETS);
    vi.mocked(ticketsApi.fetchTicketStatus).mockResolvedValue({ status: 'running', assigned_agent: 'beavy' });
    vi.mocked(ticketsApi.fetchTicketDependencies).mockResolvedValue({ dependencies: [], dependents: [] });
    vi.mocked(ticketsApi.fetchBots).mockResolvedValue([
      { name: 'beavy', status: 'active', usage: 70, queue: [{ id: 1, title: 'Queued' }], currentTask: { id: 103, title: 'Running baseline ticket', progress: 50 }, stats: { successRate: 99 } },
    ]);
    vi.mocked(ticketsApi.fetchAgentTopology).mockResolvedValue({ data: { gateways: { 'mac-main': { id: 'mac-main' } }, summary: { total_platforms: 1, total_gateways: 1 } } });
    vi.mocked(ticketsApi.fetchPlaybookStage).mockImplementation(async (stage, params = {}) => ({
      data: {
        stage,
        mode: params.mode || 'direct',
        role: params.role || 'manager',
        goal: `${stage} 阶段需要按 SOP 推进到明确下一步。`,
        next_stage_options: ['queued', 'running', 'done', 'pending_decision'].filter(Boolean),
        recommended_paths: ['先核对当前 stage / mode / role contract，再决定推进、阻塞或提决策。'],
        checklist: [
          { id: `${stage}-check-1`, text: '补齐或核对当前阶段的关键门禁项。', owner: params.role || 'manager' },
          { id: `${stage}-check-2`, text: '确认责任人、执行模式与验收路径一致。', owner: params.role || 'manager' },
        ],
        evidence_requirements: [
          { id: `${stage}-evidence-1`, text: '需要可见的测试、回归或 live contract 证据。', owner: params.role || 'manager' },
        ],
      },
    }));
    vi.mocked(ticketsApi.transitionTicket).mockResolvedValue({ success: true, ticket: FRONTEND_ACCEPTANCE_TICKET_DETAIL });
    vi.mocked(ticketsApi.getTicket).mockResolvedValue(FRONTEND_ACCEPTANCE_TICKET_DETAIL);
    vi.mocked(ticketsApi.getTicketActions).mockResolvedValue(FRONTEND_ACCEPTANCE_ACTIONS);
    vi.mocked(ticketsApi.addComment).mockResolvedValue({ success: true });
    vi.mocked(ticketsApi.addTicketDependency).mockResolvedValue({ success: true });
    vi.mocked(ticketsApi.removeTicketDependency).mockResolvedValue({ success: true });
    vi.mocked(ticketsApi.createTicket).mockResolvedValue({ success: true });
    vi.mocked(ticketsApi.deleteTicket).mockResolvedValue({ success: true });
    vi.mocked(ticketsApi.deleteTickets).mockResolvedValue({ success: true });
  });

  it('Dashboard renders canonical runtime-semantic baseline metrics and charts', async () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('today-progress-board')).toBeInTheDocument();
    });

    expect(screen.getByText('总工单')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(screen.getByText('待验收 / 审核中')).toBeInTheDocument();
    expect(screen.getAllByText('已结束').length).toBeGreaterThan(0);
    expect(screen.getByText('Management Summary')).toBeInTheDocument();
    expect(screen.getByText('今日推进摘要')).toBeInTheDocument();
    expect(screen.getByText('Risk Trends')).toBeInTheDocument();
    expect(screen.getByTestId('drilldown-board')).toBeInTheDocument();
    expect(screen.getByText('Agent Runtime Digest')).toBeInTheDocument();
    expect(screen.getByTestId('runtime-digest-board')).toBeInTheDocument();
    expect(screen.getByTestId('weekly-tickets-chart')).toBeInTheDocument();
    expect(screen.getByTestId('status-distribution-chart')).toBeInTheDocument();
  });

  it('Tickets renders canonical quick views and core contract columns from shared fixtures', async () => {
    render(
      <MemoryRouter>
        <Tickets />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Tickets/ })).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /待分诊/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /待验收 \/ 审核中/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /分诊待补全/i })).toBeInTheDocument();
    expect(screen.getByText('Next Actor')).toBeInTheDocument();
    expect(screen.getAllByText('ticket-platform').length).toBeGreaterThan(0);
    expect(screen.getByText('Triage incomplete ticket')).toBeInTheDocument();
  });

  it('KanbanBoard renders one column per canonical status and does not collapse review semantics', async () => {
    render(
      <MemoryRouter>
        <KanbanBoard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('工单看板')).toBeInTheDocument();
    });

    for (const label of buildExpectedKanbanColumns()) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    expect(screen.getByText('Done baseline ticket')).toBeInTheDocument();
    expect(screen.getByText('Review baseline ticket')).toBeInTheDocument();
    expect(screen.getByText('Complete baseline ticket')).toBeInTheDocument();
  });

  it('TicketDetail renders reviewer/decision action matrix baseline from shared fixtures', async () => {
    vi.mocked(ticketsApi.getTicket).mockResolvedValue({
      ...FRONTEND_ACCEPTANCE_ACTION_SCENARIOS.review.ticket,
      result_summary: '功能已完成，等待 reviewer 收口。',
      comments: [],
      supplemental_tickets: [
        {
          relation_type: 'validation_of',
          relation_label: '补充验证',
          ticket: { id: 209, title: 'Validation baseline ticket', status: 'done', result_summary: '待 reviewer 收口' },
        },
      ],
      supplemental_summary: { total: 1, open: 1, complete: 0, pending_review: 1, by_status: { done: 1 } },
    });
    vi.mocked(ticketsApi.getTicketActions).mockResolvedValue({
      available_actions: FRONTEND_ACCEPTANCE_ACTION_SCENARIOS.review.available_actions,
    });

    const reviewRender = renderTicketDetail();

    await waitFor(() => {
      expect(screen.getByText('Review Inbox')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: '👍 通过关单' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '👎 打回重做' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '⏸️ 暂时挂起' })).toBeInTheDocument();

    reviewRender.unmount();

    vi.mocked(ticketsApi.getTicket).mockResolvedValue({
      ...FRONTEND_ACCEPTANCE_ACTION_SCENARIOS.pending_decision.ticket,
      comments: [],
    });
    vi.mocked(ticketsApi.getTicketActions).mockResolvedValue({
      available_actions: FRONTEND_ACCEPTANCE_ACTION_SCENARIOS.pending_decision.available_actions,
    });

    renderTicketDetail();

    await waitFor(() => {
      expect(screen.getByText('Decision Panel')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: '▶️ 恢复执行' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '👍 通过关单' })).not.toBeInTheDocument();
  });

  it('TicketDetail renders reviewer-facing runtime contract for paused/dependency/supplemental states', async () => {
    renderTicketDetail();

    await waitFor(() => {
      expect(screen.getByText(/Paused baseline ticket/)).toBeInTheDocument();
    });

    expect(screen.getByText(/挂起原因/)).toBeInTheDocument();
    expect(screen.getByText('等待外部依赖')).toBeInTheDocument();
    expect(screen.getByText(/补充验证关系/)).toBeInTheDocument();
    expect(screen.getByText(/这是一张/)).toBeInTheDocument();
    expect(screen.getByText('依赖关系')).toBeInTheDocument();
    expect(screen.getByText('Playbook SOP')).toBeInTheDocument();
    expect(screen.getByText(/需要可见的测试、回归或 live contract 证据/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '▶️ 恢复执行' })).toBeInTheDocument();
    expect(screen.getByText(/已锁定 by beavy/)).toBeInTheDocument();
  });
});
