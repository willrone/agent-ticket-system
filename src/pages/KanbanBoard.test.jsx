import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import KanbanBoard from './KanbanBoard';
import * as ticketsApi from '../api/tickets';

vi.mock('../api/tickets', () => ({
  fetchTickets: vi.fn(),
  transitionTicket: vi.fn(),
}));

const mockTickets = [
  {
    id: 16,
    title: '修复 Dashboard 统计语义',
    status: 'running',
    assigned_agent: 'beavy',
    next_actor: 'beavy',
    priority: 'medium',
    locked_by: 'beavy',
  },
  {
    id: 17,
    title: 'review 中工单',
    status: 'review',
    assigned_agent: 'beavy',
    review_owner: 'leoss',
    triage_owner: 'leoss',
    next_actor: 'leoss',
    priority: 'medium',
    locked_by: null,
  },
  {
    id: 18,
    title: '待决策工单',
    status: 'pending_decision',
    assigned_agent: 'beavy',
    decision_owner: '荣晖',
    next_actor: '荣晖',
    priority: 'high',
    locked_by: null,
  },
  {
    id: 19,
    title: '已关单工单',
    status: 'complete',
    assigned_agent: 'beavy',
    next_actor: null,
    priority: 'low',
    locked_by: null,
  },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <KanbanBoard />
    </MemoryRouter>
  );
}

describe('KanbanBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('alert', vi.fn());
    vi.mocked(ticketsApi.fetchTickets).mockResolvedValue(mockTickets);
    vi.mocked(ticketsApi.transitionTicket).mockResolvedValue({ success: true });
  });

  it('renders real workflow columns and cards by actual status', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('工单看板')).toBeInTheDocument();
    });

    expect(screen.getByText('待验收')).toBeInTheDocument();
    expect(screen.getByText('审核中')).toBeInTheDocument();
    expect(screen.getByText('待决策')).toBeInTheDocument();
    expect(screen.getByText('已关单')).toBeInTheDocument();
    expect(screen.getByText('修复 Dashboard 统计语义')).toBeInTheDocument();
    expect(screen.getByText('review 中工单')).toBeInTheDocument();
    expect(screen.getByText('待决策工单')).toBeInTheDocument();
    expect(screen.getByText('已关单工单')).toBeInTheDocument();
  });

  it('uses assigned agent when dragging queued/running style transitions', async () => {
    const queuedTicket = {
      id: 21,
      title: '待开工工单',
      status: 'queued',
      assigned_agent: 'beavy',
      next_actor: 'beavy',
      priority: 'medium',
      locked_by: null,
    };
    vi.mocked(ticketsApi.fetchTickets).mockResolvedValue([queuedTicket]);

    const { container } = renderPage();

    await waitFor(() => {
      expect(screen.getByText('待开工工单')).toBeInTheDocument();
    });

    const card = screen.getByText('待开工工单').closest('[draggable="true"]');
    const runningColumn = Array.from(container.querySelectorAll('[class*="w-80"]')).find((node) => node.textContent?.includes('进行中'));

    fireEvent.dragStart(card, {
      dataTransfer: { effectAllowed: 'move', setData: vi.fn() },
    });
    fireEvent.dragOver(runningColumn, {
      preventDefault: vi.fn(),
      dataTransfer: { dropEffect: 'move' },
    });
    fireEvent.drop(runningColumn, {
      preventDefault: vi.fn(),
      dataTransfer: { dropEffect: 'move' },
    });

    await waitFor(() => {
      expect(ticketsApi.transitionTicket).toHaveBeenCalledWith(21, expect.objectContaining({
        action: 'start_work',
        actor: 'beavy',
      }));
    });
  });

  it('rejects unsupported drag transitions with clear message', async () => {
    const { container } = renderPage();

    await waitFor(() => {
      expect(screen.getByText('修复 Dashboard 统计语义')).toBeInTheDocument();
    });

    const card = screen.getByText('修复 Dashboard 统计语义').closest('[draggable="true"]');
    const failedColumn = Array.from(container.querySelectorAll('[class*="w-80"]')).find((node) => node.textContent?.includes('失败'));

    fireEvent.dragStart(card, {
      dataTransfer: { effectAllowed: 'move', setData: vi.fn() },
    });
    fireEvent.dragOver(failedColumn, {
      preventDefault: vi.fn(),
      dataTransfer: { dropEffect: 'move' },
    });
    fireEvent.drop(failedColumn, {
      preventDefault: vi.fn(),
      dataTransfer: { dropEffect: 'move' },
    });

    expect(globalThis.alert).toHaveBeenCalledWith(expect.stringContaining('当前不支持'));
    expect(ticketsApi.transitionTicket).not.toHaveBeenCalled();
  });
});
