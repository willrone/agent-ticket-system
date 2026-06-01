/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { validateAssignmentWrite } from './assignment-write-validation.js';
import {
  _resetDbForTesting,
  createTicket,
} from './store-sqlite.js';
import {
  _resetDbForTesting as _resetDispatchForTesting,
  recordDispatchEvent,
} from './dispatch.js';

describe('assignment-write-validation', () => {
  beforeEach(() => {
    _resetDbForTesting();
    _resetDispatchForTesting();
  });

  it('dispatch_receipt 必须绑定 assignment.dispatch_event_id，不能回写其他仍存在的 dispatch_event', () => {
    const ticket = createTicket({
      title: 'Dispatch receipt binding',
      description: 'Desc',
      status: 'review',
      review_owner: 'leoss',
      assigned_agent: 'beavy',
    });

    const staleDispatchId = recordDispatchEvent(ticket.id, 'leoss', 'done');
    const liveDispatchId = recordDispatchEvent(ticket.id, 'leoss', 'review');

    const assignment = {
      assignment_id: 'asg_review_current',
      ticket_id: ticket.id,
      dispatch_event_id: liveDispatchId,
      agent_id: 'leoss',
      stage: 'review',
    };

    const result = validateAssignmentWrite({
      assignment,
      ticket,
      kind: 'report',
      reportType: 'dispatch_receipt',
      payload: {
        receipt: {
          dispatch_id: staleDispatchId,
          ticket_id: ticket.id,
          stage: 'done',
          agent: 'leoss',
          decision: 'accepted',
        },
      },
      latestAssignment: assignment,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.code).toBe('DISPATCH_RECEIPT_DISPATCH_ID_INVALID');
    expect(result.machine_readable).toEqual(expect.objectContaining({
      code: 'DISPATCH_RECEIPT_DISPATCH_ID_INVALID',
      codes: expect.arrayContaining(['DISPATCH_RECEIPT_DISPATCH_ID_INVALID']),
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: 'DISPATCH_RECEIPT_DISPATCH_ID_INVALID',
          field: 'dispatch_id',
          expected: liveDispatchId,
          received: staleDispatchId,
        }),
      ]),
    }));
  });
});
