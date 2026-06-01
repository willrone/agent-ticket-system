/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { resolveDispatchDelivery, resolveNotificationDelivery } from './agent-delivery-router.js';
import { getNotifyMainSessionKey } from './agent-session-router.js';

describe('agent-delivery-router', () => {
  it('dispatch 对 human reviewer 仍走 ticket session，而不是主聊天会话', () => {
    const delivery = resolveDispatchDelivery({ agent: 'example-human-operator', ticketId: 335 });
    expect(delivery.target_session_key).toBe('agent:main:ticket:335');
    expect(delivery.target_session_key).not.toBe(getNotifyMainSessionKey());
    expect(delivery.delivery_intent).toBe('dispatch');
  });

  it('workflow_mismatch 对 human principal 也走 ticket session', () => {
    const delivery = resolveDispatchDelivery({ agent: 'example-human-operator', ticketId: 335, kind: 'workflow_mismatch' });
    expect(delivery.target_session_key).toBe('agent:main:ticket:335');
    expect(delivery.target_session_key).not.toBe(getNotifyMainSessionKey());
    expect(delivery.delivery_intent).toBe('workflow_mismatch');
  });

  it('audit nudge 对 human principal 走主聊天会话，便于补偿催办', () => {
    const delivery = resolveDispatchDelivery({ agent: 'example-human-operator', ticketId: 335, kind: 'nudge', nudgeSource: 'audit_result' });
    expect(delivery.target_session_key).toBe(getNotifyMainSessionKey());
    expect(delivery.delivery_intent).toBe('dispatch');
  });

  it('manual nudge 对 human principal 继续走 ticket session', () => {
    const delivery = resolveDispatchDelivery({ agent: 'example-human-operator', ticketId: 335, kind: 'nudge', nudgeSource: 'manual' });
    expect(delivery.target_session_key).toBe('agent:main:ticket:335');
    expect(delivery.target_session_key).not.toBe(getNotifyMainSessionKey());
    expect(delivery.delivery_intent).toBe('dispatch');
  });

  it('notifications 对 pending_decision 仍固定走主聊天会话', () => {
    const delivery = resolveNotificationDelivery({
      status: 'pending_decision',
      reviewOwner: 'example-human-operator',
      ticketId: 335,
      targetActor: 'example-human-operator',
    });
    expect(delivery.target_session_key).toBe(getNotifyMainSessionKey());
    expect(delivery.target_gateway_id).toBe('mac-main');
    expect(delivery.route_explain).toBe(null);
    expect(delivery.route_target).toBe(null);
    expect(delivery.delivery_intent).toBe('notify:pending_decision');
  });

  it('stock-platform complete 通知即使 targetActor 落在远端 owner，也必须固定走主会话主网关', () => {
    const delivery = resolveNotificationDelivery({
      status: 'complete',
      reviewOwner: 'xiaoying',
      ticketId: 401,
      targetActor: 'cowder',
      platformId: 'stock-platform',
    });
    expect(delivery.target_session_key).toBe(getNotifyMainSessionKey());
    expect(delivery.target_gateway_id).toBe('mac-main');
    expect(delivery.target_agent).toBe(null);
    expect(delivery.delivery_intent).toBe('notify:complete');
  });

  it('done 通知对 reviewer 继续走 reviewer ticket session', () => {
    const delivery = resolveNotificationDelivery({
      status: 'done',
      reviewOwner: 'xiaoying',
      ticketId: 402,
      targetActor: 'xiaoying',
      platformId: 'stock-platform',
    });
    expect(delivery.target_session_key).toBe('agent:xiaoying:ticket:402');
    expect(delivery.target_agent).toBe('xiaoying');
    expect(delivery.delivery_intent).toBe('notify:done');
  });
});
