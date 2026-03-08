/**
 * @vitest-environment node
 * Sheeply ready/ack 端到端闭环测试
 */
import './test-setup-sheeply-e2e.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from './app.js';
import { _resetDbForTesting } from './store-sqlite.js';
import { _resetDbForTesting as _resetDispatchForTesting } from './dispatch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, 'data', 'test-sheeply-e2e.db');

function ensureCleanStore() {
  _resetDbForTesting();
  _resetDispatchForTesting();
  const dir = path.dirname(TEST_DB);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const p of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

describe('Sheeply ready/ack e2e', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('打通 dispatch ready -> ack -> review dispatch -> complete notification -> ack', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Sheeply dispatch flow',
        description: 'Verify ready/ack full flow',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
      })
      .expect(201);

    const ticketId = createRes.body.id;

    const dispatchReady1 = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);

    expect(dispatchReady1.body.ready).toHaveLength(1);
    expect(dispatchReady1.body.ready[0]).toEqual(expect.objectContaining({
      ticket_id: ticketId,
      agent: 'beavy',
      status: 'queued',
    }));

    const firstDispatchId = dispatchReady1.body.ready[0].dispatch_id;
    await request(app)
      .post(`/api/dispatch/${firstDispatchId}/ack`)
      .expect(200);

    const dispatchReadyAfterAck = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    expect(dispatchReadyAfterAck.body.ready).toHaveLength(0);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'submit_for_review',
        actor: 'beavy',
        result_summary: '开发完成，等待 reviewer 验收',
      })
      .expect(200);

    const dispatchReady2 = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);

    expect(dispatchReady2.body.ready).toHaveLength(1);
    expect(dispatchReady2.body.ready[0]).toEqual(expect.objectContaining({
      ticket_id: ticketId,
      agent: 'leoss',
      status: 'done',
    }));

    await request(app)
      .post(`/api/dispatch/${dispatchReady2.body.ready[0].dispatch_id}/ack`)
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'approve', actor: 'leoss' })
      .expect(200);

    const notifyReady = await request(app)
      .get('/api/notifications/ready')
      .expect(200);

    expect(notifyReady.body.ready).toHaveLength(1);
    expect(notifyReady.body.ready[0]).toEqual(expect.objectContaining({
      ticket_id: ticketId,
      type: 'complete',
      status: 'complete',
    }));

    await request(app)
      .post(`/api/notifications/${notifyReady.body.ready[0].event_id}/ack`)
      .expect(200);

    const notifyReadyAfterAck = await request(app)
      .get('/api/notifications/ready')
      .expect(200);
    expect(notifyReadyAfterAck.body.ready).toHaveLength(0);
  });

  it('打通 pending_decision 通知 ready -> ack 闭环', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Need boss decision',
        description: 'Need product call',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        decision_owner: '荣晖',
      })
      .expect(201);

    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'request_decision',
        actor: 'beavy',
        decision_summary: '实现方向需要老大拍板',
      })
      .expect(200);

    const notifyReady = await request(app)
      .get('/api/notifications/ready')
      .expect(200);

    expect(notifyReady.body.ready).toHaveLength(1);
    expect(notifyReady.body.ready[0]).toEqual(expect.objectContaining({
      ticket_id: ticketId,
      type: 'pending_decision',
      status: 'pending_decision',
    }));

    await request(app)
      .post(`/api/notifications/${notifyReady.body.ready[0].event_id}/ack`)
      .expect(200);

    const afterAck = await request(app)
      .get('/api/notifications/ready')
      .expect(200);
    expect(afterAck.body.ready).toHaveLength(0);
  });

  it('workflow_mismatch 进入 dispatch ready 告警并可 ack 去重', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Mismatch alert flow',
        description: 'running but asking for decision',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        decision_owner: '荣晖',
      })
      .expect(201);

    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({
        author: 'beavy',
        type: 'progress',
        content: '这里需要老大拍板，是否继续按当前方向推进？',
      })
      .expect(201);

    const dispatchReady = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);

    expect(dispatchReady.body.ready).toHaveLength(1);
    expect(dispatchReady.body.ready[0]).toEqual(expect.objectContaining({
      ticket_id: ticketId,
      kind: 'workflow_mismatch',
      agent: '荣晖',
      status: 'running',
    }));
    expect(dispatchReady.body.ready[0].workflow_mismatch).toEqual(expect.objectContaining({
      recommended_status: 'pending_decision',
    }));

    await request(app)
      .post(`/api/dispatch/${dispatchReady.body.ready[0].dispatch_id}/ack`)
      .expect(200);

    const afterAck = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    expect(afterAck.body.ready).toHaveLength(0);
  });
});
