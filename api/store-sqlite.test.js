/**
 * @vitest-environment node
 * store-sqlite 基本 CRUD 测试
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as store from './store-sqlite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, 'data');

describe('store-sqlite', () => {
  beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
    const uniqueDb = path.join(TEST_DIR, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.TICKETS_DB_PATH = uniqueDb;
    store._resetDbForTesting();
  });

  it('getAllTickets 空库返回 []', () => {
    const all = store.getAllTickets();
    expect(all).toEqual([]);
  });

  it('getTicketById 不存在返回 null', () => {
    expect(store.getTicketById(999)).toBeNull();
  });

  it('createTicket 创建并返回工单', () => {
    const t = store.createTicket({
      title: 'Test',
      description: 'Desc',
      status: 'queued',
      assigned_agent: 'donky',
    });
    expect(t).toBeDefined();
    expect(t.id).toBe(1);
    expect(t.title).toBe('Test');
    expect(t.description).toBe('Desc');
    expect(t.status).toBe('queued');
    expect(t.assigned_agent).toBe('donky');
    expect(t.comments).toEqual([]);
  });

  it('getTicketById 可获取已创建工单', () => {
    store.createTicket({ title: 'A', description: 'B' });
    const t = store.getTicketById(1);
    expect(t).toBeDefined();
    expect(t.title).toBe('A');
    expect(t.description).toBe('B');
  });

  it('updateTicket 更新工单', () => {
    store.createTicket({ title: 'Old', description: 'D' });
    const updated = store.updateTicket(1, { status: 'running', result_summary: 'Done' });
    expect(updated.status).toBe('running');
    expect(updated.result_summary).toBe('Done');
    expect(updated.title).toBe('Old');
  });

  it('updateTicket 工单不存在返回 null', () => {
    expect(store.updateTicket(999, { status: 'done' })).toBeNull();
  });

  it('addComment 添加评论', () => {
    store.createTicket({ title: 'T', description: 'D' });
    const withComment = store.addComment(1, {
      author: 'user',
      content: 'Hello',
      timestamp: '2099-01-01T12:00:00.000Z',
    });
    expect(withComment.comments).toHaveLength(1);
    expect(withComment.comments[0].author).toBe('user');
    expect(withComment.comments[0].content).toBe('Hello');
  });

  it('addComment 工单不存在返回 null', () => {
    expect(store.addComment(999, { author: 'x', content: 'y' })).toBeNull();
  });

  it('getAllTickets 返回含 comments 的完整工单', () => {
    store.createTicket({ title: 'T', description: 'D' });
    store.addComment(1, { author: 'a', content: 'c', timestamp: 'ts' });
    const all = store.getAllTickets();
    expect(all).toHaveLength(1);
    expect(all[0].comments).toHaveLength(1);
    expect(all[0].comments[0].author).toBe('a');
  });

  it('综合：create→get→update→addComment→getAll 同块内连贯', () => {
    const created = store.createTicket({ title: 'X', description: 'Y' });
    expect(created.id).toBe(1);
    const got = store.getTicketById(1);
    expect(got?.title).toBe('X');
    const updated = store.updateTicket(1, { status: 'done' });
    expect(updated?.status).toBe('done');
    const withComment = store.addComment(1, { author: 'u', content: 'c' });
    expect(withComment?.comments).toHaveLength(1);
    const all = store.getAllTickets();
    expect(all).toHaveLength(1);
  });

  it('持久化分诊结构化字段与责任路由字段', () => {
    const created = store.createTicket({
      title: 'Triage',
      description: 'Need triage fields',
      status: 'triage',
      triage_owner: 'leoss',
      assigned_agent: 'beavy',
      next_actor: 'qa-owner',
      platform: 'ticket-platform',
      request_type: 'feature',
      triage_summary: '先完成最小闭环',
      implementation_scope: '前后端详情页和接口',
      constraints: '不改复杂状态机',
      deliverables: '字段、接口、页面',
      acceptance_criteria: '可填写并保存',
    });

    expect(created.status).toBe('triage');
    expect(created.triage_owner).toBe('leoss');
    expect(created.assigned_agent).toBe('beavy');
    expect(created.next_actor).toBe('qa-owner');
    expect(created.platform).toBe('ticket-platform');
    expect(created.request_type).toBe('feature');
    expect(created.constraints).toBe('不改复杂状态机');
  });


  it('兼容旧库：缺少 next_actor 列时也能自动补齐并继续创建工单', () => {
    const legacyDb = path.join(TEST_DIR, `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const raw = new Database(legacyDb);
    raw.exec(`
      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued',
        assigned_agent TEXT,
        priority TEXT DEFAULT 'medium',
        session_key TEXT,
        run_id TEXT,
        created TEXT NOT NULL,
        last_update TEXT NOT NULL,
        result_summary TEXT,
        error TEXT,
        watchers_json TEXT DEFAULT '[]',
        platform TEXT,
        request_type TEXT,
        triage_summary TEXT,
        implementation_scope TEXT,
        constraints_text TEXT,
        deliverables TEXT,
        acceptance_criteria TEXT,
        parent_ticket_id INTEGER,
        triage_owner TEXT,
        review_owner TEXT
      );
      CREATE TABLE ticket_comments (
        id INTEGER PRIMARY KEY,
        ticket_id INTEGER NOT NULL,
        author TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        content TEXT NOT NULL
      );
    `);
    raw.close();

    process.env.TICKETS_DB_PATH = legacyDb;
    store._resetDbForTesting();

    const created = store.createTicket({
      title: 'Legacy schema ticket',
      description: 'should auto migrate next_actor',
      status: 'queued',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      assigned_agent: 'beavy',
      next_actor: 'beavy',
    });

    expect(created.next_actor).toBe('beavy');

    const verify = new Database(legacyDb, { readonly: true });
    const cols = verify.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
    verify.close();
    expect(cols).toContain('next_actor');
  });

  it('支持基础父子工单关系读取', () => {
    const parent = store.createTicket({ title: 'Parent', description: 'root' });
    const child = store.createTicket({
      title: 'Child',
      description: 'sub task',
      parent_ticket_id: parent.id,
      assigned_agent: 'beavy',
    });

    const parentDetail = store.getTicketById(parent.id);
    const childDetail = store.getTicketById(child.id);

    expect(childDetail.parent_ticket_id).toBe(parent.id);
    expect(childDetail.parent_ticket?.title).toBe('Parent');
    expect(parentDetail.child_tickets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: child.id, title: 'Child', assigned_agent: 'beavy' }),
      ])
    );
  });

  it('删除工单后新建不会复用旧 ticket id', () => {
    const first = store.createTicket({ title: 'First', description: 'A' });
    const second = store.createTicket({ title: 'Second', description: 'B' });

    expect(first.id).toBe(1);
    expect(second.id).toBe(2);

    expect(store.deleteTicket(second.id)).toBe(true);

    const third = store.createTicket({ title: 'Third', description: 'C' });
    expect(third.id).toBe(3);
  });

  it('读取工单时会过滤早于工单创建时间的脏评论', () => {
    const created = store.createTicket({
      title: 'Ticket with stale comments',
      description: 'D',
      created: '2026-03-09T07:22:22.491Z',
      comments: [
        {
          id: 1001,
          author: 'legacy',
          timestamp: '2026-03-07T08:29:09.572Z',
          content: 'old leaked comment',
        },
        {
          id: 1002,
          author: 'beavy',
          timestamp: '2026-03-09T07:22:43.645Z',
          content: 'valid comment',
        },
      ],
    });

    const detail = store.getTicketById(created.id);
    expect(detail.comments).toHaveLength(1);
    expect(detail.comments[0].content).toBe('valid comment');
    expect(detail.comments[0].ticket_id).toBe(created.id);
  });
});
