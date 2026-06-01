import { describe, it, expect } from 'vitest';
import {
  deriveExecutionWorkerLifecycleStatus,
  getExecutionWorkerEvidence,
  getExecutionSchema,
  STALE_STARTING_HEARTBEAT_MINUTES,
  DERIVED_WORKER_LIFECYCLE_STALE,
} from './execution-policy.js';

describe('execution-policy worker lifecycle & evidence', () => {
  it('deriveExecutionWorkerLifecycleStatus marks weak starting as stale', () => {
    const fresh = new Date().toISOString();
    expect(deriveExecutionWorkerLifecycleStatus({ status: 'starting', session_key: 's', last_heartbeat_at: fresh }))
      .toBe('starting');
    expect(deriveExecutionWorkerLifecycleStatus({ status: 'starting', session_key: '', run_id: '', last_heartbeat_at: fresh }))
      .toBe(DERIVED_WORKER_LIFECYCLE_STALE);
    const old = new Date(Date.now() - (STALE_STARTING_HEARTBEAT_MINUTES + 2) * 60 * 1000).toISOString();
    expect(deriveExecutionWorkerLifecycleStatus({ status: 'starting', session_key: 's', last_heartbeat_at: old }))
      .toBe(DERIVED_WORKER_LIFECYCLE_STALE);
    expect(deriveExecutionWorkerLifecycleStatus({ status: 'running' })).toBe('running');
    expect(deriveExecutionWorkerLifecycleStatus({ status: 'failed' })).toBe('failed');
  });

  it('getExecutionWorkerEvidence splits active vs completed; failed is not completed', () => {
    const ticket = {
      execution_mode: 'subagent',
      current_workers: [],
      worker_stats: { active_workers: 0, running_workers: 0, total_workers: 2 },
      execution_workers: [
        { worker_key: 'a', status: 'succeeded' },
        { worker_key: 'b', status: 'failed' },
      ],
    };
    const e = getExecutionWorkerEvidence(ticket);
    expect(e.succeeded_workers).toBe(1);
    expect(e.failed_terminal_workers).toBe(1);
    expect(e.has_active_execution_evidence).toBe(false);
    expect(e.has_completed_execution_evidence).toBe(true);
    expect(e.has_worker_evidence).toBe(true);
  });

  it('getExecutionWorkerEvidence treats succeeded worker_stats as completed evidence fallback', () => {
    const ticket = {
      execution_mode: 'subagent',
      current_workers: [],
      worker_stats: { active_workers: 0, running_workers: 0, total_workers: 1, succeeded_workers: 1 },
      execution_workers: [],
    };
    const e = getExecutionWorkerEvidence(ticket);
    expect(e.succeeded_workers).toBe(1);
    expect(e.has_active_execution_evidence).toBe(false);
    expect(e.has_completed_execution_evidence).toBe(true);
    expect(e.has_worker_evidence).toBe(true);
  });

  it('getExecutionSchema documents derived stale lifecycle', () => {
    const schema = getExecutionSchema();
    expect(schema.derived_worker_lifecycle_statuses).toContain(DERIVED_WORKER_LIFECYCLE_STALE);
    expect(schema.evidence_tiers?.failed_terminal).toBeTruthy();
  });
});
