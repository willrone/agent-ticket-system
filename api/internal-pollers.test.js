/**
 * @vitest-environment node
 * 平台直驱 poller：不依赖 Sheeply，直发目标 session / agent:main:main
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startInternalPollers } from './internal-pollers.js';

describe('internal-pollers (direct-drive)', () => {
  const envRestore = {};

  beforeEach(() => {
    envRestore.TICKET_INTERNAL_POLLERS_ENABLED = process.env.TICKET_INTERNAL_POLLERS_ENABLED;
  });

  afterEach(() => {
    if (envRestore.TICKET_INTERNAL_POLLERS_ENABLED !== undefined) {
      process.env.TICKET_INTERNAL_POLLERS_ENABLED = envRestore.TICKET_INTERNAL_POLLERS_ENABLED;
    } else {
      delete process.env.TICKET_INTERNAL_POLLERS_ENABLED;
    }
  });

  it('禁用时返回 no-op stop，不启动轮询', () => {
    process.env.TICKET_INTERNAL_POLLERS_ENABLED = 'false';
    const control = startInternalPollers();
    expect(control).toHaveProperty('stop');
    expect(typeof control.stop).toBe('function');
    control.stop();
  });

  it('启用时返回可调用的 stop', () => {
    process.env.TICKET_INTERNAL_POLLERS_ENABLED = 'true';
    const control = startInternalPollers({ apiBaseUrl: 'http://127.0.0.1:9999' });
    expect(control).toHaveProperty('stop');
    expect(typeof control.stop).toBe('function');
    control.stop();
  });
});
