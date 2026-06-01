/**
 * @vitest-environment node
 * API 测试：Pull 模式 - 创建工单立即返回 queued、拉取、更新、dispatch
 */
import './test-setup.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from './app.js';
import {
  _resetDbForTesting,
  findLatestAssignmentForTicket,
  createOrReuseAssignment,
  getAssignmentById,
  updateAssignment,
  updateTicket,
  getTicketById,
  getTicketProjection,
} from './store-sqlite.js';
import {
  _resetDbForTesting as _resetDispatchForTesting,
  ackDispatchEvent as ackDispatchEventRecord,
  markDispatchDeliveryFailed,
  recordDispatchEvent,
} from './dispatch.js';
import { getAuditSessionKeyForTicket, getNotificationSessionKey, getNotifyMainSessionKey } from './agent-session-router.js';
import { MAIN_GATEWAY_ID } from './agent-topology.js';
import { AGENT_PLAYBOOK_VERSION } from './agent-facing.js';

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

afterEach(() => {
  ensureCleanStore();
});

describe('POST /api/tickets', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('创建工单立即返回 201，未传 status 时默认为 triage', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .send({ title: 'Test ticket', description: 'Test desc' })
      .expect(201);

    expect(res.body).toBeDefined();
    expect(res.body.status).toBe('triage');
    expect(res.body.assigned_agent).toBe('donky');
    expect(res.body.title).toBe('Test ticket');
    expect(res.body.description).toBe('Test desc');
  });

  it('创建工单可指定 agent', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .send({ title: 'Agent ticket', description: 'Desc', agent: 'custom-agent' })
      .expect(201);

    expect(res.body.assigned_agent).toBe('custom-agent');
    expect(res.body.status).toBe('triage');
  });

  it('ticket-platform 工单未显式指定 assigned_agent 时默认固化为 beavy，triage_owner 仍保持 leoss', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .send({ title: 'Ticket platform default executor', description: 'Desc', platform: 'ticket-platform' })
      .expect(201);

    expect(res.body.platform).toBe('ticket-platform');
    expect(res.body.assigned_agent).toBe('beavy');
    expect(res.body.triage_owner).toBe('leoss');
    expect(res.body.review_owner).toBe('leoss');
    expect(res.body.current_actor).toBe('leoss');
    expect(res.body.next_actor).toBe('leoss');
  });

  it('stock-platform 工单未显式指定 triage_owner 时默认路由到 cowder', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .send({ title: 'Stock platform default triage owner', description: 'Desc', platform: 'stock-platform' })
      .expect(201);

    expect(res.body.platform).toBe('stock-platform');
    expect(res.body.triage_owner).toBe('cowder');
    expect(res.body.review_owner).toBe('cowder');
    expect(res.body.current_actor).toBe('cowder');
    expect(res.body.next_actor).toBe('cowder');
  });

  it('human/control-ui 创建 stock-platform 工单时可显式指定 triage_owner / assigned_agent / review_owner', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Stock platform manual routing',
        description: 'Desc',
        platform: 'stock-platform',
        triage_owner: 'leoss',
        assigned_agent: 'marely',
        review_owner: 'example-human-operator',
      })
      .expect(201);

    expect(res.body.platform).toBe('stock-platform');
    expect(res.body.triage_owner).toBe('leoss');
    expect(res.body.assigned_agent).toBe('marely');
    expect(res.body.review_owner).toBe('example-human-operator');
    expect(res.body.current_actor).toBe('leoss');
    expect(res.body.next_actor).toBe('leoss');
    expect(res.body.next_actor_source).toBe('triage_owner');
  });

  it('ticket-platform 工单禁止指定非 beavy 执行人', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .send({ title: 'Ticket platform wrong executor', description: 'Desc', platform: 'ticket-platform', assigned_agent: 'donky' })
      .expect(400);

    expect(res.body.error).toBe('TICKET_PLATFORM_ASSIGNED_AGENT_INVALID');
    expect(res.body.allowed_assigned_agents).toEqual(['beavy']);
  });

  it('创建工单禁止直接指定非 triage 状态', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Explicit review owner',
        description: 'Desc',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'example-human-operator',
        status: 'done',
      })
      .expect(400);

    expect(res.body.message).toContain('创建工单只能使用 triage 状态');
    expect(res.body.allowed_create_status).toBe('triage');
  });

  it('创建工单支持进入 triage 并显式返回下一步责任人', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Need triage',
        description: 'Desc',
        status: 'triage',
        triage_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);

    expect(res.body.status).toBe('triage');
    expect(res.body.triage_owner).toBe('leoss');
    expect(res.body.next_actor).toBe('leoss');
    expect(res.body.next_actor_source).toBe('triage_owner');
  });

  it('标题为空时返回 400', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .send({ title: '', description: 'Desc' })
      .expect(400);

    expect(res.body.error).toBe('Bad request');
    expect(res.body.message).toContain('标题');
  });
});

describe('GET /api/metrics/dashboard', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('返回真实状态口径的 Dashboard 指标与状态分布', async () => {

    const runningRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Running ticket', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${runningRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${runningRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy', comment: '开始处理' })
      .expect(200);

    const doneRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Done ticket', assigned_agent: 'donky', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${doneRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${doneRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'donky' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${doneRes.body.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'donky', result_summary: 'ready' })
      .expect(200);

    const decisionRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Pending decision ticket', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${decisionRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${decisionRes.body.id}/transition`)
      .send({ action: 'request_decision', actor: 'beavy', decision_summary: '需要补拍板' })
      .expect(200);

    const completeRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Complete ticket', assigned_agent: 'cowder', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${completeRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${completeRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'cowder' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${completeRes.body.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'cowder', result_summary: 'done' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${completeRes.body.id}/transition`)
      .send({ action: 'approve', actor: 'leoss' })
      .expect(200);

    const deprecatedRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Deprecated ticket', assigned_agent: 'marely', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${deprecatedRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${deprecatedRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'marely' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${deprecatedRes.body.id}/transition`)
      .send({ action: 'fail', actor: 'marely', error: 'legacy leftover' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${deprecatedRes.body.id}/transition`)
      .send({ action: 'deprecate', actor: 'leoss', deprecation_reason: '历史残留归档为废弃' })
      .expect(200);

    const res = await request(app)
      .get('/api/metrics/dashboard')
      .expect(200);

    expect(res.body.data.stats).toEqual(expect.objectContaining({
      total: 5,
      active: 3,
      inProgress: 1,
      waitingReview: 1,
      closed: 2,
    }));

    expect(res.body.data.statusDistribution).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'running', name: '进行中', value: 1 }),
      expect.objectContaining({ status: 'done', name: '待验收', value: 1 }),
      expect.objectContaining({ status: 'pending_decision', name: '待决策', value: 1 }),
      expect.objectContaining({ status: 'complete', name: '已关单', value: 1 }),
      expect.objectContaining({ status: 'deprecated', name: '已废弃', value: 1 }),
    ]));

    expect(res.body.data.board.bucketBreakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'active', label: '待推进', count: 1 }),
      expect.objectContaining({ key: 'waiting_review', label: '待验收', count: 1 }),
      expect.objectContaining({ key: 'waiting_decision', label: '待决策', count: 1 }),
      expect.objectContaining({ key: 'closed', label: '已结束', count: 1 }),
      expect.objectContaining({ key: 'deprecated', label: '已废弃', count: 1 }),
    ]));
    expect(res.body.data.board.platformBreakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: '未分类平台', count: 5 }),
    ]));
    expect(res.body.data.board.ownerBreakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'beavy' }),
      expect.objectContaining({ key: '荣晖' }),
      expect.objectContaining({ key: 'leoss' }),
    ]));
    expect(res.body.data.board.focusBoard).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'pending_decision',
        count: 1,
        items: expect.arrayContaining([expect.objectContaining({ id: decisionRes.body.id, status: 'pending_decision' })]),
      }),
      expect.objectContaining({
        key: 'deprecated',
        count: 1,
        items: expect.arrayContaining([expect.objectContaining({ id: deprecatedRes.body.id, status: 'deprecated' })]),
      }),
    ]));
    expect(res.body.data.board.responsibilityBoard).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: runningRes.body.id, assigned_agent: 'beavy', review_owner: 'leoss' }),
      expect.objectContaining({ id: decisionRes.body.id, decision_owner: '荣晖', current_actor: '荣晖' }),
    ]));
    expect(res.body.data.board.runtimeDigestBoard).toEqual(expect.objectContaining({
      summary: expect.arrayContaining([
        expect.objectContaining({ key: 'review_queue', count: 1 }),
        expect.objectContaining({ key: 'waiting_decision', count: 1 }),
      ]),
      sections: expect.arrayContaining([
        expect.objectContaining({
          key: 'review_queue',
          items: expect.arrayContaining([expect.objectContaining({ id: doneRes.body.id, state: 'review_queue' })]),
        }),
        expect.objectContaining({
          key: 'waiting_decision',
          items: expect.arrayContaining([expect.objectContaining({ id: decisionRes.body.id, state: 'waiting_decision' })]),
        }),
      ]),
    }));
  });


  it('Dashboard 状态分布包含 paused，但 active/inProgress 不把它当 running', async () => {
    const pausedRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Paused metric', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${pausedRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${pausedRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${pausedRes.body.id}/transition`)
      .send({ action: 'pause', actor: 'beavy', pause_reason: '窗口未到' })
      .expect(200);

    const res = await request(app).get('/api/metrics/dashboard').expect(200);
    expect(res.body.data.statusDistribution).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'paused', name: '暂时挂起', value: 1 }),
    ]));
    expect(res.body.data.stats.inProgress).toBe(0);
  });

});

describe('GET /api/tickets', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('工单列表按创建时间倒序返回，最新的在前', async () => {
    await request(app)
      .post('/api/tickets')
      .send({ title: 'Older ticket', description: 'Desc' })
      .expect(201);

    await request(app)
      .post('/api/tickets')
      .send({ title: 'Newest ticket', description: 'Desc' })
      .expect(201);

    const res = await request(app)
      .get('/api/tickets')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].title).toBe('Newest ticket');
    expect(res.body[1].title).toBe('Older ticket');
  });

  it('工单列表返回 platform/request_type/责任路由字段', async () => {
    await request(app)
      .post('/api/tickets')
      .send({
        title: 'Structured ticket',
        description: 'Desc',
        status: 'triage',
        triage_owner: 'leoss',
        assigned_agent: 'beavy',
        platform: 'ticket-platform',
        request_type: 'feature',
        triage_summary: '列表页需要可识别。',
      })
      .expect(201);

    const res = await request(app)
      .get('/api/tickets')
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toEqual(expect.objectContaining({
      title: 'Structured ticket',
      status: 'triage',
      triage_owner: 'leoss',
      assigned_agent: 'beavy',
      next_actor: 'leoss',
      next_actor_source: 'triage_owner',
      bot: 'beavy',
      platform: 'ticket-platform',
      request_type: 'feature',
      triage_summary: '列表页需要可识别。',
    }));
  });

  it('支持按 status / next_actor 过滤可通知工单', async () => {
    await request(app)
      .post('/api/tickets')
      .send({ title: 'Need triage', description: 'Desc', status: 'triage', triage_owner: 'leoss', assigned_agent: 'beavy' })
      .expect(201);
    await request(app)
      .post('/api/tickets')
      .send({ title: 'Need execution', description: 'Desc', status: 'queued', triage_owner: 'leoss', assigned_agent: 'beavy' })
      .expect(201);

    const triageOnly = await request(app)
      .get('/api/tickets?status=triage&next_actor=leoss&actionable=true')
      .expect(200);

    expect(triageOnly.body).toHaveLength(1);
    expect(triageOnly.body[0].title).toBe('Need triage');
    expect(triageOnly.body[0].next_actor).toBe('leoss');
  });

  it('历史 paused 平台票会返回 paused_tail_classification，并支持过滤', async () => {
    const completedTail = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Debug create historical tail',
        description: 'Desc',
        platform: 'ticket-platform',
        triage_owner: 'leoss',
        assigned_agent: 'beavy',
        review_owner: 'leoss',
      })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${completedTail.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${completedTail.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${completedTail.body.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: '验收通过，可按已验证正常收口' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${completedTail.body.id}/transition`)
      .send({ action: 'pause', actor: 'leoss', pause_reason: '子单已完成，等待恢复后正常 closeout' })
      .expect(200);

    const governanceTail = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Inbox historical governance tail',
        description: 'Desc',
        platform: 'ticket-platform',
        triage_owner: 'leoss',
        assigned_agent: 'beavy',
        review_owner: 'leoss',
      })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${governanceTail.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${governanceTail.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${governanceTail.body.id}/transition`)
      .send({ action: 'pause', actor: 'beavy', pause_reason: '平台 worker stuck in starting + reservation_conflict' })
      .expect(200);

    const historicalOnly = await request(app)
      .get('/api/tickets?status=paused&platform=ticket-platform&historical_paused_tail=true')
      .expect(200);

    expect(historicalOnly.body).toHaveLength(2);
    const completedItem = historicalOnly.body.find((item) => item.id === completedTail.body.id);
    const governanceItem = historicalOnly.body.find((item) => item.id === governanceTail.body.id);
    expect(completedItem.paused_tail_classification).toEqual(expect.objectContaining({
      category: 'resume_then_close',
      recommendation: 'resume_then_close',
    }));
    expect(governanceItem.paused_tail_classification).toEqual(expect.objectContaining({
      category: 'superseded_by_governance_fix',
      recommendation: 'close_with_evidence_migration',
    }));

    const governanceOnly = await request(app)
      .get('/api/tickets?status=paused&paused_tail_category=superseded_by_governance_fix')
      .expect(200);
    expect(governanceOnly.body).toHaveLength(1);
    expect(governanceOnly.body[0].id).toBe(governanceTail.body.id);
  });
});

describe('GET /api/inbox/review & /api/inbox/decisions', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('按状态 + dispatch_state + available_actions 生成更细的 inbox reason / recommended action', async () => {
    const queuedReceipt = await request(app)
      .post('/api/tickets')
      .send({ title: 'Queued receipt first', triage_owner: 'leoss', assigned_agent: 'beavy', review_owner: 'leoss', status: 'queued' })
      .expect(201);

    const queuedReceiptDispatchId = recordDispatchEvent(queuedReceipt.body.id, 'beavy', 'queued');
    ackDispatchEventRecord(queuedReceiptDispatchId, {
      awaiting_receipt_from: 'beavy',
    });

    const queuedReady = await request(app)
      .post('/api/tickets')
      .send({ title: 'Queued ready to start', triage_owner: 'leoss', assigned_agent: 'beavy', review_owner: 'leoss', status: 'queued' })
      .expect(201);

    const reviewDone = await request(app)
      .post('/api/tickets')
      .send({ title: 'Done waiting review receipt', triage_owner: 'leoss', assigned_agent: 'beavy', review_owner: 'leoss' })
      .expect(201);
    await request(app).post(`/api/tickets/${reviewDone.body.id}/transition`).send({ action: 'queue', actor: 'leoss' }).expect(200);
    await request(app).post(`/api/tickets/${reviewDone.body.id}/transition`).send({ action: 'start_work', actor: 'beavy' }).expect(200);
    await request(app).post(`/api/tickets/${reviewDone.body.id}/transition`).send({ action: 'submit_for_review', actor: 'beavy', result_summary: '实现已完成，待 reviewer receipt' }).expect(200);
    const reviewDoneDispatchId = recordDispatchEvent(reviewDone.body.id, 'leoss', 'done');
    ackDispatchEventRecord(reviewDoneDispatchId, {
      awaiting_receipt_from: 'leoss',
    });

    const reviewActive = await request(app)
      .post('/api/tickets')
      .send({ title: 'Review active approve path', triage_owner: 'leoss', assigned_agent: 'beavy', review_owner: 'leoss' })
      .expect(201);
    await request(app).post(`/api/tickets/${reviewActive.body.id}/transition`).send({ action: 'queue', actor: 'leoss' }).expect(200);
    await request(app).post(`/api/tickets/${reviewActive.body.id}/transition`).send({ action: 'start_work', actor: 'beavy' }).expect(200);
    await request(app).post(`/api/tickets/${reviewActive.body.id}/transition`).send({ action: 'submit_for_review', actor: 'beavy', result_summary: '等待 reviewer approve / reject' }).expect(200);
    await request(app).post(`/api/tickets/${reviewActive.body.id}/transition`).send({ action: 'start_review', actor: 'leoss' }).expect(200);

    const decisionTicket = await request(app)
      .post('/api/tickets')
      .send({ title: 'Decision resume path', triage_owner: 'leoss', assigned_agent: 'beavy', review_owner: 'leoss' })
      .expect(201);
    await request(app).post(`/api/tickets/${decisionTicket.body.id}/transition`).send({ action: 'queue', actor: 'leoss' }).expect(200);
    await request(app).post(`/api/tickets/${decisionTicket.body.id}/transition`).send({ action: 'start_work', actor: 'beavy' }).expect(200);
    await request(app).post(`/api/tickets/${decisionTicket.body.id}/transition`).send({ action: 'request_decision', actor: 'beavy', decision_summary: '需要老大拍板后恢复执行' }).expect(200);

    const inboxRes = await request(app).get('/api/inbox').expect(200);

    const queuedReceiptItem = inboxRes.body.lanes.execution.find((item) => item.id === queuedReceipt.body.id);
    expect(queuedReceiptItem).toEqual(expect.objectContaining({
      inbox_lane: 'execution',
      recommended_action: 'start_work',
    }));
    expect(queuedReceiptItem.inbox_reason).toContain('等待 beavy 回执');
    expect(queuedReceiptItem.inbox_reason).toContain('receipt accepted');

    const queuedReadyItem = inboxRes.body.lanes.execution.find((item) => item.id === queuedReady.body.id);
    expect(queuedReadyItem).toEqual(expect.objectContaining({
      inbox_lane: 'execution',
      recommended_action: 'start_work',
    }));
    expect(queuedReadyItem.inbox_reason).toContain('下一步应 start_work 开工');

    const reviewDoneItem = inboxRes.body.lanes.review.find((item) => item.id === reviewDone.body.id);
    expect(reviewDoneItem).toEqual(expect.objectContaining({
      status: 'done',
      recommended_action: 'start_review',
    }));
    expect(reviewDoneItem.inbox_reason).toContain('等待 leoss 回执并进入 review');

    const reviewActiveItem = inboxRes.body.lanes.review.find((item) => item.id === reviewActive.body.id);
    expect(reviewActiveItem).toEqual(expect.objectContaining({
      status: 'review',
      recommended_action: 'approve',
    }));
    expect(reviewActiveItem.inbox_reason).toContain('等待 reviewer approve / reject');

    const decisionItem = inboxRes.body.lanes.decision.find((item) => item.id === decisionTicket.body.id);
    expect(decisionItem).toEqual(expect.objectContaining({
      inbox_lane: 'decision',
      recommended_action: 'resume_from_decision',
    }));
    expect(decisionItem.inbox_reason).toContain('决策后可恢复执行');
  });

  it('按 SLA 剩余时间最紧急优先返回 review inbox 与 decision inbox', async () => {
    const reviewSoon = await request(app)
      .post('/api/tickets')
      .send({ title: 'Review sooner', triage_owner: 'leoss', assigned_agent: 'beavy', review_owner: 'leoss' })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${reviewSoon.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${reviewSoon.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${reviewSoon.body.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'ready soon' })
      .expect(200);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const reviewLater = await request(app)
      .post('/api/tickets')
      .send({ title: 'Review later', triage_owner: 'leoss', assigned_agent: 'beavy', review_owner: 'leoss' })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${reviewLater.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${reviewLater.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${reviewLater.body.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'ready later' })
      .expect(200);

    const decisionTicket = await request(app)
      .post('/api/tickets')
      .send({ title: 'Need decision', triage_owner: 'leoss', assigned_agent: 'beavy', review_owner: 'leoss' })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${decisionTicket.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${decisionTicket.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${decisionTicket.body.id}/transition`)
      .send({ action: 'request_decision', actor: 'beavy', decision_summary: 'need boss' })
      .expect(200);

    const reviewRes = await request(app)
      .get('/api/inbox/review')
      .expect(200);

    expect(reviewRes.body.items.map((item) => item.title)).toEqual(['Review sooner', 'Review later']);
    expect(reviewRes.body.items[0]).toEqual(expect.objectContaining({
      inbox_lane: 'review',
      status: 'done',
      review_owner: 'leoss',
      sla_remaining_ms: expect.any(Number),
      sla_remaining_minutes: expect.any(Number),
    }));
    expect(reviewRes.body.items[0].sla_remaining_ms).toBeLessThanOrEqual(reviewRes.body.items[1].sla_remaining_ms);

    const decisionRes = await request(app)
      .get('/api/inbox/decisions')
      .expect(200);

    expect(decisionRes.body.items).toHaveLength(1);
    expect(decisionRes.body.items[0].title).toBe('Need decision');
    expect(decisionRes.body.items[0].inbox_lane).toBe('decision');
    expect(decisionRes.body.items[0].status).toBe('pending_decision');
    expect(typeof decisionRes.body.items[0].sla_remaining_ms).toBe('number');
  });
});

describe('GET /api/tickets/pull', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('无 agent 参数时返回 400', async () => {
    await request(app)
      .get('/api/tickets/pull')
      .expect(400);
  });

  it('拉取指定 agent 的 queued 工单', async () => {
    await request(app)
      .post('/api/tickets')
      .send({ title: 'Pull test', description: 'Desc', status: 'queued', agent: 'donky', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);

    const res = await request(app)
      .get('/api/tickets/pull?agent=donky&limit=1')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].status).toBe('queued');
    expect(res.body[0].assigned_agent).toBe('donky');
    expect(res.body[0].title).toBe('Pull test');
  });

  it('不匹配 agent 时返回空数组', async () => {
    await request(app)
      .post('/api/tickets')
      .send({ title: 'Donky task', description: 'Desc', agent: 'donky' })
      .expect(201);

    const res = await request(app)
      .get('/api/tickets/pull?agent=other-agent')
      .expect(200);

    expect(res.body).toEqual([]);
  });
});

describe('GET /api/tickets/:id/status', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('返回状态路由摘要，triage 走 triage_owner', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Need triage', description: 'Desc', status: 'triage', triage_owner: 'leoss', assigned_agent: 'beavy' })
      .expect(201);

    const res = await request(app)
      .get(`/api/tickets/${createRes.body.id}/status`)
      .expect(200);

    expect(res.body).toEqual(expect.objectContaining({
      status: 'triage',
      triage_owner: 'leoss',
      assigned_agent: 'beavy',
      next_actor: 'leoss',
      next_actor_source: 'triage_owner',
      should_notify: true,
    }));
  });
});


describe('GET /api/notifications/summary', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('返回 complete / failed / pending_decision / blocked 四类通知摘要', async () => {
    const completeRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Completed ticket',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${completeRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${completeRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${completeRes.body.id}/transition`)
      .send({
        action: 'submit_for_review',
        actor: 'beavy',
        result_summary: '已完成并关单'
      })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${completeRes.body.id}/transition`)
      .send({
        action: 'approve',
        actor: 'leoss'
      })
      .expect(200);

    const failedRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Failed ticket',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${failedRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${failedRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${failedRes.body.id}/transition`)
      .send({
        action: 'fail',
        actor: 'beavy',
        error: '测试失败'
      })
      .expect(200);

    const decisionRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Decision ticket',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        decision_owner: 'example-human-operator',
        assigned_agent: 'beavy',
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${decisionRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${decisionRes.body.id}/transition`)
      .send({
        action: 'start_work',
        actor: 'beavy'
      })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${decisionRes.body.id}/transition`)
      .send({
        action: 'request_decision',
        actor: 'beavy',
        decision_summary: '需要老大拍板'
      })
      .expect(200);

    const blockedRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Blocked ticket',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        decision_owner: 'example-human-operator',
        assigned_agent: 'beavy',
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${blockedRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${blockedRes.body.id}/transition`)
      .send({
        action: 'start_work',
        actor: 'beavy'
      })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${blockedRes.body.id}/transition`)
      .send({
        action: 'block',
        actor: 'beavy',
        blocker_summary: '需要老大协调外部依赖'
      })
      .expect(200);

    const res = await request(app)
      .get('/api/notifications/summary?minutes=180')
      .expect(200);

    expect(res.body.counts.complete).toBe(1);
    expect(res.body.counts.failed).toBe(1);
    expect(res.body.counts.pending_decision).toBe(1);
    expect(res.body.counts.blocked).toBe(1);
    expect(res.body.items.complete[0]).toEqual(expect.objectContaining({
      id: completeRes.body.id,
      status: 'complete',
      result_summary: '已完成并关单',
      review_owner: 'leoss',
    }));
    expect(res.body.items.failed[0]).toEqual(expect.objectContaining({
      id: failedRes.body.id,
      status: 'failed',
      error: '测试失败',
    }));
    expect(res.body.items.pending_decision[0]).toEqual(expect.objectContaining({
      id: decisionRes.body.id,
      status: 'pending_decision',
      decision_owner: 'example-human-operator',
      decision_summary: '需要老大拍板',
    }));
    expect(res.body.items.blocked[0]).toEqual(expect.objectContaining({
      id: blockedRes.body.id,
      status: 'blocked',
      decision_owner: 'example-human-operator',
    }));
  });
});

describe('PATCH /api/tickets/:id / POST /api/tickets/:id/transition', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('PATCH 可更新 review_owner，并重新计算当前责任人与 reviewer dispatch 目标', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Patch review owner',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { status: 'done' });

    const patchRes = await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ review_owner: 'example-human-operator' })
      .expect(200);

    expect(patchRes.body.review_owner).toBe('example-human-operator');
    expect(patchRes.body.current_actor).toBe('example-human-operator');
    expect(patchRes.body.next_actor).toBe('example-human-operator');
    expect(patchRes.body.next_actor_source).toBe('review_owner');

    const dispatchRes = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const readyItem = dispatchRes.body.ready.find((item) => item.ticket_id === ticketId);
    expect(readyItem).toBeDefined();
    expect(readyItem.agent).toBe('example-human-operator');
    expect(readyItem.target_session_key).toBe(`agent:main:ticket:${ticketId}`);
    expect(readyItem.target_session_key).not.toBe(getNotifyMainSessionKey());
    expect(readyItem.dedupe_key).toBe('dispatch:done:assignment:example-human-operator');
  });

  it('通过 transition API 将工单更新为 running，并写入锁定信息', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Patch test', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

    const res = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'start_work',
        actor: 'beavy'
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.ticket.status).toBe('running');
    expect(res.body.ticket.locked_by).toBe('beavy');
    expect(res.body.ticket.locked_at).toBeTruthy();
  });

  it('transition API 在 actor 缺失或占位时会按动作角色自动注入身份', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Auto actor', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

    const started = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work' })
      .expect(200);

    expect(started.body.ticket.status).toBe('running');
    expect(started.body.ticket.locked_by).toBe('beavy');

    const done = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'submit_for_review', actor: 'Current User', result_summary: 'ready' })
      .expect(200);

    expect(done.body.ticket.status).toBe('done');

    const approved = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'approve', actor: 'Current User', comment: 'review ok' })
      .expect(200);

    expect(approved.body.ticket.status).toBe('complete');

    const detail = await request(app).get(`/api/tickets/${ticketId}`).expect(200);
    expect(detail.body.comments).toEqual(expect.arrayContaining([
      expect.objectContaining({ author: 'leoss', type: 'status_change', content: 'review ok' }),
    ]));
  });

  it('通过 transition API 将 running 工单更新为 done 并设置 result_summary', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Complete test', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'start_work',
        actor: 'beavy'
      })
      .expect(200);

    const res = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'submit_for_review',
        actor: 'beavy',
        result_summary: '任务完成'
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.ticket.status).toBe('done');
    expect(res.body.ticket.result_summary).toBe('任务完成');
    expect(res.body.ticket.locked_by).toBeNull();
    expect(res.body.ticket.locked_at).toBeNull();
  });

  it('支持 triage -> queue：由 triage_owner 合法放行到 queued 并生成执行派单', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Queue from triage',
        description: 'Desc',
        status: 'triage',
        triage_owner: 'leoss',
        assigned_agent: 'beavy',
        review_owner: 'leoss'
      })
      .expect(201);
    const ticketId = createRes.body.id;

    const actionsBefore = await request(app)
      .get(`/api/tickets/${ticketId}/actions`)
      .expect(200);
    expect(actionsBefore.body.available_actions).toContain('queue');

    const queued = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    expect(queued.body.ticket.status).toBe('queued');
    expect(queued.body.ticket.current_actor).toBe('beavy');
    expect(queued.body.ticket.next_actor).toBe('beavy');

    const dispatchRes = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const readyItem = dispatchRes.body.ready.find((r) => r.ticket_id === ticketId);
    expect(readyItem).toBeDefined();
    expect(readyItem.agent).toBe('beavy');
  });

  it('triage -> queue 缺 assigned_agent 或 review_owner 时返回 409 TRIAGE_QUEUE_CHAIN_INCOMPLETE', async () => {
    const { updateTicket } = await import('./store.js');
    const full = await request(app)
      .post('/api/tickets')
      .send({ title: 'Full chain', description: 'Desc', status: 'triage', triage_owner: 'leoss', assigned_agent: 'beavy', review_owner: 'leoss' })
      .expect(201);
    updateTicket(full.body.id, { assigned_agent: null });
    const res1 = await request(app)
      .post(`/api/tickets/${full.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(409);
    expect(res1.body.error).toBe('TRIAGE_QUEUE_CHAIN_INCOMPLETE');
    expect(res1.body.missing_fields).toContain('assigned_agent');

    const full2 = await request(app)
      .post('/api/tickets')
      .send({ title: 'Full chain 2', description: 'Desc', status: 'triage', triage_owner: 'leoss', assigned_agent: 'beavy', review_owner: 'leoss' })
      .expect(201);
    updateTicket(full2.body.id, { review_owner: null });
    const res2 = await request(app)
      .post(`/api/tickets/${full2.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(409);
    expect(res2.body.error).toBe('TRIAGE_QUEUE_CHAIN_INCOMPLETE');
    expect(res2.body.missing_fields).toContain('review_owner');
  });

  it('支持 pause / resume：恢复到挂起前状态并保留挂起元信息', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Pause test', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    const paused = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'pause', actor: 'beavy', pause_reason: '等待外部窗口' })
      .expect(200);

    expect(paused.body.ticket.status).toBe('paused');
    expect(paused.body.ticket.paused_from_status).toBe('running');
    expect(paused.body.ticket.pause_reason).toBe('等待外部窗口');
    expect(paused.body.ticket.locked_by).toBeNull();

    const resumed = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'resume', actor: 'beavy' })
      .expect(200);

    expect(resumed.body.ticket.status).toBe('running');
    expect(resumed.body.ticket.paused_from_status).toBeNull();
    expect(resumed.body.ticket.pause_reason).toBeNull();
    expect(resumed.body.ticket.locked_by).toBe('beavy');
  });

  it('支持 deprecate：triage_owner 可将历史残留工单标记为 deprecated', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Legacy leftover ticket', description: 'Desc', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'fail', actor: 'beavy', error: '历史残留工单' })
      .expect(200);

    const actionsBefore = await request(app)
      .get(`/api/tickets/${ticketId}/actions`)
      .expect(200);
    expect(actionsBefore.body.available_actions).toContain('deprecate');

    const deprecated = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'deprecate', actor: 'leoss', deprecation_reason: '历史残留工单，不再进入当前流程。' })
      .expect(200);

    expect(deprecated.body.ticket.status).toBe('deprecated');
    expect(deprecated.body.ticket.deprecation_reason).toBe('历史残留工单，不再进入当前流程。');
    expect(deprecated.body.ticket.current_actor).toBeNull();

    const actionsAfter = await request(app)
      .get(`/api/tickets/${ticketId}/actions`)
      .expect(200);
    expect(actionsAfter.body.available_actions).toEqual([]);
  });

  it('支持 reset_to_queued：triage_owner 可将 running 工单撤回 queued，并自动写审计评论', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Reset start', description: 'Desc', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    const reset = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'reset_to_queued', actor: 'Current User', reason: '误触开工', comment: '尚未真正开始执行，先回退待处理。' })
      .expect(200);

    expect(reset.body.ticket.status).toBe('queued');
    expect(reset.body.ticket.locked_by).toBeNull();
    expect(reset.body.ticket.current_actor).toBe('beavy');

    const detail = await request(app).get(`/api/tickets/${ticketId}`).expect(200);
    expect(detail.body.comments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        author: 'leoss',
        type: 'status_change',
        content: expect.stringContaining('原因：误触开工'),
        metadata: expect.objectContaining({
          action: 'reset_to_queued',
          from_status: 'running',
          to_status: 'queued',
          actor: 'leoss',
          reason: '误触开工',
        }),
      }),
    ]));
  });

  it('支持 reset_to_queued：paused 工单撤回 queued 时会清空挂起元信息', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Reset paused start', description: 'Desc', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'pause', actor: 'beavy', pause_reason: '等待窗口' })
      .expect(200);

    const reset = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'reset_to_queued', actor: 'leoss', reason: '误触开工后已暂停，撤回重新排队' })
      .expect(200);

    expect(reset.body.ticket.status).toBe('queued');
    expect(reset.body.ticket.paused_from_status).toBeNull();
    expect(reset.body.ticket.paused_by).toBeNull();
    expect(reset.body.ticket.pause_reason).toBeNull();
    expect(reset.body.ticket.locked_by).toBeNull();
  });

  it('reset_to_queued 缺少 reason 时返回必填字段错误', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Reset reason required', description: 'Desc', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    const res = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'reset_to_queued', actor: 'leoss' })
      .expect(400);

    expect(res.body).toEqual(expect.objectContaining({
      error: 'Bad request',
      message: 'reason 不能为空',
      required_fields: expect.arrayContaining(['actor', 'reason']),
    }));
  });

  it('reset_to_queued 仅允许 triage_owner 执行', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Reset actor guard', description: 'Desc', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    const res = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'reset_to_queued', actor: 'beavy', reason: '误触开工' })
      .expect(403);

    expect(res.body).toEqual(expect.objectContaining({
      error: 'ACTION_FORBIDDEN',
      message: 'reset_to_queued 仅允许 leoss 执行',
    }));
  });

  it('ticket-platform 工单禁止 formal_reassign 给非 beavy', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Ticket platform formal reassign guard', description: 'Desc', platform: 'ticket-platform', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    const reassigned = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'formal_reassign', actor: 'beavy', target_agent: 'donky', comment: '误改派给非 ticket-platform 执行人' })
      .expect(409);

    expect(reassigned.body.error).toBe('TICKET_PLATFORM_ASSIGNED_AGENT_INVALID');
    expect(reassigned.body.allowed_assigned_agents).toEqual(['beavy']);
  });

  it('支持 formal_reassign：running 工单正式改派后回到 queued，并向目标 agent 重新派单', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Formal reassign flow', description: 'Desc', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    const reassigned = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'formal_reassign', actor: 'beavy', target_agent: 'donky', comment: '转给目标 agent 正式接手' })
      .expect(200);

    expect(reassigned.body.ticket.status).toBe('queued');
    expect(reassigned.body.ticket.assigned_agent).toBe('donky');
    expect(reassigned.body.ticket.current_actor).toBe('donky');
    expect(reassigned.body.ticket.locked_by).toBeNull();

    const readyRes = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const readyItem = readyRes.body.ready.find((item) => item.ticket_id === ticketId);
    expect(readyItem).toBeDefined();
    expect(readyItem.agent).toBe('donky');
    expect(readyItem.assignment.agent.id).toBe('donky');
    expect(readyItem.assignment.ticket.current_actor).toBe('donky');
    expect(readyItem.reset_session).toBe(true);
    expect(readyItem.session_reset_reason).toBe('assignment_refresh');
  });

  it('ticket-platform 工单禁止 handoff 给非 beavy', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Ticket platform handoff guard', description: 'Desc', platform: 'ticket-platform', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'pause', actor: 'beavy', pause_reason: '等待交接' })
      .expect(200);

    const handedOff = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'handoff', actor: 'beavy', target_agent: 'donky', comment: '误交接给非 ticket-platform 执行人' })
      .expect(409);

    expect(handedOff.body.error).toBe('TICKET_PLATFORM_ASSIGNED_AGENT_INVALID');
    expect(handedOff.body.allowed_assigned_agents).toEqual(['beavy']);
  });

  it('支持 handoff：paused 工单交接后回到 queued，清空挂起信息并切到目标 agent', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Handoff flow', description: 'Desc', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'pause', actor: 'beavy', pause_reason: '等待交接' })
      .expect(200);

    const handedOff = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'handoff', actor: 'beavy', target_agent: 'donky', comment: '当前上下文已交接' })
      .expect(200);

    expect(handedOff.body.ticket.status).toBe('queued');
    expect(handedOff.body.ticket.assigned_agent).toBe('donky');
    expect(handedOff.body.ticket.current_actor).toBe('donky');
    expect(handedOff.body.ticket.paused_from_status).toBeNull();
    expect(handedOff.body.ticket.paused_by).toBeNull();
    expect(handedOff.body.ticket.pause_reason).toBeNull();

    const readyRes = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const readyItem = readyRes.body.ready.find((item) => item.ticket_id === ticketId);
    expect(readyItem).toBeDefined();
    expect(readyItem.agent).toBe('donky');
    expect(readyItem.assignment.agent.id).toBe('donky');
    expect(readyItem.assignment.ticket.current_actor).toBe('donky');
  });

  it('paused 工单不会进入 dispatch ready 或 notifications ready', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Paused ready gate', description: 'Desc', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'pause', actor: 'beavy', pause_reason: '先冻结' })
      .expect(200);

    const dispatchRes = await request(app).get('/api/dispatch/ready').expect(200);
    expect(dispatchRes.body.ready.find((r) => r.ticket_id === ticketId)).toBeUndefined();

    const notifyRes = await request(app).get('/api/notifications/ready').expect(200);
    expect(notifyRes.body.ready.find((r) => r.ticket_id === ticketId)).toBeUndefined();
  });

  it('同一 assigned_agent 已有 running 工单时，第二张工单 start_work 返回 409 和占用详情', async () => {
    const first = await request(app)
      .post('/api/tickets')
      .send({ title: 'Running #1', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);

    const second = await request(app)
      .post('/api/tickets')
      .send({ title: 'Running #2', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${first.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    const res = await request(app)
      .post(`/api/tickets/${second.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(409);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('RUNNING_TICKET_CONFLICT');
    expect(res.body.attempted_action).toBe('start_work');
    expect(res.body.conflict_ticket).toEqual(expect.objectContaining({
      id: first.body.id,
      status: 'running',
      assigned_agent: 'beavy',
    }));
    expect(res.body.message).toContain(`#${first.body.id}`);
    expect(res.body.statusCode).toBe(409);
    expect(res.body.recommended_action).toContain('start_work');

    const secondDetail = await request(app).get(`/api/tickets/${second.body.id}`).expect(200);
    expect(secondDetail.body.status).toBe('queued');
    expect(secondDetail.body.locked_by).toBeNull();
  });

  it('dispatch ready 会先抢 execution reservation，第二张同 agent queued 单不会再进入 ready', async () => {
    const first = await request(app)
      .post('/api/tickets')
      .send({ title: 'Reservation front-run #1', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss', execution_mode: 'direct' })
      .expect(201);

    const second = await request(app)
      .post('/api/tickets')
      .send({ title: 'Reservation front-run #2', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss', execution_mode: 'direct' })
      .expect(201);

    const ready = await request(app).get('/api/dispatch/ready').expect(200);
    expect(ready.body.ready).toHaveLength(1);
    expect([first.body.id, second.body.id]).toContain(ready.body.ready[0].ticket_id);
    expect(ready.body.ready[0].reservation).toEqual(expect.objectContaining({
      ticket_id: ready.body.ready[0].ticket_id,
      agent_id: 'beavy',
      state: 'reserved',
    }));

    const blockedTicketId = ready.body.ready[0].ticket_id === first.body.id ? second.body.id : first.body.id;
    const blockedDetail = await request(app).get(`/api/tickets/${blockedTicketId}`).expect(200);
    expect(blockedDetail.body.execution_guard).toEqual(expect.objectContaining({
      suppress_dispatch: true,
      reason: 'reservation_conflict',
    }));
    expect(blockedDetail.body.execution_guard.reservation_conflict).toEqual(expect.objectContaining({
      agent_id: 'beavy',
      state: 'reserved',
    }));
  });

  it('dispatch detection 会前置识别 queued receipt accepted reservation，与 write-time running gate 保持一致', async () => {
    const first = await request(app)
      .post('/api/tickets')
      .send({ title: 'Receipt reserved #1', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss', execution_mode: 'subagent', max_active_workers: 1 })
      .expect(201);

    const second = await request(app)
      .post('/api/tickets')
      .send({ title: 'Receipt reserved #2', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss', execution_mode: 'subagent', max_active_workers: 1 })
      .expect(201);

    const ready1 = await request(app).get('/api/dispatch/ready').expect(200);
    const firstReady = ready1.body.ready.find((item) => item.ticket_id === first.body.id);
    const secondReady = ready1.body.ready.find((item) => item.ticket_id === second.body.id);
    expect(firstReady || secondReady).toBeDefined();

    const reserved = firstReady || secondReady;
    const blockedTicketId = reserved.ticket_id === first.body.id ? second.body.id : first.body.id;

    await request(app)
      .post(`/api/dispatch/${reserved.dispatch_id}/ack`)
      .expect(200);

    await request(app)
      .post(`/api/agent/assignments/${reserved.assignment_id}/reports`)
      .send({
        assignment_token: reserved.assignment.assignment_token,
        report_type: 'dispatch_receipt',
        idempotency_key: `reservation-${reserved.ticket_id}`,
        receipt: {
          dispatch_id: reserved.dispatch_id,
          ticket_id: reserved.ticket_id,
          stage: 'queued',
          agent: 'beavy',
          decision: 'accepted',
          message: '已 receipt，保留 running 资格。',
        },
      })
      .expect(201);

    const ready2 = await request(app).get('/api/dispatch/ready').expect(200);
    expect(ready2.body.ready.find((item) => item.ticket_id === blockedTicketId)).toBeUndefined();

    const forcedStart = await request(app)
      .post(`/api/tickets/${blockedTicketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(409);
    expect(['EXECUTION_WORKER_REQUIRED', 'RUNNING_TICKET_CONFLICT']).toContain(forcedStart.body.error);
  });

  it('released reservation 不应继续占住 lane，后续 queued 单应可重新进入 dispatch ready', async () => {
    const first = await request(app)
      .post('/api/tickets')
      .send({ title: 'Released reservation holder', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss', execution_mode: 'direct' })
      .expect(201);

    const ready1 = await request(app).get('/api/dispatch/ready').expect(200);
    const firstReady = ready1.body.ready.find((item) => item.ticket_id === first.body.id);
    expect(firstReady).toBeDefined();

    await request(app)
      .post(`/api/tickets/${first.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${first.body.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'done' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${first.body.id}/transition`)
      .send({ action: 'approve', actor: 'leoss' })
      .expect(200);

    const firstAfter = await request(app).get(`/api/tickets/${first.body.id}`).expect(200);
    expect(firstAfter.body.execution_guard.reservation).toEqual(expect.objectContaining({
      state: 'released',
      release_reason: 'approve',
    }));

    const second = await request(app)
      .post('/api/tickets')
      .send({ title: 'Should reacquire after release', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss', execution_mode: 'direct' })
      .expect(201);

    const secondDetail = await request(app).get(`/api/tickets/${second.body.id}`).expect(200);
    expect(secondDetail.body.execution_guard.reservation_conflict).toBeNull();

    const ready2 = await request(app).get('/api/dispatch/ready').expect(200);
    const secondReady = ready2.body.ready.find((item) => item.ticket_id === second.body.id);
    expect(secondReady).toBeDefined();
    expect(secondReady.reservation).toEqual(expect.objectContaining({
      ticket_id: second.body.id,
      agent_id: 'beavy',
      state: 'reserved',
    }));
  });

  it('paused->resume 到 running 也受同 agent running 门禁约束', async () => {
    const pausedTicket = await request(app)
      .post('/api/tickets')
      .send({ title: 'Paused from running', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${pausedTicket.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${pausedTicket.body.id}/transition`)
      .send({ action: 'pause', actor: 'beavy', pause_reason: '等待窗口' })
      .expect(200);

    const runningTicket = await request(app)
      .post('/api/tickets')
      .send({ title: 'Occupied running', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${runningTicket.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    const res = await request(app)
      .post(`/api/tickets/${pausedTicket.body.id}/transition`)
      .send({ action: 'resume', actor: 'beavy' })
      .expect(409);

    expect(res.body.error).toBe('RUNNING_TICKET_CONFLICT');
    expect(res.body.attempted_action).toBe('resume');
    expect(res.body.conflict_ticket).toEqual(expect.objectContaining({ id: runningTicket.body.id }));

    const pausedDetail = await request(app).get(`/api/tickets/${pausedTicket.body.id}`).expect(200);
    expect(pausedDetail.body.status).toBe('paused');
    expect(pausedDetail.body.locked_by).toBeNull();
  });

  it('非法 action 返回 400', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Invalid status test', description: 'Desc' })
      .expect(201);
    const ticketId = createRes.body.id;

    const res = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'invalid_action', actor: 'beavy' })
      .expect(400);

    expect(res.body.error).toContain('Invalid action');
    expect(res.body.allowed_actions).toContain('start_work');
  });

  it('可更新分诊结构化字段并输出责任路由', async () => {
    const parentRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Parent ticket', description: 'Root' })
      .expect(201);

    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Patch triage', description: 'Desc', triage_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { status: 'review' });

    const res = await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({
        triage_owner: 'leoss',
        assigned_agent: 'beavy',
        next_actor: 'auditor',
        platform: 'ticket-platform',
        request_type: 'feature',
        triage_summary: '先完成结构化闭环',
        implementation_scope: '前后端详情页与接口',
        constraints: '不引入自动化规则引擎',
        deliverables: '字段、编辑区、接口',
        acceptance_criteria: '可保存并供 beavy 理解',
        parent_ticket_id: parentRes.body.id,
      })
      .expect(200);

    expect(res.body.status).toBe('review');
    expect(res.body.triage_owner).toBe('leoss');
    expect(res.body.assigned_agent).toBe('beavy');
    expect(res.body.next_actor).toBe('auditor');
    expect(res.body.next_actor_source).toBe('next_actor');
    expect(res.body.platform).toBe('ticket-platform');
    expect(res.body.request_type).toBe('feature');
    expect(res.body.parent_ticket_id).toBe(parentRes.body.id);
  });

  it('ticket-platform 工单 patch 不允许改成非 beavy 执行人', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Ticket platform patch guard', description: 'Desc', platform: 'ticket-platform' })
      .expect(201);
    const ticketId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ assigned_agent: 'donky' })
      .expect(400);

    expect(res.body.error).toBe('TICKET_PLATFORM_ASSIGNED_AGENT_INVALID');
    expect(res.body.allowed_assigned_agents).toEqual(['beavy']);
  });

  it('非法 request_type 返回 400', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Invalid request type', description: 'Desc' })
      .expect(201);
    const ticketId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ request_type: 'oops' })
      .expect(400);

    expect(res.body.message).toContain('request_type 非法');
  });

  it('父工单不能指向自身', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Self parent', description: 'Desc' })
      .expect(201);
    const ticketId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ parent_ticket_id: ticketId })
      .expect(400);

    expect(res.body.message).toContain('不能指向自身');
  });

  it('工单不存在时返回 404', async () => {
    await request(app)
      .patch('/api/tickets/99999')
      .send({ status: 'running' })
      .expect(404);
  });
});

describe('POST /api/tickets/:id/dispatch', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('dispatch 仅更新 assigned_agent 和 status 为 queued', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Dispatch success', description: 'Test' })
      .expect(201);
    const ticketId = createRes.body.id;

    const dispatchRes = await request(app)
      .post(`/api/tickets/${ticketId}/dispatch`)
      .send({ agent: 'donky' })
      .expect(200);

    expect(dispatchRes.body.status).toBe('queued');
    expect(dispatchRes.body.assigned_agent).toBe('donky');
    expect(dispatchRes.body.next_actor).toBe('donky');
    expect(dispatchRes.body.next_actor_source).toBe('assigned_agent');
  });

  it('dispatch 可指定其他 agent', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Test', description: 'Desc' })
      .expect(201);
    const ticketId = createRes.body.id;

    const dispatchRes = await request(app)
      .post(`/api/tickets/${ticketId}/dispatch`)
      .send({ agent: 'custom-agent' })
      .expect(200);

    expect(dispatchRes.body.assigned_agent).toBe('custom-agent');
    expect(dispatchRes.body.status).toBe('queued');
  });

  it('ticket-platform 工单 dispatch 不允许改派给非 beavy', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Ticket platform dispatch guard', description: 'Desc', platform: 'ticket-platform' })
      .expect(201);
    const ticketId = createRes.body.id;

    const dispatchRes = await request(app)
      .post(`/api/tickets/${ticketId}/dispatch`)
      .send({ agent: 'donky' })
      .expect(400);

    expect(dispatchRes.body.error).toBe('TICKET_PLATFORM_ASSIGNED_AGENT_INVALID');
    expect(dispatchRes.body.allowed_assigned_agents).toEqual(['beavy']);
  });

  it('工单不存在时返回 404', async () => {
    await request(app)
      .post('/api/tickets/99999/dispatch')
      .send({ agent: 'donky' })
      .expect(404);
  });
});

