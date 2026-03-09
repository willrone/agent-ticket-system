/**
 * @vitest-environment node
 * 平台直驱：agent -> sessionKey 路由
 */
import { describe, it, expect } from 'vitest';
import { getSessionKeyForAgent, NOTIFY_MAIN_SESSION } from './agent-session-router.js';

describe('agent-session-router (direct-drive)', () => {
  it('NOTIFY_MAIN_SESSION 为 agent:main:main', () => {
    expect(NOTIFY_MAIN_SESSION).toBe('agent:main:main');
  });

  it('已知 agent 映射到 agent:{agent}:main', () => {
    expect(getSessionKeyForAgent('beavy')).toBe('agent:beavy:main');
    expect(getSessionKeyForAgent('donky')).toBe('agent:donky:main');
    expect(getSessionKeyForAgent('cowder')).toBe('agent:cowder:main');
    expect(getSessionKeyForAgent('doggy')).toBe('agent:doggy:main');
    expect(getSessionKeyForAgent('marely')).toBe('agent:marely:main');
    expect(getSessionKeyForAgent('leoss')).toBe('agent:leoss:main');
  });

  it('agent 大小写不敏感', () => {
    expect(getSessionKeyForAgent('Beavy')).toBe('agent:beavy:main');
    expect(getSessionKeyForAgent('LEOSS')).toBe('agent:leoss:main');
  });

  it('未知 agent（如 workflow_mismatch 荣晖）回退到 agent:main:main', () => {
    expect(getSessionKeyForAgent('荣晖')).toBe('agent:main:main');
    expect(getSessionKeyForAgent('unknown')).toBe('agent:main:main');
  });

  it('空值回退到 NOTIFY_MAIN_SESSION', () => {
    expect(getSessionKeyForAgent('')).toBe('agent:main:main');
    expect(getSessionKeyForAgent(null)).toBe('agent:main:main');
    expect(getSessionKeyForAgent(undefined)).toBe('agent:main:main');
  });
});
