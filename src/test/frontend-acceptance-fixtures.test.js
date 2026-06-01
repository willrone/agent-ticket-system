import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  buildExpectedKanbanColumns,
  FRONTEND_ACCEPTANCE_AGENT_ACTION_MATRIX,
  FRONTEND_ACCEPTANCE_DASHBOARD_PAYLOAD,
  FRONTEND_ACCEPTANCE_QUICK_VIEWS,
  FRONTEND_ACCEPTANCE_TICKETS,
  FRONTEND_ACCEPTANCE_VIEW_MODELS,
  listAcceptanceAgentActionStatuses,
  listMissingAcceptanceStatuses,
} from './frontend-acceptance-fixtures.js';
import {
  KANBAN_COLUMNS,
  WORKFLOW_BUCKET_META,
  WORKFLOW_METRIC_GROUPS,
  WORKFLOW_STATUS_ORDER,
  listAvailableActionsForStatus,
} from '../../workflow-schema.js';

const hostedRuntimeContextFixturePath = path.resolve(
  process.cwd(),
  'fixtures/ticket-platform-live/2026-03-15T1115+08-baseline/agent-runtime-context.json',
);
const hostedRuntimeContextFixture = JSON.parse(fs.readFileSync(hostedRuntimeContextFixturePath, 'utf8'));
const hostedTicketActions = hostedRuntimeContextFixture.data.ticket_actions;
const hostedAgentActionMatrix = Object.fromEntries(
  hostedTicketActions
    .filter((action) => action.key !== 'create')
    .flatMap((action) => (action.allowed_statuses || []).map((status) => [status, null]))
    .map(([status]) => [
      status,
      hostedTicketActions
        .filter((action) => action.key !== 'create' && (action.allowed_statuses || []).includes(status))
        .map((action) => action.key),
    ]),
);

describe('frontend acceptance fixtures parity', () => {
  it('covers every workflow status exactly through the shared acceptance baseline', () => {
    expect(listMissingAcceptanceStatuses()).toEqual([]);
    expect(new Set(FRONTEND_ACCEPTANCE_TICKETS.map((ticket) => ticket.status))).toEqual(new Set(WORKFLOW_STATUS_ORDER));
  });

  it('keeps view-model bucket mapping aligned with workflow bucket meta', () => {
    for (const ticket of FRONTEND_ACCEPTANCE_VIEW_MODELS) {
      expect(ticket.bucket.key).toBe(ticket.status_meta.group);
      expect(WORKFLOW_BUCKET_META[ticket.bucket.key]?.statuses).toContain(ticket.status);
    }
  });

  it('keeps dashboard payload aligned with canonical metric groups', () => {
    const stats = FRONTEND_ACCEPTANCE_DASHBOARD_PAYLOAD.data.stats;
    expect(stats.total).toBe(FRONTEND_ACCEPTANCE_VIEW_MODELS.length);
    expect(stats.active).toBe(
      FRONTEND_ACCEPTANCE_VIEW_MODELS.filter((ticket) => WORKFLOW_METRIC_GROUPS.active.includes(ticket.status)).length,
    );
    expect(stats.waitingReview).toBe(
      FRONTEND_ACCEPTANCE_VIEW_MODELS.filter((ticket) => WORKFLOW_METRIC_GROUPS.waiting_review.includes(ticket.status)).length,
    );
    expect(stats.closed).toBe(
      FRONTEND_ACCEPTANCE_VIEW_MODELS.filter((ticket) => WORKFLOW_METRIC_GROUPS.closed.includes(ticket.status)).length,
    );
  });

  it('keeps quick views stable for reviewer-facing baseline checks', () => {
    const triageIncomplete = FRONTEND_ACCEPTANCE_QUICK_VIEWS.find((view) => view.key === 'triageIncomplete');
    const beavy = FRONTEND_ACCEPTANCE_QUICK_VIEWS.find((view) => view.key === 'beavy');
    expect(triageIncomplete?.count).toBe(1);
    expect(beavy?.count).toBeGreaterThan(0);
  });

  it('keeps expected kanban labels aligned with workflow columns', () => {
    expect(buildExpectedKanbanColumns()).toEqual(KANBAN_COLUMNS.map((column) => column.label));
  });

  it('keeps agent-facing action baseline aligned with workflow status semantics', () => {
    for (const [status, actions] of Object.entries(FRONTEND_ACCEPTANCE_AGENT_ACTION_MATRIX)) {
      expect(listAvailableActionsForStatus(status)).toEqual(expect.arrayContaining(actions));
    }
  });

  it('keeps agent-facing action baseline in parity with hosted runtime context fixture', () => {
    expect(new Set(listAcceptanceAgentActionStatuses())).toEqual(new Set(Object.keys(hostedAgentActionMatrix)));

    for (const [status, actions] of Object.entries(FRONTEND_ACCEPTANCE_AGENT_ACTION_MATRIX)) {
      expect(hostedAgentActionMatrix[status]).toEqual(expect.arrayContaining(actions));
      expect(actions).toEqual(expect.arrayContaining(hostedAgentActionMatrix[status]));
    }
  });
});
