/**
 * @vitest-environment node
 * Assignment Contract v2 shadow-mode tests
 */
/* global process */
import './test-setup.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as store from './store-sqlite.js';
import { buildAssignmentContract } from './agent-facing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, 'data');
const ORIGINAL_DB_PATH = process.env.TICKETS_DB_PATH;

function resetStore() {
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  const dbPath = path.join(TEST_DIR, `assignment-contract-v2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.TICKETS_DB_PATH = dbPath;
  store._resetDbForTesting();
}

function cleanupStore() {
  const dbPath = process.env.TICKETS_DB_PATH;
  store._resetDbForTesting();
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
  if (ORIGINAL_DB_PATH) {
    process.env.TICKETS_DB_PATH = ORIGINAL_DB_PATH;
  } else {
    delete process.env.TICKETS_DB_PATH;
  }
}

describe('assignment contract v2 shadow mode', () => {
  beforeEach(resetStore);
  afterEach(cleanupStore);

  it('derives executor v2 shadow fields for existing assignment creation flow', () => {
    const ticket = store.createTicket({
      title: 'Executor shadow contract',
      description: 'Verify v2 fields are derived without changing existing assignment behavior',
      status: 'queued',
      assigned_agent: 'beavy',
      triage_owner: 'leoss',
      review_owner: 'leoss',
    });

    const assignment = store.createOrReuseAssignment({
      ticket_id: ticket.id,
      agent_id: 'beavy',
      role: 'execute',
      stage: 'queued',
      expires_at: '2099-01-01T00:00:00.000Z',
    });

    expect(assignment.role).toBe('execute');
    expect(assignment.stage).toBe('queued');
    expect(assignment.role_type).toBe('executor');
    expect(assignment.workflow_template).toBe('software_task_v1');
    expect(assignment.allowed_actions).toEqual(expect.arrayContaining(['progress_update', 'execution_completed', 'blocked_report']));
    expect(assignment.required_outputs).toEqual(['progress_update', 'execution_completed']);
    expect(assignment.stale_after_at).toBe('2099-01-01T00:00:00.000Z');
    expect(assignment.v2_contract).toEqual(expect.objectContaining({
      role_type: 'executor',
      workflow_template: 'software_task_v1',
      shadow_mode: true,
    }));
  });

  it('allows explicit required outputs and exposes v2 contract through agent-facing assignment contract', () => {
    const ticket = store.createTicket({
      title: 'Reviewer shadow contract',
      description: 'Verify explicit v2 fields surface in agent-facing contract',
      status: 'done',
      assigned_agent: 'beavy',
      triage_owner: 'leoss',
      review_owner: 'leoss',
    });

    const assignment = store.createOrReuseAssignment({
      ticket_id: ticket.id,
      agent_id: 'leoss',
      role: 'review',
      role_type: 'reviewer',
      stage: 'done',
      context_bundle_id: 'ctx-ticket-1',
      required_outputs: ['review_submission', 'gate_verdict'],
    });

    expect(assignment.role_type).toBe('reviewer');
    expect(assignment.context_bundle_id).toBe('ctx-ticket-1');
    expect(assignment.required_outputs).toEqual(['review_submission', 'gate_verdict']);

    const contract = buildAssignmentContract(assignment, store.getTicketById(ticket.id));
    expect(contract.contract.assignment_v2).toEqual(expect.objectContaining({
      role_type: 'reviewer',
      workflow_template: 'software_task_v1',
      context_bundle_id: 'ctx-ticket-1',
      shadow_mode: true,
    }));
    expect(contract.contract.assignment_v2.required_outputs).toEqual(['review_submission', 'gate_verdict']);
    expect(contract.current_assignment).toEqual(expect.objectContaining({
      role_type: 'reviewer',
      context_bundle_id: 'ctx-ticket-1',
    }));
  });

  it('can update supersession and v2 action/output hints in shadow mode', () => {
    const ticket = store.createTicket({ title: 'Supersede assignment', description: 'D', status: 'running', assigned_agent: 'beavy' });
    const assignment = store.createOrReuseAssignment({ ticket_id: ticket.id, agent_id: 'beavy', role: 'execute', stage: 'running' });

    const updated = store.updateAssignment(assignment.assignment_id, {
      superseded_by: 'asg_next',
      allowed_actions: ['progress_update'],
      required_outputs: ['handoff_summary'],
    });

    expect(updated.superseded_by).toBe('asg_next');
    expect(updated.allowed_actions).toEqual(['progress_update']);
    expect(updated.required_outputs).toEqual(['handoff_summary']);
    expect(updated.v2_contract).toEqual(expect.objectContaining({
      superseded_by: 'asg_next',
      shadow_mode: true,
    }));
  });
});
