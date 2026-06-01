import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import Tickets from './Tickets';
import * as ticketsApi from '../api/tickets';

const mockTickets = [
  {
    id: 1,
    title: 'Login page not loading',
    status: 'triage',
    priority: 'high',
    bot: 'cowder',
    triage_owner: 'leoss',
    assigned_agent: 'cowder',
    next_actor: 'leoss',
    next_actor_source: 'triage_owner',
    platform: 'ticket-platform',
    request_type: 'bug',
    triage_summary: '先定位登录页加载失败原因。',
    created: '2026-03-05T14:30:00.000Z',
    last_update: '2026-03-05T15:30:00.000Z',
    progress: 0,
  },
  {
    id: 2,
    title: 'Database connection timeout',
    status: 'queued',
    priority: 'critical',
    bot: 'beavy',
    triage_owner: 'leoss',
    assigned_agent: 'beavy',
    next_actor: 'beavy',
    next_actor_source: 'assigned_agent',
    platform: null,
    request_type: 'feature',
    triage_summary: '',
    created: '2026-03-04T09:15:00.000Z',
    last_update: '2026-03-06T09:15:00.000Z',
    progress: 65,
  },
];

vi.mock('../api/tickets', () => ({
  fetchTickets: vi.fn(),
  fetchStockAdminTickets: vi.fn(),
  fetchTicketStatus: vi.fn(),
  createTicket: vi.fn(),
  createStockAdminTicket: vi.fn(),
  deleteTicket: vi.fn(),
  deleteTickets: vi.fn(),
}));

