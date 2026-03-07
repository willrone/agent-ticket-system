import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Dashboard from './Dashboard';
import * as dashboardApi from '../api/dashboard';

const mockMetrics = {
  data: {
    stats: { total: 3, open: 2, inProgress: 1, resolved: 0 },
    weeklyTickets: [
      { day: '2026-03-03', tickets: 1 },
      { day: '2026-03-04', tickets: 1 },
      { day: '2026-03-05', tickets: 1 },
    ],
    statusDistribution: [
      { name: 'Open', value: 2, color: '#ef4444' },
      { name: 'In Progress', value: 1, color: '#f59e0b' },
    ],
  },
};

vi.mock('../api/dashboard', () => ({
  fetchDashboardMetrics: vi.fn(),
}));

describe('Dashboard', () => {
  beforeEach(() => {
    vi.mocked(dashboardApi.fetchDashboardMetrics).mockResolvedValue(mockMetrics);
  });

  it('shows loading state initially', () => {
    render(<Dashboard />);
    expect(screen.getByText(/Dashboard 加载中/)).toBeInTheDocument();
  });

  it('renders dashboard with stats on success', async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByText(/Dashboard/)).toBeInTheDocument();
    });
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(dashboardApi.fetchDashboardMetrics).toHaveBeenCalled();
  });

  it('shows error state and retry on fetch failure', async () => {
    vi.mocked(dashboardApi.fetchDashboardMetrics).mockRejectedValue(new Error('Request failed with 404'));

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText(/Dashboard 加载失败/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Request failed with 404/)).toBeInTheDocument();

    vi.mocked(dashboardApi.fetchDashboardMetrics).mockResolvedValue(mockMetrics);
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));

    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });
  });
});
