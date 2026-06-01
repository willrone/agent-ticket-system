/**
 * @vitest-environment node
 * 平台直驱：agent -> sessionKey 路由
 */
import { describe, it, expect } from 'vitest';
import { getDispatchSessionKeyForTicket, getNotificationSessionKey, getSessionKeyForAgent, NOTIFY_MAIN_SESSION, isHumanPrincipal } from './agent-session-router.js';

describe('agent-session-router (direct-drive)', () => {
  it('NOTIFY_MAIN_SESSION 为老大主会话直连 session', () => {
    expect(NOTIFY_MAIN_SESSION).toBe('agent:main:telegram:direct:8290057699');
  });

  it('已知 agent 映射到正确主会话', () => {
    expect(getSessionKeyForAgent('beavy')).toBe('agent:beavy:main');
    expect(getSessionKeyForAgent('donky')).toBe('agent:donky:main');
    expect(getSessionKeyForAgent('cowder')).toBe('agent:cowder:main');
    expect(getSessionKeyForAgent('doggy')).toBe('agent:doggy:main');
    expect(getSessionKeyForAgent('marely')).toBe('agent:marely:main');
    expect(getSessionKeyForAgent('leoss')).toBe('agent:main:main');
  });

  it('dispatch 为每张工单生成独立 ticket session', () => {
    expect(getDispatchSessionKeyForTicket('beavy', 26)).toBe('agent:beavy:ticket:26');
    expect(getDispatchSessionKeyForTicket('donky', '24')).toBe('agent:donky:ticket:24');
    expect(getDispatchSessionKeyForTicket('leoss', 31)).toBe('agent:main:ticket:31');
  });

  it('agent 大小写不敏感', () => {
    expect(getSessionKeyForAgent('Beavy')).toBe('agent:beavy:main');
    expect(getSessionKeyForAgent('LEOSS')).toBe('agent:main:main');
  });

  it('人类主体（如荣晖）固定回主会话，不再伪装成 agent session', () => {
    expect(isHumanPrincipal('荣晖')).toBe(true);
    expect(isHumanPrincipal('ronghui')).toBe(true);
    expect(getSessionKeyForAgent('荣晖')).toBe(NOTIFY_MAIN_SESSION);
    expect(getDispatchSessionKeyForTicket('荣晖', 26)).toBe(NOTIFY_MAIN_SESSION);
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
    expect(getNotificationSessionKey({ status: 'done', reviewOwner: 'leoss', ticketId: 31 }))
      .toBe('agent:main:ticket:31');
    expect(getNotificationSessionKey({ status: 'review', reviewOwner: 'beavy', ticketId: 26 }))
      .toBe('agent:beavy:ticket:26');
  });

  it('pending_decision/blocked/complete/failed 通知继续路由到主会话', () => {
    expect(getNotificationSessionKey({ status: 'pending_decision', reviewOwner: 'leoss', ticketId: 31 }))
      .toBe(NOTIFY_MAIN_SESSION);
    expect(getNotificationSessionKey({ status: 'blocked', reviewOwner: 'beavy', ticketId: 26 }))
      .toBe(NOTIFY_MAIN_SESSION);
    expect(getNotificationSessionKey({ status: 'complete', reviewOwner: 'beavy', ticketId: 26 }))
      .toBe(NOTIFY_MAIN_SESSION);
    expect(getNotificationSessionKey({ status: 'failed', reviewOwner: 'beavy', ticketId: 26 }))
      .toBe(NOTIFY_MAIN_SESSION);
  });
});