describe('comments v2', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('可创建带 type/visibility/thread_id/mentions 的评论', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Comment v2', description: 'Desc' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ watchers: ['leader'] })
      .expect(200);

    const res = await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({
        author: 'donky',
        content: '卡住了 @ops，需要确认',
        type: 'blocker',
        visibility: 'internal',
        thread_id: 'th-1',
        mentions: ['qa'],
      })
      .expect(201);

    expect(res.body.type).toBe('blocker');
    expect(res.body.visibility).toBe('internal');
    expect(res.body.thread_id).toBe('th-1');
    expect(res.body.mentions).toEqual(expect.arrayContaining(['qa', 'ops']));
    expect(res.body.notify_targets).toEqual(expect.arrayContaining(['qa', 'ops', 'leader']));
  });

  it('缺省或占位 author 会按 current_actor / override 自动注入', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Comment identity fallback',
        description: 'Desc',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        next_actor: 'auditor',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { status: 'done' });

    const res = await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({
        author: 'Current User',
        content: '请 auditor 收口',
        type: 'progress',
      })
      .expect(201);

    expect(res.body.author).toBe('auditor');

    const detail = await request(app).get(`/api/tickets/${ticketId}`).expect(200);
    expect(detail.body.current_actor).toBe('auditor');
    expect(detail.body.current_actor_source).toBe('next_actor');
    expect(detail.body.next_actor_override).toBe('auditor');
    expect(detail.body.manual_override_active).toBe(true);
    expect(detail.body.comments).toEqual(expect.arrayContaining([
      expect.objectContaining({ author: 'auditor', content: '请 auditor 收口' }),
    ]));
  });

  it('支持按条件筛选评论', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Comment filter', description: 'Desc' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app).post(`/api/tickets/${ticketId}/comments`).send({
      author: 'a', content: '进展1', type: 'progress', visibility: 'internal',
    }).expect(201);
    await request(app).post(`/api/tickets/${ticketId}/comments`).send({
      author: 'b', content: '结论', type: 'result', visibility: 'public',
    }).expect(201);

    const filtered = await request(app)
      .get(`/api/tickets/${ticketId}/comments?type=result&visibility=public`)
      .expect(200);

    expect(filtered.body.total).toBe(1);
    expect(filtered.body.comments[0].type).toBe('result');
    expect(filtered.body.comments[0].visibility).toBe('public');
  });

  it('type 非法返回 400', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Comment bad type', description: 'Desc' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({ content: 'x', type: 'oops' })
      .expect(400);
  });

  it('评论内容过长返回 400', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Comment too long', description: 'Desc' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({ content: 'x'.repeat(10001), type: 'progress' })
      .expect(400);
  });

  it('thread_id 过长返回 400', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Comment thread', description: 'Desc' })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({ content: 'x', type: 'progress', thread_id: 't'.repeat(300) })
      .expect(400);
  });
});

describe('GET /api/dispatch/ready', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('正常 running 工单派给 next_actor（assigned_agent）', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Normal running',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${createRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${createRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'donky' })
      .expect(200);
    expect((await request(app).get(`/api/tickets/${createRes.body.id}`)).body.status).toBe('running');

    const res = await request(app).get('/api/dispatch/ready').expect(200);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.request_id).toBe(res.headers['x-request-id']);
    expect(res.body.ready).toBeDefined();
    expect(res.body.ready.length).toBeGreaterThanOrEqual(1);
    const item = res.body.ready.find((r) => r.ticket_id === createRes.body.id);
    expect(item).toBeDefined();
    expect(item.agent).toBe('donky');
    expect(item.dispatch_event_id).toBe(item.dispatch_id);
    expect(item.kind).toBeUndefined(); // 正常单无 kind
    expect(item.target_gateway_id).toBe('pc-stock');
    expect(item.transport).toBe('ssh_gateway_call');
    expect(item.target_session_key).toBe(`agent:donky:ticket:${createRes.body.id}`);
    expect(item.reset_session).toBe(true);
    expect(item.session_reset_reason).toBe('assignment_refresh');
    expect(item.reason).toBe('running');
    expect(item.dedupe_key).toBe(`dispatch:running:assignment:donky`);
    expect(item.escalation_tier).toBe('delivery');
  });

  it('running + decision 评论 => workflow_mismatch 告警若命中人类主体，改走主会话而不是 agent ticket session', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Mismatch decision',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        decision_owner: 'example-human-operator',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'donky' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({
        author: 'donky',
        content: '需要老大拍板，是否继续推进',
        type: 'decision',
      })
      .expect(201);

    const res = await request(app).get('/api/dispatch/ready').expect(200);
    const item = res.body.ready.find((r) => r.ticket_id === ticketId);
    expect(item).toBeDefined();
    expect(item.kind).toBe('workflow_mismatch');
    expect(item.agent).toBe('example-human-operator');
    expect(item.workflow_mismatch).toBeDefined();
    expect(item.workflow_mismatch.category).toBe('decision_required');
    expect(item.workflow_mismatch.recommended_status).toBe('pending_decision');
    expect(item.workflow_mismatch.reason).toBeDefined();
    expect(item.target_gateway_id).toBe('mac-main');
    expect(item.transport).toBe('local_cli');
    expect(item.target_session_key).toBe(`agent:main:ticket:${ticketId}`);
    expect(item.reset_session).toBeUndefined();
    expect(item.reason).toBe('decision_required');
    expect(item.dedupe_key).toBe(`dispatch:running:workflow_mismatch:example-human-operator:decision_required`);
    expect(item.escalation_tier).toBe('warning');
    expect(item.message).toContain('workflow_mismatch');
    expect(item.message).toContain(item.workflow_mismatch.reason);
  });

  it('running + 已拍板继续推进的澄清评论，不应再进入 workflow_mismatch dispatch', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Resolved decision should keep running',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        decision_owner: 'example-human-operator',
        assigned_agent: 'cowder',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'cowder' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({
        author: 'cowder',
        content: '需要老大拍板，是否继续推进',
        type: 'decision',
      })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({
        author: 'leoss',
        content: '当前阶段核实：本票已由老大明确拍板；上一条 decision 评论用于记录授权结论，不代表工单仍处于待决策。现阶段应保持 running，并继续推进实现。',
        type: 'progress',
      })
      .expect(201);

    const res = await request(app).get('/api/dispatch/ready').expect(200);
    const item = res.body.ready.find((r) => r.ticket_id === ticketId);
    expect(item).toBeDefined();
    expect(item.kind).toBeUndefined();
    expect(item.agent).toBe('cowder');
    expect(item.reason).toBe('running');
  });

  it('complete 工单不会进入 legacy dispatch ready，且不会再打印 ready candidate/checking 残影', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Complete legacy residual',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    updateTicket(ticketId, { status: 'complete' });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const legacyRes = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    expect(legacyRes.body.ready.find((r) => r.ticket_id === ticketId)).toBeUndefined();
    const logs = spy.mock.calls.flat().join('\\n');
    expect(logs).not.toContain(`[dispatch/ready] Checking #${ticketId}`);
    expect(logs).not.toContain(`ticket=${ticketId}`);

    spy.mockRestore();
  });

  it('pending_decision 不进入 dispatch ready，只进入 notifications ready', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Decision only notify',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        decision_owner: 'example-human-operator',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'request_decision',
        actor: 'beavy',
        decision_summary: '需要老大拍板',
      })
      .expect(200);

    const dispatchRes = await request(app).get('/api/dispatch/ready').expect(200);
    expect(dispatchRes.body.ready.find((r) => r.ticket_id === ticketId)).toBeUndefined();

    const notifyRes = await request(app).get('/api/notifications/ready').expect(200);
    const notifyItem = notifyRes.body.ready.find((r) => r.ticket_id === ticketId);
    expect(notifyItem).toBeDefined();
    expect(notifyItem.type).toBe('pending_decision');
    expect(notifyItem.status).toBe('pending_decision');
    expect(notifyItem.target_session_key).toBe(getNotifyMainSessionKey());
    expect(notifyItem.target_gateway_id).toBe('mac-main');
    expect(notifyItem.transport).toBe('local_cli');
    expect(notifyItem.reason).toBe('decision_required');
    expect(notifyItem.dedupe_key).toBe('notify:pending_decision:decision_required:example-human-operator');
    expect(notifyItem.escalation_tier).toBe('decision');
  });

  it('同一 agent 已有 running 工单时，其他 queued 工单不会继续进入 dispatch ready', async () => {
    const runningRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Already running',
        description: 'Desc',
        status: 'queued',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${runningRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    const queuedRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Should stay queued',
        description: 'Desc',
        status: 'queued',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);

    const res = await request(app).get('/api/dispatch/ready').expect(200);
    expect(res.body.ready.find((r) => r.ticket_id === queuedRes.body.id)).toBeUndefined();
    expect(res.body.ready.find((r) => r.ticket_id === runningRes.body.id)).toBeDefined();
  });

  it('blocked 不进入 dispatch ready，只进入 notifications ready 并通知主会话', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Blocked only notify',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        decision_owner: 'example-human-operator',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'block',
        actor: 'beavy',
        blocker_summary: '需要老大协调外部依赖',
      })
      .expect(200);

    const dispatchRes = await request(app).get('/api/dispatch/ready').expect(200);
    expect(dispatchRes.body.ready.find((r) => r.ticket_id === ticketId)).toBeUndefined();

    const notifyRes = await request(app).get('/api/notifications/ready').expect(200);
    const notifyItem = notifyRes.body.ready.find((r) => r.ticket_id === ticketId);
    expect(notifyItem).toBeDefined();
    expect(notifyItem.request_id).toEqual(expect.any(String));
    expect(notifyItem.type).toBe('blocked');
    expect(notifyItem.status).toBe('blocked');
    expect(notifyItem.status_before).toBe('blocked');
    expect(notifyItem.status_after).toBe('blocked');
    expect(notifyItem.target_session).toBe(getNotifyMainSessionKey());
    expect(notifyItem.target_actor_session).toBe(getNotifyMainSessionKey());
    expect(notifyItem.target_session_key).toBe(getNotifyMainSessionKey());
    expect(notifyItem.target_gateway_id).toBe(MAIN_GATEWAY_ID);
    expect(notifyItem.transport).toBe('local_cli');
    expect(notifyItem.reason).toBe('blocked_attention_required');
    expect(notifyItem.dedupe_key).toBe('notify:blocked:blocked_attention_required:example-human-operator');
    expect(notifyItem.escalation_tier).toBe('decision');
  });

  it('failed 不进入 dispatch ready，只进入 notifications ready', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Failed only notify',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'fail',
        actor: 'beavy',
        error: '执行失败',
      })
      .expect(200);

    const dispatchRes = await request(app).get('/api/dispatch/ready').expect(200);
    expect(dispatchRes.body.ready.find((r) => r.ticket_id === ticketId)).toBeUndefined();

    const notifyRes = await request(app).get('/api/notifications/ready').expect(200);
    const notifyItem = notifyRes.body.ready.find((r) => r.ticket_id === ticketId);
    expect(notifyItem).toBeDefined();
    expect(notifyItem.type).toBe('failed');
    expect(notifyItem.status).toBe('failed');
    expect(notifyItem.target_session_key).toBe(getNotifyMainSessionKey());
    expect(notifyItem.target_gateway_id).toBe(MAIN_GATEWAY_ID);
    expect(notifyItem.transport).toBe('local_cli');
    expect(notifyItem.reason).toBe('execution_failed');
    expect(notifyItem.dedupe_key).toBe('notify:failed:execution_failed:荣晖');
    expect(notifyItem.escalation_tier).toBe('result');
  });

  it('complete 通知命中人类主体时仍强制投递到主会话，而不是 participant main session', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Complete notify main session',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'submit_for_review',
        actor: 'beavy',
        result_summary: '实现完成',
      })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'approve', actor: 'leoss' })
      .expect(200);

    const dispatchRes = await request(app).get('/api/dispatch/ready').expect(200);
    expect(dispatchRes.body.ready.find((r) => r.ticket_id === ticketId)).toBeUndefined();

    const notifyRes = await request(app).get('/api/notifications/ready').expect(200);
    const notifyItem = notifyRes.body.ready.find((r) => r.ticket_id === ticketId);
    expect(notifyItem).toBeDefined();
    expect(notifyItem.type).toBe('complete');
    expect(notifyItem.status).toBe('complete');
    expect(notifyItem.target_session).toBe(getNotifyMainSessionKey());
    expect(notifyItem.target_actor_session).toBe(getNotifyMainSessionKey());
    expect(notifyItem.target_session_key).toBe(getNotifyMainSessionKey());
    expect(notifyItem.target_gateway_id).toBe(MAIN_GATEWAY_ID);
    expect(notifyItem.transport).toBe('local_cli');
    expect(notifyItem.reason).toContain('complete');
    expect(notifyItem.dedupe_key).toContain('notify:complete:');
    expect(notifyItem.escalation_tier).toBe('result');
  });

  it('stock-platform complete 通知即使 decision_owner 指向 cowder，也应固定走主会话主网关', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Stock complete notify target',
        description: 'Desc',
        triage_owner: 'cowder',
        review_owner: 'xiaoying',
        assigned_agent: 'donky',
        platform: 'stock-platform',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'cowder' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'donky' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'submit_for_review',
        actor: 'donky',
        result_summary: '实现完成',
      })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'approve', actor: 'xiaoying' })
      .expect(200);

    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { decision_owner: 'cowder' });

    const notifyRes = await request(app).get('/api/notifications/ready').expect(200);
    const notifyItem = notifyRes.body.ready.find((r) => r.ticket_id === ticketId);
    expect(notifyItem).toBeDefined();
    expect(notifyItem.type).toBe('complete');
    expect(notifyItem.target_session).toBe(getNotifyMainSessionKey());
    expect(notifyItem.target_actor_session).toBe(getNotifyMainSessionKey());
    expect(notifyItem.target_session_key).toBe(getNotifyMainSessionKey());
    expect(notifyItem.target_gateway_id).toBe(MAIN_GATEWAY_ID);
    expect(notifyItem.transport).toBe('local_cli');
  });

  it('done/review 不再进入 notifications ready，reviewer 主交接统一走 dispatch ready', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Review notify target',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'beavy',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'donky' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'submit_for_review',
        actor: 'donky',
        result_summary: 'ready for beavy review',
      })
      .expect(200);

    const dispatchRes = await request(app).get('/api/dispatch/ready').expect(200);
    const dispatchItem = dispatchRes.body.ready.find((r) => r.ticket_id === ticketId);
    expect(dispatchItem).toBeDefined();
    expect(dispatchItem.agent).toBe('beavy');
    expect(dispatchItem.target_session_key).toBe(`agent:beavy:ticket:${ticketId}`);
    expect(dispatchItem.target_session_key).not.toBe(getNotifyMainSessionKey());
    expect(dispatchItem.target_gateway_id).toBe(MAIN_GATEWAY_ID);
    expect(dispatchItem.transport).toBe('local_cli');

    const notifyRes = await request(app).get('/api/notifications/ready').expect(200);
    const notifyItem = notifyRes.body.ready.find((r) => r.ticket_id === ticketId);
    expect(notifyItem).toBeUndefined();
  });

  it('补充验证单在主单 complete 后不再进入 reviewer dispatch / standalone notification', async () => {
    const primary = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Primary complete',
        description: 'main ticket',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    {
      const { updateTicket } = await import('./store.js');
      updateTicket(primary.body.id, { status: 'complete' });
    }

    const supplemental = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Smoke evidence',
        description: 'supplemental smoke ticket',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    {
      const { updateTicket } = await import('./store.js');
      updateTicket(supplemental.body.id, { status: 'queued' });
    }

    await request(app)
      .post(`/api/tickets/${supplemental.body.id}/relations`)
      .send({ related_ticket_id: primary.body.id, relation_type: 'smoke_of' })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${supplemental.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${supplemental.body.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'smoke done' })
      .expect(200);

    const dispatchRes = await request(app).get('/api/dispatch/ready').expect(200);
    expect(dispatchRes.body.ready.find((r) => r.ticket_id === supplemental.body.id)).toBeUndefined();

    const notifyRes = await request(app).get('/api/notifications/ready').expect(200);
    expect(notifyRes.body.ready.find((r) => r.ticket_id === supplemental.body.id)).toBeUndefined();

    const detailRes = await request(app).get(`/api/tickets/${primary.body.id}`).expect(200);
    expect(detailRes.body.supplemental_tickets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relation_type: 'smoke_of',
        ticket: expect.objectContaining({ id: supplemental.body.id, status: 'done' }),
      }),
    ]));
  });

  it('agent topology endpoint 返回当前 agent -> gateway 映射', async () => {
    const res = await request(app)
      .get('/api/agent-topology')
      .expect(200);

    expect(res.body.data.main_gateway_id).toBe('mac-main');
    expect(res.body.data.agent_gateway_map.donky).toBe('pc-stock');
    expect(res.body.data.agent_gateway_map.beavy).toBe('mac-main');
    expect(res.body.data.gateways['pc-stock']).toEqual(expect.objectContaining({
      id: 'pc-stock',
      transport: 'ssh_gateway_call',
    }));
    expect(res.body.data.platforms['ticket-platform']).toEqual(expect.objectContaining({
      owner_agent_id: 'leoss',
      development_agent_ids: expect.arrayContaining(['beavy']),
      review_owner_agent_id: 'leoss',
    }));
    expect(res.body.data.agent_directory.leoss).toEqual(expect.objectContaining({
      primary_platform: 'ticket-platform',
      gateway_id: 'mac-main',
    }));
    expect(res.body.data.responsibility_layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'platform_owner' }),
      expect.objectContaining({ key: 'development' }),
      expect.objectContaining({ key: 'review' }),
    ]));
  });
});