describe('Tickets', () => {
  beforeEach(() => {
    vi.mocked(ticketsApi.fetchTickets).mockResolvedValue(mockTickets);
    vi.mocked(ticketsApi.fetchTicketStatus).mockResolvedValue({ status: 'queued', assigned_agent: 'beavy' });
    vi.mocked(ticketsApi.deleteTicket).mockResolvedValue({ success: true });
    vi.mocked(ticketsApi.deleteTickets).mockResolvedValue({ success: true });
    vi.mocked(ticketsApi.createTicket).mockResolvedValue({
      id: 99,
      title: 'New created ticket',
      description: 'Need review owner',
      status: 'triage',
      triage_owner: 'leoss',
      review_owner: 'ronghui',
      assigned_agent: 'beavy',
      next_actor: 'leoss',
      next_actor_source: 'triage_owner',
      created: '2026-03-07T10:00:00.000Z',
      last_update: '2026-03-07T10:00:00.000Z',
    });
  });

  it('shows loading state initially', () => {
    render(
      <MemoryRouter>
        <Tickets />
      </MemoryRouter>
    );
    expect(screen.getByText(/加载工单中/)).toBeInTheDocument();
  });

  it('renders ticket list on success', async () => {
    render(
      <MemoryRouter>
        <Tickets />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText(/Login page not loading/)).toBeInTheDocument();
    });
    expect(screen.getAllByText(/Database connection timeout/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('heading', { name: /Tickets/ })).toBeInTheDocument();
    expect(screen.getAllByText('ticket-platform').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('bug').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /Assigned Agent/i })).toBeInTheDocument();
    expect(screen.getByText(/Next Actor/i)).toBeInTheDocument();
    expect(screen.getAllByText('leoss').length).toBeGreaterThanOrEqual(1);
    expect(ticketsApi.fetchTickets).toHaveBeenCalled();
  });



  it('renders stage orchestration summary in ticket rows', async () => {
    vi.mocked(ticketsApi.fetchTickets).mockResolvedValue([
      {
        id: 9,
        title: 'Running orchestration row',
        status: 'running',
        priority: 'high',
        bot: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
        current_actor: 'beavy',
        next_actor: 'beavy',
        next_actor_source: 'assigned_agent',
        platform: 'ticket-platform',
        request_type: 'feature',
        execution_mode: 'subagent',
        dispatch_state: 'receipt_accepted',
        created: '2026-03-06T09:15:00.000Z',
        last_update: '2026-03-06T10:15:00.000Z',
      },
    ]);

    render(
      <MemoryRouter>
        <Tickets />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Running orchestration row/)).toBeInTheDocument();
    });

    expect(screen.getByText(/阶段编排：当前处于进行中，由 beavy 继续实现与验证；完成后应提交到待验收。/)).toBeInTheDocument();
    expect(screen.getByText(/门禁就绪/)).toBeInTheDocument();
    expect(screen.getByText(/当前阶段已有责任人和下一步路径，可继续推进。/)).toBeInTheDocument();
    expect(screen.getByText(/下一步：✅ 提交验收 → 待验收/)).toBeInTheDocument();
    expect(screen.getByText(/Running orchestration row/)).toBeInTheDocument();
  });

  it('renders at-risk gate badge for queued subagent rows missing worker evidence', async () => {
    vi.mocked(ticketsApi.fetchTickets).mockResolvedValue([
      {
        id: 10,
        title: 'Queued subagent without worker evidence',
        status: 'queued',
        priority: 'high',
        bot: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
        current_actor: 'beavy',
        next_actor: 'beavy',
        next_actor_source: 'assigned_agent',
        platform: 'ticket-platform',
        request_type: 'feature',
        execution_mode: 'subagent',
        dispatch_state: 'receipt_accepted',
        execution_guard: {
          has_worker_evidence: false,
        },
        created: '2026-03-06T09:15:00.000Z',
        last_update: '2026-03-06T10:15:00.000Z',
      },
    ]);

    render(
      <MemoryRouter>
        <Tickets />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Queued subagent without worker evidence/)).toBeInTheDocument();
    });

    expect(screen.getByText(/缺 worker 证据/)).toBeInTheDocument();
    expect(screen.getByText(/subagent queued 已 receipt，但还没有真实 worker evidence/)).toBeInTheDocument();
  });

  it('renders reviewer inbox sidebar with review vs pending decision split', async () => {
    vi.mocked(ticketsApi.fetchTickets).mockResolvedValue([
      ...mockTickets,
      {
        id: 3,
        title: 'Ready for reviewer closeout',
        status: 'done',
        priority: 'medium',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
        next_actor: 'leoss',
        next_actor_source: 'review_owner',
        result_summary: '交付已经完成，等待 reviewer 收口。',
        created: '2026-03-06T09:15:00.000Z',
        last_update: '2026-03-06T10:15:00.000Z',
      },
      {
        id: 4,
        title: 'Need boss decision',
        status: 'pending_decision',
        priority: 'high',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        decision_owner: '荣晖',
        assigned_agent: 'beavy',
        next_actor: '荣晖',
        next_actor_source: 'decision_owner',
        decision_summary: '需要确认是否继续开放。',
        created: '2026-03-06T11:15:00.000Z',
        last_update: '2026-03-06T12:15:00.000Z',
      },
    ]);

    render(
      <MemoryRouter>
        <Tickets />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/review inbox \/ decision split/i)).toBeInTheDocument();
    });

    expect(screen.getAllByText(/Ready for reviewer closeout/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/reviewer 待收口/)).toBeInTheDocument();
    expect(screen.getAllByText(/Need boss decision/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/待老大决策/)).toBeInTheDocument();
    expect(screen.getByText(/等待 decision owner 拍板/)).toBeInTheDocument();
  });

  it('supports platform / request type / assigned agent filters and quick views', async () => {
    const { container } = render(
      <MemoryRouter>
        <Tickets />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Login page not loading/)).toBeInTheDocument();
    });

    const getTableRows = () => Array.from(container.querySelectorAll('tbody tr')).map((row) => row.textContent || '');

    fireEvent.change(screen.getByLabelText('按平台筛选'), { target: { value: 'ticket-platform' } });
    expect(getTableRows()).toEqual(expect.arrayContaining([expect.stringContaining('Login page not loading')]));
    expect(getTableRows().join('')).not.toContain('Database connection timeout');

    fireEvent.click(screen.getByRole('button', { name: /清空筛选/ }));
    fireEvent.change(screen.getByLabelText('按需求类型筛选'), { target: { value: 'feature' } });
    expect(getTableRows()).toEqual(expect.arrayContaining([expect.stringContaining('Database connection timeout')]));
    expect(getTableRows().join('')).not.toContain('Login page not loading');

    fireEvent.click(screen.getByRole('button', { name: /清空筛选/ }));
    fireEvent.change(screen.getByLabelText('按执行人筛选'), { target: { value: 'beavy' } });
    expect(getTableRows()).toEqual(expect.arrayContaining([expect.stringContaining('Database connection timeout')]));
    expect(getTableRows().join('')).not.toContain('Login page not loading');

    fireEvent.click(screen.getByRole('button', { name: /清空筛选/ }));
    fireEvent.click(screen.getByRole('button', { name: /只看 beavy/i }));
    expect(getTableRows()).toEqual(expect.arrayContaining([expect.stringContaining('Database connection timeout')]));
    expect(getTableRows().join('')).not.toContain('Login page not loading');

    fireEvent.click(screen.getByRole('button', { name: /待分诊/i }));
    expect(getTableRows()).toEqual(expect.arrayContaining([expect.stringContaining('Login page not loading')]));
    expect(getTableRows().join('')).not.toContain('Database connection timeout');

    fireEvent.click(screen.getByRole('button', { name: /分诊待补全/i }));
    expect(getTableRows()).toEqual(expect.arrayContaining([expect.stringContaining('Database connection timeout')]));
    expect(getTableRows().join('')).not.toContain('Login page not loading');
  });

  it('shows error state and retry on fetch failure', async () => {
    vi.mocked(ticketsApi.fetchTickets).mockRejectedValue(new Error('网络错误，请检查连接'));

    render(
      <MemoryRouter>
        <Tickets />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/加载失败/)).toBeInTheDocument();
    });
    expect(screen.getByText(/网络错误，请检查连接/)).toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: /重试/ });
    expect(retryBtn).toBeInTheDocument();

    vi.mocked(ticketsApi.fetchTickets).mockResolvedValue(mockTickets);
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByText(/Login page not loading/)).toBeInTheDocument();
    });
  });

  it('keeps ticket list usable and advertises bot status as an independent page', async () => {
    vi.mocked(ticketsApi.fetchTickets).mockResolvedValue(mockTickets);

    render(
      <MemoryRouter>
        <Tickets />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Login page not loading/)).toBeInTheDocument();
    });
    expect(screen.getByText(/当前页首屏不再请求 Bot 状态副路/)).toBeInTheDocument();
    expect(screen.queryByText(/暂无工单/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Manage and track agent tasks/)).toBeInTheDocument();
  });

  it('create modal passes explicit triage_owner / assigned_agent / review_owner when creating ticket', async () => {
    render(
      <MemoryRouter>
        <Tickets />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Login page not loading/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /New/i }));
    fireEvent.change(screen.getByPlaceholderText('输入工单标题'), { target: { value: 'New created ticket' } });
    fireEvent.change(screen.getByPlaceholderText('输入工单描述（可选）'), { target: { value: 'Need review owner' } });
    fireEvent.change(screen.getByRole('combobox', { name: '预指派执行人 *' }), { target: { value: 'beavy' } });
    fireEvent.change(screen.getByLabelText('分诊负责人'), { target: { value: 'cowder' } });
    fireEvent.change(screen.getByLabelText('验收负责人'), { target: { value: 'ronghui' } });
    fireEvent.click(screen.getByRole('button', { name: /创建工单/ }));

    await waitFor(() => {
      expect(ticketsApi.createTicket).toHaveBeenCalledWith(expect.objectContaining({
        title: 'New created ticket',
        description: 'Need review owner',
        assigned_agent: 'beavy',
        status: 'triage',
        triage_owner: 'cowder',
        review_owner: 'ronghui',
      }));
    });
  });

  it('stock admin mode uses cowder token and stock admin create API', async () => {
    render(
      <MemoryRouter>
        <Tickets />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Login page not loading/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('checkbox', { name: /启用受控 stock admin 模式/ }));
    fireEvent.change(screen.getByLabelText('Stock admin token'), { target: { value: 'stock-admin-token' } });

    await waitFor(() => {
      expect(ticketsApi.fetchStockAdminTickets).toHaveBeenCalledWith('stock-admin-token');
    });

    fireEvent.click(screen.getByRole('button', { name: /New/i }));
    fireEvent.change(screen.getByPlaceholderText('输入工单标题'), { target: { value: 'Stock admin created ticket' } });
    fireEvent.change(screen.getByPlaceholderText('输入工单描述（可选）'), { target: { value: 'Create via stock admin' } });
    fireEvent.change(screen.getByRole('combobox', { name: '预指派执行人 *' }), { target: { value: 'marely' } });
    fireEvent.change(screen.getByLabelText('分诊负责人'), { target: { value: 'cowder' } });
    fireEvent.change(screen.getByLabelText('验收负责人'), { target: { value: 'leoss' } });
    fireEvent.click(screen.getByRole('button', { name: /创建工单/ }));

    await waitFor(() => {
      expect(ticketsApi.createStockAdminTicket).toHaveBeenCalledWith('stock-admin-token', expect.objectContaining({
        title: 'Stock admin created ticket',
        description: 'Create via stock admin',
        assigned_agent: 'marely',
        triage_owner: 'cowder',
        review_owner: 'leoss',
      }));
    });
    expect(ticketsApi.createTicket).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Stock admin created ticket' }));
  });

  it('shows empty state when no tickets', async () => {
    vi.mocked(ticketsApi.fetchTickets).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <Tickets />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/暂无工单/)).toBeInTheDocument();
    });
  });

  it('supports sorting by Updated header and shows the last update column', async () => {
    const { container } = render(
      <MemoryRouter>
        <Tickets />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Updated/i })).toBeInTheDocument();
    });

    const getRows = () => Array.from(container.querySelectorAll('tbody tr'));

    let rows = getRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent + rows[1].textContent).toContain('Login page not loading');
    expect(rows[0].textContent + rows[1].textContent).toContain('Database connection timeout');

    fireEvent.click(screen.getByRole('button', { name: /Updated/i }));

    rows = getRows();
    expect(rows[0].textContent).toContain('Database connection timeout');
    expect(rows[1].textContent).toContain('Login page not loading');

    fireEvent.click(screen.getByRole('button', { name: /Updated/i }));

    rows = getRows();
    expect(rows[0].textContent).toContain('Login page not loading');
    expect(rows[1].textContent).toContain('Database connection timeout');
  });

  it('keeps dark theme styling for main content', async () => {
    const { container } = render(
      <MemoryRouter>
        <Tickets />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText(/Login page not loading/)).toBeInTheDocument();
    });
    const darkThemeCard = container.querySelector('[class*="--bg-secondary"]');
    expect(darkThemeCard).toBeTruthy();
  });

  it('does not embed Bot Status sidebar but has a clear link to /bot-status', async () => {
    render(
      <MemoryRouter>
        <Tickets />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText(/Login page not loading/)).toBeInTheDocument();
    });
    const botStatusLinks = screen.getAllByRole('link', { name: /打开 Bot Status|Bot Status/i });
    expect(botStatusLinks.length).toBeGreaterThan(0);
    expect(botStatusLinks[0]).toHaveAttribute('href', '/bot-status');
    expect(screen.queryByRole('button', { name: /ACTIVE|IDLE/ })).not.toBeInTheDocument();
  });
});
