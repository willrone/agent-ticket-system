import { describe, it, expect } from 'vitest';
import {
  buildWorkflowActorContract,
  getActionMeta,
  getStatusMeta,
  listAvailableActionsForStatus,
} from './workflow-schema.js';

describe('workflow actor contract', () => {
  it('统一从 workflow schema 解释 done 阶段的 legacy next_actor override', () => {
    const contract = buildWorkflowActorContract({
      status: 'done',
      assigned_agent: 'beavy',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      next_actor: 'auditor',
    });

    expect(contract).toEqual(expect.objectContaining({
      current_actor: 'auditor',
      current_actor_source: 'next_actor',
      next_actor: 'auditor',
      next_actor_source: 'next_actor',
      next_actor_override: 'auditor',
      manual_override_active: true,
      should_notify: true,
      workflow_notify_policy: expect.objectContaining({
        dispatch_ready: true,
        notification_ready: true,
        target: 'review_owner',
      }),
    }));
  });

  it('不允许 manual override 的状态不会把 legacy next_actor 当成解释真相', () => {
    const contract = buildWorkflowActorContract({
      status: 'queued',
      assigned_agent: 'beavy',
      triage_owner: 'leoss',
      next_actor: 'auditor',
    });

    expect(contract).toEqual(expect.objectContaining({
      current_actor: 'beavy',
      current_actor_source: 'assigned_agent',
      next_actor: 'beavy',
      next_actor_source: 'assigned_agent',
      next_actor_override: null,
      manual_override_active: false,
      should_notify: true,
    }));
  });

  it('deprecated 作为终态不再暴露 current actor，且不会继续通知/派发', () => {
    const contract = buildWorkflowActorContract({
      status: 'deprecated',
      assigned_agent: 'beavy',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      next_actor: 'auditor',
    });

    expect(contract).toEqual(expect.objectContaining({
      current_actor: null,
      current_actor_source: null,
      next_actor: null,
      next_actor_source: null,
      next_actor_override: null,
      manual_override_active: false,
      should_notify: false,
      workflow_notify_policy: expect.objectContaining({
        dispatch_ready: false,
        notification_ready: false,
        target: 'none',
      }),
    }));

    expect(getStatusMeta('deprecated')).toEqual(expect.objectContaining({
      key: 'deprecated',
      label: '已废弃',
      group: 'deprecated',
      is_terminal: true,
      counts_as_closed: true,
    }));
  });

  it('deprecate 管理动作可从历史残留阶段进入 deprecated', () => {
    expect(getActionMeta('deprecate')).toEqual(expect.objectContaining({
      key: 'deprecate',
      to: 'deprecated',
      management_only: true,
      required_fields: ['actor', 'deprecation_reason'],
    }));

    expect(listAvailableActionsForStatus('running')).toContain('deprecate');
    expect(listAvailableActionsForStatus('complete')).toContain('deprecate');
    expect(listAvailableActionsForStatus('deprecated')).not.toContain('deprecate');
  });
});
