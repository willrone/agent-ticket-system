/**
 * @vitest-environment node
 */
import './test-setup.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('./delivery-transport.js', () => ({
  deliverChatToGateway: vi.fn(),
}));

import app from './app.js';
import * as store from './store.js';
import * as dispatch from './dispatch.js';
import { getDispatchEventById } from './dispatch.js';
import { _resetDbForTesting } from './store-sqlite.js';
import { _resetDbForTesting as _resetDispatchForTesting } from './dispatch.js';
import { startInternalPollers } from './internal-pollers.js';
import { deliverChatToGateway } from './delivery-transport.js';
import { getNotifyMainSessionKey } from './agent-session-router.js';

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

async function waitFor(assertion, { timeoutMs = 3000, intervalMs = 30 } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      return await assertion();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError || new Error('waitFor timeout');
}

describe('pending-forward 补偿闭环', () => {
  let server = null;
  let control = null;
  let apiBaseUrl = null;

  beforeEach(async () => {
    ensureCleanStore();
    vi.clearAllMocks();
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    apiBaseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    control?.stop();
    control = null;
    if (server) {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      server = null;
    }
    ensureCleanStore();
  });

  it('complete / failed / pending_decision 命中规则时：失败入 pending-forward，重试成功后清除并写 dedupe', async () => {
    const cases = [
      {
        status: 'complete',
        move: async (ticketId) => {
          await request(app).post(`/api/tickets/${ticketId}/transition`).send({ action: 'queue', actor: 'leoss' }).expect(200);
          await request(app).post(`/api/tickets/${ticketId}/transition`).send({ action: 'start_work', actor: 'beavy' }).expect(200);
          await request(app).post(`/api/tickets/${ticketId}/transition`).send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'done' }).expect(200);
          await request(app).post(`/api/tickets/${ticketId}/transition`).send({ action: 'approve', actor: 'leoss' }).expect(200);
        },
      },
      {
        status: 'failed',
        move: async (ticketId) => {
          await request(app).post(`/api/tickets/${ticketId}/transition`).send({ action: 'queue', actor: 'leoss' }).expect(200);
          await request(app).post(`/api/tickets/${ticketId}/transition`).send({ action: 'start_work', actor: 'beavy' }).expect(200);
          await request(app).post(`/api/tickets/${ticketId}/transition`).send({ action: 'fail', actor: 'beavy', error: 'boom' }).expect(200);
        },
      },
      {
        status: 'pending_decision',
        move: async (ticketId) => {
          await request(app).post(`/api/tickets/${ticketId}/transition`).send({ action: 'queue', actor: 'leoss' }).expect(200);
          await request(app).post(`/api/tickets/${ticketId}/transition`).send({ action: 'start_work', actor: 'beavy' }).expect(200);
          await request(app).post(`/api/tickets/${ticketId}/transition`).send({ action: 'request_decision', actor: 'beavy', decision_summary: 'need boss' }).expect(200);
        },
      },
    ];

    for (const entry of cases) {
      const createRes = await request(app)
        .post('/api/tickets')
        .send({
          title: `pending-forward ${entry.status}`,
          description: 'Desc',
          assigned_agent: 'beavy',
          triage_owner: 'leoss',
          review_owner: 'leoss',
          decision_owner: '荣晖',
        })
        .expect(201);

      const ticketId = createRes.body.id;
      await entry.move(ticketId);
      const readyBefore = await request(app).get('/api/notifications/ready').expect(200);
      const readyItem = readyBefore.body.ready.find((item) => item.ticket_id === ticketId);
      expect(readyItem).toBeDefined();
      expect(readyItem.type).toBe(entry.status);

      deliverChatToGateway.mockRejectedValue(new Error(`telegram down for ${entry.status}`));
      control = startInternalPollers({
        apiBaseUrl,
        dispatchIntervalMs: 10_000,
        notifyIntervalMs: 40,
        auditIntervalMs: 10_000,
        deliveryTimeoutMs: 1_000,
      });

      await waitFor(async () => {
        const res = await request(app).get('/api/pending-forwards?unresolved_only=true').expect(200);
        const pending = res.body.items.find((item) => item.ticket_id === ticketId && item.event_kind === 'notification');
        expect(pending).toBeDefined();
        expect(pending.last_error).toContain(`telegram down for ${entry.status}`);
        expect(pending.metadata.type).toBe(entry.status);
      });

      const readyAfterFailure = await request(app).get('/api/notifications/ready').expect(200);
      const stillReady = readyAfterFailure.body.ready.find((item) => item.ticket_id === ticketId);
      expect(stillReady).toBeDefined();
      expect(stillReady.event_id).toBe(readyItem.event_id);

      control.stop();
      control = null;

      deliverChatToGateway.mockReset();
      deliverChatToGateway.mockResolvedValue({ ok: true, provider: 'telegram' });
      control = startInternalPollers({
        apiBaseUrl,
        dispatchIntervalMs: 10_000,
        notifyIntervalMs: 40,
        auditIntervalMs: 10_000,
        deliveryTimeoutMs: 1_000,
      });

      await waitFor(async () => {
        const res = await request(app).get('/api/pending-forwards').expect(200);
        const row = res.body.items.find((item) => item.ticket_id === ticketId && item.event_kind === 'notification');
        expect(row).toBeDefined();
        expect(row.resolution).toBe('delivered');
        expect(row.resolved_at).toBeTruthy();
      });

      await waitFor(async () => {
        const res = await request(app).get('/api/notifications/ready').expect(200);
        expect(res.body.ready.find((item) => item.ticket_id === ticketId)).toBeUndefined();
      });

      const notifyReadyAfterAck = await request(app).get('/api/notifications/ready').expect(200);
      expect(notifyReadyAfterAck.body.ready.find((item) => item.ticket_id === ticketId)).toBeUndefined();
      expect(dispatch.hasRecentNotification(ticketId, entry.status, {
        target_actor: readyItem.target_actor,
        reason: readyItem.reason,
      })).toBe(true);

      control.stop();
      control = null;
    }
  });

  it('audit_nudge 走 dispatch 通道时：失败入 pending-forward，重试成功后清除', async () => {
    const staleTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const ticket = store.createTicket({
      title: 'Audit nudge compensation',
      description: 'Desc',
      status: 'running',
      assigned_agent: 'beavy',
      next_actor: 'beavy',
      triage_owner: 'leoss',
      review_owner: 'leoss',
    });
    store.updateTicket(ticket.id, { last_update: staleTime });

    const auditEventId = dispatch.recordAuditEvent(ticket.id, 'stale_running', 'running');
    expect(auditEventId).toBeTruthy();

    dispatch.recordAuditResult({
      auditId: auditEventId,
      ticketId: ticket.id,
      auditType: 'stale_running',
      statusSnapshot: 'running',
      staleMinutes: 180,
      conclusion: 'stale_running',
      suggestedStatus: 'running',
      suggestedActor: 'beavy',
      suggestedAction: 'notify_only',
      reason: 'worker idle too long',
      confidence: 'high',
      summary: '请尽快更新进展',
      rawPayload: { from: 'test' },
    });

    const nudgesReady = await request(app).get('/api/nudges/ready').expect(200);
    const nudge = nudgesReady.body.ready.find((item) => item.ticket_id === ticket.id && item.kind === 'nudge');
    expect(nudge).toBeDefined();
    expect(nudge.nudge_source).toBe('audit_result');
    expect(nudge.agent).toBe('beavy');
    expect(nudge.target_session_key).toBeTruthy();
    expect(nudge.target_session_key).toBe(getNotifyMainSessionKey());

    deliverChatToGateway.mockRejectedValue(new Error('telegram nudge down'));
    control = startInternalPollers({
      apiBaseUrl,
      dispatchIntervalMs: 40,
      notifyIntervalMs: 10_000,
      auditIntervalMs: 10_000,
      deliveryTimeoutMs: 1_000,
    });

    await waitFor(async () => {
      const res = await request(app).get('/api/pending-forwards?unresolved_only=true').expect(200);
      const pending = res.body.items.find((item) => item.event_kind === 'dispatch_nudge'
        && item.ticket_id === ticket.id
        && item.target_session_key === getNotifyMainSessionKey());
      expect(pending).toBeDefined();
      expect(pending.last_error).toContain('telegram nudge down');
      expect(pending.metadata.nudge_source).toBe('audit_result');
    });

    control.stop();
    control = null;

    const pendingDispatch = getDispatchEventById(nudge.dispatch_id);
    expect(pendingDispatch).toBeDefined();
    expect(pendingDispatch.next_dispatch_retry_at).toBeTruthy();
    store.__dangerouslyRunSql?.(
      'UPDATE dispatch_events SET next_retry_at = ? WHERE id = ?',
      [new Date(Date.now() - 1000).toISOString(), nudge.dispatch_id],
    );

    await waitFor(async () => {
      const res = await request(app).get('/api/dispatch/ready').expect(200);
      const retried = res.body.ready.find((item) => item.dispatch_id === nudge.dispatch_id);
      expect(retried).toBeDefined();
      expect(retried.target_session_key).toBe(getNotifyMainSessionKey());
    });

    deliverChatToGateway.mockReset();
    deliverChatToGateway.mockResolvedValue({ ok: true, provider: 'telegram' });
    control = startInternalPollers({
      apiBaseUrl,
      dispatchIntervalMs: 40,
      notifyIntervalMs: 10_000,
      auditIntervalMs: 10_000,
      deliveryTimeoutMs: 1_000,
    });

    await waitFor(async () => {
      const res = await request(app).get('/api/pending-forwards').expect(200);
      const row = res.body.items.find((item) => item.event_kind === 'dispatch_nudge'
        && item.ticket_id === ticket.id
        && item.target_session_key === getNotifyMainSessionKey());
      expect(row).toBeDefined();
      expect(row.resolution).toBe('delivered');
      expect(row.resolved_at).toBeTruthy();
    });

    await waitFor(async () => {
      const res = await request(app).get('/api/dispatch/ready').expect(200);
      expect(res.body.ready.find((item) => item.ticket_id === ticket.id && item.kind === 'nudge')).toBeUndefined();
    });
  });
});
