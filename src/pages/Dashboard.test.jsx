import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Dashboard from './Dashboard';
import * as dashboardApi from '../api/dashboard';

const mockMetrics = {
  data: {
    stats: { total: 5, active: 3, inProgress: 1, waitingReview: 1, closed: 2 },
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

  it('renders dashboard with runtime-semantic stats on success', async () => {
    const { container } = render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByText(/Dashboard/)).toBeInTheDocument();
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
    expect(dashboardApi.fetchDashboardMetrics).toHaveBeenCalled();
  });

  it('shows error state and retry on fetch failure', async () => {
    vi.mocked(dashboardApi.fetchDashboardMetrics)
      .mockRejectedValueOnce(new Error('Request failed with 404'))
      .mockResolvedValueOnce(mockMetrics);

    const { container } = render(<Dashboard />);

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
