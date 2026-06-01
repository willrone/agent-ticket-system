/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const mockGetAllTickets = vi.fn();
const spawned = [];

vi.mock('./store.js', () => ({
  getAllTickets: mockGetAllTickets,
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    spawned.push(proc);
    return proc;
  }),
}));

const { getBots } = await import('./bots.js');

function resolveSpawnWithSessions(sessions) {
  const proc = spawned.shift();
  if (!proc) throw new Error('missing spawned process');
  proc.stdout.emit('data', JSON.stringify({ sessions }));
  proc.emit('close', 0);
}

describe('getBots', () => {
  beforeEach(() => {
    spawned.length = 0;
    mockGetAllTickets.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T15:05:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('按 session 而非 bot 选择 current context，优先活跃 ticket session，并回填真实 queue/currentTask/latest active time', async () => {
    mockGetAllTickets.mockReturnValue([
      {
        id: 11,
        title: 'Main queued task',
        status: 'queued',
        assigned_agent: 'beavy',
        last_update: '2026-03-14T14:40:00.000Z',
        session_key: 'agent:beavy:ticket:11',
      },
      {
        id: 12,
        title: 'Running ticket should win',
        status: 'running',
        assigned_agent: 'beavy',
        last_update: '2026-03-14T15:03:00.000Z',
        session_key: 'agent:beavy:ticket:12',
      },
      {
        id: 13,
        title: 'Finished ticket',
        status: 'complete',
        assigned_agent: 'beavy',
        last_update: '2026-03-14T13:00:00.000Z',
      },
      {
        id: 14,
        title: 'Failed ticket',
        status: 'failed',
        assigned_agent: 'beavy',
        last_update: '2026-03-14T12:00:00.000Z',
      },
    ]);

    const promise = getBots();
    resolveSpawnWithSessions([
      {
        key: 'agent:beavy:main',
        updatedAt: '2026-03-14T15:04:00.000Z',
        totalTokens: 10000,
        contextTokens: 200000,
      },
      {
        key: 'agent:beavy:ticket:11',
        updatedAt: '2026-03-14T14:39:00.000Z',
        totalTokens: 12000,
        contextTokens: 200000,
      },
      {
        key: 'agent:beavy:ticket:12',
        updatedAt: '2026-03-14T15:02:00.000Z',
        totalTokens: 18000,
        contextTokens: 200000,
      },
    ]);

    const bots = await promise;
    const beavy = bots.find((bot) => bot.agentId === 'beavy');

    expect(beavy).toBeTruthy();
    expect(beavy.status).toBe('active');
    expect(beavy.currentContext).toEqual(expect.objectContaining({
      sessionKey: 'agent:beavy:ticket:12',
      ticketId: 12,
      ticketStatus: 'running',
      latestActiveAt: '2026-03-14T15:03:00.000Z',
    }));
    expect(beavy.contextLatestActiveTime).toBe('2026-03-14T15:03:00.000Z');
    expect(beavy.currentTask).toEqual(expect.objectContaining({
      id: 12,
      title: 'Running ticket should win',
      sessionKey: 'agent:beavy:ticket:12',
    }));
    expect(beavy.queue).toEqual([
      expect.objectContaining({ id: 11, title: 'Main queued task' }),
    ]);
    expect(beavy.recentTasks).toEqual([
      expect.objectContaining({ id: 13, status: 'complete' }),
      expect.objectContaining({ id: 14, status: 'failed' }),
    ]);
    expect(beavy.stats.todayCompleted).toBe(1);
    expect(beavy.stats.successRate).toBe(50);
  });

  it('OpenClaw 失败时返回降级 bot 列表', async () => {
    mockGetAllTickets.mockReturnValue([]);
    const promise = getBots();
    const proc = spawned.shift();
    proc.stderr.emit('data', 'boom');
    proc.emit('close', 1);

    const bots = await promise;
    expect(bots.length).toBeGreaterThan(0);
    expect(bots.find((bot) => bot.agentId === 'beavy')).toEqual(expect.objectContaining({
      currentContext: null,
      contextLatestActiveTime: null,
      sessions: [],
    }));
  });

  it('即使当前无 session / ticket，也会把 inventory 中的新 PC agent 暴露给 /api/bots', async () => {
    mockGetAllTickets.mockReturnValue([]);

    const promise = getBots();
    resolveSpawnWithSessions([]);

    const bots = await promise;
    expect(bots).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'xiaoying', displayName: '小鹰', status: 'idle' }),
      expect.objectContaining({ agentId: 'xiaoyi', displayName: '小蚁', status: 'idle' }),
    ]));
  });
});
