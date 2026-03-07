/**
 * @vitest-environment node
 * 迁移脚本幂等验证
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, '..', 'api', 'data');
const TEST_JSON = path.join(TEST_DIR, 'migrate-test-tickets.json');
const TEST_DB = path.join(TEST_DIR, 'migrate-test.db');

const FIXTURE = [
  {
    id: 1,
    title: 'Fixture 1',
    description: 'Desc 1',
    status: 'queued',
    assigned_agent: 'donky',
    priority: 'medium',
    created: '2026-01-01T00:00:00.000Z',
    last_update: '2026-01-01T00:00:00.000Z',
    comments: [
      { id: 1001, author: 'u1', timestamp: 'ts1', content: 'c1' },
    ],
  },
  {
    id: 2,
    title: 'Fixture 2',
    description: 'Desc 2',
    status: 'done',
    assigned_agent: 'cowder',
    priority: 'high',
    created: '2026-01-02T00:00:00.000Z',
    last_update: '2026-01-02T00:00:00.000Z',
    comments: [],
  },
];

function runMigrate() {
  const r = spawnSync('node', ['scripts/migrate-json-to-sqlite.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      TICKETS_JSON_PATH: TEST_JSON,
      TICKETS_DB_PATH: TEST_DB,
    },
    encoding: 'utf8',
  });
  return r;
}

function readDbTickets() {
  const db = new Database(TEST_DB);
  const rows = db.prepare('SELECT * FROM tickets ORDER BY id').all();
  const tickets = [];
  for (const r of rows) {
    const comments = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY id').all(r.id);
    tickets.push({ ...r, comments });
  }
  db.close();
  return tickets;
}

describe('migrate-json-to-sqlite', () => {
  beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(TEST_JSON, JSON.stringify(FIXTURE, null, 2), 'utf8');
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_JSON)) fs.unlinkSync(TEST_JSON);
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('迁移后 DB 数据与 JSON 一致', () => {
    const r = runMigrate();
    expect(r.status).toBe(0);
    const tickets = readDbTickets();
    expect(tickets).toHaveLength(2);
    expect(tickets[0].id).toBe(1);
    expect(tickets[0].title).toBe('Fixture 1');
    expect(tickets[0].comments).toHaveLength(1);
    expect(tickets[0].comments[0].author).toBe('u1');
    expect(tickets[1].id).toBe(2);
    expect(tickets[1].title).toBe('Fixture 2');
    expect(tickets[1].comments).toHaveLength(0);
  });

  it('重复执行迁移结果一致（幂等）', () => {
    runMigrate();
    const first = readDbTickets();
    runMigrate();
    const second = readDbTickets();
    expect(second).toHaveLength(first.length);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
