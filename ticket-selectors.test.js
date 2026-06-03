import { describe, it, expect } from 'vitest';
import {
  getCanonicalStatusMeta,
  getCanonicalBucketMeta,
  resolveTicketBucketKey,
  buildTicketViewModel,
  getTicketProgress,
  isActiveWorkflowStatus,
  isWaitingReviewWorkflowStatus,
  isClosedWorkflowStatus,
  isOpenWorkflowStatus,
  groupTicketsByStatus,
  buildDashboardMetrics,
  buildTodayProgressSummary,
  hasTriageGap,
  matchesTicketQuickView,
  buildTicketQuickViews,
  buildTicketListSummary,
  buildTicketStageGateStatus,
  buildTicketRuntimeDigest,
} from './ticket-selectors.js';

describe('ticket-selectors canonical helpers', () => {
  it('getCanonicalStatusMeta returns workflow meta for known status', () => {
    const meta = getCanonicalStatusMeta('running');
    expect(meta).toBeDefined();
    expect(meta.key).toBe('running');
    expect(meta.label).toBeTypeOf('string');
  });

  it('getCanonicalStatusMeta falls back to queued for unknown status', () => {
    const meta = getCanonicalStatusMeta('unknown-status');
    expect(meta.key).toBe('queued');
  });

  it('resolveTicketBucketKey maps status to workflow bucket group', () => {
    expect(resolveTicketBucketKey('triage')).toBe('active');
    expect(resolveTicketBucketKey('done')).toBe('waiting_review');
    expect(resolveTicketBucketKey('pending_decision')).toBe('waiting_decision');
    expect(resolveTicketBucketKey('complete')).toBe('closed');
    expect(resolveTicketBucketKey('deprecated')).toBe('deprecated');
  });

  it('getCanonicalBucketMeta returns bucket meta with statuses', () => {
    const bucket = getCanonicalBucketMeta('waiting_review');
    expect(bucket).toBeDefined();
    expect(bucket.key).toBe('waiting_review');
    expect(Array.isArray(bucket.statuses)).toBe(true);
    expect(bucket.statuses).toContain('done');
  });

  it('buildTicketViewModel decorates ticket with status_meta and bucket', () => {
    const ticket = { id: 1, status: 'done', title: 'Test ticket' };
    const vm = buildTicketViewModel(ticket);
    expect(vm).toEqual(expect.objectContaining({
      id: 1,
      status: 'done',
      status_meta: expect.objectContaining({ key: 'done', label: expect.any(String) }),
      bucket: expect.objectContaining({ key: 'waiting_review', statuses: expect.arrayContaining(['done']) }),
    }));
  });

  it('buildTicketViewModel is tolerant to missing status and falls back to queued', () => {
    const vm = buildTicketViewModel({ id: 2 });
    expect(vm.status).toBe('queued');
    expect(vm.status_meta.key).toBe('queued');
  });

  it('getTicketProgress returns reasonable progress per status', () => {
    expect(getTicketProgress('triage')).toBeGreaterThanOrEqual(0);
    expect(getTicketProgress('complete')).toBe(100);
    expect(getTicketProgress('deprecated')).toBe(100);
    expect(getTicketProgress('non-existent')).toBe(0);
  });

  it('workflow status helpers classify statuses correctly', () => {
    expect(isActiveWorkflowStatus('running')).toBe(true);
    expect(isWaitingReviewWorkflowStatus('done')).toBe(true);
    expect(isClosedWorkflowStatus('complete')).toBe(true);
    expect(isClosedWorkflowStatus('deprecated')).toBe(true);
    expect(isOpenWorkflowStatus('queued')).toBe(true);
    expect(isOpenWorkflowStatus('complete')).toBe(false);
    expect(isOpenWorkflowStatus('deprecated')).toBe(false);
  });

  it('groupTicketsByStatus groups by canonical status keys', () => {
    const tickets = [
      { id: 1, status: 'queued' },
      { id: 2, status: 'running' },
      { id: 3, status: 'done' },
    ];
    const groups = groupTicketsByStatus(tickets);
    expect(Object.keys(groups)).toEqual(expect.arrayContaining(['queued', 'running', 'done']));
    expect(groups.queued.map((t) => t.id)).toEqual([1]);
    expect(groups.running.map((t) => t.id)).toEqual([2]);
    expect(groups.done.map((t) => t.id)).toEqual([3]);
  });

  it('hasTriageGap detects missing triage fields', () => {
    const full = {
      triage_owner: 'leoss',
      platform: 'ticket-platform',
      request_type: 'feature',
      assigned_agent: 'beavy',
      triage_summary: 'desc',
    };
    expect(hasTriageGap(full)).toBe(false);
    expect(hasTriageGap({ ...full, platform: '' })).toBe(true);
  });

  it('quick views and list summary are consistent with workflow helpers', () => {
    const tickets = [
      { id: 1, status: 'queued', platform: 'ticket-platform', request_type: 'feature', assigned_agent: 'beavy', triage_summary: 'ok' },
      { id: 2, status: 'running', platform: 'ticket-platform', request_type: 'bug', assigned_agent: 'beavy', triage_summary: 'ok' },
      { id: 3, status: 'done', platform: 'ticket-platform', request_type: 'feature', assigned_agent: 'donky', triage_summary: 'ok' },
      { id: 4, status: 'complete', platform: 'ticket-platform', request_type: 'feature', assigned_agent: 'beavy', triage_summary: 'ok' },
      { id: 5, status: 'deprecated', platform: 'ticket-platform', request_type: 'task', assigned_agent: 'beavy', triage_summary: 'old' },
      { id: 6, status: 'triage', platform: '', request_type: '', assigned_agent: '', triage_summary: '' },
    ].map((t) => buildTicketViewModel(t));

    const views = buildTicketQuickViews(tickets);
    const summary = buildTicketListSummary(tickets, []);

    expect(views.find((v) => v.key === 'active')?.count).toBe(
      tickets.filter((t) => isActiveWorkflowStatus(t.status)).length,
    );
    expect(views.find((v) => v.key === 'waitingReview')?.count).toBe(
      tickets.filter((t) => isWaitingReviewWorkflowStatus(t.status)).length,
    );
    expect(views.find((v) => v.key === 'closed')?.count).toBe(
      tickets.filter((t) => isClosedWorkflowStatus(t.status)).length,
    );

    expect(summary.total).toBe(tickets.length);
    expect(summary.active).toBe(
      tickets.filter((t) => isActiveWorkflowStatus(t.status)).length,
    );
    expect(summary.waitingReview).toBe(
      tickets.filter((t) => isWaitingReviewWorkflowStatus(t.status)).length,
    );
    expect(summary.closed).toBe(
      tickets.filter((t) => isClosedWorkflowStatus(t.status)).length,
    );

    const triageGapTicket = tickets.find((t) => t.status === 'triage');
    expect(matchesTicketQuickView(triageGapTicket, 'triagePending')).toBe(true);
    expect(matchesTicketQuickView(triageGapTicket, 'triageIncomplete')).toBe(true);
  });

  it('buildDashboardMetrics uses workflow helpers for counts and distributions', () => {
    const tickets = [
      buildTicketViewModel({ id: 1, status: 'queued', created: '2026-03-11T10:00:00Z' }),
      buildTicketViewModel({ id: 2, status: 'running', created: '2026-03-10T10:00:00Z' }),
      buildTicketViewModel({ id: 3, status: 'done', created: '2026-03-09T10:00:00Z' }),
      buildTicketViewModel({ id: 4, status: 'complete', created: '2026-03-08T10:00:00Z' }),
      buildTicketViewModel({ id: 5, status: 'deprecated', created: '2026-03-07T10:00:00Z' }),
    ];

    const { stats, statusDistribution, todaySummary: _todaySummary, riskSummary: _riskSummary } = buildDashboardMetrics(tickets, {
      now: new Date('2026-03-11T12:00:00Z'),
    });

    expect(stats.total).toBe(5);
    expect(stats.active).toBe(
      tickets.filter((t) => isActiveWorkflowStatus(t.status)).length,
    );
    expect(stats.waitingReview).toBe(
      tickets.filter((t) => isWaitingReviewWorkflowStatus(t.status)).length,
    );
    expect(stats.closed).toBe(
      tickets.filter((t) => isClosedWorkflowStatus(t.status)).length,
    );

    const runningSlice = statusDistribution.find((item) => item.status === 'running');
    expect(runningSlice).toBeDefined();
    expect(runningSlice.value).toBe(1);
  });

  it('buildTodayProgressSummary counts by today date', () => {
    const tickets = [
      { id: 1, status: 'queued', created: '2026-03-11T10:00:00Z', last_update: '2026-03-11T10:00:00Z' },
      { id: 2, status: 'running', created: '2026-03-10T10:00:00Z', last_update: '2026-03-11T12:00:00Z' },
      { id: 3, status: 'complete', created: '2026-03-09T10:00:00Z', last_update: '2026-03-11T09:00:00Z' },
    ];
    const summary = buildTodayProgressSummary(tickets, { now: new Date('2026-03-11T15:00:00Z') });
    expect(summary.date).toBe('2026-03-11');
    expect(summary.createdToday).toBe(1);
    expect(summary.updatedToday).toBe(3);
    expect(summary.closedToday).toBe(1);
  });

  it('buildDashboardMetrics includes todaySummary and riskSummary', () => {
    const tickets = [
      buildTicketViewModel({ id: 1, status: 'blocked', created: '2026-03-11T10:00:00Z', triage_owner: 'leoss', platform: 'p', request_type: 'bug', assigned_agent: 'beavy', triage_summary: 'ok' }),
      buildTicketViewModel({ id: 2, status: 'pending_decision', created: '2026-03-11T10:00:00Z', triage_owner: 'leoss', platform: 'p', request_type: 'feature', assigned_agent: 'beavy', triage_summary: 'ok' }),
      buildTicketViewModel({ id: 3, status: 'triage', platform: '', triage_summary: '', assigned_agent: '' }),
    ];
    const out = buildDashboardMetrics(tickets, { now: new Date('2026-03-11T12:00:00Z') });
    expect(out.todaySummary).toBeDefined();
    expect(out.todaySummary.date).toBe('2026-03-11');
    expect(out.riskSummary).toBeDefined();
    expect(out.riskSummary.blocked).toBe(1);
    expect(out.riskSummary.pendingDecision).toBe(1);
    expect(out.riskSummary.triageGap).toBe(1);
  });

  it('buildTicketStageGateStatus: 仅历史 succeeded（无活跃证据）仍 at_risk', () => {
    const gateHistorical = buildTicketStageGateStatus(buildTicketViewModel({
      id: 71,
      status: 'queued',
      triage_owner: 'leoss',
      assigned_agent: 'beavy',
      review_owner: 'leoss',
      execution_mode: 'subagent',
      dispatch_state: 'receipt_accepted',
      execution_guard: {
        has_worker_evidence: true,
        has_active_execution_evidence: false,
        succeeded_workers: 1,
      },
    }));
    expect(gateHistorical.state).toBe('at_risk');
  });

  it('buildTicketStageGateStatus marks queued subagent without worker evidence as at risk', () => {
    const gate = buildTicketStageGateStatus(buildTicketViewModel({
      id: 7,
      status: 'queued',
      triage_owner: 'leoss',
      assigned_agent: 'beavy',
      review_owner: 'leoss',
      execution_mode: 'subagent',
      dispatch_state: 'receipt_accepted',
      execution_guard: {
        has_worker_evidence: false,
        has_active_execution_evidence: false,
      },
    }));

    expect(gate.state).toBe('at_risk');
    expect(gate.label).toBe('缺 worker 证据');
    expect(gate.summary).toContain('活跃');
  });

  it('buildTicketRuntimeDigest: receipt_accepted 下仅有历史 succeeded 仍视为待活跃 worker', () => {
    const digest = buildTicketRuntimeDigest(buildTicketViewModel({
      id: 70,
      status: 'queued',
      execution_mode: 'subagent',
      dispatch_state: 'receipt_accepted',
      worker_stats: {
        total_workers: 1,
        active_workers: 0,
        running_workers: 0,
      },
      current_workers: [],
      execution_workers: [
        {
          worker_key: 'subagent-succeeded',
          worker_type: 'subagent',
          status: 'succeeded',
        },
      ],
    }));

    expect(digest.has_worker_evidence).toBe(true);
    expect(digest.has_active_execution_evidence).toBe(false);
    expect(digest.has_completed_execution_evidence).toBe(true);
    expect(digest.state).toBe('waiting_worker');
    expect(digest.summary).toContain('历史 completed');
  });

  it('buildTicketRuntimeDigest: triage 即使带 awaiting_receipt / receipt_accepted 也不计入 runtime 风险', () => {
    const awaitingDigest = buildTicketRuntimeDigest(buildTicketViewModel({
      id: 72,
      status: 'triage',
      triage_owner: 'leoss',
      dispatch_state: 'awaiting_receipt',
      awaiting_receipt_from: 'leoss',
    }));
    const workerDigest = buildTicketRuntimeDigest(buildTicketViewModel({
      id: 73,
      status: 'triage',
      triage_owner: 'leoss',
      dispatch_state: 'receipt_accepted',
      execution_mode: 'subagent',
      execution_guard: {
        has_worker_evidence: false,
        has_active_execution_evidence: false,
      },
    }));
    const metrics = buildDashboardMetrics([
      buildTicketViewModel({
        id: 72,
        status: 'triage',
        triage_owner: 'leoss',
        dispatch_state: 'awaiting_receipt',
        awaiting_receipt_from: 'leoss',
      }),
      buildTicketViewModel({
        id: 73,
        status: 'triage',
        triage_owner: 'leoss',
        dispatch_state: 'receipt_accepted',
        execution_mode: 'subagent',
        execution_guard: {
          has_worker_evidence: false,
          has_active_execution_evidence: false,
        },
      }),
    ]);

    expect(awaitingDigest.state).toBe('idle');
    expect(workerDigest.state).toBe('idle');
    expect(metrics.riskSummary.awaitingReceipt).toBe(0);
    expect(metrics.riskSummary.waitingWorker).toBe(0);
  });

  it('buildTicketStageGateStatus marks missing responsibility owners as gap', () => {
    const gate = buildTicketStageGateStatus(buildTicketViewModel({
      id: 8,
      status: 'pending_decision',
      triage_owner: 'leoss',
      assigned_agent: 'beavy',
      review_owner: 'leoss',
      decision_owner: null,
    }));

    expect(gate.state).toBe('gap');
    expect(gate.missing_owners).toContain('decision_owner');
  });
});