describe('execution contract / workers / dispatch suppress', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('workflow schema 显式返回 execution contract', async () => {
    const res = await request(app)
      .get('/api/workflow/schema')
      .expect(200);

    expect(res.body.data.execution).toBeDefined();
    expect(res.body.data.execution.modes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'direct' }),
      expect.objectContaining({ key: 'subagent' }),
      expect.objectContaining({ key: 'acp' }),
    ]));
    expect(res.body.data.execution.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'coding_or_browser_long_task', mode: 'subagent' }),
    ]));
  });

  it('GET /api/playbooks/:stage 返回按 stage/mode/role 聚合的结构化 checklist', async () => {
    const res = await request(app)
      .get('/api/playbooks/queued?mode=subagent&role=executor')
      .expect(200);

    expect(res.body.data).toEqual(expect.objectContaining({
      stage: 'queued',
      mode: 'subagent',
      role: 'executor',
    }));
    expect(res.body.data.goal).toContain('queued');
    expect(res.body.data.next_stage_options).toEqual(expect.arrayContaining(['running', 'done']));
    expect(res.body.data.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('dispatch_receipt') }),
      expect.objectContaining({ text: expect.stringContaining('真实 worker') }),
    ]));
    expect(res.body.data.evidence_requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('worker') }),
    ]));
    expect(res.body.data.source).toEqual(expect.objectContaining({
      hosted_bundle_version: AGENT_PLAYBOOK_VERSION,
    }));
  });

  it('GET /api/playbooks/:stage 对未知 stage 返回 404', async () => {
    const res = await request(app)
      .get('/api/playbooks/not-a-stage')
      .expect(404);

    expect(res.body.error).toBe('Playbook stage not found');
    expect(res.body.message).toContain('不存在');
  });

  it('subagent 模式在无 worker 迹象时不能直接 start_work 进入 running', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: '实现执行模式平台化',
        description: '需要做后端代码开发',
        status: 'queued',
        implementation_scope: '后端代码开发与测试回归',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);

    expect(createRes.body.execution_mode).toBe('subagent');

    const startRes = await request(app)
      .post(`/api/tickets/${createRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(409);

    expect(startRes.body).toEqual(expect.objectContaining({
      error: 'EXECUTION_WORKER_REQUIRED',
      execution_mode: 'subagent',
      expected_worker_type: 'subagent',
      requires_worker: true,
      worker_evidence: expect.objectContaining({
        has_worker_evidence: false,
        total_workers: 0,
        current_workers: 0,
      }),
    }));

    const detailRes = await request(app)
      .get(`/api/tickets/${createRes.body.id}`)
      .expect(200);
    expect(detailRes.body.status).toBe('queued');
    expect(detailRes.body.execution_guard).toEqual(expect.objectContaining({
      requires_worker: true,
      has_worker_evidence: false,
      total_workers: 0,
      current_workers: 0,
    }));
  });

  it('代码类工单登记 active subagent worker 后自动进入 running，活跃期间不再进入 dispatch ready', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: '实现执行模式平台化',
        description: '需要做后端代码开发',
        status: 'queued',
        implementation_scope: '后端代码开发与测试回归',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);

    const ticketId = createRes.body.id;
    expect(createRes.body.execution_mode).toBe('subagent');
    expect(createRes.body.max_active_workers).toBe(1);

    const workerRes = await request(app)
      .post(`/api/tickets/${ticketId}/workers`)
      .send({
        worker_key: 'sub-1',
        worker_type: 'subagent',
        status: 'running',
        session_key: 'agent:beavy:ticket:47',
        run_id: 'sub-run-1',
      })
      .expect(201);

    expect(workerRes.body.worker.worker_key).toBe('sub-1');
    expect(workerRes.body.ticket.status).toBe('queued');
    expect(workerRes.body.ticket.execution_guard).toEqual(expect.objectContaining({
      suppress_dispatch: true,
      requires_worker: true,
      has_worker_evidence: true,
      active_workers: 1,
      total_workers: 1,
      current_workers: 1,
    }));

    const listRes = await request(app)
      .get(`/api/tickets/${ticketId}/workers`)
      .expect(200);
    expect(listRes.body.worker_stats.active_workers).toBe(1);
    expect(listRes.body.workers).toHaveLength(1);

    const detailRes = await request(app)
      .get(`/api/tickets/${ticketId}`)
      .expect(200);
    expect(detailRes.body.status).toBe('queued');
    expect(detailRes.body.current_workers).toHaveLength(1);
    expect(detailRes.body.execution_workers).toEqual(expect.arrayContaining([
      expect.objectContaining({ worker_key: 'sub-1', run_id: 'sub-run-1', session_key: 'agent:beavy:ticket:47' }),
    ]));

    const dispatchRes = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    expect(dispatchRes.body.ready.find((r) => r.ticket_id === ticketId)).toBeUndefined();

    await request(app)
      .patch(`/api/tickets/${ticketId}/workers/sub-1`)
      .send({ status: 'succeeded', finished_at: '2026-03-10T01:00:00.000Z' })
      .expect(200);

    const dispatchResAfterFinish = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const readyItem = dispatchResAfterFinish.body.ready.find((r) => r.ticket_id === ticketId);
    expect(readyItem).toBeDefined();
    expect(readyItem.agent).toBe('beavy');
  });

  it('direct 模式拒绝 worker 登记并返回硬约束错误', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: '修正文案',
        description: '只改一个按钮文字',
        execution_mode: 'direct',
        triage_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);

    const ticketId = createRes.body.id;
    expect(createRes.body.execution_mode).toBe('direct');
    expect(createRes.body.max_active_workers).toBe(0);

    const res = await request(app)
      .post(`/api/tickets/${ticketId}/workers`)
      .send({
        worker_key: 'direct-1',
        worker_type: 'subagent',
        status: 'starting',
      })
      .expect(409);

    expect(res.body.error).toBe('INVALID_WORKER_TYPE');
    expect(res.body.message).toContain('不允许登记 worker');
  });

  it('subagent 模式超过 max_active_workers 时返回 409', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: '重构队列治理',
        description: '需要代码开发',
        execution_mode: 'subagent',
        max_active_workers: 1,
        triage_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);

    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/workers`)
      .send({
        worker_key: 'sub-1',
        worker_type: 'subagent',
        status: 'running',
      })
      .expect(201);

    const res = await request(app)
      .post(`/api/tickets/${ticketId}/workers`)
      .send({
        worker_key: 'sub-2',
        worker_type: 'subagent',
        status: 'running',
      })
      .expect(409);

    expect(res.body.error).toBe('MAX_ACTIVE_WORKERS_EXCEEDED');
    expect(res.body.max_active_workers).toBe(1);
    expect(res.body.active_workers).toBe(1);
  });
});

