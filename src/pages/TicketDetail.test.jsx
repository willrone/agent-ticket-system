import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TicketDetail from './TicketDetail';
import * as ticketsApi from '../api/tickets';

const mockTicket = {
  id: 1,
  title: 'Login page not loading',
  status: 'triage',
  priority: 'high',
  triage_owner: 'leoss',
  assigned_agent: 'donky',
  next_actor: 'leoss',
  next_actor_override: '',
  next_actor_source: 'triage_owner',
  assignee: 'donky',
  reporter: 'Alice Johnson',
  created: '2026-03-05 10:30 AM',
  last_update: '2026-03-05 02:15 PM',
  updated: '2026-03-05 02:15 PM',
  description: 'Users are reporting that the login page fails to load intermittently.',
  platform: 'ticket-platform',
  request_type: 'bug',
  triage_summary: '先补详情页结构化字段。',
  implementation_scope: '前后端最小闭环。',
  constraints: '不要引入复杂状态机。',
  deliverables: '字段、接口、页面。',
  acceptance_criteria: '老李可填写并保存分诊结果。',
  parent_ticket_id: null,
  parent_ticket: null,
  child_tickets: [],
  tags: ['frontend', 'authentication', 'urgent'],
  comments: [
    { id: 1, author: 'John Doe', timestamp: '2026-03-05 11:00 AM', content: 'I\'ve started investigating.', type: 'progress', visibility: 'internal', mentions: [], notify_targets: [] },
    { id: 2, author: 'Alice Johnson', timestamp: '2026-03-05 01:30 PM', content: 'Thanks for looking into this.', type: 'decision', visibility: 'internal', mentions: ['john'], notify_targets: ['john'] },
    { id: 3, author: 'John Doe', timestamp: '2026-03-05 02:15 PM', content: 'Found the root cause.', type: 'result', visibility: 'public', mentions: [], notify_targets: [] },
  ],
  attachments: [
    { id: 1, name: 'error-screenshot.png', size: '245 KB' },
    { id: 2, name: 'console-log.txt', size: '12 KB' },
  ],
};

vi.mock('../api/tickets', () => ({
  fetchTicketDetail: vi.fn(),
  fetchTicketComments: vi.fn(),
  submitComment: vi.fn(),
  updateTicket: vi.fn(),
}));

