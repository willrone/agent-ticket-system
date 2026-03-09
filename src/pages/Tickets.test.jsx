import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

const mockBots = [
  {
    name: 'cowder',
    displayName: '小牛',
    status: 'active',
    tokens: '43k/200k',
    usage: 22,
    emoji: '🐮',
    currentTask: { id: 2, title: 'Database connection timeout', progress: 65 },
    queue: [{ id: 1, title: 'Login page not loading' }],
    stats: { todayCompleted: 5, avgResponseTime: '2.3min', successRate: 94, uptime: '2d 14h' },
    recentTasks: [{ id: 12, title: 'Fix authentication bug', status: 'done', time: '10:30' }],
  },
  {
    name: 'beavy',
    displayName: '小李',
    status: 'idle',
    tokens: '88k/200k',
    usage: 41,
    emoji: '🦫',
    currentTask: null,
    queue: [],
    stats: { todayCompleted: 3, avgResponseTime: '2.1min', successRate: 98, uptime: '1d 8h' },
    recentTasks: [],
  },
  {
    name: 'donky',
    displayName: '小驴',
    status: 'idle',
    tokens: '105k/200k',
    usage: 53,
    emoji: '🫏',
    currentTask: null,
    queue: [],
    stats: { todayCompleted: 8, avgResponseTime: '1.8min', successRate: 97, uptime: '3d 8h' },
    recentTasks: [],
  },
];

vi.mock('../api/tickets', () => ({
  fetchTickets: vi.fn(),
  fetchBots: vi.fn(),
  fetchTicketDependencies: vi.fn(),
}));

describe('Tickets', () => {
  beforeEach(() => {
    vi.mocked(ticketsApi.fetchTickets).mockResolvedValue(mockTickets);
    vi.mocked(ticketsApi.fetchBots).mockResolvedValue(mockBots);
    vi.mocked(ticketsApi.fetchTicketDependencies).mockResolvedValue({
      dependencies: [],
      dependents: [],
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
    expect(ticketsApi.fetchBots).toHaveBeenCalled();
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

  it('shows error state when fetchBots fails instead of empty data', async () => {
    vi.mocked(ticketsApi.fetchTickets).mockResolvedValue(mockTickets);
    vi.mocked(ticketsApi.fetchBots).mockRejectedValue(new Error('无法连接后端服务，请检查 VITE_API_BASE_URL/代理配置以及后端是否已启动。'));

    render(
      <MemoryRouter>
        <Tickets />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/加载失败/)).toBeInTheDocument();
    });
    expect(screen.getByText(/无法连接后端服务/)).toBeInTheDocument();
    expect(screen.queryByText(/暂无工单/)).not.toBeInTheDocument();
  });

  it('shows empty state when no tickets', async () => {
    vi.mocked(ticketsApi.fetchTickets).mockResolvedValue([]);
    vi.mocked(ticketsApi.fetchBots).mockResolvedValue(mockBots);

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
});
