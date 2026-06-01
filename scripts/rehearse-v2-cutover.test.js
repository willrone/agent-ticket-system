/**
 * @vitest-environment node
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.join(__dirname, '..');
const TEST_DIR = path.join(REPO_DIR, 'tmp', 'cutover-rehearsal-test');
const SOURCE_DB = path.join(TEST_DIR, 'legacy.db');
const TARGET_DB = path.join(TEST_DIR, 'v2.db');

function seedDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`
    CREATE TABLE tickets (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE ticket_comments (id INTEGER PRIMARY KEY, ticket_id INTEGER, content TEXT);
    CREATE TABLE ticket_dependencies (id INTEGER PRIMARY KEY, ticket_id INTEGER, depends_on_ticket_id INTEGER);
    CREATE TABLE ticket_execution_workers (id INTEGER PRIMARY KEY, ticket_id INTEGER, worker_key TEXT);
    CREATE TABLE ticket_assignments (id INTEGER PRIMARY KEY, ticket_id INTEGER, assignment_id TEXT);
    CREATE TABLE execution_reservations (id INTEGER PRIMARY KEY, ticket_id INTEGER, lane_key TEXT);
    CREATE TABLE ticket_projection (id INTEGER PRIMARY KEY, ticket_id INTEGER, snapshot TEXT);
  `);
  db.prepare('INSERT INTO tickets (id, title) VALUES (?, ?)').run(1, 'legacy ticket');
  db.prepare('INSERT INTO ticket_comments (id, ticket_id, content) VALUES (?, ?, ?)').run(11, 1, 'hello');
  db.prepare('INSERT INTO ticket_dependencies (id, ticket_id, depends_on_ticket_id) VALUES (?, ?, ?)').run(21, 1, 99);
  db.prepare('INSERT INTO ticket_execution_workers (id, ticket_id, worker_key) VALUES (?, ?, ?)').run(31, 1, 'worker-1');
  db.prepare('INSERT INTO ticket_assignments (id, ticket_id, assignment_id) VALUES (?, ?, ?)').run(41, 1, 'asg-1');
  db.prepare('INSERT INTO execution_reservations (id, ticket_id, lane_key) VALUES (?, ?, ?)').run(51, 1, 'single_running');
  db.prepare('INSERT INTO ticket_projection (id, ticket_id, snapshot) VALUES (?, ?, ?)').run(61, 1, '{}');
  db.close();
}

function run(args = []) {
  return spawnSync('node', ['scripts/rehearse-v2-cutover.js', ...args], {
    cwd: REPO_DIR,
    encoding: 'utf8',
  });
}

describe('rehearse-v2-cutover', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    seedDb(SOURCE_DB);
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('copies legacy db to target and preserves row counts', () => {
    const result = run(['--source', SOURCE_DB, '--target', TARGET_DB, '--json']);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.source_counts.tickets).toBe(1);
    expect(payload.source_counts.ticket_comments).toBe(1);
    expect(payload.target_counts.ticket_execution_workers).toBe(1);
    expect(fs.existsSync(TARGET_DB)).toBe(true);
  });

  it('fails when source and target are identical', () => {
    const result = run(['--source', SOURCE_DB, '--target', SOURCE_DB]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source 与 target 不能相同');
  });

  it('requires --overwrite when target already exists', () => {
    fs.copyFileSync(SOURCE_DB, TARGET_DB);
    const result = run(['--source', SOURCE_DB, '--target', TARGET_DB]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('target 已存在');
  });
});
