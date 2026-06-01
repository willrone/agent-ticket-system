/**
 * @vitest-environment node
 * store-sqlite 基本 CRUD 测试
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as store from './store-sqlite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, 'data');
const ORIGINAL_DB_PATH = process.env.TICKETS_DB_PATH;

describe('store-sqlite', () => {
  beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
    const uniqueDb = path.join(TEST_DIR, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.TICKETS_DB_PATH = uniqueDb;
    store._resetDbForTesting();
  });

  afterEach(() => {
    const dbPath = process.env.TICKETS_DB_PATH;
    store._resetDbForTesting();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
    if (ORIGINAL_DB_PATH) {
      process.env.TICKETS_DB_PATH = ORIGINAL_DB_PATH;
    } else {
      delete process.env.TICKETS_DB_PATH;
    }
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


  it('持久化 paused 相关字段', () => {
    const created = store.createTicket({
      title: 'Paused ticket',
      description: 'D',
      status: 'paused',
      assigned_agent: 'beavy',
      paused_from_status: 'running',
      paused_by: 'beavy',
      paused_at: '2026-03-10T00:00:00.000Z',
      pause_reason: '等待窗口期后继续',
    });

    const detail = store.getTicketById(created.id);
    expect(detail.status).toBe('paused');
    expect(detail.paused_from_status).toBe('running');
    expect(detail.paused_by).toBe('beavy');
    expect(detail.paused_at).toBe('2026-03-10T00:00:00.000Z');
    expect(detail.pause_reason).toBe('等待窗口期后继续');
  });

  it('支持 participant registry 持久化与读取', () => {
    store.upsertParticipantRegistryEntry({
      participant_id: 'beavy',
      display_name: '小李',
      emoji: '🦫',
      participant_type: 'agent',
      role_type: 'builder',
      ownership_layer: 'development',
      primary_platform: 'ticket-platform',
      responsibilities: ['development'],
      collaborates_with: ['leoss'],
      responsibility_summary: '负责实现与回归',
      gateway_id: 'mac-main',
      source_kind: 'manual',
      status: {
        availability_status: 'paused',
        eligibility_status: 'limited',
        accepts_assignment_types: ['bugfix', 'feature'],
        status_reason: '正在回归窗口',
        metadata: { source: 'test' },
      },
      capabilities: ['development', 'review_assist'],
    });

    const detail = store.getParticipantRegistryEntry('beavy');
    expect(detail).toEqual(expect.objectContaining({
      participant_id: 'beavy',
      display_name: '小李',
      source_kind: 'manual',
      capabilities: expect.arrayContaining(['development', 'review_assist']),
      status: expect.objectContaining({
        availability_status: 'paused',
        eligibility_status: 'limited',
        accepts_assignment_types: ['bugfix', 'feature'],
      }),
    }));

    const rows = store.listParticipantRegistryEntries();
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ participant_id: 'beavy' }),
    ]));
  });

  it('syncParticipantRegistryFromTopology 不覆盖已持久化动态状态', () => {
    store.upsertParticipantRegistryEntry({
      participant_id: 'beavy',
      display_name: '小李',
      primary_platform: 'ticket-platform',
      responsibilities: ['development'],
      gateway_id: 'mac-main',
      source_kind: 'manual',
      status: {
        availability_status: 'unavailable',
        eligibility_status: 'blocked',
        accepts_assignment_types: ['hotfix'],
        status_reason: '休假中',
      },
      capabilities: ['manual_override'],
    });

    store.syncParticipantRegistryFromTopology([
      {
        participant_id: 'beavy',
        display_name: '小李',
        primary_platform: 'ticket-platform',
        responsibilities: ['development'],
        gateway_id: 'mac-main',
        source_kind: 'topology',
      },
    ]);

    const detail = store.getParticipantRegistryEntry('beavy');
    expect(detail.status).toEqual(expect.objectContaining({
      availability_status: 'unavailable',
      eligibility_status: 'blocked',
      accepts_assignment_types: ['hotfix'],
      status_reason: '休假中',
    }));
    expect(detail.capabilities).toEqual(expect.arrayContaining(['manual_override']));
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

  it('支持补充 smoke/validation/review sample 关系建模与聚合读取', () => {
    const primary = store.createTicket({ title: 'Primary', description: 'main ticket', status: 'complete' });
    const smoke = store.createTicket({ title: 'Smoke', description: 'smoke evidence', status: 'complete' });
    const validation = store.createTicket({ title: 'Validation', description: 'validation evidence', status: 'done' });

    expect(store.addTicketRelation(smoke.id, primary.id, 'smoke_of')).toBe(true);
    expect(store.addTicketRelation(validation.id, primary.id, 'validation_of')).toBe(true);

    const primaryDetail = store.getTicketById(primary.id);
    const smokeDetail = store.getTicketById(smoke.id);

    expect(primaryDetail.supplemental_tickets).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation_type: 'smoke_of', ticket: expect.objectContaining({ id: smoke.id }) }),
      expect.objectContaining({ relation_type: 'validation_of', ticket: expect.objectContaining({ id: validation.id }) }),
    ]));
    expect(primaryDetail.supplemental_summary).toEqual(expect.objectContaining({
      total: 2,
      complete: 1,
      pending_review: 1,
      open: 1,
    }));
    expect(smokeDetail.supplemental_for_ticket).toEqual(expect.objectContaining({
      relation_type: 'smoke_of',
      ticket: expect.objectContaining({ id: primary.id, status: 'complete' }),
    }));
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

  it('长代码类工单默认推断为 subagent execution_mode', () => {
    const created = store.createTicket({
      title: '实现工单执行平台化',
      description: '需要做后端 API 和前端联调',
      implementation_scope: '前后端代码开发与测试回归',
      assigned_agent: 'beavy',
    });

    expect(created.execution_mode).toBe('subagent');
    expect(created.execution_mode_source).toBe('policy');
    expect(created.execution_rule_key).toBe('coding_or_browser_long_task');
    expect(created.max_active_workers).toBe(1);
  });

  it('direct 模式不允许登记 worker，subagent 模式受 max_active_workers 限制', () => {
    const directTicket = store.createTicket({
      title: '直接处理的小修复',
      description: '只改一个文案',
      assigned_agent: 'beavy',
      execution_mode: 'direct',
    });

    expect(() => store.registerExecutionWorker(directTicket.id, {
      worker_key: 'direct-1',
      worker_type: 'subagent',
      status: 'starting',
    })).toThrow(/不允许登记 worker/);

    const delegatedTicket = store.createTicket({
      title: '重构执行治理',
      description: '需要代码开发',
      implementation_scope: '后端代码开发',
      execution_mode: 'subagent',
      max_active_workers: 1,
      assigned_agent: 'beavy',
    });

    const firstWorker = store.registerExecutionWorker(delegatedTicket.id, {
      worker_key: 'sub-1',
      worker_type: 'subagent',
      status: 'starting',
      session_key: 'agent:beavy:ticket:47',
    });
    expect(firstWorker.worker_key).toBe('sub-1');

    expect(() => store.registerExecutionWorker(delegatedTicket.id, {
      worker_key: 'sub-2',
      worker_type: 'subagent',
      status: 'running',
    })).toThrow(/活跃 worker 已达到上限 1/);

    const updatedWorker = store.updateExecutionWorker(delegatedTicket.id, 'sub-1', {
      status: 'succeeded',
      finished_at: '2026-03-10T01:00:00.000Z',
    });
    expect(updatedWorker.status).toBe('succeeded');

    const detail = store.getTicketById(delegatedTicket.id);
    expect(detail.worker_stats.active_workers).toBe(0);
    expect(detail.execution_workers).toHaveLength(1);
  });

  it('terminateActiveExecutionWorkersForTicket 将 starting/running 收为 succeeded，active_workers 归零', () => {
    const t = store.createTicket({
      title: 'Terminate workers',
      execution_mode: 'subagent',
      max_active_workers: 1,
      assigned_agent: 'beavy',
    });
    store.registerExecutionWorker(t.id, {
      worker_key: 'w1',
      worker_type: 'subagent',
      status: 'running',
      session_key: 'sk',
      run_id: 'rid',
    });
    let detail = store.getTicketById(t.id);
    expect(detail.worker_stats.active_workers).toBe(1);
    const changed = store.terminateActiveExecutionWorkersForTicket(t.id);
    expect(changed).toBe(1);
    detail = store.getTicketById(t.id);
    expect(detail.worker_stats.active_workers).toBe(0);
    expect(detail.current_workers).toHaveLength(0);
    const w = store.getExecutionWorker(t.id, 'w1');
    expect(w.status).toBe('succeeded');
    expect(w.finished_at).toBeDefined();
  });

  it('findLatestAssignmentForTicket 按创建顺序返回 replacement assignment，不受旧 assignment updated_at 影响', () => {
    const ticket = store.createTicket({
      title: 'Latest assignment should follow replacement order',
      status: 'running',
      assigned_agent: 'beavy',
    });

    const oldAssignment = store.createOrReuseAssignment({
      ticket_id: ticket.id,
      dispatch_event_id: 101,
      agent_id: 'beavy',
      stage: 'queued',
      assignment_status: 'created',
      target_session_key: 'agent:beavy:ticket:old',
      transport: 'test',
    });

    const replacementAssignment = store.createOrReuseAssignment({
      ticket_id: ticket.id,
      dispatch_event_id: 102,
      agent_id: 'beavy',
      stage: 'running',
      assignment_status: 'created',
      target_session_key: 'agent:beavy:ticket:new',
      transport: 'test',
    });

    store.updateAssignment(oldAssignment.assignment_id, {
      assignment_status: 'in_progress',
      stage: 'queued',
    });

    const latest = store.findLatestAssignmentForTicket(ticket.id, 'beavy');
    expect(latest.assignment_id).toBe(replacementAssignment.assignment_id);
    expect(latest.dispatch_event_id).toBe(102);
    expect(latest.stage).toBe('running');
  });

  it('stale starting worker（无 session_key/run_id 或 无新鲜 heartbeat）不计入 active，不压制 dispatch', () => {
    const t = store.createTicket({
      title: 'Stale starting',
      execution_mode: 'subagent',
      max_active_workers: 1,
      assigned_agent: 'beavy',
    });
    store.registerExecutionWorker(t.id, {
      worker_key: 'stale-1',
      worker_type: 'subagent',
      status: 'starting',
      started_at: new Date().toISOString(),
      last_heartbeat_at: null,
    });
    let detail = store.getTicketById(t.id);
    expect(detail.worker_stats.total_workers).toBe(1);
    expect(detail.worker_stats.active_workers).toBe(0);
    expect(detail.current_workers).toHaveLength(0);
    store.registerExecutionWorker(t.id, {
      worker_key: 'real-1',
      worker_type: 'subagent',
      status: 'running',
      session_key: 'sk',
      run_id: 'r1',
    });
    detail = store.getTicketById(t.id);
    expect(detail.worker_stats.active_workers).toBe(1);
    expect(detail.current_workers.map((w) => w.worker_key)).toEqual(['real-1']);
  });

  it('queued/running gate 仍按有效 active 计数，stale starting 不占位', () => {
    const t = store.createTicket({
      title: 'Gate',
      execution_mode: 'subagent',
      max_active_workers: 1,
      assigned_agent: 'beavy',
    });
    store.registerExecutionWorker(t.id, {
      worker_key: 'stale',
      worker_type: 'subagent',
      status: 'starting',
    });
    expect(store.getTicketById(t.id).worker_stats.active_workers).toBe(0);
    store.registerExecutionWorker(t.id, {
      worker_key: 'runner',
      worker_type: 'subagent',
      status: 'running',
      session_key: 's',
      run_id: 'r',
    });
    expect(() =>
      store.registerExecutionWorker(t.id, {
        worker_key: 'second',
        worker_type: 'subagent',
        status: 'running',
      })
    ).toThrow(/活跃 worker 已达到上限/);
  });

  it('participant registry 可从 sqlite 持久化读取状态与能力字段', () => {
    store.upsertParticipantRegistryEntry({
      participant_id: 'beavy',
      display_name: '小李',
      emoji: '🦫',
      participant_type: 'agent',
      role_type: 'builder',
      ownership_layer: 'development',
      primary_platform: 'ticket-platform',
      responsibilities: ['development'],
      collaborates_with: ['leoss'],
      responsibility_summary: '工单平台开发执行人',
      gateway_id: 'mac-main',
      source_kind: 'manual',
      status: {
        availability_status: 'busy',
        eligibility_status: 'restricted',
        accepts_assignment_types: ['bugfix', 'migration'],
        status_reason: 'focused migration',
        effective_from: '2026-03-20T00:00:00.000Z',
        metadata: { lane: 'v2' },
      },
      capabilities: ['ticket:read', 'ticket:write'],
    });

    const entry = store.getParticipantRegistryEntry('beavy');
    expect(entry).toEqual(expect.objectContaining({
      participant_id: 'beavy',
      source_kind: 'manual',
      primary_platform: 'ticket-platform',
      status: expect.objectContaining({
        availability_status: 'busy',
        eligibility_status: 'restricted',
        accepts_assignment_types: ['bugfix', 'migration'],
        status_reason: 'focused migration',
        metadata: expect.objectContaining({ lane: 'v2' }),
      }),
      capabilities: ['ticket:read', 'ticket:write'],
    }));

    const listed = store.listParticipantRegistryEntries();
    expect(listed.map((item) => item.participant_id)).toContain('beavy');
  });
});
