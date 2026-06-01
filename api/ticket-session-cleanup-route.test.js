import './test-setup.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from './app.js';
import * as store from './store.js';
import { _resetDbForTesting } from './store-sqlite.js';

let tempRoot = null;
let originalDbPath = process.env.TICKETS_DB_PATH;
let originalOpenClawHome = process.env.OPENCLAW_HOME;

function ensureCleanDb() {
  _resetDbForTesting();
  const dbPath = process.env.TICKETS_DB_PATH;
  for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('POST /api/admin/ticket-sessions/cleanup', () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-session-cleanup-route-'));
    process.env.TICKETS_DB_PATH = path.join(tempRoot, 'tickets.db');
    process.env.OPENCLAW_HOME = path.join(tempRoot, '.openclaw');
    ensureCleanDb();
  });

  afterEach(() => {
    _resetDbForTesting();
    process.env.TICKETS_DB_PATH = originalDbPath;
    process.env.OPENCLAW_HOME = originalOpenClawHome;
    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoot = null;
  });

  it('默认返回 dry-run 结果', async () => {
    const ticket = store.createTicket({
      title: 'complete old',
      assigned_agent: 'beavy',
      status: 'complete',
      last_update: '2026-02-01T00:00:00.000Z',
    });

    const sessionsDir = path.join(process.env.OPENCLAW_HOME, 'agents', 'beavy', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionId = '33333333-3333-3333-3333-333333333333';
    const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, 'x', 'utf8');
    writeJson(path.join(sessionsDir, 'sessions.json'), {
      [`agent:beavy:ticket:${ticket.id}`]: {
        sessionId,
        updatedAt: Date.parse('2026-02-01T00:00:00.000Z'),
        sessionFile: transcriptPath,
      },
      'agent:beavy:main': {
        sessionId: 'main-session',
        updatedAt: Date.now(),
      },
    });

    const res = await request(app)
      .post('/api/admin/ticket-sessions/cleanup')
      .send({ dry_run: true, retention_days: 14 })
      .expect(200);

    expect(res.body.dry_run).toBe(true);
    expect(res.body.eligible_count).toBe(1);
    expect(res.body.candidates[0]).toEqual(expect.objectContaining({
      session_key: `agent:beavy:ticket:${ticket.id}`,
      ticket_status: 'complete',
    }));
  });
});
