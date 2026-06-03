/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args) => spawnMock(...args),
}));

vi.mock('./agent-topology.js', () => ({
  getGatewayById: vi.fn((gatewayId) => {
    if (gatewayId === 'pc-stock') {
      return {
        id: 'pc-stock',
        ssh_destination: 'tester@example.com',
        openclaw_bin: 'openclaw',
      };
    }
    return null;
  }),
  getSshDestination: vi.fn((gateway) => gateway?.ssh_destination || null),
}));

function makeChild(stdoutPayload = { ok: true }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(JSON.stringify(stdoutPayload)));
    child.emit('close', 0);
  });
  return child;
}

describe('delivery-transport', () => {
  beforeEach(() => {
    vi.stubEnv('OPENCLAW_CLI', 'openclaw');
    vi.stubEnv('SSH_CLI', 'ssh');
    vi.resetModules();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeChild());
  });

  it('local_cli + resetSession 先 sessions.reset 再 chat.send', async () => {
    const { deliverChatToGateway } = await import('./delivery-transport.js');

    const result = await deliverChatToGateway({
      transport: 'local_cli',
      targetSessionKey: 'agent:beavy:ticket:70',
      message: 'hello',
      idempotencyKey: 'idem-1',
      resetSession: true,
      resetReason: 'assignment_refresh',
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0][0]).toBe('openclaw');
    expect(spawnMock.mock.calls[0][1]).toEqual([
      'gateway',
      'call',
      'sessions.reset',
      '--json',
      '--params',
      JSON.stringify({ key: 'agent:beavy:ticket:70', reason: 'reset' }),
    ]);
    expect(spawnMock.mock.calls[1][1]).toEqual([
      'gateway',
      'call',
      'chat.send',
      '--expect-final',
      '--json',
      '--params',
      JSON.stringify({ sessionKey: 'agent:beavy:ticket:70', message: 'hello', idempotencyKey: 'idem-1' }),
    ]);
    expect(result).toEqual({ reset: { ok: true }, send: { ok: true } });
  });

  it('ssh_gateway_call + resetSession 走远端 sessions.reset + chat.send', async () => {
    const { deliverChatToGateway } = await import('./delivery-transport.js');

    await deliverChatToGateway({
      targetGatewayId: 'pc-stock',
      transport: 'ssh_gateway_call',
      targetSessionKey: 'agent:donky:ticket:40',
      message: 'hello',
      idempotencyKey: 'idem-2',
      resetSession: true,
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0][0]).toBe('ssh');
    expect(spawnMock.mock.calls[0][1]).toEqual([
      '-o',
      'BatchMode=yes',
      'tester@example.com',
      "'openclaw' gateway call sessions.reset --json --params '{\"key\":\"agent:donky:ticket:40\",\"reason\":\"reset\"}'",
    ]);
    expect(spawnMock.mock.calls[1][1]).toEqual([
      '-o',
      'BatchMode=yes',
      'tester@example.com',
      "'openclaw' gateway call chat.send --expect-final --json --params '{\"sessionKey\":\"agent:donky:ticket:40\",\"message\":\"hello\",\"idempotencyKey\":\"idem-2\"}'",
    ]);
  });

  it('resetSession 超时/失败时不阻断 local chat.send', async () => {
    const { deliverChatToGateway } = await import('./delivery-transport.js');

    spawnMock
      .mockImplementationOnce(() => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.stderr.emit('data', Buffer.from('gateway timeout after 10000ms'));
          child.emit('close', 1);
        });
        return child;
      })
      .mockImplementationOnce(() => makeChild({ ok: true, sent: true }));

    const result = await deliverChatToGateway({
      transport: 'local_cli',
      targetSessionKey: 'agent:beavy:ticket:91',
      message: 'hello after reset failure',
      idempotencyKey: 'idem-reset-fallback',
      resetSession: true,
      resetReason: 'assignment_refresh',
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0][1][2]).toBe('sessions.reset');
    expect(spawnMock.mock.calls[1][1][2]).toBe('chat.send');
    expect(result.reset_error).toContain('gateway timeout after 10000ms');
    expect(result.send).toEqual({ ok: true, sent: true });
  });
});
