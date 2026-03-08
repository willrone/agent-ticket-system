/**
 * @vitest-environment node
 * API 测试：Pull 模式 - 创建工单立即返回 queued、拉取、更新、dispatch
 */
import './test-setup.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from './app.js';
import { _resetDbForTesting } from './store-sqlite.js';
import { _resetDbForTesting as _resetDispatchForTesting } from './dispatch.js';

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

describe('POST /api/tickets', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('创建工单立即返回 201，status 为 queued', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .send({ title: 'Test ticket', description: 'Test desc' })
      .expect(201);

    expect(res.body).toBeDefined();
    expect(res.body.status).toBe('queued');
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
    expect(res.body.status).toBe('queued');
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
      .send({ title: 'Pull test', description: 'Desc', agent: 'donky' })
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

  it('返回 complete / failed / pending_decision 三类通知摘要', async () => {
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
      .patch(`/api/tickets/${completeRes.body.id}`)
      .send({ status: 'complete', result_summary: '已完成并关单' })
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
      .patch(`/api/tickets/${failedRes.body.id}`)
      .send({ status: 'failed', error: '测试失败' })
      .expect(200);

    const decisionRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Decision ticket',
        description: 'Desc',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        decision_owner: '荣晖',
        assigned_agent: 'beavy',
      })
      .expect(201);
    await request(app)
      .patch(`/api/tickets/${decisionRes.body.id}`)
      .send({ status: 'pending_decision', decision_summary: '需要老大拍板' })
      .expect(200);

    const res = await request(app)
      .get('/api/notifications/summary?minutes=180')
      .expect(200);

    expect(res.body.counts.complete).toBe(1);
    expect(res.body.counts.failed).toBe(1);
    expect(res.body.counts.pending_decision).toBe(1);
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
      decision_owner: '荣晖',
      decision_summary: '需要老大拍板',
    }));
  });
});

describe('PATCH /api/tickets/:id', () => {
  beforeEach(() => {
    ensureCleanStore();
  });

  it('更新工单状态为 running', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Patch test', description: 'Desc' })
      .expect(201);
    const ticketId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ status: 'running' })
      .expect(200);

    expect(res.body.status).toBe('running');
  });

  it('更新工单为 done 并设置 result_summary', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Complete test', description: 'Desc' })
      .expect(201);
    const ticketId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ status: 'done', result_summary: '任务完成' })
      .expect(200);

    expect(res.body.status).toBe('done');
    expect(res.body.result_summary).toBe('任务完成');
  });

  it('非法状态值返回 400', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Invalid status test', description: 'Desc' })
      .expect(201);
    const ticketId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ status: 'completed' })
      .expect(400);

    expect(res.body.error).toBe('Bad request');
    expect(res.body.message).toContain('status 非法');
  });

  it('可更新分诊结构化字段并输出责任路由', async () => {
    const parentRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Parent ticket', description: 'Root' })
      .expect(201);

    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Patch triage', description: 'Desc', status: 'triage', triage_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({
        status: 'review',
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
        status: 'running',
        triage_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);
    expect(createRes.body.status).toBe('running');

    const res = await request(app).get('/api/dispatch/ready').expect(200);
    expect(res.body.ready).toBeDefined();
    expect(res.body.ready.length).toBeGreaterThanOrEqual(1);
    const item = res.body.ready.find((r) => r.ticket_id === createRes.body.id);
    expect(item).toBeDefined();
    expect(item.agent).toBe('donky');
    expect(item.kind).toBeUndefined(); // 正常单无 kind
  });

  it('running + decision 评论 => workflow_mismatch 告警，派给 decision_owner', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Mismatch decision',
        description: 'Desc',
        status: 'running',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        decision_owner: '荣晖',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;
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
    expect(item.agent).toBe('荣晖');
    expect(item.workflow_mismatch).toBeDefined();
    expect(item.workflow_mismatch.category).toBe('decision_required');
    expect(item.workflow_mismatch.recommended_status).toBe('pending_decision');
    expect(item.workflow_mismatch.reason).toBeDefined();
    expect(item.message).toContain('workflow_mismatch');
    expect(item.message).toContain(item.workflow_mismatch.reason);
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
        status: 'complete',
        assigned_agent: 'beavy',
      })
      .expect(201);

    const readyRes = await request(app).get('/api/notifications/ready').expect(200);
    const event = readyRes.body.ready.find((x) => x.ticket_id === createRes.body.id);
    expect(event).toBeDefined();

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
        status: 'complete',
        assigned_agent: 'beavy',
      })
      .expect(201);

    const ticketId = createRes.body.id;

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

    // 状态切换后，再次进入 complete 时应允许重新通知
    await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ status: 'running' })
      .expect(200);
    await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ status: 'complete' })
      .expect(200);

    const readyRes4 = await request(app).get('/api/notifications/ready').expect(200);
    const second = readyRes4.body.ready.find((x) => x.ticket_id === ticketId);
    expect(second).toBeDefined();
    expect(second.event_id).not.toBe(first.event_id);
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
        status: 'running',
        triage_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ status: 'running' })
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
        status: 'running',
        triage_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ status: 'running' })
      .expect(200);
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
});
