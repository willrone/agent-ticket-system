/**
 * @vitest-environment node
 * 平台直驱：agent -> sessionKey 路由。
 * 测试通过环境变量注入最小映射集，不依赖源码默认值。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDispatchSessionKeyForTicket, getNotificationSessionKey, getSessionKeyForAgent, NOTIFY_MAIN_SESSION } from './agent-session-router.js';

const fixtureNotifyMain = 'agent:main:telegram:direct:0000000000';
const fixtureAgentMap = JSON.stringify({ hero: 'main', sidekick: 'main' });
const fixtureDir = JSON.stringify({
  hero: { id: 'hero', display_name: 'Hero', emoji: '🦸', role_type: 'owner', ownership_layer: 'platform_owner', primary_platform: 'example', session_base: 'agent:hero', responsibility_summary: 'Fixture agent', responsibilities: ['platform_owner'], collaborates_with: ['sidekick'] },
  sidekick: { id: 'sidekick', display_name: 'Sidekick', emoji: '🦹', role_type: 'builder', ownership_layer: 'development', primary_platform: 'example', session_base: 'agent:sidekick', responsibility_summary: 'Fixture agent', responsibilities: ['development'], collaborates_with: [] },
});

beforeAll(() => {
  process.env.TICKET_AGENT_GATEWAY_OVERRIDES_JSON = fixtureAgentMap;
  process.env.TICKET_AGENT_DIRECTORY_JSON = fixtureDir;
  process.env.TICKET_NOTIFY_MAIN_GATEWAY_ID = 'main';
  process.env.TICKET_NOTIFY_MAIN_SESSION_KEY = fixtureNotifyMain;
  process.env.TICKET_HUMAN_PRINCIPAL_ALIASES = 'hero,sidekick';
});

describe('agent-session-router (direct-drive)', () => {
  it('NOTIFY_MAIN_SESSION 为老大主会话直连 session', () => {
    expect(NOTIFY_MAIN_SESSION).toBe(fixtureNotifyMain);
  });

  it('已知 agent 映射到正确主会话', () => {
    expect(getSessionKeyForAgent('hero')).toBe('agent:hero:main');
    expect(getSessionKeyForAgent('sidekick')).toBe('agent:sidekick:main');
  });

  it('dispatch 为每张工单生成独立 ticket session', () => {
    expect(getDispatchSessionKeyForTicket('hero', 26)).toBe('agent:hero:ticket:26');
    expect(getDispatchSessionKeyForTicket('sidekick', '24')).toBe('agent:sidekick:ticket:24');
  });

  it('agent 大小写不敏感', () => {
    expect(getSessionKeyForAgent('Hero')).toBe('agent:hero:main');
    expect(getSessionKeyForAgent('SIDEKICK')).toBe('agent:sidekick:main');
  });

  it('人类主体固定回主会话', () => {
    expect(getSessionKeyForAgent('hero')).toBe('agent:hero:main');
  });

  it('未知 agent 回退到 agent:main:main / agent:main:ticket:<id>', () => {
    expect(getSessionKeyForAgent('unknown')).toBe('agent:main:main');
    expect(getDispatchSessionKeyForTicket('unknown', 9)).toBe('agent:main:ticket:9');
  });

  it('空值回退到 agent:main:main', () => {
    expect(getSessionKeyForAgent('')).toBe('agent:main:main');
    expect(getSessionKeyForAgent(null)).toBe('agent:main:main');
    expect(getSessionKeyForAgent(undefined)).toBe('agent:main:main');
  });

  it('done/review 通知路由到 reviewer 的 ticket session', () => {
    expect(getNotificationSessionKey({ status: 'done', reviewOwner: 'hero', ticketId: 31 }))
      .toBe('agent:hero:ticket:31');
    expect(getNotificationSessionKey({ status: 'review', reviewOwner: 'sidekick', ticketId: 26 }))
      .toBe('agent:sidekick:ticket:26');
  });

  it('pending_decision/blocked/complete/failed 通知继续路由到主会话', () => {
    expect(getNotificationSessionKey({ status: 'pending_decision', reviewOwner: 'hero', ticketId: 31 }))
      .toBe(fixtureNotifyMain);
    expect(getNotificationSessionKey({ status: 'blocked', reviewOwner: 'sidekick', ticketId: 26 }))
      .toBe(fixtureNotifyMain);
    expect(getNotificationSessionKey({ status: 'complete', reviewOwner: 'sidekick', ticketId: 26 }))
      .toBe(fixtureNotifyMain);
    expect(getNotificationSessionKey({ status: 'failed', reviewOwner: 'sidekick', ticketId: 26 }))
      .toBe(fixtureNotifyMain);
  });
});
