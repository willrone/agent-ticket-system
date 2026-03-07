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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, 'data', 'test-tickets.db');

function ensureCleanStore() {
  _resetDbForTesting();
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

  it('标题为空时返回 400', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .send({ title: '', description: 'Desc' })
      .expect(400);

    expect(res.body.error).toBe('Bad request');
    expect(res.body.message).toContain('标题');
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
