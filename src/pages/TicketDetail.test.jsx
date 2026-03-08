import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TicketDetail from './TicketDetail';
import * as ticketsApi from '../api/tickets';

const baseTicket = {
  id: 1,
  title: 'Login page not loading',
  status: 'triage',
  priority: 'high',
  triage_owner: 'leoss',
  review_owner: 'leoss',
  assigned_agent: 'donky',
  next_actor: 'leoss',
  description: 'Users are reporting that the login page fails to load intermittently.',
  platform: 'ticket-platform',
  request_type: 'bug',
  result_summary: null,
  decision_summary: null,
  locked_by: null,
  comments: [
    {
      id: 1,
      author: 'John Doe',
      timestamp: '2026-03-05T11:00:00Z',
      content: 'I\'ve started investigating.',
      type: 'progress',
      visibility: 'internal',
      mentions: [],
      notify_targets: [],
    },
  ],
};

vi.mock('../api/tickets', () => ({
  getTicket: vi.fn(),
  getTicketActions: vi.fn(),
  transitionTicket: vi.fn(),
  addComment: vi.fn(),
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/tickets/1']}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('TicketDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('alert', vi.fn());
    vi.mocked(ticketsApi.getTicket).mockResolvedValue(baseTicket);
    vi.mocked(ticketsApi.getTicketActions).mockResolvedValue({
      available_actions: ['start_work', 'submit_for_review'],
    });
    vi.mocked(ticketsApi.transitionTicket).mockResolvedValue({
      success: true,
      ticket: { ...baseTicket, status: 'running' },
    });
    vi.mocked(ticketsApi.addComment).mockResolvedValue({
      id: 999,
      author: 'Current User',
      timestamp: '2026-03-06T10:00:00Z',
      content: 'My new comment',
      type: 'progress',
      visibility: 'internal',
      mentions: [],
      notify_targets: [],
    });
  });

  it('renders ticket detail, comments, and available actions', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Login page not loading/)).toBeInTheDocument();
    });

    expect(screen.getByText(/Users are reporting/)).toBeInTheDocument();
    expect(screen.getByText('John Doe')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '🚀 开工' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '✅ 提交验收' })).toBeInTheDocument();
  });

  it('shows locked banner when ticket is locked', async () => {
    vi.mocked(ticketsApi.getTicket).mockResolvedValue({
      ...baseTicket,
      locked_by: 'beavy',
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/已锁定 by beavy/)).toBeInTheDocument();
    });
  });

  it('submits transition action with required fields', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '✅ 提交验收' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '✅ 提交验收' }));

    const resultSummaryField = screen.getByText(/结果摘要/).parentElement.querySelector('textarea');
    const commentField = screen.getByPlaceholderText('描述此操作...');

    fireEvent.change(resultSummaryField, {
      target: { value: '任务完成，等待验收' },
    });
    fireEvent.change(commentField, {
      target: { value: '补一条状态变更说明' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认' }));

    await waitFor(() => {
      expect(ticketsApi.transitionTicket).toHaveBeenCalledWith('1', expect.objectContaining({
        action: 'submit_for_review',
        actor: 'leoss',
        result_summary: '任务完成，等待验收',
        comment: '补一条状态变更说明',
      }));
    });
  });

  it('adds comment through comment form', async () => {
    const updatedTicket = {
      ...baseTicket,
      comments: [
        ...baseTicket.comments,
        {
          id: 999,
          author: 'Current User',
          timestamp: '2026-03-06T10:00:00Z',
          content: 'My new comment',
          type: 'progress',
          visibility: 'internal',
          mentions: [],
          notify_targets: [],
        },
      ],
    };
    vi.mocked(ticketsApi.getTicket)
      .mockResolvedValueOnce(baseTicket)
      .mockResolvedValueOnce(updatedTicket);

    renderPage();

    await waitFor(() => {
      expect(screen.getByPlaceholderText('添加评论...')).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText('添加评论...');
    fireEvent.change(textarea, { target: { value: 'My new comment' } });
    fireEvent.click(screen.getByRole('button', { name: '添加评论' }));

    await waitFor(() => {
      expect(ticketsApi.addComment).toHaveBeenCalledWith('1', {
        content: 'My new comment',
        author: 'Current User',
        type: 'progress',
      });
    });

    await waitFor(() => {
      expect(screen.getByText('My new comment')).toBeInTheDocument();
    });
  });

  it('shows error state when loading ticket fails', async () => {
    vi.mocked(ticketsApi.getTicket).mockRejectedValue(new Error('网络错误，请检查连接'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/错误: 网络错误，请检查连接/)).toBeInTheDocument();
    });
  });
});
