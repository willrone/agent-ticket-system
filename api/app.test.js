/**
 * @vitest-environment node
 * API 测试：Pull 模式 - 创建工单立即返回 queued、拉取、更新、dispatch
 */
import './test-setup.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from './app.js';
import { _resetDbForTesting, findLatestAssignmentForTicket, createOrReuseAssignment } from './store-sqlite.js';
import {
  _resetDbForTesting as _resetDispatchForTesting,
  ackDispatchEvent as ackDispatchEventRecord,
} from './dispatch.js';
import { getAuditSessionKeyForTicket, getNotificationSessionKey, NOTIFY_MAIN_SESSION } from './agent-session-router.js';
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

  it('ticket-platform 工单未显式指定 assigned_agent 时默认固化为 beavy', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .send({ title: 'Ticket platform default executor', description: 'Desc', platform: 'ticket-platform' })
      .expect(201);

    expect(res.body.platform).toBe('ticket-platform');
    expect(res.body.assigned_agent).toBe('beavy');
    expect(res.body.current_actor).toBe('leoss');
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
        review_owner: 'ronghui',
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
      .send({ title: 'Running ticket', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${runningRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy', comment: '开始处理' })
      .expect(200);

    const doneRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Done ticket', status: 'queued', assigned_agent: 'donky', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${doneRes.body.id}/transition`)
      .send({ action: 'start_work', actor: 'donky' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${doneRes.body.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'donky', result_summary: 'ready' })
      .expect(200);

    await request(app)
      .post('/api/tickets')
      .send({ title: 'Pending decision ticket', status: 'pending_decision', assigned_agent: 'beavy', triage_owner: 'leoss' })
      .expect(201);

    await request(app)
      .post('/api/tickets')
      .send({ title: 'Complete ticket', status: 'complete', assigned_agent: 'beavy', triage_owner: 'leoss' })
      .expect(201);

    const res = await request(app)
      .get('/api/metrics/dashboard')
      .expect(200);

    expect(res.body.data.stats).toEqual(expect.objectContaining({
      total: 4,
      active: 3,
      inProgress: 1,
      waitingReview: 1,
      closed: 1,
    }));

    expect(res.body.data.statusDistribution).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'running', name: '进行中', value: 1 }),
      expect.objectContaining({ status: 'done', name: '待验收', value: 1 }),
      expect.objectContaining({ status: 'pending_decision', name: '待决策', value: 1 }),
      expect.objectContaining({ status: 'complete', name: '已关单', value: 1 }),
    ]));
  });


  it('Dashboard 状态分布包含 paused，但 active/inProgress 不把它当 running', async () => {
    await request(app)
      .post('/api/tickets')
      .send({ title: 'Paused metric', status: 'paused', assigned_agent: 'beavy', triage_owner: 'leoss', pause_reason: '窗口未到', paused_from_status: 'running' })
      .expect(201);

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

  it('返回 complete / failed / pending_decision 三类通知摘要', async () => {
    const completeRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Completed ticket',
        description: 'Desc',
        status: 'queued',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
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
        status: 'queued',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
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
        status: 'queued',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        decision_owner: '荣晖',
        assigned_agent: 'beavy',
      })
      .expect(201);
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
        status: 'done',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    const patchRes = await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ review_owner: 'ronghui' })
      .expect(200);

    expect(patchRes.body.review_owner).toBe('ronghui');
    expect(patchRes.body.current_actor).toBe('ronghui');
    expect(patchRes.body.next_actor).toBe('ronghui');
    expect(patchRes.body.next_actor_source).toBe('review_owner');

    const dispatchRes = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const readyItem = dispatchRes.body.ready.find((item) => item.ticket_id === ticketId);
    expect(readyItem).toBeDefined();
    expect(readyItem.agent).toBe('ronghui');
    expect(readyItem.target_session_key).toBe(NOTIFY_MAIN_SESSION);
    expect(readyItem.dedupe_key).toBe('dispatch:done:assignment:ronghui');
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

  it('支持 reset_to_queued：triage_owner 可将 running 工单撤回 queued，并自动写审计评论', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({ title: 'Reset start', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

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
      .send({ title: 'Reset paused start', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

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
      .send({ title: 'Reset reason required', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

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
      .send({ title: 'Reset actor guard', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

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
      .send({ title: 'Formal reassign flow', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

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
      .send({ title: 'Handoff flow', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

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
      .send({ title: 'Paused ready gate', description: 'Desc', status: 'queued', assigned_agent: 'beavy', triage_owner: 'leoss', review_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

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
      .send({ title: 'Patch triage', description: 'Desc', status: 'review', triage_owner: 'leoss' })
      .expect(201);
    const ticketId = createRes.body.id;

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
        status: 'done',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        next_actor: 'auditor',
      })
      .expect(201);
    const ticketId = createRes.body.id;

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
    expect(item.target_gateway_id).toBe('mac-main');
    expect(item.transport).toBe('local_cli');
    expect(item.target_session_key).toBe(NOTIFY_MAIN_SESSION);
    expect(item.reset_session).toBeUndefined();
    expect(item.reason).toBe('decision_required');
    expect(item.dedupe_key).toBe(`dispatch:running:workflow_mismatch:荣晖:decision_required`);
    expect(item.escalation_tier).toBe('warning');
    expect(item.message).toContain('workflow_mismatch');
    expect(item.message).toContain(item.workflow_mismatch.reason);
  });

  it('pending_decision 不进入 dispatch ready，只进入 notifications ready', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Decision only notify',
        description: 'Desc',
        status: 'queued',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        decision_owner: '荣晖',
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
    expect(notifyItem.target_session_key).toBe(NOTIFY_MAIN_SESSION);
    expect(notifyItem.target_gateway_id).toBe('mac-main');
    expect(notifyItem.transport).toBe('local_cli');
    expect(notifyItem.reason).toBe('decision_required');
    expect(notifyItem.dedupe_key).toBe('notify:pending_decision:decision_required:荣晖');
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

  it('done/review 不再进入 notifications ready，reviewer 主交接统一走 dispatch ready', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Review notify target',
        description: 'Desc',
        status: 'queued',
        triage_owner: 'leoss',
        review_owner: 'beavy',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;

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
    expect(dispatchItem.target_session_key).not.toBe(NOTIFY_MAIN_SESSION);
    expect(dispatchItem.target_gateway_id).toBe('mac-main');
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
        status: 'complete',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);

    const supplemental = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Smoke evidence',
        description: 'supplemental smoke ticket',
        status: 'queued',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);

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
      .post(`/api/tickets/${ticketId}/dispatch`)
      .send({ agent: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'start_work',
        actor: 'beavy'
      })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'submit_for_review',
        actor: 'beavy',
        result_summary: 'done'
      })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({
        action: 'approve',
        actor: 'leoss'
      })
      .expect(200);

    const readyRes4 = await request(app).get('/api/notifications/ready').expect(200);
    const second = readyRes4.body.ready.find((x) => x.ticket_id === ticketId);
    expect(second).toBeDefined();
    expect(second.event_id).not.toBe(first.event_id);
  });

  it('done/review 不再生成 notification 去重事件，review_owner 变化由 dispatch 侧重新派单处理', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'notify dedupe by stage reason actor',
        description: 'Desc',
        status: 'done',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);

    const ticketId = createRes.body.id;

    const readyRes1 = await request(app).get('/api/notifications/ready').expect(200);
    expect(readyRes1.body.ready.find((x) => x.ticket_id === ticketId)).toBeUndefined();

    await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .send({ review_owner: 'ronghui' })
      .expect(200);

    const readyRes2 = await request(app).get('/api/notifications/ready').expect(200);
    expect(readyRes2.body.ready.find((x) => x.ticket_id === ticketId)).toBeUndefined();

    const dispatchRes = await request(app).get('/api/dispatch/ready').expect(200);
    const dispatchItem = dispatchRes.body.ready.find((x) => x.ticket_id === ticketId);
    expect(dispatchItem).toBeDefined();
    expect(dispatchItem.agent).toBe('ronghui');
    expect(dispatchItem.target_session_key).toBe(NOTIFY_MAIN_SESSION);
    expect(dispatchItem.dedupe_key).toBe('dispatch:done:assignment:ronghui');
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
        status: 'running',
        triage_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;

    // 手动回拨 last_update 使其超过 running 审计阈值
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { last_update: staleTime });

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
        status: 'review',
        triage_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { last_update: staleTime });

    const res = await request(app).get('/api/audits/ready').expect(200);
    const item = res.body.ready.find((r) => r.ticket_id === ticketId);
    expect(item).toBeDefined();
    expect(item.audit_type).toBe('stale_review');
  });

  it('review 未超过 10 分钟阈值的工单不出现在 audits/ready 中', async () => {
    const freshTime = new Date(Date.now() - 9 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Fresh review ticket',
        description: 'Desc',
        status: 'review',
        triage_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);

    const { updateTicket } = await import('./store.js');
    updateTicket(createRes.body.id, { last_update: freshTime });

    const res = await request(app).get('/api/audits/ready').expect(200);
    const item = res.body.ready.find((r) => r.ticket_id === createRes.body.id);
    expect(item).toBeUndefined();
  });

  it('done 超过 30 分钟阈值的工单生成 stale_done 审计事件', async () => {
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Stale done ticket',
        description: 'Desc',
        status: 'done',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { last_update: staleTime });

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
        status: 'queued',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        decision_owner: '荣晖',
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
      .send({ action: 'block', actor: 'beavy', blocker_summary: '等待外部系统恢复' })
      .expect(200);

    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { last_update: staleTime });

    const res = await request(app).get('/api/audits/ready').expect(200);
    const item = res.body.ready.find((r) => r.ticket_id === ticketId);
    expect(item).toBeDefined();
    expect(item.audit_type).toBe('stale_blocked');
  });

  it('running 未超过 30 分钟阈值的工单不出现在 audits/ready 中', async () => {
    const freshTime = new Date(Date.now() - 29 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Fresh running ticket',
        description: 'Desc',
        status: 'running',
        triage_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);

    const { updateTicket } = await import('./store.js');
    updateTicket(createRes.body.id, { last_update: freshTime });

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
        status: 'running',
        triage_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { last_update: staleTime });

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
        status: 'running',
        triage_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { last_update: staleTime });

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
        status: 'running',
        triage_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;
    const { updateTicket } = await import('./store.js');
    updateTicket(ticketId, { last_update: staleTime });

    const res = await request(app).get('/api/audits/ready').expect(200);
    const item = res.body.ready.find((entry) => entry.ticket_id === ticketId);
    expect(item.contract.version).toBe('2026-03-12.audit-request.v1');
    expect(item.contract.result_endpoint).toBe(`/api/audits/${item.audit_id}/result`);
    expect(item.contract.target_session_key).toBe(`agent:auditor:audit:${ticketId}`);
    expect(item.contract.allowed_conclusions).toContain('stale_running');
    expect(item.message).toContain(`/api/audits/${item.audit_id}/result`);
  });

  it('stale_running 审计结果会写回评论并生成 running 催办，人工评论后闭环清空', async () => {
    const staleTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Running nudge loop',
        description: 'Desc',
        status: 'running',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;
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

    const dispatchReady = await request(app).get('/api/dispatch/ready').expect(200);
    const nudge = dispatchReady.body.ready.find((entry) => entry.ticket_id === ticketId && entry.kind === 'nudge');
    expect(nudge).toEqual(expect.objectContaining({
      agent: 'beavy',
      status: 'running',
      nudge_source: 'audit_result',
      reason: 'nudge_stale_running_notify_only',
      dedupe_key: 'dispatch:running:nudge_stale_running_notify_only:beavy',
      escalation_tier: 'escalated',
    }));
    expect(nudge.audit_result).toEqual(expect.objectContaining({
      audit_id: audit.audit_id,
      suggested_action: 'notify_only',
      reason: '长时间无进展，需要执行人补充状态',
    }));

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
        status: 'queued',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
      })
      .expect(201);
    const ticketId = createRes.body.id;

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
      agent: 'beavy',
      status: 'queued',
      nudge_source: 'queued_stale',
      reason: 'nudge_queued_stale',
      dedupe_key: 'dispatch:queued:nudge_queued_stale:beavy',
      escalation_tier: 'nudge',
    }));
    expect(nudge.message).toContain('queued_stale');

    await request(app)
      .post(`/api/tickets/${ticketId}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);

    const afterStart = await request(app).get('/api/dispatch/ready').expect(200);
    expect(afterStart.body.ready.find((entry) => entry.ticket_id === ticketId && entry.kind === 'nudge')).toBeUndefined();
  });

  it('stale_review 审计结果会生成 review 催办给 reviewer', async () => {
    const staleTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Review nudge loop',
        description: 'Desc',
        status: 'review',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);
    const ticketId = createRes.body.id;
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

    const dispatchReady = await request(app).get('/api/dispatch/ready').expect(200);
    const nudge = dispatchReady.body.ready.find((entry) => entry.ticket_id === ticketId && entry.kind === 'nudge');
    expect(nudge).toEqual(expect.objectContaining({
      agent: 'leoss',
      status: 'review',
      nudge_source: 'audit_result',
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

    const ticket = await request(app)
      .get(`/api/tickets/${ticketId}`)
      .expect(200);

    const readyRes = await request(app).get('/api/dispatch/ready').expect(200);
    const ready = readyRes.body.ready.find((item) => item.ticket_id === ticketId);
    expect(ready).toBeDefined();
    expect(ready.assignment_id).toBeTruthy();
    expect(ready.assignment.assignment_token).toBeTruthy();
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
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Queued dispatch guidance',
        description: 'Desc',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        status: 'queued',
      })
      .expect(201);

    const dispatchRes = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const readyItem = dispatchRes.body.ready.find((item) => item.ticket_id === createRes.body.id);
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
      .send({ title: 'Parent context', assigned_agent: 'leoss', triage_owner: 'leoss', status: 'done' })
      .expect(201);

    const dep = await request(app)
      .post('/api/tickets')
      .send({ title: 'Dependency', assigned_agent: 'doggy', triage_owner: 'leoss', status: 'running' })
      .expect(201);

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
      workflow_notify_policy: expect.objectContaining({
        dispatch_ready: true,
        notification_ready: false,
        target: 'current_actor',
      }),
    }));
    expect(detailRes.body.execution).toEqual(expect.objectContaining({
      mode: detailRes.body.ticket.execution_mode,
      worker_evidence_required: expect.any(Boolean),
      worker_evidence: expect.objectContaining({
        required: expect.any(Boolean),
        has_worker_evidence: expect.any(Boolean),
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
        completion_report_types: ['execution_completed', 'review_submission'],
      }),
    }));

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
        status: 'complete',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'beavy',
      })
      .expect(201);

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
    const root = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Stock root',
        platform: 'stock-platform',
        assigned_agent: 'cowder',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        status: 'running',
      })
      .expect(201);

    const reviewTicket = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Stock review',
        platform: 'stock-platform',
        assigned_agent: 'cowder',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        parent_ticket_id: root.body.id,
        status: 'done',
      })
      .expect(201);

    const blockedTicket = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Stock blocked',
        platform: 'stock-platform',
        assigned_agent: 'cowder',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        parent_ticket_id: root.body.id,
        status: 'blocked',
      })
      .expect(201);

    const dep = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Dependency for blocked',
        platform: 'stock-platform',
        assigned_agent: 'doggy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        status: 'running',
      })
      .expect(201);

    await request(app)
      .post(`/api/tickets/${blockedTicket.body.id}/dependencies`)
      .send({ depends_on_ticket_id: dep.body.id, dependency_type: 'blocks' })
      .expect(200);

    await request(app)
      .post(`/api/tickets/${blockedTicket.body.id}/comments`)
      .send({ author: 'leoss', content: '请先等依赖完成', type: 'progress' })
      .expect(201);

    await request(app)
      .post('/api/tickets')
      .send({
        title: 'Ticket platform control',
        platform: 'ticket-platform',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        status: 'running',
      })
      .expect(201);

    const workboardRes = await request(app)
      .get('/api/v1/agent/workboards/stock-tickets')
      .query({
        assigned_agent: 'cowder',
        bucket: 'waiting_review,blocked',
        has_dependencies: true,
        parent_ticket_id: root.body.id,
        group_by: 'bucket',
        sort: 'priority_desc',
      })
      .expect(200);

    expect(workboardRes.body.data.filters).toEqual(expect.objectContaining({
      platform: 'stock-platform',
      assigned_agent: 'cowder',
      bucket: ['waiting_review', 'blocked'],
      has_dependencies: true,
      parent_ticket_id: root.body.id,
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
            id: blockedTicket.body.id,
            bucket: 'blocked',
            has_dependencies: true,
            relation_summary: expect.objectContaining({
              dependency_count: 1,
              parent_ticket_id: root.body.id,
            }),
            last_comment_excerpt: expect.objectContaining({ excerpt: '请先等依赖完成' }),
          }),
        ]),
      }),
    ]));
    expect(workboardRes.body.data.items).toEqual([]);
    expect(workboardRes.body.data.supported_query_params).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'group_by' }),
      expect.objectContaining({ key: 'has_dependencies' }),
    ]));

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

    const readyAfterRunning = await request(app)
      .get('/api/dispatch/ready')
      .expect(200);
    const runningReady = readyAfterRunning.body.ready.find((entry) => entry.ticket_id === ticket.id && entry.status === 'running');
    expect(runningReady).toBeDefined();
    expect(runningReady.assignment_id).toBeTruthy();
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
    expect(nudgeEntry.reason).toBe('nudge_queued_stale');
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
      .expect(200);

    expect(report2.body.idempotent).toBe(true);

    const ticketAfterDuplicate = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    const beavyResultComments = ticketAfterDuplicate.body.comments.filter((comment) => comment.author === 'beavy' && comment.type === 'result');
    expect(beavyResultComments).toHaveLength(1);
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
    expect(detailBefore.body.execution_guard?.suppress_dispatch).toBe(true);

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

  it('stale starting worker 不压制 done 工单的 dispatch', async () => {
    const created = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Done with stale starting',
        status: 'queued',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        execution_mode: 'subagent',
        max_active_workers: 1,
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${created.body.id}/workers`)
      .send({
        worker_key: 'stale',
        worker_type: 'subagent',
        status: 'starting',
      })
      .expect(201);
    await request(app)
      .post(`/api/tickets/${created.body.id}/transition`)
      .send({ action: 'start_work', actor: 'beavy' })
      .expect(200);
    await request(app)
      .post(`/api/tickets/${created.body.id}/transition`)
      .send({ action: 'submit_for_review', actor: 'beavy', result_summary: 'done' })
      .expect(200);
    const detail = await request(app).get(`/api/tickets/${created.body.id}`).expect(200);
    expect(detail.body.status).toBe('done');
    expect(detail.body.worker_stats.active_workers).toBe(0);
    expect(detail.body.execution_guard?.suppress_dispatch).toBe(false);
    const dispatchRes = await request(app).get('/api/dispatch/ready').expect(200);
    const item = dispatchRes.body.ready.find((r) => r.ticket_id === created.body.id);
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
    }));

    const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
    expect(ticketAfter.body.status).toBe('pending_decision');
    expect(ticketAfter.body.decision_summary).toContain('需要老大确认');
  });

  it('远端 assignment 未配置 agent API base url 时，不再下发错误 localhost', async () => {
    delete process.env.TICKET_AGENT_API_BASE_URL;
    delete process.env.TICKET_API_BASE_URL;

    const created = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Remote agent-facing MVP',
        description: '验证远端 contract 不下发 localhost',
        status: 'queued',
        assigned_agent: 'donky',
        triage_owner: 'leoss',
        review_owner: 'leoss',
      })
      .expect(201);

    const readyRes = await request(app).get('/api/dispatch/ready').expect(200);
    const ready = readyRes.body.ready.find((item) => item.ticket_id === created.body.id);

    expect(ready).toBeDefined();
    expect(ready.target_gateway_id).toBe('pc-stock');
    expect(ready.assignment.runtime_context.api_base_url).toBe(null);
    expect(ready.message).toContain('UNCONFIGURED_REMOTE_API_BASE_URL');
    expect(ready.message).toContain('TICKET_AGENT_API_BASE_URL');

    const detailRes = await request(app)
      .get(`/api/v1/agent/assignments/${ready.assignment_id}`)
      .query({ assignment_token: ready.assignment.assignment_token })
      .expect(200);

    expect(detailRes.body.runtime_context.api_base_url).toBe(null);
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
  beforeEach(() => {
    ensureCleanStore();
    delete process.env.TICKET_AGENT_API_BASE_URL;
    delete process.env.TICKET_API_BASE_URL;
  });

  it('GET /api/live-acceptance/tickets/:id 返回 pass verdict 与 live surface 摘要', async () => {
    const ticketRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Live acceptance pass',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        execution_mode: 'direct',
        status: 'running',
      })
      .expect(201);
    const ticket = ticketRes.body;

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
    const blockedDepRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Blocking dependency',
        assigned_agent: 'donky',
        triage_owner: 'leoss',
        status: 'running',
      })
      .expect(201);
    const blockedDep = blockedDepRes.body;

    const ticketRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Live acceptance dependency gate',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        execution_mode: 'direct',
        status: 'running',
      })
      .expect(201);
    const ticket = ticketRes.body;

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

  it('GET /api/version 返回运行态版本契约：git_commit、build_time、schema_version、bundle_version', async () => {
    const res = await request(app).get('/api/version').expect(200);
    expect(res.body.data).toEqual(expect.objectContaining({
      schema_version: expect.any(String),
      bundle_version: expect.any(String),
      build_time: expect.any(String),
    }));
    expect(typeof res.body.data.git_commit === 'string' || res.body.data.git_commit === null).toBe(true);
    expect(res.body.data.schema_version.length).toBeGreaterThan(0);
    expect(res.body.data.bundle_version.length).toBeGreaterThan(0);
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
        status: 'running',
      })
      .expect(201);
    const versionRes = await request(app).get('/api/version').expect(200);
    const gateRes = await request(app)
      .get(`/api/live-acceptance/tickets/${ticketRes.body.id}`)
      .expect(200);
    expect(gateRes.body.data.live_surfaces.runtime_version).toBeDefined();
    expect(gateRes.body.data.live_surfaces.runtime_version.schema_version).toBe(versionRes.body.data.schema_version);
    expect(gateRes.body.data.live_surfaces.runtime_version.bundle_version).toBe(versionRes.body.data.bundle_version);
    expect(gateRes.body.data.live_surfaces.runtime_version.git_commit).toBe(versionRes.body.data.git_commit);
  });

  it('dispatch ready 单条契约包含 dispatch_id、ticket_id、agent、target_session_key、target_gateway_id、transport、dedupe_key、reason、escalation_tier', async () => {
    const createRes = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Dispatch contract',
        description: 'Desc',
        status: 'running',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        assigned_agent: 'donky',
      })
      .expect(201);
    const res = await request(app).get('/api/dispatch/ready').expect(200);
    const item = res.body.ready.find((r) => r.ticket_id === createRes.body.id);
    expect(item).toBeDefined();
    expect(item).toEqual(expect.objectContaining({
      dispatch_id: expect.any(Number),
      ticket_id: createRes.body.id,
      agent: 'donky',
      target_session_key: expect.any(String),
      target_gateway_id: expect.any(String),
      transport: expect.any(String),
      dedupe_key: expect.any(String),
      reason: expect.any(String),
      escalation_tier: expect.any(String),
    }));
    expect(item.target_session_key).toBe(`agent:donky:ticket:${createRes.body.id}`);
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

  beforeEach(() => {
    ensureCleanStore();
    process.env.TICKET_AGENT_ADMIN_TOKENS_JSON = JSON.stringify({
      cowder_stock_admin: {
        token: ADMIN_TOKEN,
        agent_id: 'cowder',
        capabilities: ['stock_tickets:read', 'stock_tickets:comment', 'stock_tickets:transition'],
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
    const stockTicket = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Legacy stock admin target',
        platform: 'stock-platform',
        assigned_agent: 'cowder',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        status: 'running',
      })
      .expect(201);

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
      expect.objectContaining({ id: stockTicket.body.id, platform: 'stock-platform' }),
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

    const stockTicket = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Restricted stock admin target',
        platform: 'stock-platform',
        assigned_agent: 'cowder',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        status: 'running',
      })
      .expect(201);

    const capabilityRes = await request(app)
      .post(`/api/v1/admin/stock-tickets/${stockTicket.body.id}/comments`)
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
      .post(`/api/v1/admin/stock-tickets/${stockTicket.body.id}/comments`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ content: 'bad impersonation', author: 'beavy' })
      .expect(403);

    expect(impersonateCommentRes.body).toEqual(expect.objectContaining({
      detail: 'agent-admin comment 不允许伪装为其他 author',
      expected_author: 'cowder',
    }));
    expect(impersonateCommentRes.body.error).toBeUndefined();

    const impersonateTransitionRes = await request(app)
      .post(`/api/v1/admin/stock-tickets/${stockTicket.body.id}/transition`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ action: 'pause', actor: 'beavy', pause_reason: 'bad impersonation' })
      .expect(403);

    expect(impersonateTransitionRes.body).toEqual(expect.objectContaining({
      detail: 'agent-admin transition 不允许伪装为其他 actor',
      expected_actor: 'cowder',
    }));
    expect(impersonateTransitionRes.body.error).toBeUndefined();
  });

  it('agent-admin 可读取 stock 工单盘面，并以自身身份 comment / transition', async () => {
    const stockTicket = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Stock admin target',
        platform: 'stock-platform',
        assigned_agent: 'cowder',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        status: 'running',
      })
      .expect(201);

    const nonStockTicket = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Ticket platform control',
        platform: 'ticket-platform',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        status: 'running',
      })
      .expect(201);

    const listRes = await request(app)
      .get('/api/v1/admin/stock-tickets')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .query({ assigned_agent: 'cowder' })
      .expect(200);

    expect(listRes.body.data.auth).toEqual(expect.objectContaining({
      role: 'agent_admin',
      agent_id: 'cowder',
      capabilities: expect.arrayContaining(['stock_tickets:read', 'stock_tickets:comment', 'stock_tickets:transition']),
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
        id: stockTicket.body.id,
        platform: 'stock-platform',
        assigned_agent: 'cowder',
      }),
    ]));

    const actionsRes = await request(app)
      .get(`/api/v1/admin/stock-tickets/${stockTicket.body.id}/actions`)
      .set('X-Agent-Admin-Token', ADMIN_TOKEN)
      .expect(200);

    expect(actionsRes.body).toEqual(expect.objectContaining({
      ticket_id: stockTicket.body.id,
      current_status: 'running',
      available_actions: expect.arrayContaining(['submit_for_review', 'request_decision', 'pause', 'block', 'fail']),
    }));

    const commentRes = await request(app)
      .post(`/api/v1/admin/stock-tickets/${stockTicket.body.id}/comments`)
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
      .post(`/api/v1/admin/stock-tickets/${stockTicket.body.id}/transition`)
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
        id: stockTicket.body.id,
        status: 'done',
        current_actor: 'leoss',
      }),
    }));

    const scopeRes = await request(app)
      .get(`/api/v1/admin/stock-tickets/${nonStockTicket.body.id}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .expect(403);

    expect(scopeRes.body).toEqual(expect.objectContaining({
      detail: '当前 agent-admin 接口仅允许管理 stock-platform 工单',
      ticket_id: nonStockTicket.body.id,
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
    const res = await request(app)
      .post('/api/tickets')
      .send({
        title: 'Agent action ticket',
        description: 'for agent-facing ticket action api tests',
        assigned_agent: 'beavy',
        triage_owner: 'leoss',
        review_owner: 'leoss',
        execution_mode: 'direct',
        ...overrides,
      })
      .expect(201);

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

  it('POST /api/agent/tickets guard path：拒绝越权 assigned_agent 与 forbidden field', async () => {
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

    const forbiddenAgentRes = await request(app)
      .post('/api/agent/tickets')
      .send({
        actor: 'beavy',
        title: 'Cross-agent create',
        assigned_agent: 'donky',
      })
      .expect(403);

    expect(forbiddenAgentRes.body).toEqual(expect.objectContaining({
      detail: 'assigned_agent 只能留空或等于 actor',
      actor: 'beavy',
      assigned_agent: 'donky',
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
      available_actions: [],
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

  it('POST /api/agent/tickets/:id/approve happy path：review_owner 可在 review 阶段关单', async () => {
    const ticket = await createReviewTicket();

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
      available_actions: [],
    }));
  });

  it('POST /api/agent/tickets/:id/approve 不再把人类主体展示名映射成 agent id；如已授权需显式使用被授权 agent id', async () => {
    const ticket = await createReviewTicket();

    const res = await request(app)
      .post(`/api/agent/tickets/${ticket.id}/approve`)
      .send({ actor: '荣晖' })
      .expect(403);

    expect(res.body).toEqual(expect.objectContaining({
      detail: 'actor 荣晖 是人类主体，不是平台注册 agent；如已授权代办，请改用被授权的 agent id',
      actor: '荣晖',
      human_principal: true,
    }));
    expect(res.body.known_agents).toEqual(expect.arrayContaining(['leoss']));
    expect(res.body.error).toBeUndefined();
  });

  it('POST /api/agent/tickets/:id/reject happy path：review_owner 可在 review 阶段打回 queued', async () => {
    const ticket = await createReviewTicket({ title: 'Review ticket for reject' });

    const res = await request(app)
      .post(`/api/agent/tickets/${ticket.id}/reject`)
      .send({ actor: 'leoss', reject_reason: '请补齐 hosted approve/reject write path 的 live smoke。' })
      .expect(200);

    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      action: 'reject',
      ticket: expect.objectContaining({
        id: ticket.id,
        status: 'queued',
        result_summary: null,
        next_actor: 'beavy',
      }),
      available_actions: expect.arrayContaining(['start_work']),
    }));
  });

  it('POST /api/agent/tickets/:id/approve|reject guard path：wrong actor / missing reject_reason / action not allowed 都返回 guard 错误', async () => {
    const reviewTicket = await createReviewTicket({ title: 'Review ticket for approve/reject guard' });

    const forbiddenApproveRes = await request(app)
      .post(`/api/agent/tickets/${reviewTicket.id}/approve`)
      .send({ actor: 'beavy' })
      .expect(403);

    expect(forbiddenApproveRes.body).toEqual(expect.objectContaining({
      detail: 'approve 仅允许 leoss 执行',
      action: 'approve',
      actor: 'beavy',
      expected_actor: 'leoss',
      role_key: 'review_owner',
      ticket_id: reviewTicket.id,
    }));
    expect(forbiddenApproveRes.body.error).toBeUndefined();

    const missingRejectReasonRes = await request(app)
      .post(`/api/agent/tickets/${reviewTicket.id}/reject`)
      .send({ actor: 'leoss' })
      .expect(400);

    expect(missingRejectReasonRes.body).toEqual(expect.objectContaining({
      detail: 'reject_reason 不能为空',
      required_fields: ['actor', 'reject_reason'],
    }));
    expect(missingRejectReasonRes.body.error).toBeUndefined();

    const queuedTicket = await createTicket({ title: 'Queued ticket cannot approve' });
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

  it('runtime / skills / playbook 都暴露 create/pause/resume/approve/reject ticket_actions discoverability', async () => {
    const runtimeRes = await request(app)
      .get('/api/v1/agent/runtime/context')
      .expect(200);
    expectTicketActionKeys(runtimeRes.body.data.ticket_actions);
    expectTicketActionKeys(runtimeRes.body.data.discoverability.ticket_actions);

    const skillsRes = await request(app)
      .get('/api/v1/agent/skills/current')
      .expect(200);
    expectTicketActionKeys(skillsRes.body.data.ticket_actions);
    expectTicketActionKeys(skillsRes.body.data.discoverability.ticket_actions);
    expect(skillsRes.body.data.markdown).toContain('reset_to_queued');
    expect(skillsRes.body.data.markdown).toContain('不在 agent-facing ticket_actions 直写范围内');
    expect(skillsRes.body.data.markdown).toContain('填写 `reason`');

    const playbookRes = await request(app)
      .get('/api/v1/agent/playbooks/ticket-handler')
      .expect(200);
    expectTicketActionKeys(playbookRes.body.data.ticket_actions);
    expectTicketActionKeys(playbookRes.body.data.discoverability.ticket_actions);
    expect(playbookRes.body.data.markdown).toContain('reset_to_queued');
    expect(playbookRes.body.data.markdown).toContain('triage_owner');
  });
});
