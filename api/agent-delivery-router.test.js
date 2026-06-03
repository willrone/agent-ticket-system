/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resolveDispatchDelivery, resolveNotificationDelivery } from './agent-delivery-router.js';

/** Inject minimal fixture topology before imports resolve */
const fixtureAgentMap = JSON.stringify({ hero: 'main', sidekick: 'main', hawk: 'remote' });
const fixtureDir = JSON.stringify({
  example_human_operator: { id: 'example_human_operator', display_name: 'Human', emoji: '🧑', role_type: 'owner', ownership_layer: 'platform_owner', primary_platform: 'example', session_base: 'agent:main', responsibility_summary: 'Fixture human', responsibilities: ['platform_owner'], collaborates_with: [] },
  sidekick: { id: 'sidekick', display_name: 'Sidekick', emoji: '🦹', role_type: 'builder', ownership_layer: 'development', primary_platform: 'example', session_base: 'agent:sidekick', responsibility_summary: 'Fixture agent', responsibilities: ['development'], collaborates_with: [] },
  hawk: { id: 'hawk', display_name: 'Hawk', emoji: '🦅', role_type: 'reviewer', ownership_layer: 'review', primary_platform: 'example', session_base: 'agent:hawk', responsibility_summary: 'Fixture reviewer', responsibilities: ['review'], collaborates_with: [] },
  xiaoying: { id: 'xiaoying', display_name: 'Xiaoying', emoji: '🦅', role_type: 'reviewer', ownership_layer: 'review', primary_platform: 'example', session_base: 'agent:xiaoying', responsibility_summary: 'Fixture reviewer', responsibilities: ['review'], collaborates_with: [] },
});
beforeAll(() => {
  process.env.TICKET_AGENT_GATEWAY_OVERRIDES_JSON = fixtureAgentMap;
  process.env.TICKET_AGENT_DIRECTORY_JSON = fixtureDir;
  process.env.TICKET_NOTIFY_MAIN_GATEWAY_ID = 'main';
  process.env.TICKET_HUMAN_PRINCIPAL_ALIASES = 'example_human_operator';
  process.env.TICKET_HUMAN_PRINCIPAL_ALIASES = 'hero';
});
import { getNotifyMainSessionKey } from './agent-session-router.js';

describe('agent-delivery-router', () => {
  it('dispatch 对 human reviewer 仍走 ticket session，而不是主聊天会话', () => {
    const delivery = resolveDispatchDelivery({ agent: 'hero', ticketId: 335 });
    expect(delivery.target_session_key).toBe('agent:main:ticket:335');
    expect(delivery.target_session_key).not.toBe(getNotifyMainSessionKey());
    expect(delivery.delivery_intent).toBe('dispatch');
  });

  it('workflow_mismatch 对 human principal 也走 ticket session', () => {
    const delivery = resolveDispatchDelivery({ agent: 'hero', ticketId: 335, kind: 'workflow_mismatch' });
    expect(delivery.target_session_key).toBe('agent:main:ticket:335');
    expect(delivery.target_session_key).not.toBe(getNotifyMainSessionKey());
    expect(delivery.delivery_intent).toBe('workflow_mismatch');
  });

  it('audit nudge 对 human principal 走主聊天会话，便于补偿催办', () => {
    const delivery = resolveDispatchDelivery({ agent: 'hero', ticketId: 335, kind: 'nudge', nudgeSource: 'audit_result' });
    expect(delivery.target_session_key).toBe(getNotifyMainSessionKey());
    expect(delivery.delivery_intent).toBe('dispatch');
  });

  it('manual nudge 对 human principal 继续走 ticket session', () => {
    const delivery = resolveDispatchDelivery({ agent: 'hero', ticketId: 335, kind: 'nudge', nudgeSource: 'manual' });
    expect(delivery.target_session_key).toBe('agent:main:ticket:335');
    expect(delivery.target_session_key).not.toBe(getNotifyMainSessionKey());
    expect(delivery.delivery_intent).toBe('dispatch');
  });

  it('notifications 对 pending_decision 仍固定走主聊天会话', () => {
    const delivery = resolveNotificationDelivery({
      status: 'pending_decision',
      reviewOwner: 'hero',
      ticketId: 335,
      targetActor: 'hero',
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
      reviewOwner: 'sidekick',
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
      reviewOwner: 'sidekick',
      ticketId: 402,
      targetActor: 'sidekick',
      platformId: 'stock-platform',
    });
    expect(delivery.target_session_key).toBe('agent:sidekick:ticket:402');
    expect(delivery.target_agent).toBe('sidekick');
    expect(delivery.delivery_intent).toBe('notify:done');
  });
});
