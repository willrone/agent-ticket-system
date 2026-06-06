import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, _resetLoggerForTesting } from './logger.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetLoggerForTesting();
  vi.restoreAllMocks();
});

describe('structured logger', () => {
  it('emits json records and redacts sensitive fields', () => {
    process.env.TICKET_LOG_LEVEL = 'debug';
    process.env.TICKET_LOG_FORMAT = 'json';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    createLogger('test').info('hello', {
      ticket_id: 123,
      api_key: 'secret-key',
      nested: { authorization: 'Bearer secret' },
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const record = JSON.parse(spy.mock.calls[0][0]);
    expect(record).toMatchObject({
      level: 'info',
      component: 'test',
      msg: 'hello',
      ticket_id: 123,
      api_key: '[REDACTED]',
      nested: { authorization: '[REDACTED]' },
    });
    expect(record.ts).toBeTruthy();
  });

  it('rate-limits repeated log events and reports suppressed_count on next emit', () => {
    vi.useFakeTimers();
    process.env.TICKET_LOG_LEVEL = 'debug';
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger('test');

    logger.warn('noisy', { dispatch_id: 1 }, { rateLimitKey: 'same', rateLimitMs: 1000 });
    logger.warn('noisy', { dispatch_id: 1 }, { rateLimitKey: 'same', rateLimitMs: 1000 });
    logger.warn('noisy', { dispatch_id: 1 }, { rateLimitKey: 'same', rateLimitMs: 1000 });
    vi.advanceTimersByTime(1000);
    logger.warn('noisy', { dispatch_id: 1 }, { rateLimitKey: 'same', rateLimitMs: 1000 });

    expect(spy).toHaveBeenCalledTimes(2);
    const first = JSON.parse(spy.mock.calls[0][0]);
    const second = JSON.parse(spy.mock.calls[1][0]);
    expect(first.suppressed_count).toBeUndefined();
    expect(second.suppressed_count).toBe(2);
    vi.useRealTimers();
  });
});
