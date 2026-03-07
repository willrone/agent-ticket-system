import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Tickets from './Tickets';
import * as ticketsApi from '../api/tickets';

const mockTickets = [
  { id: 1, title: 'Login page not loading', status: 'open', priority: 'high', bot: 'cowder', created: '2026-03-05 14:30', progress: 0 },
  { id: 2, title: 'Database connection timeout', status: 'in-progress', priority: 'critical', bot: 'donky', created: '2026-03-04 09:15', progress: 65 },
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
    recentTasks: [{ id: 12, title: 'Fix authentication bug', status: 'completed', time: '10:30' }],
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
}));

describe('Tickets', () => {
  beforeEach(() => {
    vi.mocked(ticketsApi.fetchTickets).mockResolvedValue(mockTickets);
    vi.mocked(ticketsApi.fetchBots).mockResolvedValue(mockBots);
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
    expect(ticketsApi.fetchTickets).toHaveBeenCalled();
    expect(ticketsApi.fetchBots).toHaveBeenCalled();
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
