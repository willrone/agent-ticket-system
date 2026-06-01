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
  nudgeTicket: vi.fn(),
  fetchAgentTopology: vi.fn(),
  fetchPlaybookStage: vi.fn(),
  fetchTicketDependencies: vi.fn(),
  addTicketDependency: vi.fn(),
  removeTicketDependency: vi.fn(),
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
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.mocked(ticketsApi.getTicket).mockResolvedValue(baseTicket);
    vi.mocked(ticketsApi.getTicketActions).mockResolvedValue({
      available_actions: ['start_work', 'submit_for_review'],
      action_objects: [
        {
          key: 'start_work',
          label: '🚀 开工',
          from: ['queued'],
          to: 'running',
          required_fields: ['actor'],
          role_key: 'assigned_agent',
        },
        {
          key: 'submit_for_review',
          label: '✅ 提交验收',
          from: ['running'],
          to: 'done',
          required_fields: ['actor', 'result_summary'],
          role_key: 'assigned_agent',
        },
      ],
    });
    vi.mocked(ticketsApi.transitionTicket).mockResolvedValue({
      success: true,
      ticket: { ...baseTicket, status: 'running' },
    });
    vi.mocked(ticketsApi.addComment).mockResolvedValue({
      id: 999,
      author: 'leoss',
      timestamp: '2026-03-06T10:00:00Z',
      content: 'My new comment',
      type: 'progress',
      visibility: 'internal',
      mentions: [],
      notify_targets: [],
    });
    vi.mocked(ticketsApi.nudgeTicket).mockResolvedValue({
      success: true,
      ready_item: {
        agent: 'leoss',
      },
    });
    vi.mocked(ticketsApi.fetchAgentTopology).mockResolvedValue({
      data: {
        main_gateway_id: 'mac-main',
        gateways: {
          'mac-main': {
            id: 'mac-main',
            label: 'Mac 主平台',
            transport: 'local_cli',
          },
        },
        agent_directory: {
          leoss: {
            id: 'leoss',
            display_name: '老李',
            role_type: 'owner',
            ownership_layer: 'platform_owner',
            primary_platform: 'ticket-platform',
            gateway_id: 'mac-main',
          },
          beavy: {
            id: 'beavy',
            display_name: '小李',
            role_type: 'builder',
            ownership_layer: 'development',
            primary_platform: 'ticket-platform',
            gateway_id: 'mac-main',
          },
          donky: {
            id: 'donky',
            display_name: '小驴',
            role_type: 'builder',
            ownership_layer: 'development',
            primary_platform: 'stock-platform',
            gateway_id: 'mac-main',
          },
        },
        platforms: {
          'ticket-platform': {
            id: 'ticket-platform',
            display_name: '工单平台',
          },
          'stock-platform': {
            id: 'stock-platform',
            display_name: '股票平台',
          },
        },
        responsibility_layers: [],
        topology_edges: [],
        summary: {},
      },
    });
    vi.mocked(ticketsApi.fetchPlaybookStage).mockResolvedValue({
      data: {
        stage: 'triage',
        goal: '把 triage 阶段推进到 queued，或明确说明为什么暂时不能 queue。',
        next_stage_options: ['queued', 'pending_decision'],
        recommended_paths: ['责任链完整时 queue，缺上下文时 request_decision。'],
        checklist: [
          { id: 'triage-check-1', text: '补齐目标、范围、约束、交付物、验收标准。', owner: 'triage' },
        ],
        evidence_requirements: [
          { id: 'triage-evidence-1', text: 'assignment/ticket 中能读到最小需求 contract。', owner: 'manager' },
        ],
      },
    });
    vi.mocked(ticketsApi.fetchTicketDependencies).mockResolvedValue({
      dependencies: [],
      dependents: [],
    });
    vi.mocked(ticketsApi.addTicketDependency).mockResolvedValue({ success: true });
    vi.mocked(ticketsApi.removeTicketDependency).mockResolvedValue({ success: true });
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


  it('renders control read model panels when detail payload includes aggregated views', async () => {
    vi.mocked(ticketsApi.getTicket).mockResolvedValue({
      ...baseTicket,
      status: 'queued',
      current_actor: 'beavy',
      control_read_model: {
        responsibility_view: {
          current_actor: 'beavy',
          summary: '分诊: leoss · 执行: beavy · 验收: leoss',
          chain: [
            { role: 'triage_owner', label: '分诊负责人', value: 'leoss', source: 'ticket' },
            { role: 'assigned_agent', label: '执行人', value: 'beavy', source: 'ticket' },
          ],
        },
        ticket_operational_view: {
          bucket: 'active',
          execution_mode: 'subagent',
          latest_report_type: 'progress_update',
          latest_comment_summary: {
            by: 'beavy',
            at: '2026-03-06T09:00:00Z',
            excerpt: 'Loop worker 已启动，开始第一轮回归。',
          },
        },
        execution_guard_view: {
          requires_worker: true,
          has_worker_evidence: false,
          active_workers: 0,
          max_active_workers: 1,
          suppress_dispatch: false,
          reason: 'waiting_worker',
          available_actions: ['start_work', 'pause'],
        },
        runtime_digest_view: {
          state: 'waiting_worker',
          summary: '已 receipt accepted，但尚未出现真实 worker/running 证据。',
          execution_mode: 'subagent',
          dispatch_state: 'receipt_accepted',
          awaiting_receipt_from: null,
          current_actor: 'beavy',
          active_workers: 0,
          running_workers: 0,
        },
      },
    });
    vi.mocked(ticketsApi.getTicketActions).mockResolvedValue({
      available_actions: ['start_work', 'pause'],
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Control Read Model')).toBeInTheDocument();
    });

    expect(screen.getByText('Responsibility View')).toBeInTheDocument();
    expect(screen.getByText('Operational View')).toBeInTheDocument();
    expect(screen.getAllByText('Execution Guard').length).toBeGreaterThan(0);
    expect(screen.getByText('Runtime Digest')).toBeInTheDocument();
    expect(screen.getByText(/分诊: leoss · 执行: beavy · 验收: leoss/)).toBeInTheDocument();
    expect(screen.getByText('老李')).toBeInTheDocument();
    expect(screen.getByText('@leoss')).toBeInTheDocument();
    expect(screen.getByText('责任层：platform_owner')).toBeInTheDocument();
    expect(screen.getAllByText('平台：工单平台').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Gateway：Mac 主平台').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Loop worker 已启动，开始第一轮回归/).length).toBeGreaterThan(0);
    expect(screen.getByText('progress_update')).toBeInTheDocument();
    expect(screen.getAllByText('waiting_worker').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/已 receipt accepted，但尚未出现真实 worker\/running 证据/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('需要 worker').length).toBeGreaterThan(0);
  });

  it('renders evidence snapshot and unified evidence timeline', async () => {
    vi.mocked(ticketsApi.getTicket).mockResolvedValue({
      ...baseTicket,
      status: 'running',
      assigned_agent: 'beavy',
      current_actor: 'beavy',
      execution_workers: [
        {
          id: 49,
          worker_key: 'ticket-83-loop-worker',
          worker_type: 'subagent',
          status: 'running',
          session_key: 'agent:beavy:subagent:demo',
          run_id: 'run_demo_123',
          label: 'ticket-83-loop-worker',
          summary: 'Loop-controlled subagent spawned',
          started_at: '2026-03-16T14:38:05.555Z',
          last_heartbeat_at: '2026-03-16T14:40:05.555Z',
        },
      ],
      control_read_model: {
        responsibility_view: {
          current_actor: 'beavy',
          summary: '分诊: leoss · 执行: beavy · 验收: leoss',
          chain: [],
        },
        ticket_operational_view: {
          latest_report_type: 'progress_update',
          latest_comment_summary: {
            by: 'beavy',
            at: '2026-03-16T14:41:05.555Z',
            excerpt: 'worker 已启动并开始第一轮回归。',
          },
        },
        execution_guard_view: {
          requires_worker: true,
          has_worker_evidence: true,
          active_workers: 1,
          max_active_workers: 1,
          suppress_dispatch: false,
          reason: 'worker_running',
          available_actions: ['submit_for_review'],
        },
        runtime_digest_view: {
          state: 'running',
          summary: '已有 1 个活跃 worker 在跑。',
          execution_mode: 'subagent',
          dispatch_state: 'receipt_accepted',
          awaiting_receipt_from: null,
          current_actor: 'beavy',
          active_workers: 1,
          running_workers: 1,
        },
      },
    });
    vi.mocked(ticketsApi.getTicketActions).mockResolvedValue({
      available_actions: ['submit_for_review'],
      action_objects: [],
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Evidence Snapshot')).toBeInTheDocument();
    });

    expect(screen.getByText('Evidence Timeline')).toBeInTheDocument();
    expect(screen.getAllByText(/已有 worker 证据/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/最新评论摘要/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/worker 已启动并开始第一轮回归/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Runtime Digest · running/)).toBeInTheDocument();
    expect(screen.getByText(/Worker · ticket-83-loop-worker/)).toBeInTheDocument();
    expect(screen.getAllByText(/run_demo_123/).length).toBeGreaterThan(0);
  });

  it('renders action preflight, execution records, and raw error details', async () => {
    vi.mocked(ticketsApi.getTicket).mockResolvedValue({
      ...baseTicket,
      status: 'running',
      assigned_agent: 'beavy',
      current_actor: 'beavy',
      error: 'live raw error payload',
      execution_workers: [
        {
          id: 49,
          worker_key: 'ticket-83-loop-worker',
          worker_type: 'subagent',
          status: 'running',
          session_key: 'agent:beavy:subagent:demo',
          run_id: 'run_demo_123',
          label: 'ticket-83-loop-worker',
          summary: 'Loop-controlled subagent spawned',
          started_at: '2026-03-16T14:38:05.555Z',
          last_heartbeat_at: '2026-03-16T14:40:05.555Z',
        },
      ],
    });
    vi.mocked(ticketsApi.getTicketActions).mockResolvedValue({
      available_actions: ['submit_for_review', 'pause'],
      action_objects: [
        {
          key: 'submit_for_review',
          label: '✅ 提交验收',
          from: ['running'],
          to: 'done',
          required_fields: ['actor', 'result_summary'],
          role_key: 'assigned_agent',
        },
      ],
    });
    vi.mocked(ticketsApi.transitionTicket).mockRejectedValueOnce(Object.assign(new Error('Bad request'), {
      details: {
        detail: 'result_summary 不能为空',
        request_id: 'req_test_123',
        missing_fields: ['result_summary'],
      },
    }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Action Preflight')).toBeInTheDocument();
    });

    expect(screen.getByText(/角色：assigned_agent/)).toBeInTheDocument();
    expect(screen.getByText(/必填字段：actor、result_summary/)).toBeInTheDocument();
    expect(screen.getByText('Execution Records')).toBeInTheDocument();
    expect(screen.getAllByText(/ticket-83-loop-worker/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/run_demo_123/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '✅ 提交验收' }));
    const resultSummaryField = screen.getByText(/结果摘要/).parentElement.querySelector('textarea');
    fireEvent.change(resultSummaryField, {
      target: { value: '先给一个摘要，模拟后端仍拒绝' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认' }));

    await waitFor(() => {
      expect(globalThis.alert).toHaveBeenCalledWith('操作失败: result_summary 不能为空');
    });

    expect(screen.getAllByText(/request_id：req_test_123/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/错误原文/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/result_summary 不能为空/).length).toBeGreaterThan(0);
  });


  it('renders stage orchestration card for running tickets', async () => {
    vi.mocked(ticketsApi.getTicket).mockResolvedValue({
      ...baseTicket,
      status: 'running',
      assigned_agent: 'beavy',
      current_actor: 'beavy',
      review_owner: 'leoss',
      execution_mode: 'subagent',
      dispatch_state: 'receipt_accepted',
      triage_summary: '',
      comments: [],
    });
    vi.mocked(ticketsApi.getTicketActions).mockResolvedValue({
      available_actions: ['submit_for_review'],
      action_objects: [],
    });
    vi.mocked(ticketsApi.fetchPlaybookStage).mockResolvedValue({
      data: {
        stage: 'running',
        goal: '把 running 收口到 done 或其他明确下一阶段。',
        next_stage_options: ['done', 'blocked', 'pending_decision'],
        recommended_paths: ['实现与验证完成后提交 execution_completed / review_submission。'],
        checklist: [
          { id: 'running-check-1', text: '先 receipt，再推进到下一阶段；不能卡在 queued/running。', owner: 'executor' },
        ],
        evidence_requirements: [
          { id: 'running-evidence-1', text: '补齐最小验证，并把关键进展写入 memory 与 reports。', owner: 'reviewer' },
        ],
      },
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('阶段推进与交接编排')).toBeInTheDocument();
    });

    expect(screen.getByText('Stage Orchestration')).toBeInTheDocument();
    expect(screen.getAllByText(/当前处于进行中，由 beavy 继续实现与验证；完成后应提交到待验收。/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/下一步建议/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/✅ 提交验收/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/目标阶段/).length).toBeGreaterThan(0);
    expect(screen.getByText(/^待验收$/)).toBeInTheDocument();
    expect(screen.getAllByText(/交接摘要/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/reviewer leoss/).length).toBeGreaterThan(0);
    expect(screen.getByText('Playbook SOP')).toBeInTheDocument();
    expect(screen.getByText(/把 running 收口到 done 或其他明确下一阶段/)).toBeInTheDocument();
    expect(screen.getByText(/先 receipt，再推进到下一阶段；不能卡在 queued\/running/)).toBeInTheDocument();
    expect(screen.getByText(/补齐最小验证，并把关键进展写入 memory 与 reports/)).toBeInTheDocument();
    expect(ticketsApi.fetchPlaybookStage).toHaveBeenCalledWith('running', {
      mode: 'subagent',
      role: 'executor',
    });
  });

  it('renders reviewer summary and decision panel for review-stage tickets', async () => {
    vi.mocked(ticketsApi.getTicket).mockResolvedValue({
      ...baseTicket,
      status: 'review',
      result_summary: '功能已完成，等待 reviewer 最终确认。',
      comments: [],
      supplemental_tickets: [
        {
          relation_type: 'validation_of',
          relation_label: '补充验证',
          ticket: { id: 12, title: 'Validation ticket', status: 'done', result_summary: '待 reviewer 收口' },
        },
      ],
      supplemental_summary: { total: 1, open: 1, complete: 0, pending_review: 1, by_status: { done: 1 } },
    });
    vi.mocked(ticketsApi.getTicketActions).mockResolvedValue({
      available_actions: ['approve', 'reject', 'request_decision'],
    });
    vi.mocked(ticketsApi.fetchTicketDependencies).mockResolvedValue({
      dependencies: [
        {
          id: 2,
          ticket_id: 1,
          depends_on_ticket_id: 8,
          dependency_type: 'blocks',
          created_at: '2026-03-08T12:00:00Z',
        },
      ],
      dependents: [],
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Review Inbox')).toBeInTheDocument();
    });

    expect(screen.getByText('Review Summary')).toBeInTheDocument();
    expect(screen.getByText('Decision Panel')).toBeInTheDocument();
    expect(screen.getByText(/reviewer 可直接收口/)).toBeInTheDocument();
    expect(screen.getAllByText(/功能已完成，等待 reviewer 最终确认/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/补充验证：共 1 张/)).toBeInTheDocument();
    expect(screen.getByText(/前置依赖 1 项/)).toBeInTheDocument();
    expect(screen.getByText(/Reviewer 可直接执行/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '👍 通过关单' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '👎 打回重做' })).toBeInTheDocument();
    expect(screen.getByText(/需要升级 \/ 决策动作/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '🤔 请求决策' })).toBeInTheDocument();
  });

  it('renders boss-decision split for pending decision tickets', async () => {
    vi.mocked(ticketsApi.getTicket).mockResolvedValue({
      ...baseTicket,
      status: 'pending_decision',
      next_actor: '荣晖',
      decision_owner: '荣晖',
      decision_summary: '需要确认是否继续开放 reviewer assignment 化。',
      decision_context: '当前变更涉及 reviewer 工作台和 assignment contract。',
      comments: [],
    });
    vi.mocked(ticketsApi.getTicketActions).mockResolvedValue({
      available_actions: ['resume_from_decision'],
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Decision Panel')).toBeInTheDocument();
    });

    expect(screen.getByText(/待老大 \/ decision owner 拍板/)).toBeInTheDocument();
    expect(screen.getByText(/当前决策人：荣晖/)).toBeInTheDocument();
    expect(screen.getByText('决策负责人')).toBeInTheDocument();
    expect(screen.getAllByText(/^荣晖$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/需要确认是否继续开放 reviewer assignment 化/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/decision owner 可直接点击“恢复执行”/)).toBeInTheDocument();
    expect(screen.getByText(/需要升级 \/ 决策动作/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '▶️ 恢复执行' })).toBeInTheDocument();
    expect(screen.queryByText(/Reviewer 可直接执行/)).not.toBeInTheDocument();
  });


  it('renders pause action and requires pause reason', async () => {
    vi.mocked(ticketsApi.getTicket).mockResolvedValue({
      ...baseTicket,
      status: 'running',
    });
    vi.mocked(ticketsApi.getTicketActions).mockResolvedValue({
      available_actions: ['pause'],
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '⏸️ 暂时挂起' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '⏸️ 暂时挂起' }));
    expect(screen.getByText(/挂起原因/)).toBeInTheDocument();
  });

  it('supports one-click nudge for current actor', async () => {
    vi.mocked(ticketsApi.getTicket).mockResolvedValue({
      ...baseTicket,
      status: 'running',
      current_actor: 'beavy',
      next_actor: 'beavy',
      assigned_agent: 'beavy',
    });
    vi.mocked(ticketsApi.getTicketActions).mockResolvedValue({
      available_actions: ['pause'],
    });
    vi.mocked(ticketsApi.nudgeTicket).mockResolvedValue({
      success: true,
      ready_item: { agent: 'beavy' },
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '⚡ 催 beavy' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '⚡ 催 beavy' }));

    await waitFor(() => {
      expect(ticketsApi.nudgeTicket).toHaveBeenCalledWith('1');
    });
    expect(globalThis.alert).toHaveBeenCalledWith('已向 beavy 发出催单消息');
  });

  it('renders reset_to_queued action and requires reason', async () => {
    vi.mocked(ticketsApi.getTicket).mockResolvedValue({
      ...baseTicket,
      status: 'running',
      triage_owner: 'leoss',
      next_actor: 'leoss',
      locked_by: 'beavy',
    });
    vi.mocked(ticketsApi.getTicketActions).mockResolvedValue({
      available_actions: ['reset_to_queued'],
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '↩️ 撤销开工回队列' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '↩️ 撤销开工回队列' }));
    expect(screen.getByText(/撤销原因/)).toBeInTheDocument();
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
        actor: 'donky',
        result_summary: '任务完成，等待验收',
        comment: '补一条状态变更说明',
      }));
    });
  });

  it('submits reset_to_queued with triage_owner actor and reason', async () => {
    vi.mocked(ticketsApi.getTicket).mockResolvedValue({
      ...baseTicket,
      status: 'running',
      triage_owner: 'leoss',
      next_actor: 'leoss',
      locked_by: 'beavy',
    });
    vi.mocked(ticketsApi.getTicketActions).mockResolvedValue({
      available_actions: ['reset_to_queued'],
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '↩️ 撤销开工回队列' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '↩️ 撤销开工回队列' }));

    const reasonField = screen.getByText(/撤销原因/).parentElement.querySelector('textarea');
    const commentField = screen.getByPlaceholderText('描述此操作...');

    fireEvent.change(reasonField, {
      target: { value: '误触开工，需要回到待处理' },
    });
    fireEvent.change(commentField, {
      target: { value: '尚未真正开始执行' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认' }));

    await waitFor(() => {
      expect(ticketsApi.transitionTicket).toHaveBeenCalledWith('1', expect.objectContaining({
        action: 'reset_to_queued',
        actor: 'leoss',
        reason: '误触开工，需要回到待处理',
        comment: '尚未真正开始执行',
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
          author: 'leoss',
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
        author: 'leoss',
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

  it('renders dependencies section with empty state', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('依赖关系')).toBeInTheDocument();
    });

    expect(screen.getByText('无依赖')).toBeInTheDocument();
    expect(screen.getByText('无工单依赖本工单')).toBeInTheDocument();
  });

  it('renders dependencies and dependents when present', async () => {
    vi.mocked(ticketsApi.fetchTicketDependencies).mockResolvedValue({
      dependencies: [
        {
          id: 1,
          ticket_id: 1,
          depends_on_ticket_id: 2,
          dependency_type: 'blocks',
          created_at: '2026-03-08T12:00:00Z',
        },
      ],
      dependents: [
        {
          id: 2,
          ticket_id: 3,
          depends_on_ticket_id: 1,
          dependency_type: 'blocks',
          created_at: '2026-03-08T13:00:00Z',
        },
      ],
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('🔗 本工单依赖 (1)')).toBeInTheDocument();
      expect(screen.getByText('⬅️ 被依赖 (1)')).toBeInTheDocument();
    });

    expect(screen.getByText('#2')).toBeInTheDocument();
    expect(screen.getByText('#3')).toBeInTheDocument();
  });

  it('renders supplemental relation summary for primary and supplemental tickets', async () => {
    vi.mocked(ticketsApi.getTicket).mockResolvedValue({
      ...baseTicket,
      parent_child_summary: {
        is_parent: true,
        has_parent: false,
        parent_ticket_id: null,
        child_count: 2,
        terminal_child_count: 1,
        open_child_count: 1,
        all_children_terminal: false,
        by_status: { complete: 1, review: 1 },
        latest_completed_at: '2026-03-06T08:00:00Z',
        latest_completed_child: { id: 69, title: 'Child completed', status: 'complete', completed_at: '2026-03-06T08:00:00Z' },
        blocked_child_count: 0,
        failed_child_count: 0,
        attention_required: false,
        blocking_children: [
          { id: 70, title: 'Child still in review', status: 'review', result_summary: '等待 reviewer 最终确认' },
        ],
      },
      supplemental_for_ticket: {
        relation_type: 'smoke_of',
        relation_label: 'Smoke 验证',
        ticket: { id: 61, title: 'Primary ticket', status: 'complete' },
      },
      supplemental_tickets: [
        {
          relation_type: 'validation_of',
          relation_label: '补充验证',
          ticket: { id: 62, title: 'Validation ticket', status: 'done', result_summary: '待 reviewer 收口' },
        },
      ],
      supplemental_summary: { total: 1, open: 1, complete: 0, pending_review: 1, by_status: { done: 1 } },
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('补充验证关系')).toBeInTheDocument();
    });

    expect(screen.getByText('子单汇总')).toBeInTheDocument();
    expect(screen.getByText('母单 / 子单收口')).toBeInTheDocument();
    expect(screen.getByText(/子单 2 张 · 已终态 1 张 · 未闭环 1 张/)).toBeInTheDocument();
    expect(screen.getByText('仍有子单未闭环')).toBeInTheDocument();
    expect(screen.getAllByText(/× 1/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/最近完成时间：/)).toBeInTheDocument();
    expect(screen.getByText('风险信号：blocked 0 · failed 0')).toBeInTheDocument();
    expect(screen.getByText('#70')).toBeInTheDocument();
    expect(screen.getByText('等待 reviewer 最终确认')).toBeInTheDocument();
    expect(screen.getByText(/这是一张/)).toBeInTheDocument();
    expect(screen.getByText('#61')).toBeInTheDocument();
    expect(screen.getByText(/围绕本单的补充验证 \(1\)/)).toBeInTheDocument();
    expect(screen.getByText('#62')).toBeInTheDocument();
    expect(screen.getByText('待 reviewer 收口')).toBeInTheDocument();
  });

  it('adds dependency when form is submitted', async () => {
    vi.mocked(ticketsApi.fetchTicketDependencies)
      .mockResolvedValueOnce({ dependencies: [], dependents: [] })
      .mockResolvedValueOnce({
        dependencies: [
          {
            id: 1,
            ticket_id: 1,
            depends_on_ticket_id: 5,
            dependency_type: 'blocks',
            created_at: '2026-03-09T12:00:00Z',
          },
        ],
        dependents: [],
      });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('+ 添加依赖')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('+ 添加依赖'));

    const input = screen.getByPlaceholderText('输入依赖的工单 ID');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '确认' }));

    await waitFor(() => {
      expect(ticketsApi.addTicketDependency).toHaveBeenCalledWith('1', 5);
    });
  });

  it('removes dependency when delete button is clicked', async () => {
    vi.mocked(ticketsApi.fetchTicketDependencies)
      .mockResolvedValueOnce({
        dependencies: [
          {
            id: 1,
            ticket_id: 1,
            depends_on_ticket_id: 2,
            dependency_type: 'blocks',
            created_at: '2026-03-08T12:00:00Z',
          },
        ],
        dependents: [],
      })
      .mockResolvedValueOnce({ dependencies: [], dependents: [] });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('#2')).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByText('删除');
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(ticketsApi.removeTicketDependency).toHaveBeenCalledWith('1', 2);
    });
  });
});
