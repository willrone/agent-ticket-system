import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import TicketDetail from './TicketDetail'
import * as ticketsApi from '../api/tickets'

const mockTicket = {
  id: 1,
  title: 'Login page not loading',
  status: 'open',
  priority: 'high',
  assignee: 'John Doe',
  reporter: 'Alice Johnson',
  created: '2026-03-05 10:30 AM',
  last_update: '2026-03-05 02:15 PM',
  updated: '2026-03-05 02:15 PM',
  description: 'Users are reporting that the login page fails to load intermittently.',
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
}

vi.mock('../api/tickets', () => ({
  fetchTicketDetail: vi.fn(),
  fetchTicketComments: vi.fn(),
  submitComment: vi.fn(),
}))

describe('TicketDetail', () => {
  beforeEach(() => {
    vi.mocked(ticketsApi.fetchTicketDetail).mockResolvedValue(mockTicket)
    vi.mocked(ticketsApi.fetchTicketComments).mockResolvedValue({ comments: mockTicket.comments, total: mockTicket.comments.length })
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
    })
  })

  it('uses dark cyber theme (CSS vars) for main content cards', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/tickets/1']}>
        <Routes>
          <Route path="/tickets/:id" element={<TicketDetail />} />
        </Routes>
      </MemoryRouter>
    )
    await waitFor(() => {
      expect(screen.getByText(/Login page not loading/)).toBeInTheDocument()
    })
    const darkThemeCard = container.querySelector('[class*="--bg-secondary"]')
    expect(darkThemeCard).toBeTruthy()
  })

  it('adds new comment to list when input comment and click submit', async () => {
    render(
      <MemoryRouter initialEntries={['/tickets/1']}>
        <Routes>
          <Route path="/tickets/:id" element={<TicketDetail />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Add a comment/i)).toBeInTheDocument()
    })
    const textarea = screen.getByPlaceholderText(/Add a comment/i)
    const threadInput = screen.getByPlaceholderText(/Thread ID \(optional\)/i)
    const mentionsInput = screen.getByPlaceholderText(/Mentions: ops,qa/i)
    const submitBtn = screen.getByRole('button', { name: /Post Comment/i })

    fireEvent.change(textarea, { target: { value: 'My new comment' } })
    fireEvent.change(threadInput, { target: { value: 'th-1' } })
    fireEvent.change(mentionsInput, { target: { value: 'ops,qa' } })
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(screen.getByText('My new comment')).toBeInTheDocument()
    })
    expect(screen.getByText('Current User')).toBeInTheDocument()
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
    )
    expect(textarea).toHaveValue('')
    expect(screen.getByRole('alert')).toHaveTextContent('评论已发布')
  })

  it('shows loading state and disables submit during submission', async () => {
    let resolveSubmit
    vi.mocked(ticketsApi.submitComment).mockImplementation(
      () => new Promise((r) => { resolveSubmit = r })
    )

    render(
      <MemoryRouter initialEntries={['/tickets/1']}>
        <Routes>
          <Route path="/tickets/:id" element={<TicketDetail />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Add a comment/i)).toBeInTheDocument()
    })
    const textarea = screen.getByPlaceholderText(/Add a comment/i)
    const submitBtn = screen.getByRole('button', { name: /Post Comment/i })

    fireEvent.change(textarea, { target: { value: 'Loading test' } })
    fireEvent.click(submitBtn)

    expect(screen.getByRole('button', { name: /Submitting/i })).toBeDisabled()
    expect(textarea).toBeDisabled()

    resolveSubmit({
      id: 888,
      author: 'Current User',
      timestamp: '03/06/2026 11:00 AM',
      content: 'Loading test',
    })

    await waitFor(() => {
      expect(screen.getByText('Loading test')).toBeInTheDocument()
    })
  })

  it('shows error message when submit fails and keeps input', async () => {
    vi.mocked(ticketsApi.submitComment).mockRejectedValue(new Error('网络错误，请检查连接'))

    render(
      <MemoryRouter initialEntries={['/tickets/1']}>
        <Routes>
          <Route path="/tickets/:id" element={<TicketDetail />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Add a comment/i)).toBeInTheDocument()
    })
    const textarea = screen.getByPlaceholderText(/Add a comment/i)
    const submitBtn = screen.getByRole('button', { name: /Post Comment/i })

    fireEvent.change(textarea, { target: { value: 'Failed comment' } })
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('网络错误，请检查连接')
    })
    expect(textarea).toHaveValue('Failed comment')
    expect(screen.getByText(/Comments \(\d+\/\d+\)/)).toHaveTextContent('Comments (3/3)')
  })
})
