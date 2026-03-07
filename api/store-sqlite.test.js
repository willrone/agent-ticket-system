/**
 * @vitest-environment node
 * store-sqlite 基本 CRUD 测试
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach } from 'vitest';
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
      timestamp: '2026-01-01 12:00',
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
});
