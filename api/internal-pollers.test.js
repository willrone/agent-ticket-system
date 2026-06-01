/**
 * @vitest-environment node
 * 平台直驱 poller：不依赖 Sheeply，直发目标 session / agent:main:main
 */
import './test-setup.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startInternalPollers, autoLockDeliveredQueuedTicket } from './internal-pollers.js';
import * as store from './store.js';
import { _resetDbForTesting } from './store-sqlite.js';
import { _resetDbForTesting as _resetDispatchForTesting, hasRecentDispatch } from './dispatch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, 'data', 'test-tickets.db');

function ensureCleanStore() {
  _resetDbForTesting();
  _resetDispatchForTesting();
  const dir = path.dirname(TEST_DB);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const p of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

describe('internal-pollers (direct-drive)', () => {
  const envRestore = {};

  beforeEach(() => {
    ensureCleanStore();
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

  it('启用时返回可调用的 stop（含 audit worker）', () => {
    process.env.TICKET_INTERNAL_POLLERS_ENABLED = 'true';
    const control = startInternalPollers({ apiBaseUrl: 'http://127.0.0.1:9999' });
    expect(control).toHaveProperty('stop');
    expect(typeof control.stop).toBe('function');
    control.stop();
  });

  it('支持自定义 auditIntervalMs', () => {
    process.env.TICKET_INTERNAL_POLLERS_ENABLED = 'true';
    const control = startInternalPollers({
      apiBaseUrl: 'http://127.0.0.1:9999',
      auditIntervalMs: 60_000,
    });
    expect(control).toHaveProperty('stop');
    control.stop();
  });

  it('delivery ack 不再把 queued 自动推进到 running，必须等待 receipt', () => {
    const ticket = store.createTicket({
      title: 'Receipt-driven dispatch only',
      description: 'Desc',
      execution_mode: 'direct',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      assigned_agent: 'beavy',
    });
    const dispatchId = store.createOrReuseAssignment({
      ticket_id: ticket.id,
      dispatch_event_id: 123,
      agent_id: 'beavy',
      gateway_id: 'mac-main',
      execution_mode: ticket.execution_mode,
      assignment_status: 'delivered',
      intent: 'dispatch',
      role: 'execute',
      stage: 'queued',
      target_session_key: `agent:beavy:ticket:${ticket.id}`,
      transport: 'local_cli',
    }).dispatch_event_id;

    const result = autoLockDeliveredQueuedTicket({
      ticketId: ticket.id,
      actor: 'beavy',
      dispatchId,
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toBe('receipt_driven_dispatch');
    const updated = store.getTicketById(ticket.id);
    expect(updated.status).toBe('queued');
    expect(hasRecentDispatch(ticket.id, 'beavy', 'running', 60)).toBe(false);
  });
});
