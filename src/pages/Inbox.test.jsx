import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import Inbox from './Inbox';
import * as ticketsApi from '../api/tickets';

vi.mock('../api/tickets', () => ({
  fetchInbox: vi.fn(),
}));

describe('Inbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ticketsApi.fetchInbox).mockResolvedValue({
      lanes: {
        triage: [
          {
            id: 11,
            title: 'Need triage',
            status: 'triage',
            triage_owner: 'leoss',
            next_actor: 'leoss',
            inbox_reason: '等待 triage owner 完成范围收敛并决定是否入队',
            recommended_action: 'queue',
            sla_remaining_ms: 45 * 60 * 1000,
            last_update: '2026-03-19T00:05:00.000Z',
          },
        ],
        execution: [
          {
            id: 12,
            title: 'Execution running',
            status: 'running',
            assigned_agent: 'beavy',
            current_actor: 'beavy',
            next_actor: 'beavy',
            inbox_reason: '当前由执行人处理中，等待实现完成后提交验收或请求决策',
            recommended_action: 'submit_for_review',
            sla_remaining_ms: 5 * 60 * 1000,
            last_update: '2026-03-19T00:10:00.000Z',
          },
        ],
        review: [
          {
            id: 13,
            title: 'Review later',
            status: 'review',
            review_owner: 'leoss',
            next_actor: 'leoss',
            inbox_reason: '仍在 review 中',
            recommended_action: 'approve',
            sla_remaining_ms: 30 * 60 * 1000,
            last_update: '2026-03-19T00:20:00.000Z',
          },
        ],
        decision: [
          {
            id: 21,
            title: 'Need boss decision',
            status: 'pending_decision',
            decision_owner: '荣晖',
            next_actor: '荣晖',
            inbox_reason: '等待 decision owner 拍板',
            recommended_action: 'resume_from_decision',
            sla_remaining_ms: -10 * 60 * 1000,
            last_update: '2026-03-19T00:30:00.000Z',
          },
        ],
      },
    });
  });

  it('默认渲染 triage inbox，并展示最小字段集 / recommended action / SLA', async () => {
    render(
      <MemoryRouter>
        <Inbox />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
    });

    expect(screen.getByText(/Need triage/)).toBeInTheDocument();
    expect(screen.getByText('进入原因')).toBeInTheDocument();
    expect(screen.getByText(/等待 triage owner 完成范围收敛并决定是否入队/)).toBeInTheDocument();
    expect(screen.getByText('推荐动作')).toBeInTheDocument();
    expect(screen.getByText(/^queue$/i)).toBeInTheDocument();
    expect(screen.getByText('更新时间')).toBeInTheDocument();
    expect(screen.getByText(/剩余 45 分钟/)).toBeInTheDocument();
    expect(ticketsApi.fetchInbox).toHaveBeenCalledTimes(1);
  });

  it('可切换到 execution / review / decision inbox', async () => {
    render(
      <MemoryRouter>
        <Inbox />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Need triage/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Execution Inbox/i }));
    expect(await screen.findByText(/Execution running/)).toBeInTheDocument();
    expect(screen.getByText('当前责任人')).toBeInTheDocument();
    expect(screen.getAllByText(/^beavy$/i)).toHaveLength(2);
    expect(screen.getByText(/^submit for review$/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Review Inbox/i }));
    expect(await screen.findByText(/Review later/)).toBeInTheDocument();
    expect(screen.getByText(/^approve$/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Decision Inbox/i }));
    expect(await screen.findByText(/Need boss decision/)).toBeInTheDocument();
    expect(screen.getByText(/待老大决策/)).toBeInTheDocument();
    expect(screen.getByText(/^resume from decision$/i)).toBeInTheDocument();
    expect(screen.getByText(/超时 10 分钟/)).toBeInTheDocument();
  });
});