describe('TicketDetail', () => {
  beforeEach(() => {
    vi.mocked(ticketsApi.fetchTicketDetail).mockResolvedValue(mockTicket);
    vi.mocked(ticketsApi.fetchTicketComments).mockResolvedValue({ comments: mockTicket.comments, total: mockTicket.comments.length });
    vi.mocked(ticketsApi.submitComment).mockResolvedValue({
      id: 999,
      author: 'Current User',
      timestamp: '03/06/2026 10:00 AM',
      content: 'My new comment',
      type: 'progress',
      visibility: 'internal',
      thread_id: null,
      mentions: [],
      notify_targets: [],
    });
    vi.mocked(ticketsApi.updateTicket).mockResolvedValue({
      ...mockTicket,
      status: 'review',
      triage_owner: 'leoss',
      assigned_agent: 'beavy',
      assignee: 'beavy',
      next_actor: 'auditor',
      next_actor_override: 'auditor',
      next_actor_source: 'next_actor',
      platform: 'ticket-platform',
      request_type: 'feature',
      triage_summary: '已明确开发边界。',
      implementation_scope: '详情页 + API',
      constraints: '不改状态机',
      deliverables: '字段和页面',
      acceptance_criteria: '可保存并指派给 beavy',
      parent_ticket_id: 12,
      parent_ticket: { id: 12, title: 'Parent ticket', status: 'queued', assigned_agent: 'cowder' },
      updated: '2026-03-06 11:00 AM',
      last_update: '2026-03-06 11:00 AM',
    });
  });

  it('uses dark cyber theme (CSS vars) for main content cards', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/tickets/1']}>
        <Routes>
          <Route path="/tickets/:id" element={<TicketDetail />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText(/Login page not loading/)).toBeInTheDocument();
    });
    const darkThemeCard = container.querySelector('[class*="--bg-secondary"]');
    expect(darkThemeCard).toBeTruthy();
  });

  it('saves triage fields and assigns ticket to beavy', async () => {
    render(
      <MemoryRouter initialEntries={['/tickets/1']}>
        <Routes>
          <Route path="/tickets/:id" element={<TicketDetail />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByLabelText('指派给')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('当前状态'), { target: { value: 'review' } });
    fireEvent.change(screen.getByLabelText('分诊负责人'), { target: { value: 'leoss' } });
    fireEvent.change(screen.getByLabelText('指派给'), { target: { value: 'beavy' } });
    fireEvent.change(screen.getByLabelText('手动下一步责任人'), { target: { value: 'auditor' } });
    fireEvent.change(screen.getByLabelText('需求类型'), { target: { value: 'feature' } });
    fireEvent.change(screen.getByLabelText('父工单 ID'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('分诊结论'), { target: { value: '已明确开发边界。' } });
    fireEvent.change(screen.getByLabelText('实施范围'), { target: { value: '详情页 + API' } });
    fireEvent.change(screen.getByLabelText('约束条件'), { target: { value: '不改状态机' } });
    fireEvent.change(screen.getByLabelText('交付物'), { target: { value: '字段和页面' } });
    fireEvent.change(screen.getByLabelText('验收标准'), { target: { value: '可保存并指派给 beavy' } });
    fireEvent.click(screen.getByRole('button', { name: /保存分诊/i }));

    await waitFor(() => {
      expect(ticketsApi.updateTicket).toHaveBeenCalledWith('1', expect.objectContaining({
        status: 'review',
        triage_owner: 'leoss',
        assigned_agent: 'beavy',
        next_actor: 'auditor',
        request_type: 'feature',
        triage_summary: '已明确开发边界。',
        implementation_scope: '详情页 + API',
        constraints: '不改状态机',
        deliverables: '字段和页面',
        acceptance_criteria: '可保存并指派给 beavy',
        parent_ticket_id: 12,
      }));
    });
    expect(screen.getByText('分诊信息已保存')).toBeInTheDocument();
    expect(screen.getByText(/当前路由/)).toBeInTheDocument();
    expect(screen.getByText(/#12 Parent ticket/)).toBeInTheDocument();
  });

  it('adds new comment to list when input comment and click submit', async () => {
    render(
      <MemoryRouter initialEntries={['/tickets/1']}>
        <Routes>
          <Route path="/tickets/:id" element={<TicketDetail />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Add a comment/i)).toBeInTheDocument();
    });
    const textarea = screen.getByPlaceholderText(/Add a comment/i);
    const threadInput = screen.getByPlaceholderText(/Thread ID \(optional\)/i);
    const mentionsInput = screen.getByPlaceholderText(/Mentions: ops,qa/i);
    const submitBtn = screen.getByRole('button', { name: /Post Comment/i });

    fireEvent.change(textarea, { target: { value: 'My new comment' } });
    fireEvent.change(threadInput, { target: { value: 'th-1' } });
    fireEvent.change(mentionsInput, { target: { value: 'ops,qa' } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('My new comment')).toBeInTheDocument();
    });
    expect(screen.getByText('Current User')).toBeInTheDocument();
    expect(ticketsApi.submitComment).toHaveBeenCalledWith(
      '1',
      'My new comment',
      'Current User',
      expect.objectContaining({
        type: 'progress',
        visibility: 'internal',
        thread_id: 'th-1',
        mentions: ['ops', 'qa'],
      })
    );
    expect(textarea).toHaveValue('');
    expect(screen.getByText('评论已发布')).toBeInTheDocument();
  });

  it('shows loading state and disables submit during submission', async () => {
    let resolveSubmit;
    vi.mocked(ticketsApi.submitComment).mockImplementation(
      () => new Promise((r) => { resolveSubmit = r; })
    );

    render(
      <MemoryRouter initialEntries={['/tickets/1']}>
        <Routes>
          <Route path="/tickets/:id" element={<TicketDetail />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Add a comment/i)).toBeInTheDocument();
    });
    const textarea = screen.getByPlaceholderText(/Add a comment/i);
    const submitBtn = screen.getByRole('button', { name: /Post Comment/i });

    fireEvent.change(textarea, { target: { value: 'Loading test' } });
    fireEvent.click(submitBtn);

    expect(screen.getByRole('button', { name: /Submitting/i })).toBeDisabled();
    expect(textarea).toBeDisabled();

    resolveSubmit({
      id: 888,
      author: 'Current User',
      timestamp: '03/06/2026 11:00 AM',
      content: 'Loading test',
    });

    await waitFor(() => {
      expect(screen.getByText('Loading test')).toBeInTheDocument();
    });
  });

  it('shows error message when submit fails and keeps input', async () => {
    vi.mocked(ticketsApi.submitComment).mockRejectedValue(new Error('网络错误，请检查连接'));

    render(
      <MemoryRouter initialEntries={['/tickets/1']}>
        <Routes>
          <Route path="/tickets/:id" element={<TicketDetail />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Add a comment/i)).toBeInTheDocument();
    });
    const textarea = screen.getByPlaceholderText(/Add a comment/i);
    const submitBtn = screen.getByRole('button', { name: /Post Comment/i });

    fireEvent.change(textarea, { target: { value: 'Failed comment' } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('网络错误，请检查连接')).toBeInTheDocument();
    });
    expect(textarea).toHaveValue('Failed comment');
    expect(screen.getByText(/Comments \(\d+\/\d+\)/)).toHaveTextContent('Comments (3/3)');
  });
});