describe('ack 兼容路由', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('POST /api/notifications/ack 支持 body.event_id 并可完成去重', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'notify ack compat',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${createRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${createRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${createRes.body.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'done' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${createRes.body.id}/transition`)
      .send({ action: 'approve', actor: 'leoss' })
      .expect(200);

    const readyRes = await request(app).get('/api/notifications/ready').expect(200);
    expect(readyRes.headers['x-request-id']).toBeTruthy();
    expect(readyRes.body.request_id).toBe(readyRes.headers['x-request-id']);
    const event = readyRes.body.ready.find((x) => x.ticket_id === createRes.body.id);
    expect(event).toBeDefined();
    expect(event.notification_event_id).toBe(event.event_id);

    await request(app)
      .post('/api/notifications/ack')
      .send({ event_id: event.event_id })
      .expect(200);

    const readyAfterAck = await request(app).get('/api/notifications/ready').expect(200);
    const sameTicket = readyAfterAck.body.ready.find((x) => x.ticket_id === createRes.body.id);
    expect(sameTicket).toBeUndefined();
  });

  it('POST /api/notifications/ack 缺少 event_id 返回 400', async () => {
    const res = await request(app)
      .post('/api/notifications/ack')
      .send({})
      .expect(400);
    expect(res.body.message).toContain('event_id');
  });
});

describe('notifications 去重闭环', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('同一状态版本 ack 后不重复；状态切换后可再次通知', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'notify dedupe lifecycle',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);

    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'done' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'approve', actor: 'leoss' })
      .expect(200);

    const readyRes1 = await request(app).get('/api/notifications/ready').expect(200);
    const first = readyRes1.body.ready.find((x) => x.ticket_id === ticketId);
    expect(first).toBeDefined();

    await request(app)
      .post(`/api/notifications/${first.event_id}/ack`)
      .expect(200);

    // 同状态下，ack 后不应重复出现
    const readyRes2 = await request(app).get('/api/notifications/ready').expect(200);
    const repeated = readyRes2.body.ready.find((x) => x.ticket_id === ticketId);
    expect(repeated).toBeUndefined();

    // 非状态字段更新也不应触发重复通知
    await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ description: 'updated without status change' })
      .expect(200);
    const readyRes3 = await request(app).get('/api/notifications/ready').expect(200);
    const repeatedAfterNonStatusUpdate = readyRes3.body.ready.find((x) => x.ticket_id === ticketId);
    expect(repeatedAfterNonStatusUpdate).toBeUndefined();

    // 状态切换后，再次进入 blocked 时应允许重新通知
    const createRes2 = await request(app)
      .post('/api/tickets')
      .send({
        title: 'notify dedupe lifecycle second round',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);

    const ticketId2 = createRes2.body.id;
    await request(app)
      .post(`/api/tickets/${ticketId2}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId2}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId2}/transition`)
      .send({ action: 'block', actor: 'beavy', blocker_summary: 'blocked again' })
      .expect(200);

    const readyRes4 = await request(app).get('/api/notifications/ready').expect(200);
    const second = readyRes4.body.ready.find((x) => x.ticket_id === ticketId2);
    expect(second).toBeDefined();
    expect(second.event_id).not.toBe(first.event_id);
  });

  it('done/review 不再生成 notification 去重事件，review_owner 变化由 dispatch 侧重新派单处理', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'notify dedupe by stage reason actor',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);

    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'done' })
      .expect(200);

    const readyRes1 = await request(app).get('/api/notifications/ready').expect(200);
    expect(readyRes1.body.ready.find((x) => x.ticket_id === ticketId)).toBeUndefined();

    await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ review_owner: 'example-human-operator' })
      .expect(200);

    const readyRes2 = await request(app).get('/api/notifications/ready').expect(200);
    expect(readyRes2.body.ready.find((x) => x.ticket_id === ticketId)).toBeUndefined();

    const dispatchRes = await request(app).get('/api/dispatch/ready').expect(200);
    const dispatchItem = dispatchRes.body.ready.find((x) => x.ticket_id === ticketId);
    expect(dispatchItem).toBeDefined();
    expect(dispatchItem.agent).toBe('example-human-operator');
    expect(dispatchItem.target_session_key).toBe(`agent:main:ticket:${ticketId}`);
    expect(dispatchItem.dedupe_key).toBe('dispatch:done:assignment:example-human-operator');
  });
});

describe('workflow_mismatch 字段输出', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('GET /api/tickets 列表含 workflow_mismatch 字段', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'List mismatch',
        description: 'Desc',
        status: 'queued',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'start_work',
        actor: 'donky'
      })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({ author: 'a', content: '需要老大决策', type: 'decision' })
      .expect(201);

    const res = await request(app).get('/api/tickets').expect(200);
    const t = res.body.find((x) => x.id === ticketId);
    expect(t).toBeDefined();
    expect(t.workflow_mismatch).toBeDefined();
    expect(t.workflow_mismatch.category).toBe('decision_required');
    expect(t.workflow_mismatch.reason).toBeDefined();
  });

  it('GET /api/tickets/:id 详情含 workflow_mismatch 字段', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Detail mismatch',
        description: 'Desc',
        status: 'queued',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'start_work',
        actor: 'donky'
      });
    await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({ author: 'a', content: 'token 不足，上下文不够', type: 'blocker' })
      .expect(201);

    const res = await request(app).get(`/api/tickets/${ticketId}`).expect(200);
    expect(res.body.workflow_mismatch).toBeDefined();
    expect(res.body.workflow_mismatch.category).toBe('context_gap');
    expect(res.body.workflow_mismatch.recommended_status).toBe('review');
    expect(res.body.workflow_mismatch.reason).toBeDefined();
  });

  it('GET /api/tickets/:id 详情含 paused_tail_classification 字段', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Historical paused detail',
        description: 'Desc',
        platform: 'ticket-platform',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'pause', actor: 'beavy', pause_reason: 'debug cleanup 脏票，无真实 blocker' })
      .expect(200);

    const res = await request(app).get(`/api/tickets/${ticketId}`).expect(200);
    expect(res.body.paused_tail_classification).toBeDefined();
    expect(res.body.paused_tail_classification).toEqual(expect.objectContaining({
      category: 'cleanup_candidate',
      recommendation: 'deprecate_when_triage_confirms',
    }));
  });

  it('GET /api/tickets/:id 返回 control_read_model（responsibility_view / ticket_operational_view / execution_guard_view）', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Control read model ticket',
        description: 'Desc',
        status: 'triage',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    const res = await request(app).get(`/api/tickets/${ticketId}`).expect(200);
    expect(res.body.control_read_model).toBeDefined();
    expect(res.body.control_read_model.responsibility_view).toBeDefined();
    expect(res.body.control_read_model.ticket_operational_view).toBeDefined();
    expect(res.body.control_read_model.execution_guard_view).toBeDefined();

    const rv = res.body.control_read_model.responsibility_view;
    expect(rv.chain).toBeDefined();
    expect(Array.isArray(rv.chain)).toBe(true);
    expect(rv.current_actor).toBeDefined();
    expect(rv.summary).toBeDefined();
    expect(rv).toHaveProperty('next_actor');
    expect(rv).toHaveProperty('next_actor_source');
    expect(rv).toHaveProperty('next_actor_override');
    expect(rv).toHaveProperty('manual_override_active');
    expect(rv).toHaveProperty('explanation');
    expect(typeof rv.manual_override_active).toBe('boolean');

    const ov = res.body.control_read_model.ticket_operational_view;
    expect(ov.ticket_id).toBe(ticketId);
    expect(ov.status).toBe('triage');
    expect(ov.bucket).toBe('active');
    expect(ov.current_actor).toBeDefined();

    const gv = res.body.control_read_model.execution_guard_view;
    expect(typeof gv.requires_worker).toBe('boolean');
    expect(typeof gv.has_worker_evidence).toBe('boolean');
    expect(Array.isArray(gv.available_actions)).toBe(true);
  });

  it('GET /api/control/tickets/:id/operational-view 返回同一套三视图', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Control operational view',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    const res = await request(app).get(`/api/control/tickets/${ticketId}/operational-view`).expect(200);
    expect(res.body.ticket_id).toBe(ticketId);
    expect(res.body.responsibility_view).toBeDefined();
    expect(res.body.ticket_operational_view).toBeDefined();
    expect(res.body.execution_guard_view).toBeDefined();
    expect(res.body.ticket_operational_view.status).toBe('queued');
    expect(res.body.execution_guard_view.available_actions).toEqual(expect.arrayContaining(['start_work', 'pause']));
    expect(res.body.responsibility_view.next_actor_override).toBeNull();
    expect(res.body.responsibility_view.manual_override_active).toBe(false);
  });

  it('control read model：operational-view 的 responsibility_view 含 next_actor_override 与 manual_override_active', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Override responsibility view',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    await request(app).post(`/api/tickets/${ticketId}/transition`).send({ action: 'queue', actor: 'leoss' }).expect(200);
    await request(app).post(`/api/tickets/${ticketId}/transition`).send({ action: 'start_work', actor: 'beavy' }).expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'Done' })
      .expect(200);
    await request(app).patch(`/api/tickets/${ticketId}`).send({ next_actor: 'auditor' }).expect(200);
    const res = await request(app).get(`/api/control/tickets/${ticketId}/operational-view`).expect(200);
    expect(res.body.responsibility_view.current_actor).toBe('auditor');
    expect(res.body.responsibility_view.current_actor_source).toBe('next_actor');
    expect(res.body.responsibility_view.next_actor).toBe('auditor');
    expect(res.body.responsibility_view.next_actor_source).toBe('next_actor');
    expect(res.body.responsibility_view.next_actor_override).toBe('auditor');
    expect(res.body.responsibility_view.manual_override_active).toBe(true);
    expect(res.body.responsibility_view.explanation).toEqual(expect.objectContaining({
      current_actor: 'auditor',
      next_actor: 'auditor',
      next_actor_source: 'next_actor',
      manual_override_active: true,
      resolution: expect.objectContaining({
        actor: 'auditor',
        source: 'next_actor',
        mode: 'manual_override',
      }),
      override_governance: expect.objectContaining({
        allowed_in_status: true,
        active: true,
        effective: true,
        residual: false,
      }),
    }));
  });

  it('control read model：暴露 override 残留治理解释与 workflow_mismatch 结构化信息', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Residual override mismatch view',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, {
      status: 'running',
      next_actor_override: 'auditor',
    });
    await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({
        author: 'beavy',
        content: '上下文不足，需要更多信息',
        type: 'blocker',
      })
      .expect(201);

    const res = await request(app).get(`/api/control/tickets/${ticketId}/operational-view`).expect(200);
    expect(res.body.responsibility_view.current_actor).toBe('beavy');
    expect(res.body.responsibility_view.current_actor_source).toBe('assigned_agent');
    expect(res.body.responsibility_view.next_actor_override).toBeNull();
    expect(res.body.responsibility_view.manual_override_active).toBe(false);
    expect(res.body.responsibility_view.explanation.override_governance).toEqual(expect.objectContaining({
      allowed_in_status: false,
      active: false,
      override_actor: null,
      stored_override_actor: 'auditor',
      effective: false,
      residual: true,
    }));
    expect(res.body.responsibility_view.explanation.override_governance.reason).toContain('残留');

    expect(res.body.ticket_operational_view.audit_flags).toEqual(['context_gap']);
    expect(res.body.ticket_operational_view.workflow_mismatch).toEqual(expect.objectContaining({
      category: 'context_gap',
      recommended_status: 'review',
    }));
    expect(res.body.ticket_operational_view.anomaly_flags).toEqual(expect.objectContaining({
      workflow_mismatch: true,
      manual_override_residual: true,
    }));
  });

  it('control read model：subagent 工单 execution_guard_view 含 worker gate 与 responsibility 链摘要', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Subagent gate ticket',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
        execution_mode: 'subagent',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    const detail = await request(app).get(`/api/tickets/${ticketId}`).expect(200);
    const gv = detail.body.control_read_model.execution_guard_view;
    expect(gv.requires_worker).toBe(true);
    expect(gv.has_worker_evidence).toBe(false);
    expect(gv.available_actions).toBeDefined();

    const rv = detail.body.control_read_model.responsibility_view;
    expect(rv.chain.some((c) => c.role === 'assigned_agent' && c.value === 'beavy')).toBe(true);
    expect(rv.current_actor).toBe('beavy');
    expect(rv.summary).toContain('beavy');
  });

  it('control read model：有评论时 ticket_operational_view 含 latest_comment_summary', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Comment summary ticket',
        status: 'triage',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({ author: 'leoss', content: '已评估，可 queue。', type: 'progress' })
      .expect(201);
    const res = await request(app).get(`/api/tickets/${ticketId}`).expect(200);
    const ov = res.body.control_read_model.ticket_operational_view;
    expect(ov.latest_comment_summary).toBeDefined();
    expect(ov.latest_comment_summary.excerpt).toContain('已评估');
    expect(ov.latest_comment_summary.by).toBe('leoss');
  });
});

describe('GET /api/audits/ready', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('running 超过 30 分钟阈值的工单生成 stale_running 审计事件', async () => {
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Stale running ticket',
        description: 'Desc',
        triage_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    // 手动回拨 last_update 使其超过 running 审计阈值
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { status: 'running', last_update: staleTime });

    const res = await request(app).get('/api/audits/ready').expect(200);
    expect(res.body.ready).toBeDefined();
    const item = res.body.ready.find((r) => r.ticket_id === ticketId);
    expect(item).toBeDefined();
    expect(item.audit_type).toBe('stale_running');
    expect(item.stale_minutes).toBeGreaterThanOrEqual(30);
    expect(item.message).toContain('审计任务');
    expect(item.message).toContain('不要自动修改工单状态');
  });

  it('triage 超过 30 分钟阈值的工单生成 stale_triage 审计事件', async () => {
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Stale triage ticket',
        description: 'Desc',
        status: 'triage',
        triage_owner: 'leoss',
        assigned_agent: 'donky',
        review_owner: 'leoss',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { last_update: staleTime });

    const res = await request(app).get('/api/audits/ready').expect(200);
    const item = res.body.ready.find((r) => r.ticket_id === ticketId);
    expect(item).toBeDefined();
    expect(item.audit_type).toBe('stale_triage');
  });

  it('review 超过阈值的工单生成 stale_review 审计事件', async () => {
    const staleTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Stale review ticket',
        description: 'Desc',
        triage_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { status: 'review', last_update: staleTime });

    const res = await request(app).get('/api/audits/ready').expect(200);
    const item = res.body.ready.find((r) => r.ticket_id === ticketId);
    expect(item).toBeDefined();
    expect(item.audit_type).toBe('stale_review');
  });

  it('review 未超过 60 分钟阈值的工单不出现在 audits/ready 中', async () => {
    const freshTime = new Date(Date.now() - 59 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Fresh review ticket',
        description: 'Desc',
        triage_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);

    const { updateTicket } = await import('./store.js');
    updateTicket(createRes.body.id, { status: 'review', last_update: freshTime });

    const res = await request(app).get('/api/audits/ready').expect(200);
    const item = res.body.ready.find((r) => r.ticket_id === createRes.body.id);
    expect(item).toBeUndefined();
  });

  it('done 超过 15 分钟阈值的工单生成 stale_done 审计事件', async () => {
    const staleTime = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Stale done ticket',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { status: 'done', last_update: staleTime });

    const res = await request(app).get('/api/audits/ready').expect(200);
    const item = res.body.ready.find((r) => r.ticket_id === ticketId);
    expect(item).toBeDefined();
    expect(item.audit_type).toBe('stale_done');
  });

  it('pending_decision 超过 12h 阈值的工单生成 stale_pending_decision 审计事件', async () => {
    const staleTime = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Stale pending_decision ticket',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        decision_owner: 'example-human-operator',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'request_decision', actor: 'beavy', decision_summary: '需要决策' })
      .expect(200);

    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { last_update: staleTime });

    const res = await request(app).get('/api/audits/ready').expect(200);
    const item = res.body.ready.find((r) => r.ticket_id === ticketId);
    expect(item).toBeDefined();
    expect(item.audit_type).toBe('stale_pending_decision');
  });

  it('paused 超过 4 小时阈值的工单生成 stale_paused 审计事件', async () => {
    const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Stale paused ticket',
        description: 'Desc',
        status: 'queued',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'pause', actor: 'beavy', pause_reason: '等待外部依赖' })
      .expect(200);

    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { last_update: staleTime });

    const res = await request(app).get('/api/audits/ready').expect(200);
    const item = res.body.ready.find((r) => r.ticket_id === ticketId);
    expect(item).toBeDefined();
    expect(item.audit_type).toBe('stale_paused');
  });

  it('blocked 超过 4 小时阈值的工单生成 stale_blocked 审计事件', async () => {
    const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Stale blocked ticket',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'block', actor: 'beavy', blocker_summary: '等待外部系统恢复' })
      .expect(200);

    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { last_update: staleTime });

    const res = await request(app).get('/api/audits/ready').expect(200);
    const item = res.body.ready.find((r) => r.ticket_id === ticketId);
    expect(item).toBeDefined();
    expect(item.audit_type).toBe('stale_blocked');
  });

  it('deprecated 工单不进入 audits/ready，避免污染运营审计口径', async () => {
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Deprecated audit boundary ticket',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'fail', actor: 'beavy', error: 'legacy leftover' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'deprecate', actor: 'leoss', deprecation_reason: '历史残留，不纳入当前运营审计推进口径' })
      .expect(200);

    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { last_update: staleTime });

    const res = await request(app).get('/api/audits/ready').expect(200);
    const item = res.body.ready.find((r) => r.ticket_id === ticketId);
    expect(item).toBeUndefined();
  });

  it('running 未超过 30 分钟阈值的工单不出现在 audits/ready 中', async () => {
    const freshTime = new Date(Date.now() - 29 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Fresh running ticket',
        description: 'Desc',
        status: 'queued',
        platform: 'stock-platform',
        triage_owner: 'cowder',
        review_owner: 'xiaoying',
        assigned_agent: 'donky',
      })
      .expect(201);

    const { updateTicket } = await import('./store.js');
    updateTicket(createRes.body.id, { status: 'running', last_update: freshTime });

    const res = await request(app).get('/api/audits/ready').expect(200);
    const item = res.body.ready.find((r) => r.ticket_id === createRes.body.id);
    expect(item).toBeUndefined();
  });
});

describe('POST /api/audits/:id/ack', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('ack 生效后同类审计事件不重复', async () => {
    const staleTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Audit dedup test',
        description: 'Desc',
        status: 'queued',
        platform: 'stock-platform',
        triage_owner: 'cowder',
        review_owner: 'xiaoying',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { status: 'running', last_update: staleTime });

    const readyRes1 = await request(app).get('/api/audits/ready').expect(200);
    const first = readyRes1.body.ready.find((r) => r.ticket_id === ticketId);
    expect(first).toBeDefined();

    await request(app)
      .post(`/api/audits/${first.audit_id}/ack`)
      .expect(200);

    const readyRes2 = await request(app).get('/api/audits/ready').expect(200);
    const repeated = readyRes2.body.ready.find((r) => r.ticket_id === ticketId);
    expect(repeated).toBeUndefined();
  });

  it('状态切换后可重新进入审计', async () => {
    const staleTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Audit reset test',
        description: 'Desc',
        status: 'queued',
        platform: 'stock-platform',
        triage_owner: 'cowder',
        review_owner: 'xiaoying',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { status: 'running', last_update: staleTime });

    const readyRes1 = await request(app).get('/api/audits/ready').expect(200);
    const first = readyRes1.body.ready.find((r) => r.ticket_id === ticketId);
    expect(first).toBeDefined();
    await request(app).post(`/api/audits/${first.audit_id}/ack`).expect(200);

    // dispatch 会重置工单状态并清理审计事件
    await request(app)
      .post(`/api/tickets/${ticketId}/dispatch`)
      .send({ agent: 'donky' })
      .expect(200);

    // 重新进入 running 并回拨 last_update
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'donky' })
      .expect(200);
    updateTicket(ticketId, { last_update: staleTime });

    const readyRes2 = await request(app).get('/api/audits/ready').expect(200);
    const second = readyRes2.body.ready.find((r) => r.ticket_id === ticketId);
    expect(second).toBeDefined();
    expect(second.audit_id).not.toBe(first.audit_id);
  });

  it('不存在的 audit_id 返回 404', async () => {
    await request(app)
      .post('/api/audits/99999/ack')
      .expect(404);
  });
});

describe('audit sessionKey 使用 agent:auditor:audit:<ticket_id> 模式', () => {
  it('返回正确的 audit session key', () => {
    expect(getAuditSessionKeyForTicket(26)).toBe('agent:auditor:audit:26');
    expect(getAuditSessionKeyForTicket(1)).toBe('agent:auditor:audit:1');
    expect(getAuditSessionKeyForTicket(null)).toBe('agent:auditor:main');
    expect(getAuditSessionKeyForTicket(0)).toBe('agent:auditor:main');
  });
});

describe('audit result contract + nudge loop', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('audits/ready 返回 result contract', async () => {
    const staleTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Audit contract test',
        description: 'Desc',
        triage_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { last_update: staleTime });

    const res = await request(app).get('/api/audits/ready').expect(200);
    const item = res.body.ready.find((entry) => entry.ticket_id === ticketId);
    expect(item.contract.version).toBe('2026-03-12.audit-request.v1');
    expect(item.contract.result_endpoint).toBe(`/api/audits/${item.audit_id}/result`);
    expect(item.contract.target_session_key).toBe(`agent:auditor:audit:${ticketId}`);
    expect(item.contract.allowed_conclusions).toContain('stale_running');
    expect(item.contract.allowed_conclusions).toContain('stale_queued_after_receipt');
    expect(item.message).toContain(`/api/audits/${item.audit_id}/result`);
  });

  it('stale_running 审计结果会写回评论并生成 running 催办，人工评论后闭环清空', async () => {
    const staleTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Running nudge loop',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { last_update: staleTime });

    const readyRes = await request(app).get('/api/audits/ready').expect(200);
    const audit = readyRes.body.ready.find((entry) => entry.ticket_id === ticketId);
    expect(audit).toBeDefined();

    const resultRes = await request(app)
      .post(`/api/audits/${audit.audit_id}/result`)
      .send({
        conclusion: 'stale_running',
        suggested_status: 'running',
        suggested_actor: 'beavy',
        suggested_action: 'notify_only',
        reason: '长时间无进展，需要执行人补充状态',
        confidence: 'high',
        summary: '请尽快补进展或说明阻塞',
      })
      .expect(201);

    expect(resultRes.body.result).toEqual(expect.objectContaining({
      audit_id: audit.audit_id,
      conclusion: 'stale_running',
      suggested_actor: 'beavy',
      suggested_action: 'notify_only',
    }));

    const detail = await request(app).get(`/api/tickets/${ticketId}`).expect(200);
    expect(detail.body.comments.some((comment) => comment.content.includes('【审计回写】'))).toBe(true);

    const nudgesReady = await request(app).get('/api/nudges/ready').expect(200);
    const nudge = nudgesReady.body.ready.find((entry) => entry.ticket_id === ticketId && entry.kind === 'nudge');
    expect(nudge).toEqual(expect.objectContaining({
      agent: 'beavy',
      status: 'running',
      nudge_source: 'audit_result',
      nudge_level: 'L3',
      reason: 'nudge_l3_stale_running_notify_only',
      dedupe_key: 'dispatch:running:nudge_l3_stale_running_notify_only:beavy',
      escalation_tier: 'L3',
    }));
    expect(nudge.audit_result).toEqual(expect.objectContaining({
      audit_id: audit.audit_id,
      suggested_action: 'notify_only',
      reason: '长时间无进展，需要执行人补充状态',
    }));
    expect(nudge.target_session_key).toBe(getNotifyMainSessionKey());

    await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({
        author: 'beavy',
        type: 'progress',
        content: '已恢复推进，今晚补结果。',
      })
      .expect(201);

    const afterComment = await request(app).get('/api/dispatch/ready').expect(200);
    expect(afterComment.body.ready.find((entry) => entry.ticket_id === ticketId && entry.kind === 'nudge')).toBeUndefined();
  });

  it('queued 派发 ack 后超时会进入 queued stale 催办', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Queued stale loop',
        description: 'Desc',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    const initialReady = await request(app).get('/api/dispatch/ready').expect(200);
    const initialDispatch = initialReady.body.ready.find((entry) => entry.ticket_id === ticketId && !entry.kind);
    expect(initialDispatch).toBeDefined();
    await request(app).post(`/api/dispatch/${initialDispatch.dispatch_id}/ack`).expect(200);

    const staleTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { last_update: staleTime });

    const nudgeReady = await request(app).get('/api/dispatch/ready').expect(200);
    const nudge = nudgeReady.body.ready.find((entry) => entry.ticket_id === ticketId && entry.kind === 'nudge');
    expect(nudge).toEqual(expect.objectContaining({
      agent: '荣晖',
      status: 'queued',
      nudge_source: 'queued_stale',
      nudge_level: 'L3',
      reason: 'nudge_l3_queued_stale',
      dedupe_key: 'dispatch:queued:nudge_l3_queued_stale:荣晖',
      escalation_tier: 'L3',
    }));
    expect(nudge.message).toContain('queued_stale');
    expect(nudge.target_session_key).toBe(getNotifyMainSessionKey());

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    const afterStart = await request(app).get('/api/dispatch/ready').expect(200);
    expect(afterStart.body.ready.find((entry) => entry.ticket_id === ticketId && entry.kind === 'nudge')).toBeUndefined();
  });

  async function createQueuedStaleAfterReceiptAudit(ticketId, {
    dispatch,
    receiptKey,
    receiptMessage,
    resultKey,
    resultReason,
  }) {
    const { updateTicket } = await import('./store.js');

    await request(app).post(`/api/dispatch/${dispatch.dispatch_id}/ack`).expect(200);
    await request(app)
      .post(`/api/agent/assignments/${dispatch.assignment_id}/reports`)
      .send({
        assignment_token: dispatch.assignment.assignment_token,
        report_type: 'dispatch_receipt',
        idempotency_key: receiptKey,
        receipt: {
          dispatch_id: dispatch.dispatch_id,
          ticket_id: ticketId,
          stage: 'queued',
          agent: 'beavy',
          decision: 'accepted',
          message: receiptMessage,
        },
      })
      .expect(201);

    updateTicket(ticketId, { last_update: new Date(Date.now() - 45 * 60 * 1000).toISOString() });
    const auditReady = await request(app).get('/api/audits/ready').expect(200);
    const audit = auditReady.body.ready.find((entry) => entry.ticket_id === ticketId && entry.audit_type === 'stale_queued_after_receipt');
    expect(audit).toBeDefined();

    await request(app)
      .post(`/api/audits/${audit.audit_id}/result`)
      .send({
        conclusion: 'stale_queued_after_receipt',
        suggested_status: 'queued',
        suggested_actor: 'beavy',
        suggested_action: 'notify_only',
        reason: resultReason,
        confidence: 'medium',
      })
      .expect(201);

    return audit;
  }

  it('恢复到 queued 后会重新进入 queued_stale 审计链', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Queued stale re-entry',
        description: 'Desc',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        execution_mode: 'subagent',
        max_active_workers: 1,
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    const firstDispatchReady = await request(app).get('/api/dispatch/ready').expect(200);
    const firstDispatch = firstDispatchReady.body.ready.find((entry) => entry.ticket_id === ticketId && !entry.kind);
    expect(firstDispatch).toBeDefined();

    const firstAudit = await createQueuedStaleAfterReceiptAudit(ticketId, {
      dispatch: firstDispatch,
      receiptKey: 'queued-stale-reentry-first-receipt',
      receiptMessage: '首次 queued receipt accepted',
      resultKey: 'queued-stale-reentry-first-result',
      resultReason: '首次 queued stale 已记录',
    });

    await request(app)
      .post(`/api/agent/assignments/${firstDispatch.assignment_id}/reports`)
      .send({
        assignment_token: firstDispatch.assignment.assignment_token,
        report_type: 'blocked_report',
        idempotency_key: 'queued-stale-reentry-blocked',
        result: { summary: '等待外部条件' },
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'unblock', actor: 'leoss' })
      .expect(200);

    const secondDispatchReady = await request(app).get('/api/dispatch/ready').expect(200);
    const secondDispatch = secondDispatchReady.body.ready.find((entry) => entry.ticket_id === ticketId && !entry.kind);
    expect(secondDispatch).toBeDefined();

    const secondAudit = await createQueuedStaleAfterReceiptAudit(ticketId, {
      dispatch: secondDispatch,
      receiptKey: 'queued-stale-reentry-second-receipt',
      receiptMessage: '第二次 queued receipt accepted',
      resultReason: '第二次 queued stale 已记录',
    });

    expect(secondAudit.audit_id).not.toBe(firstAudit.audit_id);
  });

  it('reset_to_queued 后会重新进入 queued_stale 审计链', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Queued stale reset re-entry',
        description: 'Desc',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        execution_mode: 'subagent',
        max_active_workers: 1,
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    const firstDispatchReady = await request(app).get('/api/dispatch/ready').expect(200);
    const firstDispatch = firstDispatchReady.body.ready.find((entry) => entry.ticket_id === ticketId && !entry.kind);
    expect(firstDispatch).toBeDefined();

    const firstAudit = await createQueuedStaleAfterReceiptAudit(ticketId, {
      dispatch: firstDispatch,
      receiptKey: 'queued-stale-reset-first-receipt',
      receiptMessage: 'reset 前首次 queued receipt accepted',
      resultReason: 'reset 前首次 queued stale 已记录',
    });

    await request(app)
      .post(`/api/tickets/${ticketId}/workers`)
      .send({
        worker_key: 'queued-stale-reset-worker',
        worker_type: 'subagent',
        status: 'running',
        session_key: `agent:beavy:ticket:${ticketId}:worker`,
        run_id: `queued-stale-reset-run-${ticketId}`,
      })
      .expect(201);

    const runningAfterWorker = await request(app).get(`/api/tickets/${ticketId}`).expect(200);
    expect(runningAfterWorker.body.status).toBe('running');

    const staleAssignmentBeforeReset = findLatestAssignmentForTicket(ticketId, 'beavy');
    expect(staleAssignmentBeforeReset).toBeTruthy();
    expect(['queued', 'running']).toContain(staleAssignmentBeforeReset.stage);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'reset_to_queued', actor: 'leoss', reason: '误触开工，回到 queued 重新派发' })
      .expect(200);

    const invalidatedAssignment = getAssignmentById(staleAssignmentBeforeReset.assignment_id);
    expect(invalidatedAssignment).toEqual(expect.objectContaining({
      assignment_id: staleAssignmentBeforeReset.assignment_id,
      assignment_status: 'failed_delivery',
      last_error: 'ticket_reset_to_queued',
      stage: 'queued',
    }));

    const resetWorker = await request(app)
      .patch(`/api/tickets/${ticketId}/workers/queued-stale-reset-worker`)
      .send({ status: 'succeeded', finished_at: '2026-03-15T13:30:00.000Z' })
      .expect(200);
    expect(resetWorker.body.ticket.execution_guard).toEqual(expect.objectContaining({
      has_worker_evidence: false,
      active_workers: 0,
    }));

    const secondDispatchReady = await request(app).get('/api/dispatch/ready').expect(200);
    const secondDispatch = secondDispatchReady.body.ready.find((entry) => entry.ticket_id === ticketId && !entry.kind);
    expect(secondDispatch).toBeDefined();

    const secondAudit = await createQueuedStaleAfterReceiptAudit(ticketId, {
      dispatch: secondDispatch,
      receiptKey: 'queued-stale-reset-second-receipt',
      receiptMessage: 'reset 后第二次 queued receipt accepted',
      resultReason: 'reset 后第二次 queued stale 已记录',
    });

    expect(secondAudit.audit_id).not.toBe(firstAudit.audit_id);
  });

  it('manual nudge 会按当前处理人生成一条 dispatch nudge', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Manual nudge loop',
        description: 'Desc',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    const nudgeRes = await request(app)
      .post(`/api/tickets/${ticketId}/nudge`)
      .send({})
      .expect(201);

    expect(nudgeRes.body).toEqual(expect.objectContaining({
      success: true,
      reused: false,
      dispatch_id: expect.any(Number),
    }));
    expect(nudgeRes.body.ready_item).toEqual(expect.objectContaining({
      agent: 'beavy',
      kind: 'nudge',
      nudge_source: 'manual',
      nudge_level: 'L1',
      reason: 'nudge_manual',
      dedupe_key: 'dispatch:running:nudge_manual:beavy',
      escalation_tier: 'L1',
    }));

    const dispatchReady = await request(app).get('/api/dispatch/ready').expect(200);
    const nudge = dispatchReady.body.ready.find((entry) => entry.ticket_id === ticketId && entry.kind === 'nudge');
    expect(nudge).toEqual(expect.objectContaining({
      dispatch_id: nudgeRes.body.dispatch_id,
      agent: 'beavy',
      status: 'running',
      nudge_source: 'manual',
      nudge_level: 'L1',
      reason: 'nudge_manual',
      dedupe_key: 'dispatch:running:nudge_manual:beavy',
      escalation_tier: 'L1',
      target_session_key: `agent:beavy:ticket:${ticketId}`,
    }));
    expect(nudge.message).toContain('manual_nudge');
  });

  it('manual nudge 投递失败后会写入 backoff，并在 next_retry_at 前阻止 ready 重放', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Manual nudge backoff',
        description: 'Desc',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    const nudgeRes = await request(app)
      .post(`/api/tickets/${ticketId}/nudge`)
      .send({})
      .expect(201);

    const failed = markDispatchDeliveryFailed(nudgeRes.body.dispatch_id, {
      retryCount: 1,
      nextRetryAt: '2099-01-01T00:00:00.000Z',
    });
    expect(failed).toEqual(expect.objectContaining({
      id: nudgeRes.body.dispatch_id,
      dispatch_state: 'pending_delivery',
      dispatch_retry_count: 1,
      next_dispatch_retry_at: '2099-01-01T00:00:00.000Z',
      suppress_ready: true,
    }));

    const readyAgain = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    expect(readyAgain.body.ready.find((entry) => entry.dispatch_id === nudgeRes.body.dispatch_id)).toBeUndefined();
  });

  it('stale_review 审计结果会在 SLA 2x 后升级到 L2 reviewer/triage 催办', async () => {
    const staleTime = new Date(Date.now() - 125 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Review nudge loop',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'ready for review' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_review', actor: 'leoss' })
      .expect(200);
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { last_update: staleTime });

    const readyRes = await request(app).get('/api/audits/ready').expect(200);
    const audit = readyRes.body.ready.find((entry) => entry.ticket_id === ticketId);
    expect(audit.audit_type).toBe('stale_review');

    await request(app)
      .post(`/api/audits/${audit.audit_id}/result`)
      .send({
        conclusion: 'stale_review',
        suggested_status: 'review',
        suggested_actor: 'leoss',
        suggested_action: 'manual_review',
        reason: 'review 长时间无人确认，需要 reviewer 收口',
        confidence: 'medium',
      })
      .expect(201);

    const nudgesReady = await request(app).get('/api/nudges/ready').expect(200);
    const nudge = nudgesReady.body.ready.find((entry) => entry.ticket_id === ticketId && entry.kind === 'nudge');
    expect(nudge).toEqual(expect.objectContaining({
      agent: 'leoss',
      status: 'review',
      nudge_source: 'audit_result',
      nudge_level: 'L2',
      reason: 'nudge_l2_stale_review_manual_review',
      dedupe_key: 'dispatch:review:nudge_l2_stale_review_manual_review:leoss',
      escalation_tier: 'L2',
    }));
    expect(nudge.audit_result).toEqual(expect.objectContaining({
      conclusion: 'stale_review',
      suggested_action: 'manual_review',
    }));
  });
});


describe('agent-facing task API MVP', () => {
  beforeEach(() => {
    ensureCleanStore();
    delete process.env.TICKET_AGENT_API_BASE_URL;
    delete process.env.TICKET_API_BASE_URL;
  });

  async function createReadyAssignment(overrides = {}) {
    const {
      status: targetStatus = 'queued',
      title = 'Agent-facing MVP',
      description = '落 assignment/read-report API',
      assigned_agent = 'beavy',
      triage_owner = 'leoss',
      review_owner = 'leoss',
      execution_mode = 'direct',
      implementation_scope = '后端 API MVP',
      constraints = '保持 additive',
      seed_status_via_store = false,
      ...rest
    } = overrides;

    const created = await request(app)
      .post('/api/tickets')
      .send({
        title,
        description,
        assigned_agent,
        triage_owner,
        review_owner,
        execution_mode,
        implementation_scope,
        constraints,
        ...rest,
      })
      .expect(201);

    const ticketId = created.body.id;
    const currentStatus = targetStatus || 'queued';

    if (seed_status_via_store) {
      if (currentStatus !== 'triage') {
        const { updateTicket } = await import('./store.js');
        updateTicket(ticketId, { status: currentStatus });
      }
    } else {
      if (['queued', 'running', 'done', 'review'].includes(currentStatus)) {
        await request(app)
          .post(`/api/tickets/${ticketId}/transition`)
          .send({ action: 'queue', actor: triage_owner })
          .expect(200);
      }

      if (['running', 'done', 'review'].includes(currentStatus)) {
        await request(app)
          .post(`/api/tickets/${ticketId}/transition`)
          .send({ action: 'start_work', actor: assigned_agent })
          .expect(200);
      }

      if (['done', 'review'].includes(currentStatus)) {
        await request(app)
          .post(`/api/tickets/${ticketId}/transition`)
          .send({ action: 'submit_for_review', actor: assigned_agent, result_summary: 'ready for review' })
          .expect(200);
      }

      if (currentStatus === 'review') {
        await request(app)
          .post(`/api/tickets/${ticketId}/transition`)
          .send({ action: 'start_review', actor: review_owner })
          .expect(200);
      }

      if (!['triage', 'queued', 'running', 'done', 'review'].includes(currentStatus)) {
        const { updateTicket } = await import('./store.js');
        updateTicket(ticketId, { status: currentStatus });
      }
    }

    const ticket = await request(app)
      .get(`/api/tickets/${ticketId}`)
      .expect(200);

    const readyRes = await request(app).get('/api/dispatch/ready').expect(200);
    const ready = readyRes.body.ready.find((item) => item.ticket_id === ticketId);
    if (!seed_status_via_store) {
      expect(ready).toBeDefined();
      expect(ready.assignment_id).toBeTruthy();
      expect(ready.assignment.assignment_token).toBeTruthy();
    }
    return { ticket: ticket.body, ready };
  }

  it('skill fetch API 返回平台托管 bundle，且同时包含 markdown + manifest + checksum', async () => {
    const skillRes = await request(app)
      .get('/api/v1/agent/skills/current')
      .expect(200);

    expect(skillRes.body.data).toEqual(expect.objectContaining({
      skill_id: 'ticket-handler',
      playbook_key: 'ticket-handler',
      version: expect.any(String),
      markdown: expect.stringContaining('execution_mode 适配规则'),
      checksum_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      workboards: expect.arrayContaining([
        expect.objectContaining({
          key: 'stock-tickets',
          endpoint: '/api/v1/agent/workboards/stock-tickets',
        }),
      ]),
      manifest: expect.objectContaining({
        manifest_version: 'v1',
        allowed_report_types: expect.arrayContaining(['progress_update', 'dispatch_receipt', 'execution_completed', 'decision_request', 'triage_structured_report']),
        constraints: expect.objectContaining({
          single_writer: true,
          direct_ticket_write_allowed: false,
        }),
        execution_mode_guidance: expect.arrayContaining([
          expect.objectContaining({ mode: 'direct', spawn_required: false }),
          expect.objectContaining({ mode: 'subagent', preferred_runtime: 'subagent', spawn_required: true }),
          expect.objectContaining({ mode: 'acp', preferred_runtime: 'acp', spawn_required: true }),
        ]),
        stage_mode_checklists: expect.arrayContaining([
          expect.objectContaining({ stage: 'triage', mode: 'direct' }),
          expect.objectContaining({ stage: 'triage', mode: 'subagent' }),
          expect.objectContaining({ stage: 'queued', mode: 'direct' }),
          expect.objectContaining({ stage: 'queued', mode: 'subagent' }),
          expect.objectContaining({ stage: 'review', mode: 'direct' }),
          expect.objectContaining({ stage: 'review', mode: 'subagent' }),
        ]),
        role_checklists: expect.arrayContaining([
          expect.objectContaining({ role: 'triage' }),
          expect.objectContaining({ role: 'executor' }),
          expect.objectContaining({ role: 'reviewer' }),
          expect.objectContaining({ role: 'manager' }),
          expect.objectContaining({ role: 'auditor' }),
        ]),
        acceptance_gate_cards: expect.arrayContaining([
          expect.objectContaining({ audience: 'reviewer' }),
          expect.objectContaining({ audience: 'manager' }),
        ]),
        writeback_templates: expect.objectContaining({
          heartbeat: expect.objectContaining({ channel: 'heartbeat' }),
          dispatch_receipt: expect.objectContaining({
            report_type: 'dispatch_receipt',
            when: expect.stringContaining('receipt 不是终点'),
          }),
          progress_update: expect.objectContaining({ report_type: 'progress_update' }),
          execution_completed: expect.objectContaining({ report_type: 'execution_completed' }),
        }),
        workboards: expect.arrayContaining([
          expect.objectContaining({ key: 'stock-tickets' }),
        ]),
      }),
    }));

    const playbookRes = await request(app)
      .get('/api/v1/agent/playbooks/ticket-handler')
      .expect(200);

    expect(playbookRes.body.data.ref.playbook_url).toBe('/api/v1/agent/playbooks/ticket-handler');
    expect(playbookRes.body.data.checksum_sha256).toBe(skillRes.body.data.checksum_sha256);
    expect(playbookRes.body.data.markdown).toContain('## 当前阶段推进剧本（receipt 不是终点）');
    expect(playbookRes.body.data.markdown).toContain('### stage=review');
    expect(playbookRes.body.data.markdown).toContain('下一阶段可选项：complete / queued / paused / pending_decision');
  });

  it('dispatch ready assignment message 会明确 receipt 不是终点，并写出当前阶段下一步', async () => {
    const { ticket: created } = await createReadyAssignment({
      title: 'Queued dispatch guidance',
      description: 'Desc',
      assigned_agent: 'beavy',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      status: 'queued',
    });

    const dispatchRes = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const readyItem = dispatchRes.body.ready.find((item) => item.ticket_id === created.id);
    expect(readyItem).toBeDefined();
    expect(readyItem.message).toContain('receipt 不是终点');
    expect(readyItem.message).toContain('当前阶段=queued');
    expect(readyItem.message).toContain('推进到【下一阶段】');
    expect(readyItem.message).toContain('subagent/acp 模式先登记真实 worker');
  });

  it('subagent assignment/runtime/skill 会明确要求先派生 worker，且无 worker 迹象时 report 不会把 queued 直接桥接到 running', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'subagent',
      max_active_workers: 1,
      title: 'Subagent worker required',
      implementation_scope: '后端代码开发与测试回归',
    });
    const token = ready.assignment.assignment_token;

    const skillRes = await request(app)
      .get('/api/v1/agent/skills/current')
      .expect(200);
    expect(skillRes.body.data.markdown).toContain('receipt 不是终点');
    expect(skillRes.body.data.markdown).toContain('### stage=queued');
    expect(skillRes.body.data.markdown).toContain('下一阶段可选项：running / done / blocked / pending_decision / failed / paused');
    expect(skillRes.body.data.markdown).toContain('进入 running 前必须先派生并登记 worker');
    expect(skillRes.body.data.manifest.execution_mode_guidance).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'subagent',
        spawn_required: true,
        running_requires_worker_evidence: true,
        worker_requirement: expect.stringContaining('必须先派生并登记 subagent worker'),
      }),
    ]));

    const detailRes = await request(app)
      .get(`/api/v1/agent/assignments/${ready.assignment_id}`)
      .set('x-assignment-token', token)
      .expect(200);
    expect(detailRes.body.execution).toEqual(expect.objectContaining({
      mode: 'subagent',
      running_requires_worker_evidence: true,
      worker_requirement: expect.stringContaining('必须先派生并登记 subagent worker'),
      guidance: expect.objectContaining({
        spawn_required: true,
        running_requires_worker_evidence: true,
      }),
    }));

    const reportRes = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'execution_completed',
        idempotency_key: 'subagent-no-worker-report',
        progress: { status: 'in_progress', percent: 100 },
        result: {
          summary: '子代理结果已整理',
          details_markdown: '故意不登记 worker，验证 queued 不会被直接桥接到 running。',
        },
      })
      .expect(201);

    expect(reportRes.body.assignment_status).toBe('in_progress');
    expect(reportRes.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'submit_for_review',
      will_transition: false,
      applied: false,
      blocked_by_guard: true,
      guard_error: 'EXECUTION_WORKER_REQUIRED',
    }));
    expect(reportRes.body.interpreter_result.transition_error).toContain('execution_mode=subagent');
    expect(reportRes.body.interpreter_result.transition_preview.attempted_steps).toEqual([]);

    const ticketAfter = await request(app)
      .get(`/api/tickets/${ticket.id}`)
      .expect(200);
    expect(ticketAfter.body.status).toBe('queued');
    expect(ticketAfter.body.execution_guard).toEqual(expect.objectContaining({
      requires_worker: true,
      has_worker_evidence: false,
      total_workers: 0,
      current_workers: 0,
    }));
    expect(ticketAfter.body.comments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        author: 'beavy',
        type: 'result',
        content: expect.stringContaining('【agent_report】execution_completed'),
      }),
    ]));
  });

  it('canonical v1 与 legacy alias 共存，且错误模型统一返回 detail/request_id', async () => {
    const { ready } = await createReadyAssignment();

    const canonicalRes = await request(app)
      .get('/api/v1/agent/skills/current')
      .expect(200);
    const legacyRes = await request(app)
      .get('/api/agent/skills/current')
      .expect(200);

    expect(canonicalRes.body.data.checksum_sha256).toBe(legacyRes.body.data.checksum_sha256);

    const unauthorizedRes = await request(app)
      .get('/api/v1/agent/runtime/context')
      .query({ assignment_id: ready.assignment_id })
      .expect(401);

    expect(unauthorizedRes.headers['x-request-id']).toBeTruthy();
    expect(unauthorizedRes.body).toEqual(expect.objectContaining({
      detail: 'assignment_token 无效或缺失',
      request_id: unauthorizedRes.headers['x-request-id'],
    }));
    expect(unauthorizedRes.body.error).toBeUndefined();
  });

  it('dispatch ready 返回 assignment contract，并可用 token 读取上下文/依赖/评论', async () => {
    const parent = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Parent context',
        platform: 'stock-platform',
        assigned_agent: 'donky',
        triage_owner: 'cowder',
        review_owner: 'xiaoying',
        status: 'queued',
      })
      .expect(201);

    const dep = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Dependency',
        platform: 'stock-platform',
        assigned_agent: 'donky',
        triage_owner: 'cowder',
        review_owner: 'xiaoying',
        status: 'queued',
      })
      .expect(201);

    const { updateTicket } = await import('./store.js');
    updateTicket(parent.body.id, { status: 'done' });
    updateTicket(dep.body.id, { status: 'running' });

    const { ticket, ready } = await createReadyAssignment();

    await request(app)
      .patch(`/api/tickets/${ticket.id}`)
      .send({ parent_ticket_id: parent.body.id })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticket.id}/dependencies`)
      .send({ depends_on_ticket_id: dep.body.id, dependency_type: 'blocks' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticket.id}/comments`)
      .send({ author: 'leoss', content: '请优先保兼容', type: 'decision' })
      .expect(201);

    const token = ready.assignment.assignment_token;

    const detailRes = await request(app)
      .get(`/api/v1/agent/assignments/${ready.assignment_id}`)
      .set('x-assignment-token', token)
      .expect(200);

    expect(detailRes.body.assignment_id).toBe(ready.assignment_id);
    expect(detailRes.body.assignment).toEqual(expect.objectContaining({
      id: ready.assignment_id,
      assignment_id: ready.assignment_id,
      stage: 'queued',
      ticket_id: ticket.id,
      agent_id: 'beavy',
    }));
    expect(detailRes.body.assignment_context).toEqual(expect.objectContaining({
      id: ready.assignment_id,
      assignment_id: ready.assignment_id,
      stage: 'queued',
      available_actions: expect.arrayContaining(['start_work']),
      ticket: expect.objectContaining({
        id: ticket.id,
        status: 'queued',
        current_actor: 'beavy',
      }),
    }));
    expect(detailRes.body.current_assignment).toEqual(expect.objectContaining({
      id: ready.assignment_id,
      assignment_id: ready.assignment_id,
      stage: 'queued',
      available_actions: expect.arrayContaining(['start_work']),
    }));
    expect(detailRes.body.goal.instructions_markdown).toContain('后端 API MVP');
    expect(detailRes.body.permissions.can_direct_ticket_write).toBe(false);
    expect(detailRes.body.skill_ref).toEqual(expect.objectContaining({
      skill_id: 'ticket-handler',
      playbook_key: 'ticket-handler',
      version: expect.any(String),
      checksum_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(detailRes.body.runtime_context.bootstrap).toEqual(expect.objectContaining({
      skill_current: '/api/v1/agent/skills/current',
      playbook_current: '/api/v1/agent/playbooks/ticket-handler',
      stock_tickets_workboard: '/api/v1/agent/workboards/stock-tickets',
    }));
    expect(detailRes.body.runtime_context.workboards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'stock-tickets',
        endpoint: '/api/v1/agent/workboards/stock-tickets',
      }),
    ]));
    expect(detailRes.body.contract).toEqual(expect.objectContaining({
      single_writer: true,
      allowed_report_types: expect.arrayContaining(['progress_update', 'dispatch_receipt', 'execution_completed', 'triage_structured_report']),
      auth: expect.objectContaining({
        preferred_transport: expect.objectContaining({ name: 'X-Assignment-Token' }),
      }),
      request_id: expect.objectContaining({
        header: 'X-Request-Id',
        error_field: 'request_id',
      }),
    }));
    expect(detailRes.body.reply_contract).toEqual(expect.objectContaining({
      auth: expect.objectContaining({
        preferred_transport: expect.objectContaining({ name: 'X-Assignment-Token' }),
      }),
      channels: expect.objectContaining({
        heartbeat: expect.objectContaining({ endpoint: `/api/v1/agent/assignments/${ready.assignment_id}/heartbeat` }),
        reports: expect.objectContaining({ endpoint: `/api/v1/agent/assignments/${ready.assignment_id}/reports` }),
      }),
      legacy_aliases: expect.arrayContaining([
        `/api/agent/assignments/${ready.assignment_id}/heartbeat`,
        `/api/agent/assignments/${ready.assignment_id}/reports`,
      ]),
    }));
    expect(detailRes.body.ticket).toEqual(expect.objectContaining({
      execution_mode: expect.any(String),
      execution_mode_source: expect.anything(),
      execution_rule_key: expect.anything(),
      max_active_workers: expect.any(Number),
      dispatch_state: expect.anything(),
      dispatch_retry_count: expect.any(Number),
      worker_stats: expect.objectContaining({
        total_workers: expect.any(Number),
        active_workers: expect.any(Number),
        running_workers: expect.any(Number),
      }),
      current_workers: expect.any(Array),
      execution_workers: expect.any(Array),
      current_actor: 'beavy',
      current_actor_source: 'assigned_agent',
      next_actor: 'beavy',
      next_actor_source: 'assigned_agent',
      next_actor_override: null,
      manual_override_active: false,
      should_notify: true,
      available_actions: expect.arrayContaining(['start_work']),
      workflow_notify_policy: expect.objectContaining({
        dispatch_ready: true,
        notification_ready: false,
        target: 'current_actor',
      }),
    }));
    expect(detailRes.body.execution).toEqual(expect.objectContaining({
      mode: detailRes.body.ticket.execution_mode,
      worker_evidence_required: expect.anything(),
      worker_evidence: expect.objectContaining({
        required: expect.anything(),
        has_worker_evidence: expect.anything(),
        worker_stats: expect.objectContaining({
          total_workers: expect.any(Number),
          active_workers: expect.any(Number),
          running_workers: expect.any(Number),
        }),
        current_workers: expect.any(Array),
        execution_workers: expect.any(Array),
      }),
      writeback_contract: expect.objectContaining({
        kickoff_channel: 'heartbeat',
        receipt_report_type: 'dispatch_receipt',
        progress_report_type: 'progress_update',
        completion_report_types: expect.arrayContaining(['execution_completed', 'review_submission']),
      }),
    }));
    expect(typeof detailRes.body.execution.worker_evidence_required).toBe('boolean');
    expect(typeof detailRes.body.execution.worker_evidence.required).toBe('boolean');
    expect(typeof detailRes.body.execution.worker_evidence.has_worker_evidence).toBe('boolean');

    const depsRes = await request(app)
      .get(`/api/agent/assignments/${ready.assignment_id}/dependencies`)
      .query({ assignment_token: token })
      .expect(200);

    expect(depsRes.body.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'depends_on', ticket_id: dep.body.id, blocking: true, satisfied: false }),
    ]));
    expect(depsRes.body.parents).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'parent', ticket_id: parent.body.id }),
    ]));

    const commentsRes = await request(app)
      .get(`/api/agent/assignments/${ready.assignment_id}/comments`)
      .query({ assignment_token: token })
      .expect(200);

    expect(commentsRes.body.comments).toEqual(expect.arrayContaining([
      expect.objectContaining({ author: 'leoss', actor_role: 'review_owner' }),
    ]));
  });

  it('live acceptance gate 输出 reviewer 可消费 verdict，并覆盖 pass/partial/live-not-upgraded/contract-mismatch/dependency-not-closed', async () => {
    const { ticket, ready } = await createReadyAssignment({
      title: 'Live acceptance gate baseline',
      review_owner: 'leoss',
      assigned_agent: 'beavy',
    });
    const token = ready.assignment.assignment_token;

    const detailRes = await request(app)
      .get(`/api/v1/agent/assignments/${ready.assignment_id}`)
      .set('x-assignment-token', token)
      .expect(200);

    expect(detailRes.body.links.live_acceptance).toBe(`/api/v1/agent/assignments/${ready.assignment_id}/live-acceptance`);
    expect(detailRes.body.links.legacy_aliases.live_acceptance).toBe(`/api/agent/assignments/${ready.assignment_id}/live-acceptance`);

    const workflowRes = await request(app)
      .get('/api/v1/agent/workflow/schema')
      .expect(200);

    const passRes = await request(app)
      .get(`/api/v1/agent/assignments/${ready.assignment_id}/live-acceptance`)
      .set('x-assignment-token', token)
      .query({
        expected_bundle_version: AGENT_PLAYBOOK_VERSION,
        expected_workflow_schema_version: workflowRes.body.data.schema_version,
        expected_api_base_url: 'http://127.0.0.1:8788',
      })
      .expect(200);

    expect(passRes.body.verdict).toBe('pass');
    expect(passRes.body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'workflow-schema', status: 'pass' }),
      expect.objectContaining({ key: 'runtime-context', status: 'pass' }),
      expect.objectContaining({ key: 'hosted-skill-bundle', status: 'pass' }),
      expect.objectContaining({ key: 'dependencies', status: 'pass' }),
    ]));

    const partialRemote = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Remote live acceptance partial',
        description: 'remote gateway no api base url yet',
        assigned_agent: 'cowder',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        execution_mode: 'direct',
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${partialRemote.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    const partialReadyRes = await request(app).get('/api/dispatch/ready').expect(200);
    const partialReady = partialReadyRes.body.ready.find((item) => item.ticket_id === partialRemote.body.id);
    const partialToken = partialReady.assignment.assignment_token;

    const partialRes = await request(app)
      .get(`/api/v1/agent/assignments/${partialReady.assignment_id}/live-acceptance`)
      .set('x-assignment-token', partialToken)
      .expect(200);

    expect(partialRes.body.verdict).toBe('partial');
    expect(partialRes.body.live.api_base_url).toBe(null);
    expect(partialRes.body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'runtime-context', status: 'warn' }),
    ]));

    const notUpgradedRes = await request(app)
      .get(`/api/v1/agent/assignments/${ready.assignment_id}/live-acceptance`)
      .set('x-assignment-token', token)
      .query({ expected_bundle_version: '2099-12-31.bundle.v999' })
      .expect(200);

    expect(notUpgradedRes.body.verdict).toBe('live-not-upgraded');
    expect(notUpgradedRes.body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'hosted-skill-bundle', status: 'fail' }),
    ]));

    const contractMismatchRes = await request(app)
      .get(`/api/v1/agent/assignments/${ready.assignment_id}/live-acceptance`)
      .set('x-assignment-token', token)
      .query({ expected_workflow_schema_version: 'v999' })
      .expect(200);

    expect(contractMismatchRes.body.verdict).toBe('contract-mismatch');
    expect(contractMismatchRes.body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'workflow-schema', status: 'fail' }),
    ]));

    const dep = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Open dependency',
        assigned_agent: 'doggy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${dep.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${dep.body.id}/transition`)
      .send({ action: 'start_work', actor: 'doggy' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticket.id}/dependencies`)
      .send({ depends_on_ticket_id: dep.body.id, dependency_type: 'blocks' })
      .expect(200);

    const depRes = await request(app)
      .get(`/api/v1/agent/assignments/${ready.assignment_id}/live-acceptance`)
      .set('x-assignment-token', token)
      .expect(200);

    expect(depRes.body.verdict).toBe('dependency-not-closed');
    expect(depRes.body.dependency_snapshot.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticket_id: dep.body.id, status: 'running', blocking: true, satisfied: false }),
    ]));
    expect(depRes.body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'dependencies', status: 'fail' }),
    ]));
  });

  it('assignment read/dependencies 可显式返回 supplemental relation 与 stale delivery 提示', async () => {
    const primary = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Primary complete',
        description: 'main ticket',
        status: 'queued',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);

    const { updateTicket } = await import('./store.js');
    updateTicket(primary.body.id, { status: 'complete' });

    const created = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Supplemental smoke',
        description: 'smoke evidence',
        status: 'queued',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
      })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${created.body.id}/relations`)
      .send({ related_ticket_id: primary.body.id, relation_type: 'smoke_of' })
      .expect(201);

    const readyRes = await request(app).get('/api/dispatch/ready').expect(200);
    const ready = readyRes.body.ready.find((item) => item.ticket_id === created.body.id);
    const token = ready.assignment.assignment_token;

    await request(app)
      .post(`/api/tickets/${created.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${created.body.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'supplemental smoke done' })
      .expect(200);

    const detailRes = await request(app)
      .get(`/api/v1/agent/assignments/${ready.assignment_id}`)
      .query({ assignment_token: token })
      .expect(200);

    expect(detailRes.body.delivery).toEqual(expect.objectContaining({
      stale: true,
      stale_reason: 'ticket_status_changed_after_dispatch',
      live_ticket_status: 'done',
      assignment_stage: 'queued',
    }));

    const depsRes = await request(app)
      .get(`/api/agent/assignments/${ready.assignment_id}/dependencies`)
      .query({ assignment_token: token })
      .expect(200);

    expect(depsRes.body.related).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relation: 'outgoing',
        dependency_type: 'smoke_of',
        relation_label: 'Smoke 验证',
        ticket_id: primary.body.id,
      }),
    ]));
  });

  it('stock workboard API 返回筛选/分组盘面，并在 runtime/playbook 中可发现', async () => {
    const { ticket: root } = await createReadyAssignment({
      title: 'Stock root',
      platform: 'stock-platform',
      assigned_agent: 'cowder',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      status: 'running',
      seed_status_via_store: true,
    });

    const { ticket: deprecatedTicket } = await createReadyAssignment({
      title: 'Stock deprecated',
      platform: 'stock-platform',
      assigned_agent: 'cowder',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      parent_ticket_id: root.id,
      status: 'deprecated',
      seed_status_via_store: true,
    });

    const { ticket: reviewTicket } = await createReadyAssignment({
      title: 'Stock review',
      platform: 'stock-platform',
      assigned_agent: 'cowder',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      parent_ticket_id: root.id,
      status: 'done',
      seed_status_via_store: true,
    });

    const { ticket: blockedTicket } = await createReadyAssignment({
      title: 'Stock blocked',
      platform: 'stock-platform',
      assigned_agent: 'cowder',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      parent_ticket_id: root.id,
      status: 'blocked',
      seed_status_via_store: true,
    });

    const { ticket: dep } = await createReadyAssignment({
      title: 'Dependency for blocked',
      platform: 'stock-platform',
      assigned_agent: 'doggy',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      status: 'running',
      seed_status_via_store: true,
    });

    await request(app)
      .post(`/api/tickets/${blockedTicket.id}/dependencies`)
      .send({ depends_on_ticket_id: dep.id, dependency_type: 'blocks' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${blockedTicket.id}/comments`)
      .send({ author: 'leoss', content: '请先等依赖完成', type: 'progress' })
      .expect(201);

    await createReadyAssignment({
      title: 'Ticket platform control',
      platform: 'ticket-platform',
      assigned_agent: 'beavy',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      status: 'running',
      seed_status_via_store: true,
    });

    const workboardRes = await request(app)
      .get('/api/v1/agent/workboards/stock-tickets')
      .query({
        assigned_agent: 'cowder',
        bucket: 'waiting_review,blocked,deprecated',
        has_dependencies: true,
        parent_ticket_id: root.id,
        group_by: 'bucket',
        sort: 'priority_desc',
      })
      .expect(200);

    expect(workboardRes.body.data.filters).toEqual(expect.objectContaining({
      platform: 'stock-platform',
      assigned_agent: 'cowder',
      bucket: ['waiting_review', 'blocked', 'deprecated'],
      has_dependencies: true,
      parent_ticket_id: root.id,
      group_by: 'bucket',
    }));
    expect(workboardRes.body.data.summary).toEqual(expect.objectContaining({
      total_filtered: 1,
      by_status: expect.arrayContaining([
        expect.objectContaining({ status: 'blocked', bucket: 'blocked', count: 1 }),
      ]),
      by_bucket: expect.arrayContaining([
        expect.objectContaining({ bucket: 'blocked', count: 1 }),
      ]),
    }));
    expect(workboardRes.body.data.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group_by: 'bucket',
        group_key: 'blocked',
        count: 1,
        items: expect.arrayContaining([
          expect.objectContaining({
            id: blockedTicket.id,
            bucket: 'blocked',
            has_dependencies: true,
            relation_summary: expect.objectContaining({
              dependency_count: 1,
              parent_ticket_id: root.id,
            }),
            last_comment_excerpt: expect.objectContaining({ excerpt: '请先等依赖完成' }),
          }),
        ]),
      }),
    ]));
    expect(workboardRes.body.data.items).toEqual([]);
    expect(workboardRes.body.data.supported_query_params).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'platform' }),
      expect.objectContaining({ key: 'group_by' }),
      expect.objectContaining({ key: 'has_dependencies' }),
    ]));

    const platformMismatchRes = await request(app)
      .get('/api/v1/agent/workboards/stock-tickets')
      .query({ platform: 'ticket-platform' })
      .expect(200);

    expect(platformMismatchRes.body.data).toEqual(expect.objectContaining({
      summary: expect.objectContaining({ total_filtered: 0 }),
      pagination: expect.objectContaining({ total: 0, returned: 0, has_more: false }),
      items: [],
      groups: [],
    }));

    const runtimeRes = await request(app)
      .get('/api/v1/agent/runtime/context')
      .expect(200);

    expect(runtimeRes.body.data.workboards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'stock-tickets',
        endpoint: '/api/v1/agent/workboards/stock-tickets',
      }),
    ]));

    const playbookRes = await request(app)
      .get('/api/v1/agent/playbooks/ticket-handler')
      .expect(200);

    expect(playbookRes.body.data.markdown).toContain('Stock Workboard API');
    expect(playbookRes.body.data.markdown).toContain('/api/v1/agent/workboards/stock-tickets?status=running&group_by=current_actor');
    expect(playbookRes.body.data.markdown).toContain('/api/v1/agent/workboards/stock-tickets?bucket=waiting_review,blocked,deprecated&group_by=bucket&sort=priority_desc');
    expect(runtimeRes.body.data.workboards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        buckets: expect.arrayContaining([
          expect.objectContaining({ key: 'deprecated', label: '已废弃' }),
        ]),
      }),
    ]));

    const deprecatedBucketRes = await request(app)
      .get('/api/v1/agent/workboards/stock-tickets')
      .query({
        assigned_agent: 'cowder',
        bucket: 'deprecated',
      })
      .expect(200);

    expect(deprecatedBucketRes.body.data.summary).toEqual(expect.objectContaining({
      total_filtered: 1,
      by_bucket: expect.arrayContaining([
        expect.objectContaining({ bucket: 'deprecated', bucket_label: '已废弃', count: 1 }),
      ]),
      by_status: expect.arrayContaining([
        expect.objectContaining({ status: 'deprecated', bucket: 'deprecated', count: 1 }),
      ]),
    }));
    expect(deprecatedBucketRes.body.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: deprecatedTicket.id,
        status: 'deprecated',
        bucket: 'deprecated',
        bucket_label: '已废弃',
        relation_summary: expect.objectContaining({
          parent_ticket_id: root.id,
        }),
      }),
    ]));
  });

  it('queued receipt accepted 后才会从 queued 推进到 running', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'direct',
      title: 'Dispatch receipt accepted -> running',
    });
    const token = ready.assignment.assignment_token;

    await request(app)
      .post(`/api/dispatch/${ready.dispatch_id}/ack`)
      .expect(200);

    const detailBefore = await request(app)
      .get(`/api/tickets/${ticket.id}`)
      .expect(200);
    expect(detailBefore.body.status).toBe('queued');
    expect(detailBefore.body.dispatch_state).toBe('awaiting_receipt');
    expect(detailBefore.body.awaiting_receipt_from).toBe('beavy');
    expect(detailBefore.body.dispatch_ack_deadline_at).toBeTruthy();

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'dispatch_receipt',
        idempotency_key: 'queued-receipt-accepted',
        receipt: {
          dispatch_id: ready.dispatch_id,
          ticket_id: ticket.id,
          stage: 'queued',
          agent: 'beavy',
          decision: 'accepted',
          message: '已收到 assignment，开始执行。',
        },
      })
      .expect(201);

    expect(report.body.assignment_status).toBe('in_progress');
    expect(report.body.validation_audit_id).toBeTruthy();
    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'start_work',
      suggested_status: 'running',
      applied: true,
      bridge_actions: ['start_work'],
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('running');
    expect(ticketAfter.body.comments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        author: 'beavy',
        type: 'progress',
        content: expect.stringContaining('【agent_report】dispatch_receipt'),
      }),
    ]));
  });

  it('queued receipt accepted 桥接到 running 后会立即生成新的 running assignment，旧 queued assignment 立刻 stale，且新 assignment 可继续 heartbeat/report', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'direct',
      title: 'Queued receipt accepted creates running successor assignment',
    });
    const queuedToken = ready.assignment.assignment_token;

    await request(app)
      .post(`/api/dispatch/${ready.dispatch_id}/ack`)
      .expect(200);

    const receiptRes = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: queuedToken,
        report_type: 'dispatch_receipt',
        idempotency_key: 'queued-receipt-successor-running',
        receipt: {
          dispatch_id: ready.dispatch_id,
          ticket_id: ticket.id,
          stage: 'queued',
          agent: 'beavy',
          decision: 'accepted',
          message: '已 receipt，继续 running。',
        },
      })
      .expect(201);

    expect(receiptRes.body.assignment_status).toBe('in_progress');
    expect(receiptRes.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'start_work',
      suggested_status: 'running',
      applied: true,
      bridge_actions: ['start_work'],
    }));
    expect(receiptRes.body.interpreter_result.successor_assignment).toEqual(expect.objectContaining({
      assignment_id: expect.any(String),
      assignment_token: expect.any(String),
      stage: 'running',
      ticket_id: ticket.id,
      agent_id: 'beavy',
    }));
    expect(receiptRes.body.interpreter_result.successor_assignment.assignment_id).not.toBe(ready.assignment_id);

    const ticketAfterReceipt = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfterReceipt.body.status).toBe('running');

    const latestRunningAssignment = findLatestAssignmentForTicket(ticket.id, 'beavy');
    expect(latestRunningAssignment).toEqual(expect.objectContaining({
      assignment_id: receiptRes.body.interpreter_result.successor_assignment.assignment_id,
      stage: 'running',
      ticket_id: ticket.id,
      agent_id: 'beavy',
    }));

    await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/heartbeat`)
      .send({
        assignment_token: queuedToken,
        idempotency_key: 'queued-assignment-stale-after-successor-running',
        progress: { status: 'in_progress', percent: 20 },
      })
      .expect(409);

    const runningAssignmentId = receiptRes.body.interpreter_result.successor_assignment.assignment_id;
    const runningToken = receiptRes.body.interpreter_result.successor_assignment.assignment_token;

    const heartbeatRes = await request(app)
      .post(`/api/agent/assignments/${runningAssignmentId}/heartbeat`)
      .send({
        assignment_token: runningToken,
        idempotency_key: 'running-successor-heartbeat',
        progress: { status: 'in_progress', percent: 25 },
      })
      .expect(201);
    expect(heartbeatRes.body.assignment_id).toBe(runningAssignmentId);
    expect(heartbeatRes.body.assignment_status).toBe('in_progress');

    const reportRes = await request(app)
      .post(`/api/agent/assignments/${runningAssignmentId}/reports`)
      .send({
        assignment_token: runningToken,
        report_type: 'progress_update',
        idempotency_key: 'running-successor-progress-report',
        progress: { status: 'in_progress', percent: 30 },
        summary: '使用 successor running assignment 继续回写',
      })
      .expect(201);
    expect(reportRes.body.assignment_id).toBe(runningAssignmentId);
    expect(reportRes.body.assignment_status).toBe('in_progress');

    const readyAfterRunning = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const runningReady = readyAfterRunning.body.ready.find((entry) => entry.ticket_id === ticket.id && entry.status === 'running');
    expect(runningReady).toBeDefined();
    expect(runningReady.assignment_id).toBe(runningAssignmentId);
    expect(runningReady.assignment.delivery.stage).toBe('running');
  });

  it('running successor assignment 提交 execution_completed 后进入 done reviewer 交接，不误入 Telegram notifications ready', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'direct',
      title: 'Running successor execution_completed keeps reviewer handoff boundary',
    });
    const queuedToken = ready.assignment.assignment_token;

    await request(app)
      .post(`/api/dispatch/${ready.dispatch_id}/ack`)
      .expect(200);

    const receiptRes = await request(app)
      .post(`/api/v1/agent/assignments/${ready.assignment_id}/reports`)
      .set('X-Assignment-Token', queuedToken)
      .send({
        report_type: 'dispatch_receipt',
        idempotency_key: 'queued-receipt-for-running-completion-boundary',
        receipt: {
          dispatch_id: ready.dispatch_id,
          ticket_id: ticket.id,
          stage: 'queued',
          agent: 'beavy',
          decision: 'accepted',
          message: '已 receipt，继续 running。',
        },
      })
      .expect(201);

    const runningAssignmentId = receiptRes.body.interpreter_result.successor_assignment.assignment_id;
    const runningToken = receiptRes.body.interpreter_result.successor_assignment.assignment_token;

    const completionRes = await request(app)
      .post(`/api/v1/agent/assignments/${runningAssignmentId}/reports`)
      .set('X-Assignment-Token', runningToken)
      .send({
        report_type: 'execution_completed',
        idempotency_key: 'running-successor-complete-review-boundary',
        result: {
          summary: 'running assignment 已完成实现并提交 reviewer 交接',
          details_markdown: '验证 report API 收口后应进入 done/reviewer dispatch，而不是直接走 Telegram notifications ready。',
        },
      })
      .expect(201);

    expect(completionRes.body.assignment_status).toBe('submitted');
    expect(completionRes.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'submit_for_review',
      suggested_status: 'done',
      applied: true,
      bridge_actions: ['submit_for_review'],
      attempted_steps: [
        expect.objectContaining({ action: 'submit_for_review', from_status: 'running', success: true, to_status: 'done' }),
      ],
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('done');
    expect(ticketAfter.body.result_summary).toContain('running assignment 已完成实现');

    const notifyRes = await request(app).get('/api/notifications/ready').expect(200);
    expect(notifyRes.body.ready.find((entry) => entry.ticket_id === ticket.id)).toBeUndefined();

    const dispatchRes = await request(app).get('/api/dispatch/ready').expect(200);
    const reviewerEntry = dispatchRes.body.ready.find((entry) => entry.ticket_id === ticket.id);
    expect(reviewerEntry).toBeDefined();
    expect(reviewerEntry.agent).toBe('leoss');
    expect(reviewerEntry.status).toBe('done');
    expect(reviewerEntry.target_session_key).toBe(`agent:main:ticket:${ticket.id}`);
    expect(reviewerEntry.target_session_key).not.toBe(getNotifyMainSessionKey());
  });

  it('agent-facing decision_request report 会稳定进入 Telegram notifications ready 主会话', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'direct',
      title: 'Decision request enters Telegram notify path via report API',
    });
    const token = ready.assignment.assignment_token;

    const report = await request(app)
      .post(`/api/v1/agent/assignments/${ready.assignment_id}/reports`)
      .set('X-Assignment-Token', token)
      .send({
        report_type: 'decision_request',
        idempotency_key: 'decision-request-telegram-notify-entry',
        result: {
          summary: '需要老大确认是否继续开放 reviewer assignment 化',
          details_markdown: '验证 agent-facing report 收口到 pending_decision 后，会稳定进入 Telegram 主会话通知链。',
        },
      })
      .expect(201);

    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'request_decision',
      suggested_status: 'pending_decision',
      applied: true,
      bridge_actions: ['request_decision'],
      attempted_steps: [
        expect.objectContaining({ action: 'request_decision', from_status: 'queued', success: true, to_status: 'pending_decision' }),
      ],
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('pending_decision');
    expect(ticketAfter.body.decision_summary).toContain('需要老大确认');

    const notifyRes = await request(app).get('/api/notifications/ready').expect(200);
    const notifyItem = notifyRes.body.ready.find((entry) => entry.ticket_id === ticket.id);
    expect(notifyItem).toBeDefined();
    expect(notifyItem.type).toBe('pending_decision');
    expect(notifyItem.target_session_key).toBe(getNotifyMainSessionKey());
    expect(notifyItem.target_gateway_id).toBe(MAIN_GATEWAY_ID);
    expect(notifyItem.transport).toBe('local_cli');
    expect(notifyItem.reason).toBe('decision_required');
    expect(notifyItem.dedupe_key).toBe('notify:pending_decision:decision_required:荣晖');
  });

  it('assignment write validation: stale assignment heartbeat 返回 409 ASSIGNMENT_STALE 与 machine_readable', async () => {
    const { ticket, ready } = await createReadyAssignment({ title: 'Stale heartbeat test' });
    const token = ready.assignment.assignment_token;

    await request(app).post(`/api/dispatch/${ready.dispatch_id}/ack`).expect(200);

    await request(app)
      .post(`/api/tickets/${ticket.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    const res = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/heartbeat`)
      .set('x-assignment-token', token)
      .send({ idempotency_key: 'stale-hb', progress: { status: 'in_progress', percent: 10 } })
      .expect(409);

    expect(res.body.code).toBe('ASSIGNMENT_STALE');
    expect(res.body.validation_audit_id).toBeTruthy();
    expect(res.body.machine_readable).toEqual(expect.objectContaining({
      code: 'ASSIGNMENT_STALE',
      codes: expect.arrayContaining(['ASSIGNMENT_STALE']),
      errors: expect.arrayContaining([expect.objectContaining({ code: 'ASSIGNMENT_STALE' })]),
    }));
  });

  it('assignment write validation: superseded assignment heartbeat 返回 409 ASSIGNMENT_STALE', async () => {
    const { ticket, ready } = await createReadyAssignment({ title: 'Superseded assignment test' });
    const token = ready.assignment.assignment_token;

    await request(app)
      .post(`/api/tickets/${ticket.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    const newerAssignment = createOrReuseAssignment({
      ticket_id: ticket.id,
      agent_id: 'beavy',
      stage: 'running',
      dispatch_event_id: ready.dispatch_id + 1,
      target_session_key: 'agent:beavy:ticket:test',
      target_gateway_id: 'mac-main',
      transport: 'test',
      dedupe_key: `superseded-${ticket.id}`,
    });
    expect(newerAssignment.assignment_id).not.toBe(ready.assignment_id);

    const res = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/heartbeat`)
      .set('x-assignment-token', token)
      .send({ idempotency_key: 'superseded-hb', progress: { status: 'in_progress', percent: 10 } })
      .expect(409);

    expect(res.body.code).toBe('ASSIGNMENT_STALE');
    expect(res.body.validation_audit_id).toBeTruthy();
    expect(res.body.machine_readable).toEqual(expect.objectContaining({
      code: 'ASSIGNMENT_STALE',
      codes: expect.arrayContaining(['ASSIGNMENT_STALE']),
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: 'ASSIGNMENT_STALE',
          message: expect.stringContaining('superseded_assignment'),
        }),
      ]),
    }));
  });

  it('assignment write validation: dispatch_receipt 无效 dispatch_id 返回 400 与 machine_readable', async () => {
    const { ticket, ready } = await createReadyAssignment({ title: 'Invalid receipt test' });
    const token = ready.assignment.assignment_token;

    await request(app).post(`/api/dispatch/${ready.dispatch_id}/ack`).expect(200);

    const res = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .set('x-assignment-token', token)
      .send({
        report_type: 'dispatch_receipt',
        idempotency_key: 'invalid-dispatch-id',
        receipt: {
          dispatch_id: 999999,
          ticket_id: ticket.id,
          stage: 'queued',
          agent: 'beavy',
          decision: 'accepted',
          message: 'test',
        },
      })
      .expect(400);

    expect(res.body.code).toBe('DISPATCH_RECEIPT_DISPATCH_ID_INVALID');
    expect(res.body.validation_audit_id).toBeTruthy();
    expect(res.body.machine_readable).toEqual(expect.objectContaining({
      code: 'DISPATCH_RECEIPT_DISPATCH_ID_INVALID',
      codes: expect.arrayContaining(['DISPATCH_RECEIPT_DISPATCH_ID_INVALID']),
      errors: expect.any(Array),
    }));
  });

  it('replacement assignment read 会绑定自身 dispatch delivery，而不是复用 ticket 全局握手断面', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'subagent',
      max_active_workers: 1,
      title: 'Replacement assignment delivery should bind to itself',
    });

    await request(app)
      .post(`/api/dispatch/${ready.dispatch_id}/ack`)
      .expect(200);

    await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: ready.assignment.assignment_token,
        report_type: 'dispatch_receipt',
        idempotency_key: 'replacement-old-receipt-accepted',
        receipt: {
          dispatch_id: ready.dispatch_id,
          ticket_id: ticket.id,
          stage: 'queued',
          agent: 'beavy',
          decision: 'accepted',
          message: '旧 dispatch 已 receipt accepted。',
        },
      })
      .expect(201);

    const replacementDispatchId = recordDispatchEvent(ticket.id, 'beavy', 'queued');
    ackDispatchEventRecord(replacementDispatchId);
    const replacementAssignment = createOrReuseAssignment({
      ticket_id: ticket.id,
      dispatch_event_id: replacementDispatchId,
      agent_id: 'beavy',
      gateway_id: 'mac-main',
      execution_mode: 'subagent',
      assignment_status: 'created',
      intent: 'dispatch',
      role: 'execute',
      stage: 'queued',
      assignment_token: 'replacement-assignment-token',
      target_session_key: `agent:beavy:ticket:${ticket.id}`,
      transport: 'test',
    });

    const detailRes = await request(app)
      .get(`/api/v1/agent/assignments/${replacementAssignment.assignment_id}`)
      .set('x-assignment-token', 'replacement-assignment-token')
      .expect(200);

    expect(detailRes.body.delivery).toEqual(expect.objectContaining({
      dispatch_event_id: replacementDispatchId,
      dispatch_state: 'awaiting_receipt',
      awaiting_receipt_from: 'beavy',
      dispatch_ack_deadline_at: expect.any(String),
      dispatch_retry_count: 0,
    }));
    expect(detailRes.body.delivery.dispatch_event_id).not.toBe(ready.dispatch_id);
    expect(detailRes.body.delivery.live_ticket_dispatch_state).toBe('awaiting_receipt');
  });

  it('subagent queued receipt accepted 但缺 worker 时保持 queued，补 worker 后自动桥接到 running', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'subagent',
      max_active_workers: 1,
      title: 'Queued receipt accepted waits for worker evidence',
    });
    const token = ready.assignment.assignment_token;

    await request(app)
      .post(`/api/dispatch/${ready.dispatch_id}/ack`)
      .expect(200);

    const receiptRes = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'dispatch_receipt',
        idempotency_key: 'queued-receipt-subagent-no-worker',
        receipt: {
          dispatch_id: ready.dispatch_id,
          ticket_id: ticket.id,
          stage: 'queued',
          agent: 'beavy',
          decision: 'accepted',
          message: '先确认 receipt，随后补 worker 证据。',
        },
      })
      .expect(201);

    expect(receiptRes.body.assignment_status).toBe('receipt_recorded');
    expect(receiptRes.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'start_work',
      suggested_status: 'running',
      applied: false,
      bridge_actions: ['start_work'],
    }));
    expect(receiptRes.body.interpreter_result.transition_error).toBe('EXECUTION_WORKER_REQUIRED');

    const queuedAfterReceipt = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(queuedAfterReceipt.body.status).toBe('queued');
    expect(queuedAfterReceipt.body.dispatch_state).toBe('receipt_accepted');
    expect(queuedAfterReceipt.body.execution_guard).toEqual(expect.objectContaining({
      suppress_dispatch: false,
      has_worker_evidence: false,
      requires_worker: true,
    }));

    const readyAfterReceipt = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    expect(readyAfterReceipt.body.ready.find((entry) => entry.ticket_id === ticket.id)).toBeUndefined();

    const workerRes = await request(app)
      .post(`/api/tickets/${ticket.id}/workers`)
      .send({
        worker_key: 'subagent-auto-start',
        worker_type: 'subagent',
        status: 'running',
        session_key: 'agent:beavy:ticket:auto-start',
        run_id: 'run-auto-start',
      })
      .expect(201);

    expect(workerRes.body.ticket.status).toBe('running');
    expect(workerRes.body.ticket.execution_guard).toEqual(expect.objectContaining({
      suppress_dispatch: false,
      reason: 'running_assignment_refresh',
      has_worker_evidence: true,
    }));

    const detailAfterWorker = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(detailAfterWorker.body.status).toBe('running');

    const latestAfterWorker = findLatestAssignmentForTicket(ticket.id, 'beavy');
    expect(latestAfterWorker).toEqual(expect.objectContaining({
      stage: 'running',
      ticket_id: ticket.id,
      agent_id: 'beavy',
    }));
    expect(latestAfterWorker.assignment_id).not.toBe(ready.assignment_id);

    updateAssignment(ready.assignment_id, {
      assignment_status: 'in_progress',
      stage: 'queued',
    });

    const latestAfterQueuedWrite = findLatestAssignmentForTicket(ticket.id, 'beavy');
    expect(latestAfterQueuedWrite.assignment_id).toBe(latestAfterWorker.assignment_id);
    expect(latestAfterQueuedWrite.stage).toBe('running');

    const readyAfterRunning = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const runningReady = readyAfterRunning.body.ready.find((entry) => entry.ticket_id === ticket.id && entry.status === 'running');
    expect(runningReady).toBeDefined();
    expect(runningReady.assignment_id).toBeTruthy();
    expect(runningReady.assignment_id).toBe(latestAfterWorker.assignment_id);
    expect(runningReady.assignment_id).not.toBe(ready.assignment_id);
    expect(runningReady.assignment.delivery.stage).toBe('running');

    const staleHeartbeat = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/heartbeat`)
      .send({
        assignment_token: token,
        idempotency_key: 'queued-assignment-stale-after-running',
        progress: { status: 'in_progress', percent: 15 },
      })
      .expect(409);
    expect(staleHeartbeat.body.code).toBe('ASSIGNMENT_STALE');

    const staleReport = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'progress_update',
        idempotency_key: 'queued-assignment-report-stale-after-running',
        progress: { status: 'in_progress', percent: 16 },
      })
      .expect(409);
    expect(staleReport.body.code).toBe('ASSIGNMENT_STALE');
  });

  it('GET /api/nudges/ready 返回独立 nudge 队列', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'subagent',
      max_active_workers: 1,
      title: 'Standalone nudge ready route',
    });

    await request(app)
      .post(`/api/dispatch/${ready.dispatch_id}/ack`)
      .expect(200);

    await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: ready.assignment.assignment_token,
        report_type: 'dispatch_receipt',
        idempotency_key: 'standalone-nudge-ready-route',
        receipt: {
          dispatch_id: ready.dispatch_id,
          ticket_id: ticket.id,
          stage: 'queued',
          agent: 'beavy',
          decision: 'accepted',
          message: '已接单，等待 worker bridge。',
        },
      })
      .expect(201);

    const staleTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const { updateTicket } = await import('./store.js');
    updateTicket(ticket.id, { last_update: staleTime });

    const readyRes = await request(app)
      .get('/api/nudges/ready')
      .expect(200);
    const nudgeEntry = readyRes.body.ready.find((entry) => entry.ticket_id === ticket.id && entry.kind === 'nudge');
    expect(nudgeEntry).toBeDefined();
    expect(nudgeEntry.nudge_source).toBe('queued_stale');
    expect(nudgeEntry.agent).toBe('荣晖');
    expect(nudgeEntry.nudge_level).toBe('L3');
    expect(nudgeEntry.reason).toBe('nudge_l3_queued_stale');
    expect(nudgeEntry.escalation_tier).toBe('L3');
  });

  it('queued stale 催办：receipt accepted 但 requires_worker 且无 worker evidence 的灰状态在阈值后进入催办', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'subagent',
      max_active_workers: 1,
      title: 'Receipt accepted no worker evidence should get queued_stale nudge',
    });

    await request(app)
      .post(`/api/dispatch/${ready.dispatch_id}/ack`)
      .expect(200);

    await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: ready.assignment.assignment_token,
        report_type: 'dispatch_receipt',
        idempotency_key: 'queued-receipt-subagent-stale-guard',
        receipt: {
          dispatch_id: ready.dispatch_id,
          ticket_id: ticket.id,
          stage: 'queued',
          agent: 'beavy',
          decision: 'accepted',
          message: '先接单，等待 worker bridge。',
        },
      })
      .expect(201);

    const staleTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const { updateTicket } = await import('./store.js');
    updateTicket(ticket.id, { last_update: staleTime });

    const readyRes = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const nudgeEntry = readyRes.body.ready.find((entry) => entry.ticket_id === ticket.id && entry.kind === 'nudge');
    expect(nudgeEntry).toBeDefined();
    expect(nudgeEntry.nudge_source).toBe('queued_stale');
    expect(nudgeEntry.agent).toBe('荣晖');
    expect(nudgeEntry.nudge_level).toBe('L3');
    expect(nudgeEntry.reason).toBe('nudge_l3_queued_stale');
    expect(nudgeEntry.escalation_tier).toBe('L3');
  });

  it('done 阶段收到 review receipt accepted 后才会从 done 推进到 review', async () => {
    const { ticket, ready } = await createReadyAssignment({
      status: 'done',
      assigned_agent: 'beavy',
      review_owner: 'leoss',
      title: 'Review receipt accepted -> review',
    });
    const token = ready.assignment.assignment_token;

    expect(ready.agent).toBe('leoss');

    await request(app)
      .post(`/api/dispatch/${ready.dispatch_id}/ack`)
      .expect(200);

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'dispatch_receipt',
        idempotency_key: 'review-receipt-accepted',
        receipt: {
          dispatch_id: ready.dispatch_id,
          ticket_id: ticket.id,
          stage: 'done',
          agent: 'leoss',
          decision: 'accepted',
          message: '已收到 review assignment，开始验收。',
        },
      })
      .expect(201);

    expect(report.body.assignment_status).toBe('in_progress');
    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'start_review',
      suggested_status: 'review',
      applied: true,
      bridge_actions: ['start_review'],
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('review');
  });

  it('非 accepted receipt 只记录回执，不推进状态', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'direct',
      title: 'Dispatch receipt rejected does not transition',
    });
    const token = ready.assignment.assignment_token;

    await request(app)
      .post(`/api/dispatch/${ready.dispatch_id}/ack`)
      .expect(200);

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'dispatch_receipt',
        idempotency_key: 'queued-receipt-busy',
        receipt: {
          dispatch_id: ready.dispatch_id,
          ticket_id: ticket.id,
          stage: 'queued',
          agent: 'beavy',
          decision: 'busy',
          message: '当前有更高优先级任务，暂不接单。',
        },
      })
      .expect(201);

    expect(report.body.assignment_status).toBe('receipt_recorded');
    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: null,
      suggested_status: 'queued',
      applied: false,
      bridge_actions: [],
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('queued');
  });

  it('done -> review 后会补发新的 review assignment，旧 done assignment 不可续写', async () => {
    const { ticket, ready } = await createReadyAssignment({
      status: 'done',
      assigned_agent: 'beavy',
      review_owner: 'leoss',
      title: 'Review assignment refresh after done -> review',
    });
    const token = ready.assignment.assignment_token;

    expect(ready.agent).toBe('leoss');

    await request(app)
      .post(`/api/dispatch/${ready.dispatch_id}/ack`)
      .expect(200);

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'dispatch_receipt',
        idempotency_key: 'review-refresh-dispatch-receipt',
        receipt: {
          dispatch_id: ready.dispatch_id,
          ticket_id: ticket.id,
          stage: 'done',
          agent: 'leoss',
          decision: 'accepted',
          message: '已收到 review assignment，开始验收。',
        },
      })
      .expect(201);

    expect(report.body.assignment_status).toBe('in_progress');
    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'start_review',
      suggested_status: 'review',
      applied: true,
      bridge_actions: ['start_review'],
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('review');

    const readyAgain = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const reviewReady = readyAgain.body.ready.find((item) => item.ticket_id === ticket.id && item.status === 'review');
    expect(reviewReady).toBeDefined();
    expect(reviewReady.assignment_id).toBeTruthy();
    expect(reviewReady.assignment_id).not.toBe(ready.assignment_id);
    expect(reviewReady.assignment.delivery.stage).toBe('review');

    const staleHeartbeat = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/heartbeat`)
      .send({
        assignment_token: token,
        idempotency_key: 'done-assignment-stale-after-review',
        progress: { status: 'in_progress', percent: 20 },
      })
      .expect(409);
    expect(staleHeartbeat.body.code).toBe('ASSIGNMENT_STALE');

    const staleReport = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'progress_update',
        idempotency_key: 'done-assignment-report-stale-after-review',
        progress: { status: 'in_progress', percent: 21 },
      })
      .expect(409);
    expect(staleReport.body.code).toBe('ASSIGNMENT_STALE');
  });

  it('review refresh 后即使旧 done assignment 再次更新，latest assignment 仍应稳定指向新的 review assignment', async () => {
    const { ticket, ready } = await createReadyAssignment({
      status: 'done',
      assigned_agent: 'beavy',
      review_owner: 'leoss',
      title: 'Review assignment stays latest after old done assignment updates',
    });
    const doneToken = ready.assignment.assignment_token;

    await request(app)
      .post(`/api/dispatch/${ready.dispatch_id}/ack`)
      .expect(200);

    await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: doneToken,
        report_type: 'dispatch_receipt',
        idempotency_key: 'review-refresh-latest-stability',
        receipt: {
          dispatch_id: ready.dispatch_id,
          ticket_id: ticket.id,
          stage: 'done',
          agent: 'leoss',
          decision: 'accepted',
          message: '已收到 review assignment，开始验收。',
        },
      })
      .expect(201);

    const readyAgain = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const reviewReady = readyAgain.body.ready.find((item) => item.ticket_id === ticket.id && item.status === 'review');
    expect(reviewReady).toBeDefined();
    expect(reviewReady.assignment_id).not.toBe(ready.assignment_id);

    updateAssignment(ready.assignment_id, {
      assignment_status: 'in_progress',
      stage: 'done',
    });

    const latest = findLatestAssignmentForTicket(ticket.id, 'leoss');
    expect(latest.assignment_id).toBe(reviewReady.assignment_id);

    const reviewHeartbeat = await request(app)
      .post(`/api/agent/assignments/${reviewReady.assignment_id}/heartbeat`)
      .send({
        assignment_token: reviewReady.assignment.assignment_token,
        idempotency_key: 'review-refresh-latest-stability-heartbeat',
        progress: { status: 'in_progress', percent: 22 },
      })
      .expect(201);
    expect(reviewHeartbeat.body.assignment_id).toBe(reviewReady.assignment_id);
    expect(reviewHeartbeat.body.assignment_status).toBe('in_progress');
  });

  it('旧 assignment 不能回写新 review dispatch_event，避免 reviewer dispatch_event 错绑', async () => {
    const { ticket, ready } = await createReadyAssignment({
      status: 'done',
      assigned_agent: 'beavy',
      review_owner: 'leoss',
      title: 'Old done assignment must not receipt new review dispatch',
    });
    const doneToken = ready.assignment.assignment_token;

    await request(app)
      .post(`/api/dispatch/${ready.dispatch_id}/ack`)
      .expect(200);

    await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: doneToken,
        report_type: 'dispatch_receipt',
        idempotency_key: 'review-refresh-create-new-dispatch',
        receipt: {
          dispatch_id: ready.dispatch_id,
          ticket_id: ticket.id,
          stage: 'done',
          agent: 'leoss',
          decision: 'accepted',
          message: '已收到 review assignment，开始验收。',
        },
      })
      .expect(201);

    const readyAgain = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const reviewReady = readyAgain.body.ready.find((item) => item.ticket_id === ticket.id && item.status === 'review');
    expect(reviewReady).toBeDefined();

    const mismatchReceipt = await request(app)
      .post(`/api/agent/assignments/${reviewReady.assignment_id}/reports`)
      .send({
        assignment_token: reviewReady.assignment.assignment_token,
        report_type: 'dispatch_receipt',
        idempotency_key: 'review-assignment-cannot-bind-old-done-dispatch',
        receipt: {
          dispatch_id: ready.dispatch_id,
          ticket_id: ticket.id,
          stage: 'done',
          agent: 'leoss',
          decision: 'accepted',
          message: '新 review assignment 不应回写旧 done dispatch',
        },
      })
      .expect(400);

    expect(mismatchReceipt.body.code).toBe('DISPATCH_RECEIPT_DISPATCH_ID_INVALID');
    expect(mismatchReceipt.body.machine_readable?.codes || []).toContain('DISPATCH_RECEIPT_DISPATCH_ID_INVALID');
  });

  it('review 阶段收到 accepted receipt 只确认 reviewer 已接单，不再推进新状态', async () => {
    const { ticket, ready } = await createReadyAssignment({
      status: 'review',
      assigned_agent: 'beavy',
      review_owner: 'leoss',
      title: 'Review stage receipt accepted stays review',
    });
    const token = ready.assignment.assignment_token;

    expect(ready.agent).toBe('leoss');

    await request(app)
      .post(`/api/dispatch/${ready.dispatch_id}/ack`)
      .expect(200);

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'dispatch_receipt',
        idempotency_key: 'review-stage-receipt-accepted',
        receipt: {
          dispatch_id: ready.dispatch_id,
          ticket_id: ticket.id,
          stage: 'review',
          agent: 'leoss',
          decision: 'accepted',
          message: '已收到 review 阶段 assignment，继续验收。',
        },
      })
      .expect(201);

    expect(report.body.assignment_status).toBe('in_progress');
    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: null,
      suggested_status: 'review',
      applied: false,
      bridge_actions: [],
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('review');
    expect(ticketAfter.body.dispatch_state).toBe('receipt_accepted');

    const readyAgain = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    expect(readyAgain.body.ready.find((item) => item.ticket_id === ticket.id)).toBeUndefined();
  });

  it('receipt 超时后会暴露 timeout/retry 元数据，并允许重新派单', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'direct',
      title: 'Dispatch receipt timeout retry',
    });

    ackDispatchEventRecord(ready.dispatch_id, {
      ackDeadlineAt: '2026-03-01T00:00:00.000Z',
      awaitingReceiptFrom: 'beavy',
      nextRetryAt: '2026-03-01T00:00:00.000Z',
    });

    const detailBeforeRetry = await request(app)
      .get(`/api/tickets/${ticket.id}`)
      .expect(200);
    expect(detailBeforeRetry.body.status).toBe('queued');
    expect(detailBeforeRetry.body.dispatch_state).toBe('receipt_overdue');
    expect(detailBeforeRetry.body.dispatch_timeout_reason).toBe('receipt_not_received_before_deadline');
    expect(detailBeforeRetry.body.dispatch_watchers).toEqual(expect.arrayContaining(['beavy', 'leoss']));
    expect(detailBeforeRetry.body.next_dispatch_retry_at).toBe('2026-03-01T00:00:00.000Z');

    const readyAgain = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const retried = readyAgain.body.ready.find((item) => item.ticket_id === ticket.id && item.dispatch_id !== ready.dispatch_id);
    expect(retried).toBeDefined();
    expect(retried.dispatch_retry_count).toBe(1);
  });

  it('dispatch delivery failure 会写入 backoff，并在 next_retry_at 前阻止 ready 重放', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'direct',
      title: 'Dispatch delivery failure backoff',
    });

    const failed = markDispatchDeliveryFailed(ready.dispatch_id, {
      retryCount: 1,
      nextRetryAt: '2099-01-01T00:00:00.000Z',
    });
    expect(failed).toEqual(expect.objectContaining({
      id: ready.dispatch_id,
      dispatch_state: 'pending_delivery',
      dispatch_retry_count: 1,
      next_dispatch_retry_at: '2099-01-01T00:00:00.000Z',
      suppress_ready: true,
    }));

    const detail = await request(app)
      .get(`/api/tickets/${ticket.id}`)
      .expect(200);
    expect(detail.body.dispatch_state).toBe('pending_delivery');
    expect(detail.body.dispatch_retry_count).toBe(1);
    expect(detail.body.next_dispatch_retry_at).toBe('2099-01-01T00:00:00.000Z');

    const readyAgain = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    expect(readyAgain.body.ready.find((item) => item.ticket_id === ticket.id)).toBeUndefined();
  });

  it('pending_delivery 的 next_retry_at 到点后会重新出现在 ready', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'direct',
      title: 'Dispatch ready gate resumes after retry window',
    });

    markDispatchDeliveryFailed(ready.dispatch_id, {
      retryCount: 1,
      nextRetryAt: '2000-01-01T00:00:00.000Z',
    });

    const readyAgain = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const retried = readyAgain.body.ready.find((item) => item.ticket_id === ticket.id);
    expect(retried).toBeDefined();
    expect(retried.dispatch_id).toBe(ready.dispatch_id);
    expect(retried.dispatch_retry_count).toBe(1);
  });

  it('triage structured report 在责任链完整时会自动 bridge 到 queued', async () => {
    const created = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Triage report auto queue',
        description: 'triage contract smoke',
        status: 'triage',
        triage_owner: 'leoss',
        assigned_agent: 'beavy',
        review_owner: 'leoss',
        execution_mode: 'direct',
      })
      .expect(201);

    const readyRes = await request(app).get('/api/dispatch/ready').expect(200);
    const ready = readyRes.body.ready.find((item) => item.ticket_id === created.body.id);
    expect(ready).toBeDefined();
    expect(ready.agent).toBe('leoss');
    const token = ready.assignment.assignment_token;

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'triage_structured_report',
        idempotency_key: 'triage-structured-auto-queue',
        summary: '责任链完整，可直接放行执行。',
        triage: {
          verdict: 'queue',
          is_executable: true,
          route: {
            target_status: 'queued',
            reason: 'scope / constraints / deliverables 已明确，直接进入执行队列。',
          },
          responsibility: {
            triage_owner: 'leoss',
            assigned_agent: 'beavy',
            review_owner: 'leoss',
            chain_complete: true,
            missing_fields: [],
          },
          suggested_next_step: {
            action: 'queue',
            suggested_status: 'queued',
            reason: '开始执行',
          },
        },
      })
      .expect(201);

    expect(report.body.assignment_status).toBe('in_progress');
    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'queue',
      suggested_status: 'queued',
      applied: true,
      bridge_actions: ['queue'],
      blocked_by_guard: false,
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${created.body.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('queued');
    expect(ticketAfter.body.next_actor).toBe('beavy');
    expect(ticketAfter.body.comments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        author: 'leoss',
        type: 'result',
        content: expect.stringContaining('【agent_report】triage_structured_report'),
      }),
    ]));
  });

  it('triage structured report 缺责任链时不 auto-queue，并返回 machine-readable reason', async () => {
    const created = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Triage report missing chain',
        description: 'triage guard smoke',
        status: 'triage',
        triage_owner: 'leoss',
        assigned_agent: 'beavy',
        execution_mode: 'direct',
      })
      .expect(201);

    const readyRes = await request(app).get('/api/dispatch/ready').expect(200);
    const ready = readyRes.body.ready.find((item) => item.ticket_id === created.body.id);
    expect(ready).toBeDefined();
    const token = ready.assignment.assignment_token;

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'triage_structured_report',
        idempotency_key: 'triage-structured-missing-chain',
        summary: '责任链不完整，不能假成功 queued。',
        triage: {
          verdict: 'queue',
          is_executable: true,
          machine_reason_code: 'TRIAGE_QUEUE_CHAIN_INCOMPLETE',
          route: {
            target_status: 'queued',
            reason: '执行人已明确，但 review_owner 仍缺失。',
          },
          responsibility: {
            triage_owner: 'leoss',
            assigned_agent: 'beavy',
            chain_complete: false,
            missing_fields: ['review_owner'],
          },
          suggested_next_step: {
            action: 'fill_responsibility_chain',
            suggested_status: 'triage',
            reason: '先补 review_owner，再重新提交 triage report。',
          },
        },
      })
      .expect(201);

    expect(report.body.assignment_status).toBe('receipt_recorded');
    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: null,
      suggested_status: 'queued',
      will_transition: false,
      applied: false,
      blocked_by_guard: true,
      guard_error: 'TRIAGE_QUEUE_CHAIN_INCOMPLETE',
    }));
    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      bridge_actions: [],
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${created.body.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('triage');
    expect(ticketAfter.body.next_actor).toBe('leoss');
  });

  it('queued 工单收到 execution_completed 时，会自动桥接 start_work -> submit_for_review', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'direct',
      title: 'Agent-facing queued auto bridge',
    });
    const token = ready.assignment.assignment_token;

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'execution_completed',
        idempotency_key: 'queued-report-1',
        progress: { status: 'in_progress', percent: 100 },
        result: {
          summary: '无需人工 start_work 也应自动提交验收',
          details_markdown: 'queued 场景下由 report interpreter 自动桥接到 running，再提交 done。',
        },
      })
      .expect(201);

    expect(report.body.assignment_status).toBe('submitted');
    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'submit_for_review',
      suggested_status: 'done',
      applied: true,
      bridge_actions: ['start_work', 'submit_for_review'],
    }));
    expect(report.body.interpreter_result.transition_preview.attempted_steps).toEqual([
      expect.objectContaining({ action: 'start_work', from_status: 'queued', success: true, to_status: 'running' }),
      expect.objectContaining({ action: 'submit_for_review', from_status: 'running', success: true, to_status: 'done' }),
    ]);

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('done');
    expect(ticketAfter.body.result_summary).toContain('无需人工 start_work');
  });

  it('subagent queued 工单无 worker 证据时，不允许仅靠 execution_completed 自动提审', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'subagent',
      title: 'Subagent report requires worker evidence',
    });
    const token = ready.assignment.assignment_token;

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'execution_completed',
        idempotency_key: 'subagent-report-no-worker',
        progress: { status: 'in_progress', percent: 100 },
        result: {
          summary: '没有真实 worker 不应直接 done',
          details_markdown: 'subagent 模式必须先有真实 worker / current_workers / execution_workers 证据。',
        },
      })
      .expect(201);

    expect(report.body.assignment_status).toBe('in_progress');
    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'submit_for_review',
      suggested_status: 'done',
      will_transition: false,
      applied: false,
      blocked_by_guard: true,
      guard_error: 'EXECUTION_WORKER_REQUIRED',
      expected_worker_type: 'subagent',
      worker_evidence_required: true,
      worker_stats: expect.objectContaining({
        total_workers: 0,
        active_workers: 0,
        running_workers: 0,
      }),
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('queued');
  });

  it('subagent queued 工单只有 failed 终态 worker 历史时，不允许把 total_workers 当作完成证据', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'subagent',
      title: 'Subagent failed terminal worker history is not enough',
    });
    const token = ready.assignment.assignment_token;

    await request(app)
      .post(`/api/tickets/${ticket.id}/workers`)
      .send({
        worker_key: 'subagent-terminal-only',
        worker_type: 'subagent',
        status: 'running',
        session_key: `agent:beavy:ticket:${ticket.id}:worker-terminal-only`,
        run_id: `subagent-terminal-only-${ticket.id}`,
      })
      .expect(201);

    await request(app)
      .patch(`/api/tickets/${ticket.id}/workers/subagent-terminal-only`)
      .send({ status: 'failed', finished_at: '2026-03-15T13:45:00.000Z' })
      .expect(200);

    const ticketBeforeReport = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketBeforeReport.body.worker_stats).toEqual(expect.objectContaining({
      total_workers: 1,
      active_workers: 0,
      running_workers: 0,
    }));
    expect(ticketBeforeReport.body.execution_guard).toEqual(expect.objectContaining({
      has_worker_evidence: false,
      total_workers: 1,
      active_workers: 0,
      running_workers: 0,
      current_workers: 0,
    }));

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'execution_completed',
        idempotency_key: 'subagent-report-failed-terminal-history-only',
        progress: { status: 'in_progress', percent: 100 },
        result: {
          summary: '只有 failed 终态 worker 历史，不应直接 done',
          details_markdown: 'failed 历史 total_workers 不能替代真实 worker evidence。',
        },
      })
      .expect(201);

    expect(report.body.assignment_status).toBe('in_progress');
    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'submit_for_review',
      suggested_status: 'done',
      will_transition: false,
      applied: false,
      blocked_by_guard: true,
      guard_error: 'EXECUTION_WORKER_REQUIRED',
      expected_worker_type: 'subagent',
      worker_evidence_required: true,
      worker_stats: expect.objectContaining({
        total_workers: 1,
        active_workers: 0,
        running_workers: 0,
      }),
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('queued');
  });

  it('subagent queued 工单仅有 succeeded execution_worker 时：完成回写可走通，但活跃证据与 completed 分级；live acceptance 提示缺活跃 worker', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'subagent',
      title: 'Subagent succeeded worker evidence closes contract gap',
    });
    const token = ready.assignment.assignment_token;

    await request(app)
      .post(`/api/tickets/${ticket.id}/workers`)
      .send({
        worker_key: 'subagent-succeeded-evidence',
        worker_type: 'subagent',
        status: 'running',
        session_key: `agent:beavy:ticket:${ticket.id}:worker-succeeded-evidence`,
        run_id: `subagent-succeeded-evidence-${ticket.id}`,
      })
      .expect(201);

    await request(app)
      .patch(`/api/tickets/${ticket.id}/workers/subagent-succeeded-evidence`)
      .send({ status: 'succeeded', finished_at: '2026-03-15T13:46:00.000Z' })
      .expect(200);

    const ticketBeforeReport = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketBeforeReport.body.execution_guard).toEqual(expect.objectContaining({
      has_worker_evidence: true,
      has_active_execution_evidence: false,
      has_completed_execution_evidence: true,
      total_workers: 1,
      active_workers: 0,
      running_workers: 0,
      current_workers: 0,
      succeeded_workers: 1,
    }));

    const assignmentDetail = await request(app)
      .get(`/api/v1/agent/assignments/${ready.assignment_id}`)
      .set('X-Assignment-Token', token)
      .expect(200);

    expect(assignmentDetail.body.ticket.execution_guard).toEqual(expect.objectContaining({
      has_worker_evidence: true,
      has_active_execution_evidence: false,
      succeeded_workers: 1,
    }));
    expect(assignmentDetail.body.execution).toEqual(expect.objectContaining({
      mode: 'subagent',
      worker_evidence_required: true,
      worker_evidence: expect.objectContaining({
        has_worker_evidence: true,
        worker_stats: expect.objectContaining({
          total_workers: 1,
          active_workers: 0,
          running_workers: 0,
        }),
        execution_workers: expect.arrayContaining([
          expect.objectContaining({
            worker_key: 'subagent-succeeded-evidence',
            status: 'succeeded',
          }),
        ]),
      }),
    }));

    const liveAcceptance = await request(app)
      .get(`/api/live-acceptance/tickets/${ticket.id}`)
      .expect(200);

    expect(liveAcceptance.body.data.issues.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'worker-evidence-missing' }),
    ]));

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'execution_completed',
        idempotency_key: 'subagent-report-succeeded-terminal-evidence',
        progress: { status: 'in_progress', percent: 100 },
        result: {
          summary: '仅有历史 succeeded 时完成回写仍放行（门禁看 has_worker_evidence），与活跃证据分级解耦',
          details_markdown: 'queued 自动桥接：transition guard 仍认 completed 痕迹；运营侧用 has_active_execution_evidence 识别新开工。',
        },
      })
      .expect(201);

    expect(report.body.assignment_status).toBe('submitted');
    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'submit_for_review',
      suggested_status: 'done',
      will_transition: true,
      applied: true,
      blocked_by_guard: false,
      bridge_actions: ['start_work', 'submit_for_review'],
    }));
    expect(report.body.interpreter_result.transition_preview.attempted_steps).toEqual([
      expect.objectContaining({ action: 'start_work', from_status: 'queued', success: true, to_status: 'running' }),
      expect.objectContaining({ action: 'submit_for_review', from_status: 'running', success: true, to_status: 'done' }),
    ]);

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('done');
    expect(ticketAfter.body.result_summary).toContain('仅有历史 succeeded');
  });

  it('assignment read 会返回 subagent worker 证据快照，供 reviewer/agent 校验', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'subagent',
      title: 'Subagent assignment worker evidence',
    });
    const token = ready.assignment.assignment_token;

    await request(app)
      .post(`/api/tickets/${ticket.id}/workers`)
      .send({
        worker_key: 'subagent-1',
        worker_type: 'subagent',
        status: 'running',
        session_key: 'agent:beavy:ticket:74',
        run_id: 'run-subagent-1',
      })
      .expect(201);

    const detailRes = await request(app)
      .get(`/api/v1/agent/assignments/${ready.assignment_id}`)
      .set('X-Assignment-Token', token)
      .expect(200);

    expect(detailRes.body.ticket).toEqual(expect.objectContaining({
      worker_stats: expect.objectContaining({
        total_workers: 1,
        active_workers: 1,
        running_workers: 1,
      }),
      current_workers: expect.arrayContaining([
        expect.objectContaining({
          worker_key: 'subagent-1',
          worker_type: 'subagent',
          session_key: 'agent:beavy:ticket:74',
        }),
      ]),
      execution_workers: expect.arrayContaining([
        expect.objectContaining({
          worker_key: 'subagent-1',
          worker_type: 'subagent',
          run_id: 'run-subagent-1',
        }),
      ]),
    }));
    expect(detailRes.body.execution).toEqual(expect.objectContaining({
      mode: 'subagent',
      worker_evidence_required: true,
      worker_evidence: expect.objectContaining({
        required: true,
        has_worker_evidence: true,
        worker_stats: expect.objectContaining({
          total_workers: 1,
          active_workers: 1,
          running_workers: 1,
        }),
        current_workers: expect.arrayContaining([
          expect.objectContaining({ worker_key: 'subagent-1' }),
        ]),
        execution_workers: expect.arrayContaining([
          expect.objectContaining({ worker_key: 'subagent-1' }),
        ]),
      }),
    }));
  });

  it('subagent queued 工单可从 hosted agent_report 评论派生 worker evidence，并解除 start_work 门禁', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'subagent',
      max_active_workers: 1,
      title: 'Hosted agent_report worker evidence can unblock start_work',
    });
    const token = ready.assignment.assignment_token;

    const blockedBefore = await request(app)
      .post(`/api/v1/agent/tickets/${ticket.id}/start-work`)
      .set('X-Assignment-Token', token)
      .send({ actor: 'beavy', assignment_id: ready.assignment_id })
      .expect(409);

    expect(blockedBefore.body).toEqual(expect.objectContaining({
      action: 'start_work',
      current_status: 'queued',
      execution_mode: 'subagent',
      expected_worker_type: 'subagent',
      detail: expect.stringContaining('必须先派生并登记 worker'),
    }));

    await request(app)
      .post(`/api/tickets/${ticket.id}/comments`)
      .send({
        author: 'beavy',
        type: 'decision',
        content: [
          '【agent_report】decision_request',
          `【assignment】${ready.assignment_id}`,
          '【agent】beavy',
          '【摘要】真实 subagent 已运行，但 worker evidence 尚未映射到 ticket 读模型',
          '【详情】',
          '- worker_session_key=agent:beavy:subagent-ticket:279:runctx',
          '- worker_run_id=run-hosted-comment-worker-279',
          '- worker_label=subagent-ticket-279-runctx',
          '- worker_summary=Loop child already running and writing back via hosted contract',
        ].join('\n'),
      })
      .expect(201);

    const ticketDetail = await request(app)
      .get(`/api/tickets/${ticket.id}`)
      .expect(200);

    expect(ticketDetail.body.execution_guard).toEqual(expect.objectContaining({
      has_worker_evidence: true,
      has_active_execution_evidence: true,
      current_workers: 1,
      running_workers: 1,
    }));
    expect(ticketDetail.body.current_workers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        worker_type: 'subagent',
        session_key: 'agent:beavy:subagent-ticket:279:runctx',
        run_id: 'run-hosted-comment-worker-279',
        status: 'running',
        metadata: expect.objectContaining({
          source: 'agent_report_comment',
          report_type: 'decision_request',
        }),
      }),
    ]));
    expect(ticketDetail.body.execution_workers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        session_key: 'agent:beavy:subagent-ticket:279:runctx',
        run_id: 'run-hosted-comment-worker-279',
      }),
    ]));

    const workersRes = await request(app)
      .get(`/api/tickets/${ticket.id}/workers`)
      .expect(200);

    expect(workersRes.body.worker_stats).toEqual(expect.objectContaining({
      total_workers: 1,
      active_workers: 1,
      running_workers: 1,
    }));
    expect(workersRes.body.workers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        session_key: 'agent:beavy:subagent-ticket:279:runctx',
        run_id: 'run-hosted-comment-worker-279',
        metadata: expect.objectContaining({
          source: 'agent_report_comment',
        }),
      }),
    ]));

    const assignmentDetail = await request(app)
      .get(`/api/v1/agent/assignments/${ready.assignment_id}`)
      .set('X-Assignment-Token', token)
      .expect(200);

    expect(assignmentDetail.body.ticket.execution_guard).toEqual(expect.objectContaining({
      has_worker_evidence: true,
      has_active_execution_evidence: true,
      current_workers: 1,
    }));
    expect(assignmentDetail.body.ticket.current_workers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        session_key: 'agent:beavy:subagent-ticket:279:runctx',
        run_id: 'run-hosted-comment-worker-279',
      }),
    ]));

    const started = await request(app)
      .post(`/api/v1/agent/tickets/${ticket.id}/start-work`)
      .set('X-Assignment-Token', token)
      .send({ actor: 'beavy', assignment_id: ready.assignment_id })
      .expect(200);

    expect(started.body.ticket).toEqual(expect.objectContaining({
      status: 'running',
      execution_guard: expect.objectContaining({
        has_worker_evidence: true,
        has_active_execution_evidence: true,
      }),
    }));
  });

  it('heartbeat 幂等，report 可由平台解释并推进到 done', async () => {
    const { ticket, ready } = await createReadyAssignment();
    const token = ready.assignment.assignment_token;

    const hb1 = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/heartbeat`)
      .send({
        assignment_token: token,
        idempotency_key: 'hb-1',
        progress: { status: 'in_progress', percent: 20, message: '开始实现 assignment registry' },
      })
      .expect(201);

    expect(hb1.body.assignment_status).toBe('in_progress');
    expect(hb1.body.validation_audit_id).toBeTruthy();

    const hb2 = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/heartbeat`)
      .send({
        assignment_token: token,
        idempotency_key: 'hb-1',
        progress: { status: 'in_progress', percent: 20, message: '开始实现 assignment registry' },
      })
      .expect(200);

    expect(hb2.body.idempotent).toBe(true);

    const report1 = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'execution_completed',
        idempotency_key: 'report-1',
        progress: { status: 'in_progress', percent: 100 },
        result: {
          summary: 'agent-facing API MVP 后端已落最小闭环',
          details_markdown: '已包含 assignment/read/report/heartbeat/interpreter。',
        },
      })
      .expect(201);

    expect(report1.body.assignment_status).toBe('submitted');
    expect(report1.body.validation_audit_id).toBeTruthy();
    expect(report1.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'submit_for_review',
      suggested_status: 'done',
      applied: true,
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('done');
    expect(ticketAfter.body.result_summary).toContain('agent-facing API MVP');
    expect(ticketAfter.body.comments).toEqual(expect.arrayContaining([
      expect.objectContaining({ author: 'beavy', type: 'result' }),
    ]));

    const report2 = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'execution_completed',
        idempotency_key: 'report-1',
        progress: { status: 'in_progress', percent: 100 },
        result: {
          summary: 'agent-facing API MVP 后端已落最小闭环',
          details_markdown: '已包含 assignment/read/report/heartbeat/interpreter。',
        },
      })
      .expect(409);

    expect(report2.body).toEqual(expect.objectContaining({
      code: 'ASSIGNMENT_STALE',
      detail: expect.stringContaining('assignment 已过期'),
      request_id: expect.any(String),
      machine_readable: expect.objectContaining({
        code: 'ASSIGNMENT_STALE',
        codes: expect.arrayContaining(['ASSIGNMENT_STALE']),
        errors: expect.arrayContaining([
          expect.objectContaining({ code: 'ASSIGNMENT_STALE' }),
        ]),
      }),
    }));

    const ticketAfterDuplicate = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    const beavyResultComments = ticketAfterDuplicate.body.comments.filter((comment) => comment.author === 'beavy' && comment.type === 'result');
    expect(beavyResultComments).toHaveLength(1);
  });


  it('submit_for_review 会清掉 legacy next_actor，done 阶段不再把执行人当 residual override', async () => {
    const created = await request(app).post('/api/tickets').send({
      title: 'Clear legacy next_actor on submit_for_review',
      triage_owner: 'leoss',
      assigned_agent: 'beavy',
      review_owner: 'leoss',
      status: 'queued',
    }).expect(201);

    const ticketId = created.body.id;
    await request(app).post(`/api/tickets/${ticketId}/transition`).send({ action: 'start_work', actor: 'beavy' }).expect(200);
    await request(app).post(`/api/tickets/${ticketId}/transition`).send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'ready for review' }).expect(200);

    const detail = await request(app).get(`/api/tickets/${ticketId}`).expect(200);
    expect(detail.body.status).toBe('done');
    expect(detail.body.current_actor).toBe('leoss');
    expect(detail.body.next_actor).toBe('leoss');
    expect(detail.body.next_actor_override).toBeNull();
    expect(detail.body.manual_override_active).toBe(false);

    const raw = getTicketById(ticketId);
    expect(raw.next_actor).toBeNull();
    expect(raw.next_actor_override).toBeNull();

    const projection = getTicketProjection(ticketId);
    expect(projection.current_actor).toBe('leoss');
    expect(projection.next_actor).toBe('leoss');
  });

  it('submit_for_review 后 active execution workers 收为 terminal，reviewer 恢复出现在 dispatch/ready', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'subagent',
      max_active_workers: 1,
      review_owner: 'leoss',
      title: 'Submit then reviewer dispatch',
    });
    await request(app)
      .post(`/api/tickets/${ticket.id}/workers`)
      .send({
        worker_key: 'w1',
        worker_type: 'subagent',
        status: 'running',
        session_key: 'sk',
        run_id: 'r1',
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${ticket.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    const detailBefore = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(detailBefore.body.worker_stats.active_workers).toBe(1);
    expect(detailBefore.body.execution_guard?.suppress_dispatch).toBe(false);
    expect(detailBefore.body.execution_guard?.reason).toBe('running_assignment_refresh');

    await request(app)
      .post(`/api/tickets/${ticket.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'ready for review' })
      .expect(200);

    const detailAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(detailAfter.body.status).toBe('done');
    expect(detailAfter.body.worker_stats.active_workers).toBe(0);
    expect(detailAfter.body.execution_guard?.suppress_dispatch).toBe(false);
    expect(detailAfter.body.current_workers).toHaveLength(0);

    const dispatchRes = await request(app).get('/api/dispatch/ready').expect(200);
    const reviewerItem = dispatchRes.body.ready.find((item) => item.ticket_id === ticket.id && item.agent === 'leoss');
    expect(reviewerItem).toBeDefined();
    expect(reviewerItem.status).toBe('done');
  });

  it('queued -> running auto-start successor assignment 会回填 dispatch route 的 target_session_key / gateway / transport', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Queued auto-start successor route fallback',
        description: 'verify running successor route fallback',
        status: 'queued',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        execution_mode: 'subagent',
        max_active_workers: 1,
      })
      .expect(201);
    const ticketId = createRes.body.id;

    const dispatchResBefore = await request(app).get('/api/dispatch/ready').expect(200);
    const queuedDispatch = dispatchResBefore.body.ready.find((item) => item.ticket_id === ticketId && item.status === 'queued');
    expect(queuedDispatch).toBeDefined();

    const assignmentId = queuedDispatch.assignment_id;
    const token = queuedDispatch.assignment.assignment_token;

    await request(app)
      .post(`/api/agent/assignments/${assignmentId}/reports`)
      .send({
        assignment_token: token,
        report_type: 'dispatch_receipt',
        idempotency_key: `receipt-auto-route-${ticketId}`,
        progress: { status: 'in_progress', percent: 5 },
        receipt: {
          dispatch_id: queuedDispatch.dispatch_id,
          ticket_id: ticketId,
          stage: 'queued',
          agent: 'beavy',
          decision: 'accepted',
          target_session_key: `agent:beavy:ticket:${ticketId}`,
          message: 'accepted queued assignment before worker registration',
        },
      })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${ticketId}/workers`)
      .send({
        worker_key: 'auto-route',
        worker_type: 'subagent',
        status: 'running',
        session_key: `agent:beavy:subagent:auto-route-${ticketId}`,
        run_id: `run-auto-route-${ticketId}`,
      })
      .expect(201);

    const detail = await request(app).get(`/api/tickets/${ticketId}`).expect(200);
    expect(detail.body.status).toBe('running');
    expect(detail.body.execution_guard).toEqual(expect.objectContaining({
      has_worker_evidence: true,
      has_active_execution_evidence: true,
    }));

    const runningAssignment = findLatestAssignmentForTicket(ticketId, 'beavy');
    expect(runningAssignment).toBeDefined();
    expect(runningAssignment.stage).toBe('running');
    expect(runningAssignment.target_session_key).toBe(`agent:beavy:ticket:${ticketId}`);
    expect(runningAssignment.gateway_id).toBe('mac-main');
    expect(runningAssignment.transport).toBe('local_cli');

    const dispatchResAfter = await request(app).get('/api/dispatch/ready').expect(200);
    const runningDispatch = dispatchResAfter.body.ready.find((item) => item.ticket_id === ticketId && item.status === 'running');
    expect(runningDispatch).toBeDefined();
    expect(runningDispatch.target_session_key).toBe(`agent:beavy:ticket:${ticketId}`);
    expect(runningDispatch.target_gateway_id).toBe('mac-main');
    expect(runningDispatch.transport).toBe('local_cli');
  });

  it('stale starting worker 不算 worker evidence，需补真实 worker 后才能开工；done 后不压制 reviewer dispatch', async () => {
    const { ticket: created } = await createReadyAssignment({
      title: 'Done with stale starting',
      status: 'queued',
      assigned_agent: 'beavy',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      execution_mode: 'subagent',
      max_active_workers: 1,
    });
    await request(app)
      .post(`/api/tickets/${created.id}/workers`)
      .send({
        worker_key: 'stale',
        worker_type: 'subagent',
        status: 'starting',
      })
      .expect(201);

    const blockedStart = await request(app)
      .post(`/api/tickets/${created.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(409);
    expect(blockedStart.body.error).toBe('EXECUTION_WORKER_REQUIRED');

    const detailBefore = await request(app).get(`/api/tickets/${created.id}`).expect(200);
    expect(detailBefore.body.status).toBe('queued');
    expect(detailBefore.body.worker_stats.active_workers).toBe(0);
    expect(detailBefore.body.execution_guard).toEqual(expect.objectContaining({
      requires_worker: true,
      has_worker_evidence: false,
      suppress_dispatch: false,
    }));

    const workerRes = await request(app)
      .post(`/api/tickets/${created.id}/workers`)
      .send({
        worker_key: 'real',
        worker_type: 'subagent',
        status: 'running',
        session_key: 'agent:beavy:ticket:stale-fix',
        run_id: 'run-stale-fix',
      })
      .expect(201);
    expect(workerRes.body.ticket.status).toBe('queued');
    expect(workerRes.body.ticket.execution_guard).toEqual(expect.objectContaining({
      has_worker_evidence: true,
      active_workers: 1,
      suppress_dispatch: true,
      reason: 'active_worker_in_progress',
    }));

    await request(app)
      .post(`/api/tickets/${created.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${created.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'done' })
      .expect(200);
    const detail = await request(app).get(`/api/tickets/${created.id}`).expect(200);
    expect(detail.body.status).toBe('done');
    expect(detail.body.worker_stats.active_workers).toBe(0);
    expect(detail.body.current_workers).toHaveLength(0);
    expect(detail.body.execution_guard?.suppress_dispatch).toBe(false);
    const dispatchRes = await request(app).get('/api/dispatch/ready').expect(200);
    const item = dispatchRes.body.ready.find((r) => r.ticket_id === created.id);
    expect(item).toBeDefined();
    expect(item.agent).toBe('leoss');
  });

  it('decision_request report 由平台解释为 pending_decision', async () => {
    const { ticket, ready } = await createReadyAssignment();
    const token = ready.assignment.assignment_token;

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'decision_request',
        idempotency_key: 'decision-1',
        result: {
          summary: '需要老大确认是否继续开放 reviewer assignment 化',
          details_markdown: 'MVP 已闭环，但 Phase 2 范围需要老大拍板。',
        },
      })
      .expect(201);

    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'request_decision',
      suggested_status: 'pending_decision',
      applied: true,
      bridge_actions: ['request_decision'],
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('pending_decision');
    expect(ticketAfter.body.decision_summary).toContain('需要老大确认');
  });

  it('queued 工单 blocked_report 不桥接 start_work，直接 block', async () => {
    const { ticket, ready } = await createReadyAssignment();
    const token = ready.assignment.assignment_token;

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'blocked_report',
        idempotency_key: 'blocked-1',
        result: { summary: '依赖 #99 未完成' },
      })
      .expect(201);

    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'block',
      suggested_status: 'blocked',
      applied: true,
      bridge_actions: ['block'],
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('blocked');
  });

  it('queued 工单 execution_failed 不桥接 start_work，直接 fail', async () => {
    const { ticket, ready } = await createReadyAssignment();
    const token = ready.assignment.assignment_token;

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'execution_failed',
        idempotency_key: 'fail-1',
        result: { summary: '环境不可用' },
      })
      .expect(201);

    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'fail',
      suggested_status: 'failed',
      applied: true,
      bridge_actions: ['fail'],
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('failed');
  });

  it('queued subagent/acp 工单收到 decision_request 时，不需要先 start_work 也能推进到 pending_decision', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'acp',
      title: 'Queued ACP decision request without worker',
    });
    const token = ready.assignment.assignment_token;

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'decision_request',
        idempotency_key: 'decision-queued-acp-no-worker',
        result: {
          summary: 'acpx backend 缺失，需要 reviewer 决策 execution_mode',
          details_markdown: '当前 queued 且无 worker evidence；应允许直接进入 pending_decision，而不是被 start_work 卡住。',
        },
      })
      .expect(201);

    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'request_decision',
      suggested_status: 'pending_decision',
      applied: true,
      bridge_actions: ['request_decision'],
      attempted_steps: [
        expect.objectContaining({ action: 'request_decision', from_status: 'queued', success: true, to_status: 'pending_decision' }),
      ],
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('pending_decision');
  });

  it('queued acp 工单收到 blocked_report 时，不需要先 start_work 也能推进到 blocked', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'acp',
      title: 'Queued ACP blocked without worker',
    });
    const token = ready.assignment.assignment_token;

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'blocked_report',
        idempotency_key: 'blocked-queued-acp-no-worker',
        observation: {
          summary: 'acpx backend 缺失，无法启动真实 worker',
        },
        proposed_next_step: {
          suggested_status: 'blocked',
          reason: '等待 runtime 或改 execution_mode',
        },
      })
      .expect(201);

    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'block',
      suggested_status: 'blocked',
      applied: true,
      bridge_actions: ['block'],
      attempted_steps: [
        expect.objectContaining({ action: 'block', from_status: 'queued', success: true, to_status: 'blocked' }),
      ],
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('blocked');
  });

  it('queued acp 工单收到 execution_failed 时，不需要先 start_work 也能推进到 failed', async () => {
    const { ticket, ready } = await createReadyAssignment({
      execution_mode: 'acp',
      title: 'Queued ACP fail without worker',
    });
    const token = ready.assignment.assignment_token;

    const report = await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: token,
        report_type: 'execution_failed',
        idempotency_key: 'failed-queued-acp-no-worker',
        error: {
          message: '宿主未配置 acpx backend，无法启动 ACP worker',
        },
      })
      .expect(201);

    expect(report.body.interpreter_result.transition_preview).toEqual(expect.objectContaining({
      action: 'fail',
      suggested_status: 'failed',
      applied: true,
      bridge_actions: ['fail'],
      attempted_steps: [
        expect.objectContaining({ action: 'fail', from_status: 'queued', success: true, to_status: 'failed' }),
      ],
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('failed');
  });

  it('远端 assignment 未配置 agent API base url 时，不再下发错误 localhost', async () => {
    delete process.env.TICKET_AGENT_API_BASE_URL;
    delete process.env.TICKET_API_BASE_URL;

    const { ticket: created, ready } = await createReadyAssignment({
      title: 'Remote agent-facing MVP',
      description: '验证远端 contract 不下发 localhost',
      assigned_agent: 'donky',
      triage_owner: 'leoss',
      review_owner: 'leoss',
    });

    expect(ready).toBeDefined();
    expect(ready.target_gateway_id).toBe('pc-stock');
    expect(ready.assignment.runtime_context.api_base_url).toBe(null);
    expect(ready.assignment.runtime_context.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'REMOTE_AGENT_API_BASE_URL_MISSING',
        severity: 'warning',
        env_config: 'TICKET_AGENT_API_BASE_URL',
        gateway_id: 'pc-stock',
      }),
    ]));
    expect(ready.message).toContain('UNCONFIGURED_REMOTE_API_BASE_URL');
    expect(ready.message).toContain('TICKET_AGENT_API_BASE_URL');

    const detailRes = await request(app)
      .get(`/api/v1/agent/assignments/${ready.assignment_id}`)
      .query({ assignment_token: ready.assignment.assignment_token })
      .expect(200);

    expect(detailRes.body.runtime_context.api_base_url).toBe(null);
    expect(detailRes.body.runtime_context.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'REMOTE_AGENT_API_BASE_URL_MISSING',
        gateway_id: 'pc-stock',
      }),
    ]));
  });

  it('显式配置 TICKET_AGENT_API_BASE_URL 后，远端 assignment 返回可访问 base url', async () => {
    process.env.TICKET_AGENT_API_BASE_URL = 'http://192.168.3.10:8788';

    const created = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Remote agent-facing MVP with explicit base url',
        description: '验证远端 contract 使用显式 API base url',
        assigned_agent: 'donky',
        triage_owner: 'leoss',
        review_owner: 'leoss',
      })
      .expect(201);

    const readyRes = await request(app).get('/api/dispatch/ready').expect(200);
    const ready = readyRes.body.ready.find((item) => item.ticket_id === created.body.id);

    expect(ready).toBeDefined();
    expect(ready.assignment.runtime_context.api_base_url).toBe('http://192.168.3.10:8788');
    expect(ready.message).toContain('api_base_url: http://192.168.3.10:8788');
    expect(ready.message).not.toContain('UNCONFIGURED_REMOTE_API_BASE_URL');

    const runtimeRes = await request(app)
      .get('/api/v1/agent/runtime/context')
      .query({
        assignment_id: ready.assignment_id,
        assignment_token: ready.assignment.assignment_token,
      })
      .expect(200);

    expect(runtimeRes.body.data.api_base_url).toBe('http://192.168.3.10:8788');
    expect(runtimeRes.body.data.warnings).toEqual([]);
    expect(runtimeRes.body.data.workboards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'stock-tickets',
        url: 'http://192.168.3.10:8788/api/v1/agent/workboards/stock-tickets',
      }),
    ]));

    delete process.env.TICKET_AGENT_API_BASE_URL;
  });
});

describe('live acceptance gate API', () => {
  async function createTicketWithStatus(payload, status = 'triage') {
    const createRes = await request(app)
      .post('/api/tickets')
      .send(payload)
      .expect(201);

    if (status && status !== 'triage') {
      const { updateTicket } = await import('./store.js');
      updateTicket(createRes.body.id, { status });
      return request(app).get(`/api/tickets/${createRes.body.id}`).expect(200).then((res) => res.body);
    }

    return createRes.body;
  }

  beforeEach(() => {
    ensureCleanStore();
    delete process.env.TICKET_AGENT_API_BASE_URL;
    delete process.env.TICKET_API_BASE_URL;
  });

  it('GET /api/live-acceptance/tickets/:id 返回 pass verdict 与 live surface 摘要', async () => {
    const ticket = await createTicketWithStatus({
      title: 'Live acceptance pass',
      assigned_agent: 'beavy',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      execution_mode: 'direct',
    }, 'running');

    const readyRes = await request(app).get('/api/dispatch/ready').expect(200);
    const ready = readyRes.body.ready.find((item) => item.ticket_id === ticket.id);
    expect(ready).toBeDefined();

    const res = await request(app)
      .get(`/api/live-acceptance/tickets/${ticket.id}`)
      .expect(200);

    expect(res.body.data).toEqual(expect.objectContaining({
      verdict: 'pass',
      summary: expect.stringContaining('通过'),
      live_surfaces: expect.objectContaining({
        runtime_context: expect.objectContaining({
          canonical_prefix: '/api/v1/agent',
          auth_transport: 'X-Assignment-Token',
        }),
        hosted_bundle: expect.objectContaining({
          version: expect.any(String),
          checksum_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          ticket_actions: expect.arrayContaining(['create', 'pause', 'resume', 'approve', 'reject']),
        }),
        assignment: expect.objectContaining({
          assignment_id: ready.assignment_id,
        }),
        dependencies: expect.objectContaining({
          total: 0,
          unresolved: 0,
        }),
      }),
      issues: expect.objectContaining({
        contract_mismatches: [],
        unresolved_dependencies: [],
      }),
    }));
  });

  it('GET /api/live-acceptance/tickets/:id 支持 dependency-not-closed / live-not-upgraded / contract-mismatch verdict', async () => {
    const blockedDep = await createTicketWithStatus({
      title: 'Blocking dependency',
      assigned_agent: 'donky',
      triage_owner: 'leoss',
    }, 'running');

    const ticket = await createTicketWithStatus({
      title: 'Live acceptance dependency gate',
      assigned_agent: 'beavy',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      execution_mode: 'direct',
    }, 'running');

    await request(app)
      .post(`/api/tickets/${ticket.id}/dependencies`)
      .send({ depends_on_ticket_id: blockedDep.id, dependency_type: 'blocks' })
      .expect(200);

    const depRes = await request(app)
      .get(`/api/live-acceptance/tickets/${ticket.id}`)
      .expect(200);
    expect(depRes.body.data.verdict).toBe('dependency-not-closed');
    expect(depRes.body.data.issues.unresolved_dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticket_id: blockedDep.id, status: 'running' }),
    ]));

    await request(app)
      .delete(`/api/tickets/${ticket.id}/dependencies/${blockedDep.id}`)
      .expect(200);

    const liveNotUpgradedRes = await request(app)
      .get(`/api/live-acceptance/tickets/${ticket.id}`)
      .query({ expected_bundle_version: '2099-01-01.bundle.v999' })
      .expect(200);
    expect(liveNotUpgradedRes.body.data.verdict).toBe('live-not-upgraded');
    expect(liveNotUpgradedRes.body.data.issues.live_not_upgraded).toEqual(expect.objectContaining({
      expected_bundle_version: '2099-01-01.bundle.v999',
      actual_bundle_version: expect.any(String),
    }));

    const mismatchRes = await request(app)
      .get(`/api/live-acceptance/tickets/${ticket.id}`)
      .query({ required_ticket_actions: 'create,pause,approve,reject,nonexistent_action' })
      .expect(200);
    expect(mismatchRes.body.data.verdict).toBe('contract-mismatch');
    expect(mismatchRes.body.data.issues.contract_mismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'missing-ticket-action',
        message: expect.stringContaining('nonexistent_action'),
      }),
    ]));
  });
});

describe('runtime version and dispatch/review/worker contract regression', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('GET /api/version 返回运行态版本契约：git_commit、build_time、schema_version、bundle_version 与 production baseline identity', async () => {
    const res = await request(app).get('/api/version').expect(200);
    expect(res.body.data).toEqual(expect.objectContaining({
      schema_version: expect.any(String),
      bundle_version: expect.any(String),
      build_time: expect.any(String),
      production_repo: expect.any(String),
      repo_root: expect.any(String),
      working_directory: expect.any(String),
      release_fingerprint: expect.any(String),
      environment: 'production',
    }));
    expect(typeof res.body.data.git_commit === 'string' || res.body.data.git_commit === null).toBe(true);
    expect(res.body.data.schema_version.length).toBeGreaterThan(0);
    expect(res.body.data.bundle_version.length).toBeGreaterThan(0);
    expect(res.body.data.production_repo.length).toBeGreaterThan(0);
    expect(res.body.data.repo_root.length).toBeGreaterThan(0);
    expect(res.body.data.release_fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(res.body.data.build_time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('live acceptance 响应包含 runtime_version，与 GET /api/version 一致', async () => {
    const ticketRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Version gate',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${ticketRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    const versionRes = await request(app).get('/api/version').expect(200);
    const gateRes = await request(app)
      .get(`/api/live-acceptance/tickets/${ticketRes.body.id}`)
      .expect(200);
    expect(gateRes.body.data.live_surfaces.runtime_version).toBeDefined();
    expect(gateRes.body.data.live_surfaces.runtime_version.schema_version).toBe(versionRes.body.data.schema_version);
    expect(gateRes.body.data.live_surfaces.runtime_version.bundle_version).toBe(versionRes.body.data.bundle_version);
    expect(gateRes.body.data.live_surfaces.runtime_version.git_commit).toBe(versionRes.body.data.git_commit);
    expect(gateRes.body.data.live_surfaces.runtime_version.production_repo).toBe(versionRes.body.data.production_repo);
    expect(gateRes.body.data.live_surfaces.runtime_version.repo_root).toBe(versionRes.body.data.repo_root);
    expect(gateRes.body.data.live_surfaces.runtime_version.release_fingerprint).toBe(versionRes.body.data.release_fingerprint);
  });

  it('dispatch ready 单条契约包含 dispatch_id、ticket_id、agent、target_session_key、target_gateway_id、transport、dedupe_key、reason、escalation_tier 与关键观测字段', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Dispatch contract',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${createRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${createRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'donky' })
      .expect(200);
    const res = await request(app).get('/api/dispatch/ready').expect(200);
    const item = res.body.ready.find((r) => r.ticket_id === createRes.body.id);
    expect(item).toBeDefined();
    expect(item).toEqual(expect.objectContaining({
      request_id: expect.any(String),
      dispatch_id: expect.any(Number),
      dispatch_event_id: expect.any(Number),
      ticket_id: createRes.body.id,
      assignment_id: expect.any(String),
      agent: 'donky',
      target_agent: 'donky',
      target_session: expect.any(String),
      target_session_key: expect.any(String),
      target_gateway_id: expect.any(String),
      transport: expect.any(String),
      status_before: 'running',
      status_after: 'running',
      computed_actor: expect.any(String),
      override_actor: null,
      dedupe_key: expect.any(String),
      reason: expect.any(String),
      escalation_tier: expect.any(String),
    }));
    expect(item.target_session).toBe(`agent:donky:ticket:${createRes.body.id}`);
    expect(item.target_session_key).toBe(`agent:donky:ticket:${createRes.body.id}`);
    expect(item.dispatch_event_id).toBe(item.dispatch_id);
    expect(item.dedupe_key).toBe('dispatch:running:assignment:donky');
  });

  it('review 链：done 工单进入 dispatch ready 给 review_owner，receipt accepted 后推进 start_review', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Review chain',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'beavy',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'donky' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'submit_for_review', actor: 'donky', result_summary: 'done' })
      .expect(200);

    const dispatchRes = await request(app).get('/api/dispatch/ready').expect(200);
    const readyItem = dispatchRes.body.ready.find((r) => r.ticket_id === ticketId);
    expect(readyItem).toBeDefined();
    expect(readyItem.agent).toBe('beavy');
    expect(readyItem.reason).toBe('done');
    const assignmentId = readyItem.assignment_id;
    const token = readyItem.assignment?.assignment_token;
    expect(assignmentId).toBeDefined();
    expect(token).toBeDefined();

    await request(app).post(`/api/dispatch/${readyItem.dispatch_id}/ack`).expect(200);
    await request(app)
      .post(`/api/v1/agent/assignments/${assignmentId}/reports`)
      .set('x-assignment-token', token)
      .send({
        report_type: 'dispatch_receipt',
        idempotency_key: 'review-receipt-1',
        receipt: {
          dispatch_id: readyItem.dispatch_id,
          ticket_id: ticketId,
          stage: 'done',
          agent: 'beavy',
          decision: 'accepted',
          message: 'reviewer 已接单',
        },
        progress: { status: 'in_progress', percent: 5, message: 'accepted' },
      })
      .expect(201);

    const ticketAfter = await request(app).get(`/api/tickets/${ticketId}`).expect(200);
    expect(ticketAfter.body.status).toBe('review');
  });

  it('dispatch ready 会跳过 advance_chain 非法的被派发阶段', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Invalid running advance chain',
        description: 'missing assigned agent should block dispatch',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);

    const ticketId = createRes.body.id;
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ assigned_agent: '' })
      .expect(200);

    const detailRes = await request(app)
      .get(`/api/tickets/${ticketId}`)
      .expect(200);
    expect(detailRes.body.status).toBe('running');
    expect(detailRes.body.advance_chain).toEqual(expect.objectContaining({
      ok: false,
      code: 'DISPATCH_ADVANCE_CHAIN_INVALID',
      stage: 'running',
      missing_fields: expect.arrayContaining(['assigned_agent']),
    }));

    const readyRes = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    expect(readyRes.body.ready.find((r) => r.ticket_id === ticketId)).toBeUndefined();
  });

  it('worker 契约：POST /workers 必填 worker_key/worker_type，返回 execution_guard 含 suppress_dispatch、requires_worker、has_worker_evidence', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Worker contract',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
        execution_mode: 'subagent',
        max_active_workers: 1,
      })
      .expect(201);
    const ticketId = createRes.body.id;
    const workerRes = await request(app)
      .post(`/api/tickets/${ticketId}/workers`)
      .send({ worker_key: 'sub-1', worker_type: 'subagent', run_id: 'run-1', session_key: 'agent:beavy:ticket:1' })
      .expect(201);
    expect(workerRes.body.worker).toEqual(expect.objectContaining({
      worker_key: 'sub-1',
      worker_type: 'subagent',
    }));
    expect(workerRes.body.ticket.execution_guard).toEqual(expect.objectContaining({
      suppress_dispatch: true,
      requires_worker: true,
      has_worker_evidence: true,
      active_workers: 1,
      total_workers: 1,
    }));
  });
});

describe('agent admin stock management APIs', () => {
  const ADMIN_TOKEN = 'stock-admin-token';

  async function createTicketWithStatus(payload, status = 'triage') {
    const createRes = await request(app)
      .post('/api/tickets')
      .send(payload)
      .expect(201);

    if (status && status !== 'triage') {
      const { updateTicket } = await import('./store.js');
      updateTicket(createRes.body.id, { status });
      return request(app).get(`/api/tickets/${createRes.body.id}`).expect(200).then((res) => res.body);
    }

    return createRes.body;
  }

  beforeEach(() => {
    ensureCleanStore();
    process.env.TICKET_AGENT_ADMIN_TOKENS_JSON = JSON.stringify({
      cowder_stock_admin: {
        token: ADMIN_TOKEN,
        agent_id: 'cowder',
        capabilities: ['stock_tickets:read', 'stock_tickets:create', 'stock_tickets:comment', 'stock_tickets:transition'],
      },
    });
  });

  it('未携带 agent-admin token 时返回统一 401 错误模型', async () => {
    const res = await request(app)
      .get('/api/v1/admin/stock-tickets')
      .expect(401);

    expect(res.body).toEqual(expect.objectContaining({
      detail: 'agent-admin token 无效或缺失',
      request_id: expect.any(String),
    }));
    expect(res.body.error).toBeUndefined();
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('legacy /api/admin alias 与 X-Agent-Admin-Token 仍可读取 stock workboard', async () => {
    const stockTicket = await createTicketWithStatus({
      title: 'Legacy stock admin target',
      platform: 'stock-platform',
      assigned_agent: 'cowder',
      triage_owner: 'leoss',
      review_owner: 'leoss',
    }, 'running');

    const res = await request(app)
      .get('/api/admin/stock-tickets')
      .set('X-Agent-Admin-Token', ADMIN_TOKEN)
      .query({ assigned_agent: 'cowder' })
      .expect(200);

    expect(res.body.data.auth).toEqual(expect.objectContaining({
      role: 'agent_admin',
      agent_id: 'cowder',
    }));
    expect(res.body.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: stockTicket.id, platform: 'stock-platform' }),
    ]));
  });

  it('agent-admin token 会校验 capability，且 comment / transition 不允许伪装身份', async () => {
    process.env.TICKET_AGENT_ADMIN_TOKENS_JSON = JSON.stringify({
      cowder_stock_admin: {
        token: ADMIN_TOKEN,
        agent_id: 'cowder',
        capabilities: ['stock_tickets:read'],
      },
    });

    const stockTicket = await createTicketWithStatus({
      title: 'Restricted stock admin target',
      platform: 'stock-platform',
      assigned_agent: 'cowder',
      triage_owner: 'leoss',
      review_owner: 'leoss',
    }, 'running');

    const capabilityRes = await request(app)
      .post(`/api/v1/admin/stock-tickets/${stockTicket.id}/comments`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ content: 'should be rejected by capability' })
      .expect(403);

    expect(capabilityRes.body).toEqual(expect.objectContaining({
      detail: '当前 agent-admin token 缺少能力：stock_tickets:comment',
      required_capability: 'stock_tickets:comment',
    }));
    expect(capabilityRes.body.error).toBeUndefined();

    process.env.TICKET_AGENT_ADMIN_TOKENS_JSON = JSON.stringify({
      cowder_stock_admin: {
        token: ADMIN_TOKEN,
        agent_id: 'cowder',
        capabilities: ['stock_tickets:read', 'stock_tickets:comment', 'stock_tickets:transition'],
      },
    });

    const impersonateCommentRes = await request(app)
      .post(`/api/v1/admin/stock-tickets/${stockTicket.id}/comments`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ content: 'bad impersonation', author: 'beavy' })
      .expect(403);

    expect(impersonateCommentRes.body).toEqual(expect.objectContaining({
      detail: 'agent-admin comment 不允许伪装为其他 author',
      expected_author: 'cowder',
    }));
    expect(impersonateCommentRes.body.error).toBeUndefined();

    const impersonateTransitionRes = await request(app)
      .post(`/api/v1/admin/stock-tickets/${stockTicket.id}/transition`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ action: 'pause', actor: 'beavy', pause_reason: 'bad impersonation' })
      .expect(403);

    expect(impersonateTransitionRes.body).toEqual(expect.objectContaining({
      detail: 'agent-admin transition 不允许伪装为其他 actor',
      expected_actor: 'cowder',
    }));
    expect(impersonateTransitionRes.body.error).toBeUndefined();
  });

  it('agent-admin 可创建 stock-platform 工单并留下 control-ui 留痕', async () => {
    const res = await request(app)
      .post('/api/v1/admin/stock-tickets')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({
        title: 'Stock admin create target',
        description: 'Create via control-ui stock admin',
        platform: 'stock-platform',
        triage_owner: 'cowder',
        assigned_agent: 'marely',
        review_owner: 'leoss',
      })
      .expect(201);

    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      ticket: expect.objectContaining({
        title: 'Stock admin create target',
        platform: 'stock-platform',
        triage_owner: 'cowder',
        assigned_agent: 'marely',
        review_owner: 'leoss',
        current_actor: 'cowder',
        next_actor: 'cowder',
      }),
      audit_comment: expect.objectContaining({
        author: 'cowder',
        type: 'system',
        metadata: expect.objectContaining({
          source: 'control-ui-stock-admin',
          actor: 'cowder',
          explicit_triage_owner: 'cowder',
          explicit_assigned_agent: 'marely',
          explicit_review_owner: 'leoss',
        }),
      }),
      auth: expect.objectContaining({
        role: 'agent_admin',
        agent_id: 'cowder',
      }),
    }));

    const detailRes = await request(app)
      .get(`/api/v1/admin/stock-tickets/${res.body.ticket.id}/comments`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .expect(200);

    expect(detailRes.body.comments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        author: 'cowder',
        type: 'system',
        metadata: expect.objectContaining({
          source: 'control-ui-stock-admin',
        }),
      }),
    ]));
  });

  it('agent-admin 可读取 stock 工单盘面，并以自身身份 comment / transition', async () => {
    const stockTicket = await createTicketWithStatus({
      title: 'Stock admin target',
      platform: 'stock-platform',
      assigned_agent: 'cowder',
      triage_owner: 'leoss',
      review_owner: 'leoss',
    }, 'running');

    const nonStockTicket = await createTicketWithStatus({
      title: 'Ticket platform control',
      platform: 'ticket-platform',
      assigned_agent: 'beavy',
      triage_owner: 'leoss',
      review_owner: 'leoss',
    }, 'running');

    const listRes = await request(app)
      .get('/api/v1/admin/stock-tickets')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .query({ assigned_agent: 'cowder' })
      .expect(200);

    expect(listRes.body.data.auth).toEqual(expect.objectContaining({
      role: 'agent_admin',
      agent_id: 'cowder',
      capabilities: expect.arrayContaining(['stock_tickets:read', 'stock_tickets:create', 'stock_tickets:comment', 'stock_tickets:transition']),
      contract: expect.objectContaining({
        scheme: 'agent_admin_token',
        preferred_transport: expect.objectContaining({ name: 'Authorization' }),
      }),
      error_model: expect.objectContaining({
        shape: expect.objectContaining({ detail: 'string', request_id: 'string' }),
      }),
    }));
    expect(listRes.body.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: stockTicket.id,
        platform: 'stock-platform',
        assigned_agent: 'cowder',
      }),
    ]));

    const actionsRes = await request(app)
      .get(`/api/v1/admin/stock-tickets/${stockTicket.id}/actions`)
      .set('X-Agent-Admin-Token', ADMIN_TOKEN)
      .expect(200);

    expect(actionsRes.body).toEqual(expect.objectContaining({
      ticket_id: stockTicket.id,
      current_status: 'running',
      available_actions: expect.arrayContaining(['submit_for_review', 'request_decision', 'pause', 'block', 'fail']),
    }));

    const commentRes = await request(app)
      .post(`/api/v1/admin/stock-tickets/${stockTicket.id}/comments`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({
        content: 'admin smoke comment',
        author: 'cowder',
        type: 'progress',
      })
      .expect(201);

    expect(commentRes.body).toEqual(expect.objectContaining({
      success: true,
      comment: expect.objectContaining({
        author: 'cowder',
        content: 'admin smoke comment',
      }),
    }));

    const transitionRes = await request(app)
      .post(`/api/v1/admin/stock-tickets/${stockTicket.id}/transition`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({
        action: 'submit_for_review',
        actor: 'cowder',
        result_summary: 'agent-admin smoke done',
        comment: '提交给 reviewer 验收',
      })
      .expect(200);

    expect(transitionRes.body).toEqual(expect.objectContaining({
      success: true,
      action: 'submit_for_review',
      ticket: expect.objectContaining({
        id: stockTicket.id,
        status: 'done',
        current_actor: 'leoss',
      }),
    }));

    const scopeRes = await request(app)
      .get(`/api/v1/admin/stock-tickets/${nonStockTicket.id}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .expect(403);

    expect(scopeRes.body).toEqual(expect.objectContaining({
      detail: '当前 agent-admin 接口仅允许管理 stock-platform 工单',
      ticket_id: nonStockTicket.id,
      platform: 'ticket-platform',
    }));
    expect(scopeRes.body.error).toBeUndefined();
  });
});

describe('agent-facing ticket action APIs', () => {
  beforeEach(() => {
    ensureCleanStore();
    delete process.env.TICKET_AGENT_API_BASE_URL;
    delete process.env.TICKET_API_BASE_URL;
    delete process.env.TICKET_AGENT_ADMIN_TOKENS_JSON;
  });

  async function createTicket(overrides = {}) {
    const { status, ...restOverrides } = overrides;
    const res = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Agent action ticket',
        description: 'for agent-facing ticket action api tests',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        execution_mode: 'direct',
        ...restOverrides,
      })
      .expect(201);

    if (status && status !== 'triage') {
      const { updateTicket } = await import('./store.js');
      updateTicket(res.body.id, { status });
      return request(app).get(`/api/tickets/${res.body.id}`).expect(200).then((response) => response.body);
    }

    return res.body;
  }

  async function createRunningTicket(overrides = {}) {
    const ticket = await createTicket(overrides);
    await request(app)
      .post(`/api/tickets/${ticket.id}/transition`)
      .send({ action: 'queue', actor: ticket.triage_owner || 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticket.id}/transition`)
      .send({ action: 'start_work', actor: ticket.assigned_agent })
      .expect(200);
    return request(app).get(`/api/tickets/${ticket.id}`).expect(200).then((res) => res.body);
  }

  async function createPausedTicket(overrides = {}) {
    const ticket = await createRunningTicket(overrides);
    await request(app)
      .post(`/api/tickets/${ticket.id}/transition`)
      .send({ action: 'pause', actor: ticket.assigned_agent, pause_reason: '等待外部窗口' })
      .expect(200);
    return request(app).get(`/api/tickets/${ticket.id}`).expect(200).then((res) => res.body);
  }

  async function createReviewTicket(overrides = {}) {
    const ticket = await createRunningTicket(overrides);
    await request(app)
      .post(`/api/tickets/${ticket.id}/transition`)
      .send({ action: 'submit_for_review', actor: ticket.assigned_agent, result_summary: 'ready for review' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticket.id}/transition`)
      .send({ action: 'start_review', actor: 'leoss' })
      .expect(200);
    return request(app).get(`/api/tickets/${ticket.id}`).expect(200).then((res) => res.body);
  }

  async function createReviewerActionContext(overrides = {}) {
    const ticket = await createReviewTicket(overrides);
    const readyRes = await request(app).get('/api/dispatch/ready').expect(200);
    const ready = readyRes.body.ready.find((item) => item.ticket_id === ticket.id && item.status === 'review');
    expect(ready).toBeDefined();
    expect(ready.assignment_id).toBeTruthy();
    expect(ready.assignment.assignment_token).toBeTruthy();

    await request(app)
      .post(`/api/agent/assignments/${ready.assignment_id}/reports`)
      .send({
        assignment_token: ready.assignment.assignment_token,
        report_type: 'review_submission',
        idempotency_key: `review-submission-${ticket.id}`,
        summary: 'review complete，允许进入 reviewer approve/reject write path。',
        review: {
          verdict: 'pass',
          notes: 'test fixture',
        },
      })
      .expect(201);

    return {
      ticket,
      assignment_id: ready.assignment_id,
      assignment_token: ready.assignment.assignment_token,
      assignment_agent: ready.agent,
    };
  }

  async function createPendingDecisionDelegationContext(overrides = {}) {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: overrides.title || 'Pending decision delegated write path',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        decision_owner: overrides.decision_owner || 'ronghui',
        assigned_agent: overrides.assigned_agent || 'beavy',
        platform: overrides.platform || 'ticket-platform',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: overrides.assigned_agent || 'beavy' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'request_decision',
        actor: overrides.assigned_agent || 'beavy',
        decision_summary: overrides.decision_summary || '需要老大拍板后恢复执行',
      })
      .expect(200);

    const assignment = createOrReuseAssignment({
      ticket_id: ticketId,
      agent_id: overrides.assignment_agent || 'beavy',
      stage: 'pending_decision',
      assignment_status: 'delivered',
      role: 'decision_delegate',
      intent: 'notification',
      target_session_key: `agent:${overrides.assignment_agent || 'beavy'}:ticket:${ticketId}`,
      transport: 'test',
    });

    const ticket = await request(app).get(`/api/tickets/${ticketId}`).expect(200).then((res) => res.body);
    return {
      ticket,
      assignment_id: assignment.assignment_id,
      assignment_token: assignment.assignment_token,
      assignment_agent: assignment.agent_id,
    };
  }

  function expectTicketActionKeys(actions = []) {
    expect(actions.map((item) => item.key)).toEqual(expect.arrayContaining(['create', 'pause', 'resume', 'approve', 'reject']));
  }

  it('POST /api/agent/tickets happy path：按 actor 创建 triage 工单', async () => {
    const res = await request(app)
      .post('/api/agent/tickets')
      .send({
        actor: 'beavy',
        title: 'Agent-facing create',
        description: '只允许创建自己名下 triage 工单',
        implementation_scope: '补最小 API 测试',
      })
      .expect(201);

    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      action: 'create',
      ticket: expect.objectContaining({
        title: 'Agent-facing create',
        status: 'triage',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        next_actor: 'leoss',
      }),
      available_actions: expect.arrayContaining(['queue', 'pause']),
    }));
  });

  it('POST /api/agent/tickets 在 stock-platform 下默认 triage_owner= cowder，且仅保留受控 forbidden 字段约束', async () => {
    const res = await request(app)
      .post('/api/agent/tickets')
      .send({
        actor: 'cowder',
        title: 'Stock agent-facing create',
        platform: 'stock-platform',
      })
      .expect(201);

    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      action: 'create',
      ticket: expect.objectContaining({
        title: 'Stock agent-facing create',
        status: 'triage',
        assigned_agent: 'cowder',
        triage_owner: 'cowder',
        review_owner: 'cowder',
        current_actor: 'cowder',
        next_actor: 'cowder',
        platform: 'stock-platform',
      }),
      available_actions: expect.arrayContaining(['queue', 'pause']),
    }));

    const forbiddenOwnerRes = await request(app)
      .post('/api/agent/tickets')
      .send({
        actor: 'beavy',
        title: 'Invalid controlled override',
        decision_owner: 'example-human-operator',
        next_actor: 'cowder',
      })
      .expect(400);

    expect(forbiddenOwnerRes.body).toEqual(expect.objectContaining({
      detail: 'agent-facing create 不允许直接覆盖字段：decision_owner, next_actor',
      forbidden_fields: ['decision_owner', 'next_actor'],
    }));
    expect(forbiddenOwnerRes.body.error).toBeUndefined();
  });

  it('POST /api/agent/tickets 允许显式指定 triage_owner / assigned_agent / review_owner，并让责任链按指定值落链', async () => {
    const createRes = await request(app)
      .post('/api/agent/tickets')
      .send({
        actor: 'cowder',
        title: 'Explicit owner chain from cowder',
        platform: 'stock-platform',
        triage_owner: 'cowder',
        assigned_agent: 'marely',
        review_owner: 'leoss',
      })
      .expect(201);

    expect(createRes.body).toEqual(expect.objectContaining({
      success: true,
      action: 'create',
      ticket: expect.objectContaining({
        title: 'Explicit owner chain from cowder',
        status: 'triage',
        platform: 'stock-platform',
        triage_owner: 'cowder',
        assigned_agent: 'marely',
        review_owner: 'leoss',
        current_actor: 'cowder',
        current_actor_source: 'triage_owner',
        next_actor: 'cowder',
        next_actor_source: 'triage_owner',
      }),
    }));

    const ticketId = createRes.body.ticket.id;

    const queueRes = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'queue', actor: 'cowder' })
      .expect(200);

    expect(queueRes.body.ticket).toEqual(expect.objectContaining({
      id: ticketId,
      status: 'queued',
      triage_owner: 'cowder',
      assigned_agent: 'marely',
      review_owner: 'leoss',
      current_actor: 'marely',
      current_actor_source: 'assigned_agent',
      next_actor: 'marely',
      next_actor_source: 'assigned_agent',
    }));

    const readyAfterQueue = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);

    expect(readyAfterQueue.body.ready).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticket_id: ticketId,
        status: 'queued',
        agent: 'marely',
        next_actor: 'marely',
      }),
    ]));

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'marely' })
      .expect(200);

    const submitRes = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'submit_for_review', actor: 'marely', result_summary: 'ready for review' })
      .expect(200);

    expect(submitRes.body.ticket).toEqual(expect.objectContaining({
      status: 'done',
      current_actor: 'leoss',
      current_actor_source: 'review_owner',
      next_actor: 'leoss',
      next_actor_source: 'review_owner',
      review_owner: 'leoss',
    }));

    const readyAfterDone = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);

    expect(readyAfterDone.body.ready).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticket_id: ticketId,
        status: 'done',
        agent: 'leoss',
        next_actor: 'leoss',
      }),
    ]));

    const startReviewRes = await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_review', actor: 'leoss' })
      .expect(200);

    expect(startReviewRes.body.ticket).toEqual(expect.objectContaining({
      status: 'review',
      current_actor: 'leoss',
      current_actor_source: 'review_owner',
      next_actor: 'leoss',
      next_actor_source: 'review_owner',
      review_owner: 'leoss',
    }));
  });

  it('POST /api/agent/tickets guard path：拒绝受控 forbidden field，并保留 ticket-platform assigned_agent 限制', async () => {
    const forbiddenFieldRes = await request(app)
      .post('/api/agent/tickets')
      .send({
        actor: 'beavy',
        title: 'Invalid field override',
        status: 'running',
      })
      .expect(400);

    expect(forbiddenFieldRes.body).toEqual(expect.objectContaining({
      detail: 'agent-facing create 不允许直接覆盖字段：status',
      forbidden_fields: ['status'],
    }));
    expect(forbiddenFieldRes.body.error).toBeUndefined();

    const forbiddenOwnerRes = await request(app)
      .post('/api/agent/tickets')
      .send({
        actor: 'beavy',
        title: 'Invalid owner override',
        decision_owner: 'example-human-operator',
        next_actor: 'cowder',
      })
      .expect(400);

    expect(forbiddenOwnerRes.body).toEqual(expect.objectContaining({
      detail: 'agent-facing create 不允许直接覆盖字段：decision_owner, next_actor',
      forbidden_fields: ['decision_owner', 'next_actor'],
    }));
    expect(forbiddenOwnerRes.body.error).toBeUndefined();

    const forbiddenAgentRes = await request(app)
      .post('/api/agent/tickets')
      .send({
        actor: 'beavy',
        title: 'Ticket platform wrong executor',
        platform: 'ticket-platform',
        assigned_agent: 'donky',
      })
      .expect(400);

    expect(forbiddenAgentRes.body).toEqual(expect.objectContaining({
      detail: 'platform=ticket-platform 时 assigned_agent/target_agent 只能为 beavy',
      platform: 'ticket-platform',
      allowed_assigned_agents: ['beavy'],
    }));
    expect(forbiddenAgentRes.body.error).toBeUndefined();
  });

  it('POST /api/agent/tickets/:id/pause happy path：running 工单可被 current_actor 挂起', async () => {
    const ticket = await createRunningTicket();

    const res = await request(app)
      .post(`/api/agent/tickets/${ticket.id}/pause`)
      .send({ actor: 'beavy', pause_reason: '等待 reviewer 回应' })
      .expect(200);

    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      action: 'pause',
      ticket: expect.objectContaining({
        id: ticket.id,
        status: 'paused',
        paused_from_status: 'running',
        paused_by: 'beavy',
        pause_reason: '等待 reviewer 回应',
      }),
      available_actions: expect.arrayContaining(['resume']),
    }));
  });

  it('POST /api/agent/tickets/:id/pause happy path：review 工单可被 review_owner（current_actor）挂起', async () => {
    const ticket = await createTicket({
      title: 'Review ticket can pause',
      status: 'review',
      assigned_agent: 'beavy',
      triage_owner: 'leoss',
      review_owner: 'cowder',
    });

    const res = await request(app)
      .post(`/api/agent/tickets/${ticket.id}/pause`)
      .send({ actor: 'cowder', pause_reason: 'review 阶段先挂起等待补充信息' })
      .expect(200);

    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      action: 'pause',
      ticket: expect.objectContaining({
        id: ticket.id,
        status: 'paused',
        paused_from_status: 'review',
        paused_by: 'cowder',
        pause_reason: 'review 阶段先挂起等待补充信息',
      }),
      available_actions: expect.arrayContaining(['resume']),
    }));
  });

  it('POST /api/agent/tickets/:id/pause guard path：wrong actor / action not allowed 均返回 guard 错误', async () => {
    const completeTicket = await createTicket({ title: 'Complete ticket cannot pause', status: 'complete' });
    const notAllowedRes = await request(app)
      .post(`/api/agent/tickets/${completeTicket.id}/pause`)
      .send({ actor: 'beavy', pause_reason: 'complete 不能 pause' })
      .expect(409);

    expect(notAllowedRes.body).toEqual(expect.objectContaining({
      detail: '当前 status=complete 不允许 pause',
      action: 'pause',
      ticket_id: completeTicket.id,
      current_status: 'complete',
      available_actions: expect.arrayContaining(['deprecate']),
    }));
    expect(notAllowedRes.body.error).toBeUndefined();

    const runningTicket = await createRunningTicket({ title: 'Wrong actor cannot pause' });
    const forbiddenRes = await request(app)
      .post(`/api/agent/tickets/${runningTicket.id}/pause`)
      .send({ actor: 'donky', pause_reason: '我不该能挂起别人工单' })
      .expect(403);

    expect(forbiddenRes.body).toEqual(expect.objectContaining({
      detail: 'pause 仅允许 beavy 执行',
      action: 'pause',
      actor: 'donky',
      expected_actor: 'beavy',
      role_key: 'current_actor',
      current_actor: 'beavy',
      ticket_id: runningTicket.id,
    }));
    expect(forbiddenRes.body.error).toBeUndefined();
  });

  it('POST /api/agent/tickets/:id/resume happy path：paused 工单可恢复到挂起前状态', async () => {
    const ticket = await createPausedTicket();

    const res = await request(app)
      .post(`/api/agent/tickets/${ticket.id}/resume`)
      .send({ actor: 'beavy' })
      .expect(200);

    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      action: 'resume',
      ticket: expect.objectContaining({
        id: ticket.id,
        status: 'running',
        paused_from_status: null,
        paused_by: null,
        pause_reason: null,
        locked_by: 'beavy',
      }),
    }));
  });

  it('POST /api/agent/tickets/:id/resume guard path：wrong actor / running conflict 均返回 guard 错误', async () => {
    const pausedTicket = await createPausedTicket({ title: 'Paused ticket for resume guard' });
    const forbiddenRes = await request(app)
      .post(`/api/agent/tickets/${pausedTicket.id}/resume`)
      .send({ actor: 'donky' })
      .expect(403);

    expect(forbiddenRes.body).toEqual(expect.objectContaining({
      detail: 'resume 仅允许 beavy 执行',
      action: 'resume',
      actor: 'donky',
      expected_actor: 'beavy',
      role_key: 'paused_by',
      ticket_id: pausedTicket.id,
    }));
    expect(forbiddenRes.body.error).toBeUndefined();

    const conflictTicket = await createPausedTicket({ title: 'Paused ticket for conflict' });
    await createRunningTicket({ title: 'Occupied running ticket' });

    const conflictRes = await request(app)
      .post(`/api/agent/tickets/${conflictTicket.id}/resume`)
      .send({ actor: 'beavy' })
      .expect(409);

    expect(conflictRes.body).toEqual(expect.objectContaining({
      detail: expect.stringContaining('agent beavy 已有进行中的工单'),
      action: 'resume',
      available_actions: expect.arrayContaining(['resume']),
    }));
    expect(conflictRes.body.error).toBeUndefined();

    const ticketAfter = await request(app).get(`/api/tickets/${conflictTicket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('paused');
  });

  it('POST /api/agent/tickets/:id/approve happy path：review_owner 可在 done 阶段直接 closeout，不再被 review residual guard 卡成 409', async () => {
    const ticket = await createRunningTicket({
      title: 'Done closeout without review residual guard',
      assigned_agent: 'beavy',
      triage_owner: 'leoss',
      review_owner: 'leoss',
    });

    await request(app)
      .post(`/api/tickets/${ticket.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'acceptance already satisfied' })
      .expect(200);

    const detailBefore = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(detailBefore.body.status).toBe('done');

    const res = await request(app)
      .post(`/api/agent/tickets/${ticket.id}/approve`)
      .send({ actor: 'leoss' })
      .expect(200);

    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      action: 'approve',
      ticket: expect.objectContaining({
        id: ticket.id,
        status: 'complete',
        current_actor: null,
        next_actor: null,
      }),
    }));
    expect(Array.isArray(res.body.available_actions)).toBe(true);
  });

  it('POST /api/agent/tickets/:id/approve happy path：review_owner 可在 review 阶段关单', async () => {
    const reviewContext = await createReviewerActionContext();

    const res = await request(app)
      .post(`/api/agent/tickets/${reviewContext.ticket.id}/approve`)
      .send({
        actor: 'leoss',
        assignment_id: reviewContext.assignment_id,
        assignment_token: reviewContext.assignment_token,
      })
      .expect(200);

    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      action: 'approve',
      ticket: expect.objectContaining({
        id: reviewContext.ticket.id,
        status: 'complete',
        current_actor: null,
        next_actor: null,
      }),
    }));
    expect(Array.isArray(res.body.available_actions)).toBe(true);
  });

  it('POST /api/agent/tickets/:id/approve 不再把人类主体展示名映射成 agent id；如已授权需显式使用被授权 agent id', async () => {
    const ticket = await createReviewTicket();

    const res = await request(app)
      .post(`/api/agent/tickets/${ticket.id}/approve`)
      .send({ actor: 'example-human-operator' })
      .expect(403);

    expect(res.body).toEqual(expect.objectContaining({
      detail: 'actor example-human-operator 是人类主体，不是平台注册 agent；如已授权代办，请改用被授权的 agent id',
      actor: 'example-human-operator',
      human_principal: true,
    }));
    expect(res.body.known_agents).toEqual(expect.arrayContaining(['leoss']));
    expect(res.body.error).toBeUndefined();
  });

  it('POST /api/agent/tickets/:id/approve hosted reviewer assignment identity：非平台注册 reviewer 可沿 assignment 身份 approve', async () => {
    const reviewContext = await createReviewerActionContext({
      title: 'Review ticket for hosted eagle approve',
      review_owner: 'eagle',
    });

    expect(reviewContext.assignment_agent).toBe('eagle');
    expect(reviewContext.ticket.review_owner).toBe('eagle');

    const res = await request(app)
      .post(`/api/agent/tickets/${reviewContext.ticket.id}/approve`)
      .send({
        actor: 'eagle',
        assignment_id: reviewContext.assignment_id,
        assignment_token: reviewContext.assignment_token,
      })
      .expect(200);

    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      action: 'approve',
      ticket: expect.objectContaining({
        id: reviewContext.ticket.id,
        status: 'complete',
        current_actor: null,
        next_actor: null,
      }),
    }));
    expect(Array.isArray(res.body.available_actions)).toBe(true);
  });

  it('POST /api/agent/tickets/:id/reject hosted reviewer assignment identity：非平台注册 reviewer 可沿 assignment 身份 reject', async () => {
    const reviewContext = await createReviewerActionContext({
      title: 'Review ticket for hosted eagle reject',
      review_owner: 'eagle',
    });

    expect(reviewContext.assignment_agent).toBe('eagle');
    expect(reviewContext.ticket.review_owner).toBe('eagle');

    const res = await request(app)
      .post(`/api/agent/tickets/${reviewContext.ticket.id}/reject`)
      .send({
        actor: 'eagle',
        assignment_id: reviewContext.assignment_id,
        assignment_token: reviewContext.assignment_token,
        reject_reason: '请补齐 hosted approve/reject write path 的 live smoke。',
      })
      .expect(200);

    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      action: 'reject',
      ticket: expect.objectContaining({
        id: reviewContext.ticket.id,
        status: 'queued',
        result_summary: null,
        next_actor: 'beavy',
      }),
      available_actions: expect.arrayContaining(['start_work']),
    }));

    const latestQueuedAssignment = findLatestAssignmentForTicket(reviewContext.ticket.id, 'eagle');
    expect(latestQueuedAssignment).toEqual(expect.objectContaining({
      ticket_id: reviewContext.ticket.id,
      agent_id: 'eagle',
      stage: 'queued',
    }));
    expect(latestQueuedAssignment.assignment_id).not.toBe(reviewContext.assignment_id);

    const detailRes = await request(app)
      .get(`/api/v1/agent/assignments/${reviewContext.assignment_id}`)
      .set('x-assignment-token', reviewContext.assignment_token)
      .expect(200);

    expect(detailRes.body.current_assignment).toEqual(expect.objectContaining({
      assignment_id: latestQueuedAssignment.assignment_id,
      agent_id: 'eagle',
      stage: 'queued',
      available_actions: expect.arrayContaining(['start_work']),
    }));
    expect(detailRes.body.assignment_context).toEqual(expect.objectContaining({
      assignment_id: latestQueuedAssignment.assignment_id,
      agent_id: 'eagle',
      stage: 'queued',
      available_actions: expect.arrayContaining(['start_work']),
    }));
  });

  it('POST /api/agent/tickets/:id/reject 若已存在 fresh queued successor assignment，则复用而不再生成重复 queued 占位', async () => {
    const runningTicket = await createRunningTicket({
      title: 'Running ticket for queued successor reuse',
      assigned_agent: 'beavy',
      triage_owner: 'leoss',
      review_owner: 'eagle',
    });

    await request(app)
      .post(`/api/tickets/${runningTicket.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'ready for reviewer' })
      .expect(200);

    const reviewTicket = getTicketById(runningTicket.id);
    expect(reviewTicket.status).toBe('done');

    const reviewerDispatchId = recordDispatchEvent(reviewTicket.id, 'eagle', 'done');
    ackDispatchEventRecord(reviewerDispatchId);
    const reviewAssignment = createOrReuseAssignment({
      ticket_id: reviewTicket.id,
      dispatch_event_id: reviewerDispatchId,
      agent_id: 'eagle',
      gateway_id: 'mac-main',
      execution_mode: reviewTicket.execution_mode,
      assignment_status: 'created',
      intent: 'dispatch',
      role: 'execute',
      stage: 'done',
      assignment_token: 'queued-successor-reuse-reviewer-token',
      target_session_key: `agent:eagle:ticket:${reviewTicket.id}`,
      transport: 'test',
    });

    const existingQueuedAssignment = createOrReuseAssignment({
      ticket_id: reviewTicket.id,
      agent_id: 'eagle',
      stage: 'queued',
      assignment_status: 'created',
      gateway_id: 'mac-main',
      target_session_key: `agent:eagle:ticket:${reviewTicket.id}`,
      transport: 'test',
    });

    const res = await request(app)
      .post(`/api/agent/tickets/${reviewTicket.id}/reject`)
      .send({
        actor: 'eagle',
        assignment_id: reviewAssignment.assignment_id,
        assignment_token: reviewAssignment.assignment_token,
        reject_reason: '复用已有 queued successor，避免重复 reject 占位。',
      });

    if (res.status !== 200) {
      throw new Error(`queued successor reuse reject response ${res.status}: ${JSON.stringify(res.body)}`);
    }

    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      action: 'reject',
      ticket: expect.objectContaining({
        id: reviewTicket.id,
        status: 'queued',
      }),
    }));

    const latestQueuedAssignment = findLatestAssignmentForTicket(reviewTicket.id, 'eagle');
    expect(latestQueuedAssignment).toEqual(expect.objectContaining({
      assignment_id: existingQueuedAssignment.assignment_id,
      ticket_id: reviewTicket.id,
      agent_id: 'eagle',
      stage: 'queued',
      assignment_status: 'created',
    }));

    const detailRes = await request(app)
      .get(`/api/v1/agent/assignments/${reviewAssignment.assignment_id}`)
      .set('x-assignment-token', reviewAssignment.assignment_token)
      .expect(200);

    expect(detailRes.body.current_assignment).toEqual(expect.objectContaining({
      assignment_id: existingQueuedAssignment.assignment_id,
      agent_id: 'eagle',
      stage: 'queued',
      available_actions: expect.arrayContaining(['start_work']),
    }));
  });

  it('GET /api/dispatch/ready reviewer done-stage assignment 会暴露 current_assignment，且指向 fresh latest assignment', async () => {
    const ticket = await createReviewTicket({
      title: 'Review ticket current assignment contract',
      review_owner: 'eagle',
    });

    const readyRes = await request(app).get('/api/dispatch/ready').expect(200);
    const ready = readyRes.body.ready.find((item) => item.ticket_id === ticket.id);
    expect(ready).toBeDefined();
    expect(ready.assignment).toEqual(expect.objectContaining({
      assignment_id: ready.assignment_id,
      current_assignment: expect.objectContaining({
        assignment_id: ready.assignment_id,
        agent_id: 'eagle',
        stage: ready.status,
      }),
      assignment_context: expect.objectContaining({
        assignment_id: ready.assignment_id,
        agent_id: 'eagle',
        stage: ready.status,
      }),
    }));
    expect(['done', 'review']).toContain(ready.status);
  });

  it('POST /api/agent/tickets/:id/resume-from-decision 允许被授权 agent 代人类 decision_owner 执行并保留代理审计轨迹', async () => {
    const decisionContext = await createPendingDecisionDelegationContext();

    const res = await request(app)
      .post(`/api/agent/tickets/${decisionContext.ticket.id}/resume-from-decision`)
      .send({
        actor: 'beavy',
        assignment_id: decisionContext.assignment_id,
        assignment_token: decisionContext.assignment_token,
      })
      .expect(200);

    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      action: 'resume_from_decision',
      ticket: expect.objectContaining({
        id: decisionContext.ticket.id,
        status: 'queued',
        current_actor: 'beavy',
        next_actor: 'beavy',
      }),
      available_actions: expect.arrayContaining(['start_work']),
    }));

    const commentsRes = await request(app)
      .get(`/api/tickets/${decisionContext.ticket.id}/comments`)
      .expect(200);
    const auditComment = commentsRes.body.comments.find((item) => item.metadata?.source === 'agent_assignment_delegation_audit');
    expect(auditComment).toEqual(expect.objectContaining({
      author: 'beavy',
      type: 'system',
      visibility: 'internal',
      metadata: expect.objectContaining({
        action: 'resume_from_decision',
        actor: 'beavy',
        acted_for: 'ronghui',
        delegated: true,
        assignment_id: decisionContext.assignment_id,
        assignment_agent: 'beavy',
        from_status: 'pending_decision',
        to_status: 'queued',
        role_key: 'decision_owner',
      }),
    }));
    expect(auditComment.content).toContain('代理代办审计');
  });

  it('POST /api/agent/tickets/:id/reject happy path：review_owner 可在 review 阶段打回 queued', async () => {
    const reviewContext = await createReviewerActionContext({ title: 'Review ticket for reject' });

    const res = await request(app)
      .post(`/api/agent/tickets/${reviewContext.ticket.id}/reject`)
      .send({
        actor: 'leoss',
        assignment_id: reviewContext.assignment_id,
        assignment_token: reviewContext.assignment_token,
        reject_reason: '请补齐 hosted approve/reject write path 的 live smoke。',
      })
      .expect(200);

    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      action: 'reject',
      ticket: expect.objectContaining({
        id: reviewContext.ticket.id,
        status: 'queued',
        result_summary: null,
        next_actor: 'beavy',
      }),
      available_actions: expect.arrayContaining(['start_work']),
    }));
  });

  it('POST /api/agent/tickets/:id/approve|reject guard path：wrong actor / missing reject_reason / action not allowed 都返回 guard 错误', async () => {
    const reviewContext = await createReviewerActionContext({ title: 'Review ticket for approve/reject guard' });

    const forbiddenApproveRes = await request(app)
      .post(`/api/agent/tickets/${reviewContext.ticket.id}/approve`)
      .send({
        actor: 'beavy',
        assignment_id: reviewContext.assignment_id,
        assignment_token: reviewContext.assignment_token,
      })
      .expect(403);

    expect(forbiddenApproveRes.body).toEqual(expect.objectContaining({
      detail: 'approve 仅允许 leoss 执行',
      action: 'approve',
      actor: 'beavy',
      expected_actor: 'leoss',
      role_key: 'review_owner',
      ticket_id: reviewContext.ticket.id,
    }));
    expect(forbiddenApproveRes.body.error).toBeUndefined();

    const missingRejectReasonRes = await request(app)
      .post(`/api/agent/tickets/${reviewContext.ticket.id}/reject`)
      .send({
        actor: 'leoss',
        assignment_id: reviewContext.assignment_id,
        assignment_token: reviewContext.assignment_token,
      })
      .expect(400);

    expect(missingRejectReasonRes.body).toEqual(expect.objectContaining({
      detail: 'reject_reason 不能为空',
      required_fields: ['actor', 'reject_reason'],
    }));
    expect(missingRejectReasonRes.body.error).toBeUndefined();

    const queuedTicket = await createTicket({ title: 'Queued ticket cannot approve' });
    await request(app)
      .post(`/api/tickets/${queuedTicket.id}/transition`)
      .send({ action: 'queue', actor: queuedTicket.triage_owner || 'leoss' })
      .expect(200);

    const notAllowedRes = await request(app)
      .post(`/api/agent/tickets/${queuedTicket.id}/approve`)
      .send({ actor: 'leoss' })
      .expect(409);

    expect(notAllowedRes.body).toEqual(expect.objectContaining({
      detail: '当前 status=queued 不允许 approve',
      action: 'approve',
      ticket_id: queuedTicket.id,
      current_status: 'queued',
      available_actions: expect.arrayContaining(['start_work']),
    }));
    expect(notAllowedRes.body.error).toBeUndefined();
  });

  it('POST /api/tickets/:id/transition approve guard：母单存在未闭环子单时禁止 complete 假闭环', async () => {
    const parentCreateRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Parent ticket closeout guard',
        description: 'parent closeout guard',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        execution_mode: 'direct',
      })
      .expect(201);
    const parentTicket = parentCreateRes.body;

    await request(app)
      .post(`/api/tickets/${parentTicket.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${parentTicket.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${parentTicket.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'parent ready for review' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${parentTicket.id}/transition`)
      .send({ action: 'start_review', actor: 'leoss' })
      .expect(200);

    const childRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Child still running',
        description: 'child still running',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        execution_mode: 'direct',
        parent_ticket_id: parentTicket.id,
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${childRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${childRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .patch(`/api/tickets/${childRes.body.id}`)
      .send({ result_summary: '子单结果尚未回流' })
      .expect(200);

    const guardRes = await request(app)
      .post(`/api/tickets/${parentTicket.id}/transition`)
      .send({ action: 'approve', actor: 'leoss' })
      .expect(409);

    expect(guardRes.body).toEqual(expect.objectContaining({
      error: 'PARENT_CLOSEOUT_CHILDREN_INCOMPLETE',
      message: '母单存在未闭环子单，当前不允许 approve',
      action: 'approve',
      current_status: 'review',
      blocking_child_count: 1,
      blocking_children: [expect.objectContaining({
        title: 'Child still running',
        status: 'running',
        result_summary: '子单结果尚未回流',
      })],
      parent_closeout_summary: expect.objectContaining({
        is_parent: true,
        child_count: 1,
        open_child_count: 1,
        all_children_terminal: false,
      }),
    }));

    const parentAfter = await request(app).get(`/api/tickets/${parentTicket.id}`).expect(200);
    expect(parentAfter.body.status).toBe('review');
    expect(parentAfter.body.parent_child_summary).toEqual(expect.objectContaining({
      is_parent: true,
      child_count: 1,
      open_child_count: 1,
      all_children_terminal: false,
      blocking_children: [expect.objectContaining({
        title: 'Child still running',
        status: 'running',
      })],
    }));
  });

  it('POST /api/tickets/:id/transition approve：complete 子单不应继续阻断父单 closeout', async () => {
    const parentCreateRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Parent ticket closeout complete child pass-through',
        description: 'parent closeout complete child pass-through',
        assigned_agent: 'cowder',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        execution_mode: 'direct',
      })
      .expect(201);
    const parentTicket = parentCreateRes.body;

    const childTicket = await createReviewTicket({
      title: 'Child already complete',
      description: 'child already complete',
      assigned_agent: 'cowder',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      execution_mode: 'direct',
      parent_ticket_id: parentTicket.id,
    });

    await request(app)
      .post(`/api/tickets/${childTicket.id}/transition`)
      .send({ action: 'approve', actor: 'leoss' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${parentTicket.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${parentTicket.id}/transition`)
      .send({ action: 'start_work', actor: 'cowder' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${parentTicket.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'cowder', result_summary: 'parent ready for approve after child complete' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${parentTicket.id}/transition`)
      .send({ action: 'start_review', actor: 'leoss' })
      .expect(200);

    const approveRes = await request(app)
      .post(`/api/tickets/${parentTicket.id}/transition`)
      .send({ action: 'approve', actor: 'leoss' })
      .expect(200);

    expect(approveRes.body).toEqual(expect.objectContaining({
      success: true,
      ticket: expect.objectContaining({
        status: 'complete',
        parent_child_summary: expect.objectContaining({
          is_parent: true,
          child_count: 1,
          terminal_child_count: 1,
          open_child_count: 0,
          all_children_terminal: true,
          blocking_children: [],
        }),
      }),
    }));
  });

  it('GET /api/v1/agent/workboards/stock-tickets relation_summary 包含 parent_child_summary', async () => {
    const root = await createReviewTicket({
      title: 'Parent for workboard parent-child summary',
      platform: 'stock-platform',
      assigned_agent: 'cowder',
    });

    await createTicket({
      title: 'Child still queued',
      platform: 'stock-platform',
      assigned_agent: 'cowder',
      parent_ticket_id: root.id,
      result_summary: '等待执行',
    });

    const workboardRes = await request(app)
      .get('/api/v1/agent/workboards/stock-tickets')
      .expect(200);

    const parentItem = workboardRes.body.data.items.find((item) => item.id === root.id);
    expect(parentItem).toEqual(expect.objectContaining({
      relation_summary: expect.objectContaining({
        child_count: 1,
        parent_child_summary: expect.objectContaining({
          is_parent: true,
          child_count: 1,
          open_child_count: 1,
          all_children_terminal: false,
          blocking_children: [expect.objectContaining({
            title: 'Child still queued',
            status: 'triage',
            result_summary: null,
          })],
        }),
      }),
    }));
  });

  it('GET /api/tickets/:id 与 /api/tickets/:id/children 返回父子聚合汇总', async () => {
    const parent = await createReviewTicket({
      title: 'Parent summary API coverage',
      platform: 'ticket-platform',
      assigned_agent: 'beavy',
    });

    const blockedChildRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Blocked child',
        platform: 'ticket-platform',
        assigned_agent: 'beavy',
        parent_ticket_id: parent.id,
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${blockedChildRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${blockedChildRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${blockedChildRes.body.id}/transition`)
      .send({ action: 'block', actor: 'beavy', blocker_summary: '等待外部依赖' })
      .expect(200);

    const failedChildRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Failed child',
        platform: 'ticket-platform',
        assigned_agent: 'beavy',
        parent_ticket_id: parent.id,
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${failedChildRes.body.id}/transition`)
      .send({ action: 'queue', actor: 'leoss' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${failedChildRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${failedChildRes.body.id}/transition`)
      .send({ action: 'fail', actor: 'beavy', error: '子任务执行失败' })
      .expect(200);

    const detailRes = await request(app).get(`/api/tickets/${parent.id}`).expect(200);
    expect(detailRes.body.parent_summary).toEqual(expect.objectContaining({
      is_parent: true,
      child_count: 2,
      terminal_child_count: 1,
      open_child_count: 1,
      by_status: expect.objectContaining({ blocked: 1, failed: 1 }),
      blocked_child_count: 1,
      failed_child_count: 1,
      attention_required: true,
      latest_completed_at: expect.any(String),
      latest_completed_child: expect.objectContaining({
        title: 'Failed child',
        status: 'failed',
      }),
      blocking_children: [expect.objectContaining({
        title: 'Blocked child',
        status: 'blocked',
      })],
    }));

    const childrenRes = await request(app).get(`/api/tickets/${parent.id}/children`).expect(200);
    expect(childrenRes.body).toEqual(expect.objectContaining({
      ticket_id: parent.id,
      summary: expect.objectContaining({
        child_count: 2,
        blocked_child_count: 1,
        failed_child_count: 1,
        attention_required: true,
      }),
      items: expect.arrayContaining([
        expect.objectContaining({ title: 'Blocked child', status: 'blocked' }),
        expect.objectContaining({ title: 'Failed child', status: 'failed' }),
      ]),
    }));
  });

  it('runtime / skills / playbook 都暴露 create/pause/resume/approve/reject ticket_actions discoverability', async () => {
    const runtimeRes = await request(app)
      .get('/api/v1/agent/runtime/context')
      .expect(200);
    expectTicketActionKeys(runtimeRes.body.data.ticket_actions);
    expectTicketActionKeys(runtimeRes.body.data.discoverability.ticket_actions);
    expect(runtimeRes.body.data.runtime_version).toEqual(expect.objectContaining({
      production_repo: expect.any(String),
      repo_root: expect.any(String),
      working_directory: expect.any(String),
      release_fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
      environment: 'production',
    }));
    expect(runtimeRes.body.data.production_baseline).toEqual(expect.objectContaining({
      production_repo: runtimeRes.body.data.runtime_version.production_repo,
      repo_root: runtimeRes.body.data.runtime_version.repo_root,
      release_fingerprint: runtimeRes.body.data.runtime_version.release_fingerprint,
    }));

    const runtimeCreate = runtimeRes.body.data.ticket_actions.find((item) => item.key === 'create');
    expect(runtimeCreate).toEqual(expect.objectContaining({
      endpoint: '/api/v1/agent/tickets',
    }));
    expect(runtimeCreate.request_fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'triage_owner' }),
      expect.objectContaining({ key: 'assigned_agent' }),
      expect.objectContaining({ key: 'review_owner' }),
    ]));
    expect(runtimeCreate.constraints).toEqual(expect.arrayContaining([
      expect.stringContaining('status 固定 triage'),
      expect.stringContaining('decision_owner/next_actor/review_plan/review_state 不允许由 agent-facing create 直接覆盖'),
      expect.stringContaining('ticket-platform 的 assigned_agent/target_agent 仍只允许 beavy'),
    ]));

    const skillsRes = await request(app)
      .get('/api/v1/agent/skills/current')
      .expect(200);
    expectTicketActionKeys(skillsRes.body.data.ticket_actions);
    expectTicketActionKeys(skillsRes.body.data.discoverability.ticket_actions);
    expect(skillsRes.body.data.markdown).toContain('create 只允许创建 triage 新单');
    expect(skillsRes.body.data.markdown).toContain('可显式指定 triage_owner/assigned_agent/review_owner');
    expect(skillsRes.body.data.markdown).toContain('decision_owner/next_actor 仍由平台 single writer 收口');
    expect(skillsRes.body.data.markdown).toContain('reset_to_queued');
    expect(skillsRes.body.data.markdown).toContain('不在 agent-facing ticket_actions 直写范围内');
    expect(skillsRes.body.data.markdown).toContain('填写 `reason`');

    const playbookRes = await request(app)
      .get('/api/v1/agent/playbooks/ticket-handler')
      .expect(200);
    expectTicketActionKeys(playbookRes.body.data.ticket_actions);
    expectTicketActionKeys(playbookRes.body.data.discoverability.ticket_actions);
    expect(playbookRes.body.data.markdown).toContain('create 只允许创建 triage 新单');
    expect(playbookRes.body.data.markdown).toContain('可显式指定 triage_owner/assigned_agent/review_owner');
    expect(playbookRes.body.data.markdown).toContain('decision_owner/next_actor 仍由平台 single writer 收口');
    expect(playbookRes.body.data.markdown).toContain('reset_to_queued');
    expect(playbookRes.body.data.markdown).toContain('triage_owner');
  });

  it('runtime context 暴露 v2 bootstrap participant registry / role-domain registry endpoint', async () => {
    const res = await request(app)
      .get('/api/v1/agent/runtime/context')
      .expect(200);

    expect(res.body.data.bootstrap).toEqual(expect.objectContaining({
      workflow_schema: '/api/v1/agent/workflow/schema',
      runtime_context: '/api/v1/agent/runtime/context',
      participant_registry: '/api/v1/agent/participants',
      participant_route_resolve: '/api/v1/agent/routing/resolve',
      assignment_read: '/api/v1/agent/assignments/:assignment_id',
      assignment_report: '/api/v1/agent/assignments/:assignment_id/reports',
      skill_current: '/api/v1/agent/skills/current',
      playbook_current: '/api/v1/agent/playbooks/ticket-handler',
      stock_tickets_workboard: '/api/v1/agent/workboards/stock-tickets',
    }));
    expect(res.body.data.warnings).toEqual([]);
    expect(res.body.data.feature_flags).toEqual(expect.objectContaining({
      participant_registry_api: true,
      participant_route_resolve_api: true,
      platform_describe_api: true,
      registry_roles_api: true,
      registry_domains_api: true,
      registry_agent_register_api: true,
      registry_agent_heartbeat_api: true,
      registry_resolve_api: true,
      config_observability_api: true,
    }));
  });

  it('participant registry / routing resolve 提供 ticket-platform bootstrap skeleton', async () => {
    const registryRes = await request(app)
      .get('/api/v1/agent/participants')
      .query({ platform_id: 'ticket-platform' })
      .expect(200);

    expect(registryRes.body.data.kind).toBe('agent.participant_registry');
    expect(registryRes.body.data.summary.filtered_participants).toBeGreaterThan(0);
    expect(registryRes.body.data.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        participant_id: 'beavy',
        primary_platform: 'ticket-platform',
        capabilities: expect.arrayContaining(['development', 'platform:ticket-platform']),
        status: expect.objectContaining({
          availability_status: 'active',
          eligibility_status: 'eligible',
        }),
      }),
      expect.objectContaining({
        participant_id: 'leoss',
      }),
    ]));

    const detailRes = await request(app)
      .get('/api/v1/agent/participants/beavy')
      .expect(200);
    expect(detailRes.body.data).toEqual(expect.objectContaining({
      participant_id: 'beavy',
      primary_platform: 'ticket-platform',
      capabilities: expect.arrayContaining(['development', 'platform:ticket-platform']),
      status: expect.objectContaining({
        availability_status: 'active',
        eligibility_status: 'eligible',
      }),
      gateway: expect.objectContaining({
        id: 'mac-main',
      }),
    }));

    const routeRes = await request(app)
      .get('/api/v1/agent/routing/resolve')
      .query({
        platform_id: 'ticket-platform',
        role_key: 'development',
        reason: 'bootstrap_executor',
        intent: 'dispatch',
        session_kind: 'ticket',
        ticket_id: 177,
      })
      .expect(200);
    expect(routeRes.body.data).toEqual(expect.objectContaining({
      kind: 'agent.participant_route',
      resolved: expect.objectContaining({
        participant_id: 'beavy',
        status: expect.objectContaining({
          availability_status: 'active',
          eligibility_status: 'eligible',
        }),
        capabilities: expect.arrayContaining(['development', 'platform:ticket-platform']),
        source_kind: 'topology',
        binding: expect.objectContaining({
          session_base: 'agent:beavy',
        }),
      }),
      route_target: expect.objectContaining({
        gateway_id: 'mac-main',
        participant_id: 'beavy',
        session_kind: 'ticket',
        target_session_key: 'agent:beavy:ticket:177',
      }),
      explain: expect.objectContaining({
        resolution_source: 'platform.development_agent_ids[0]',
        session_base: 'agent:beavy',
      }),
    }));
  });

  it('GET /health 返回 production JSON contract，不应落到前端 HTML fallback', async () => {
    const res = await request(app)
      .get('/health')
      .expect(200);

    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.text).not.toContain('<!doctype html>');
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      service: 'ticket-platform-v2',
      status: 'healthy',
      request_id: expect.any(String),
      production_baseline: expect.objectContaining({
        production_repo: expect.any(String),
        repo_root: expect.any(String),
        working_directory: expect.any(String),
        release_fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
        environment: 'production',
      }),
    }));
  });

  it('role-domain registry API 提供 v2 describe / domains / register / heartbeat / resolve', async () => {
    const describeRes = await request(app)
      .get('/api/v1/platform/describe')
      .expect(200);
    expect(describeRes.body.data).toEqual(expect.objectContaining({
      platform: 'ticket-platform-v2',
      contract_version: '2026-03-role-domain-registry-v1',
      production_baseline: expect.objectContaining({
        production_repo: expect.any(String),
        repo_root: expect.any(String),
        working_directory: expect.any(String),
        release_fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
        environment: 'production',
      }),
      apis: expect.objectContaining({
        list_roles: '/api/v1/registry/roles',
        list_domains: '/api/v1/registry/domains',
        register_agent: '/api/v1/registry/agents/register',
        heartbeat: '/api/v1/registry/agents/heartbeat',
        resolve_assignment: '/api/v1/registry/resolve',
      }),
    }));
    expect(describeRes.body.data.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'triage' }),
      expect.objectContaining({ key: 'executor' }),
      expect.objectContaining({ key: 'reviewer' }),
      expect.objectContaining({ key: 'audit' }),
      expect.objectContaining({ key: 'manager' }),
    ]));
    expect(describeRes.body.data.domains).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'ticket-platform' }),
    ]));

    const rolesRes = await request(app)
      .get('/api/v1/registry/roles')
      .expect(200);
    expect(rolesRes.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'manager', management_only: true }),
      expect.objectContaining({ key: 'executor', enabled: true }),
    ]));

    await request(app)
      .post('/api/v1/registry/domains')
      .send({
        key: 'new-domain',
        label: 'should fail without token',
        enabled_roles: ['executor'],
      })
      .expect(401);

    const createDomainRes = await request(app)
      .post('/api/v1/registry/domains')
      .set('X-Platform-Token', 'dev-platform-token')
      .send({
        key: 'ops-platform',
        label: '运维业务线',
        description: '只在 v2 独立线验证 registry contract',
        enabled_roles: ['triage', 'executor', 'reviewer', 'manager'],
      })
      .expect(201);
    expect(createDomainRes.body.data).toEqual(expect.objectContaining({
      key: 'ops-platform',
      label: '运维业务线',
      enabled_roles: ['triage', 'executor', 'reviewer', 'manager'],
      created_by: 'leoss',
    }));

    const domainsRes = await request(app)
      .get('/api/v1/registry/domains')
      .expect(200);
    expect(domainsRes.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'ticket-platform' }),
      expect.objectContaining({ key: 'ops-platform' }),
    ]));

    const registerRes = await request(app)
      .post('/api/v1/registry/agents/register')
      .send({
        agent_id: 'beavy',
        display_name: '小李',
        roles: ['executor'],
        domains: ['ticket-platform', 'ops-platform'],
        gateway: 'mac-main',
        session_binding: 'agent:beavy:ticket',
        capacity: 2,
        priority: 120,
        status: 'online',
      })
      .expect(200);
    expect(registerRes.body.data).toEqual(expect.objectContaining({
      agent_id: 'beavy',
      roles: ['executor'],
      domains: ['ticket-platform', 'ops-platform'],
      capacity: 2,
      priority: 120,
      status: 'online',
    }));

    const heartbeatRes = await request(app)
      .post('/api/v1/registry/agents/heartbeat')
      .send({
        agent_id: 'beavy',
        status: 'online',
        active_load: 1,
        capacity: 2,
        metadata: { source: 'vitest' },
      })
      .expect(200);
    expect(heartbeatRes.body.data).toEqual(expect.objectContaining({
      agent_id: 'beavy',
      active_load: 1,
      capacity: 2,
      status: 'online',
      last_heartbeat: expect.any(String),
    }));

    const resolveRes = await request(app)
      .post('/api/v1/registry/resolve')
      .send({
        domain: 'ticket-platform',
        required_role: 'executor',
      })
      .expect(200);
    expect(resolveRes.body.data).toEqual(expect.objectContaining({
      resolved_agent: 'beavy',
      requested: expect.objectContaining({
        domain: 'ticket-platform',
        required_role: 'executor',
      }),
      domain: expect.objectContaining({ key: 'ticket-platform' }),
    }));
    expect(resolveRes.body.data.reason).toContain('role+domain matched');
  });

  it('agent_registration 会投影成 participant，并为 reviewer dispatch 生成 main session binding', async () => {
    await request(app)
      .post('/api/v1/registry/agents/register')
      .send({
        agent_id: 'eagle',
        display_name: '小鹰',
        roles: ['reviewer'],
        domains: ['stock-platform'],
        gateway: 'pc-stock',
        session_binding: 'agent:eagle',
        capacity: 1,
        priority: 110,
        status: 'online',
      })
      .expect(200);

    await request(app)
      .post('/api/v1/registry/agents/heartbeat')
      .send({
        agent_id: 'eagle',
        status: 'online',
        active_load: 0,
        capacity: 1,
      })
      .expect(200);

    const participantRes = await request(app)
      .get('/api/v1/agent/participants/eagle')
      .expect(200);

    expect(participantRes.body.data).toEqual(expect.objectContaining({
      participant_id: 'eagle',
      display_name: '小鹰',
      primary_platform: 'stock-platform',
      source_kind: 'agent_registration',
      platform_roles: expect.arrayContaining(['review_owner']),
      gateway: expect.objectContaining({
        id: 'pc-stock',
      }),
      binding: expect.objectContaining({
        session_base: 'agent:eagle',
        main_session_key: 'agent:eagle:main',
      }),
    }));

    const routeRes = await request(app)
      .get('/api/v1/agent/routing/resolve')
      .query({
        participant_id: 'eagle',
        reason: 'review_dispatch',
      })
      .expect(200);

    expect(routeRes.body.data).toEqual(expect.objectContaining({
      resolved: expect.objectContaining({
        participant_id: 'eagle',
        source_kind: 'agent_registration',
        primary_platform: 'stock-platform',
        platform_roles: expect.arrayContaining(['review_owner']),
        binding: expect.objectContaining({
          session_base: 'agent:eagle',
          main_session_key: 'agent:eagle:main',
        }),
      }),
      route_target: expect.objectContaining({
        participant_id: 'eagle',
        session_kind: 'ticket',
        target_session_key: 'agent:eagle:main',
      }),
      explain: expect.objectContaining({
        resolution_source: 'participant_id',
        session_base: 'agent:eagle',
        reason: 'ok',
      }),
    }));
  });
});

