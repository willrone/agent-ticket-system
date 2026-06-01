import './test-setup.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  previewTicketSessionCleanup,
  runTicketSessionCleanup,
} from './ticket-session-cleanup.js';
import * as store from './store.js';
import { _resetDbForTesting } from './store-sqlite.js';

let tempRoot = null;
let openclawHome = null;
let originalDbPath = process.env.TICKETS_DB_PATH;

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

function createSessionStore(agentId, entries) {
  const storePath = path.join(openclawHome, 'agents', agentId, 'sessions', 'sessions.json');
  writeJson(storePath, entries);
  return storePath;
}

function createTranscript(agentId, sessionId, content = 'test transcript') {
  const transcriptPath = path.join(openclawHome, 'agents', agentId, 'sessions', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, content, 'utf8');
  return transcriptPath;
}

describe('ticket-session-cleanup', () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-session-cleanup-'));
    openclawHome = path.join(tempRoot, '.openclaw');
    process.env.TICKETS_DB_PATH = path.join(tempRoot, 'tickets.db');
    ensureCleanDb();
  });

  afterEach(() => {
    _resetDbForTesting();
    process.env.TICKETS_DB_PATH = originalDbPath;
    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoot = null;
    openclawHome = null;
  });

  it('dry-run 仅命中 complete/failed 且超过保留期的 ticket session', () => {
    const nowMs = Date.parse('2026-03-09T15:00:00.000Z');

    const completeTicket = store.createTicket({
      title: 'complete old',
      assigned_agent: 'beavy',
      status: 'complete',
      last_update: '2026-02-20T00:00:00.000Z',
    });
    const failedTicket = store.createTicket({
      title: 'failed recent',
      assigned_agent: 'beavy',
      status: 'failed',
      last_update: '2026-03-05T00:00:00.000Z',
    });
    const doneTicket = store.createTicket({
      title: 'done protected',
      assigned_agent: 'beavy',
      status: 'done',
      last_update: '2026-02-01T00:00:00.000Z',
    });

    const sessionId26 = '11111111-1111-1111-1111-111111111126';
    const sessionId27 = '11111111-1111-1111-1111-111111111127';
    const sessionId28 = '11111111-1111-1111-1111-111111111128';
    const transcript26 = createTranscript('beavy', sessionId26, 'ticket 1');
    createTranscript('beavy', sessionId27, 'ticket 2');
    createTranscript('beavy', sessionId28, 'ticket 3');

    createSessionStore('beavy', {
      [`agent:beavy:ticket:${completeTicket.id}`]: {
        sessionId: sessionId26,
        updatedAt: Date.parse('2026-02-20T00:00:00.000Z'),
        sessionFile: transcript26,
      },
      [`agent:beavy:ticket:${failedTicket.id}`]: {
        sessionId: sessionId27,
        updatedAt: Date.parse('2026-03-05T00:00:00.000Z'),
        sessionFile: path.join(openclawHome, 'agents', 'beavy', 'sessions', `${sessionId27}.jsonl`),
      },
      [`agent:beavy:ticket:${doneTicket.id}`]: {
        sessionId: sessionId28,
        updatedAt: Date.parse('2026-02-01T00:00:00.000Z'),
        sessionFile: path.join(openclawHome, 'agents', 'beavy', 'sessions', `${sessionId28}.jsonl`),
      },
      'agent:beavy:main': {
        sessionId: 'main-session',
        updatedAt: nowMs,
      },
    });

    const result = previewTicketSessionCleanup({
      openclawHome,
      nowMs,
      retentionDays: 14,
    });

    expect(result.eligible_count).toBe(1);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        session_key: `agent:beavy:ticket:${completeTicket.id}`,
        ticket_id: completeTicket.id,
        ticket_status: 'complete',
      }),
    ]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ session_key: `agent:beavy:ticket:${failedTicket.id}`, reason: 'within_retention' }),
      expect.objectContaining({ session_key: `agent:beavy:ticket:${doneTicket.id}`, reason: 'status_protected' }),
    ]));
  });

  it('enforce 会删除命中的 store entry 并归档 transcript，主会话不受影响', async () => {
    const nowMs = Date.parse('2026-03-09T15:00:00.000Z');
    const completeTicket = store.createTicket({
      title: 'complete old',
      assigned_agent: 'beavy',
      status: 'complete',
      last_update: '2026-02-20T00:00:00.000Z',
    });
    const runningTicket = store.createTicket({
      title: 'running keep',
      assigned_agent: 'beavy',
      status: 'running',
      last_update: '2026-02-01T00:00:00.000Z',
    });

    const sessionId1 = '22222222-1111-1111-1111-111111111111';
    const sessionId2 = '22222222-2222-2222-2222-222222222222';
    const transcript1 = createTranscript('beavy', sessionId1, 'cleanup me');
    const transcript2 = createTranscript('beavy', sessionId2, 'keep me');
    const storePath = createSessionStore('beavy', {
      [`agent:beavy:ticket:${completeTicket.id}`]: {
        sessionId: sessionId1,
        updatedAt: Date.parse('2026-02-20T00:00:00.000Z'),
        sessionFile: transcript1,
      },
      [`agent:beavy:ticket:${runningTicket.id}`]: {
        sessionId: sessionId2,
        updatedAt: Date.parse('2026-02-01T00:00:00.000Z'),
        sessionFile: transcript2,
      },
      'agent:beavy:main': {
        sessionId: 'main-session',
        updatedAt: nowMs,
      },
    });

    const result = await runTicketSessionCleanup({
      openclawHome,
      nowMs,
      retentionDays: 14,
    });

    expect(result.deleted_count).toBe(1);
    expect(result.archived_transcript_count).toBe(1);
    expect(result.mutated_store_count).toBe(1);
    expect(result.mutated_stores[0].deleted_session_keys).toEqual([`agent:beavy:ticket:${completeTicket.id}`]);
    expect(result.mutated_stores[0].backup_path).toContain('sessions.json.bak.ticket-cleanup.');

    const afterStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    expect(afterStore[`agent:beavy:ticket:${completeTicket.id}`]).toBeUndefined();
    expect(afterStore[`agent:beavy:ticket:${runningTicket.id}`]).toBeDefined();
    expect(afterStore['agent:beavy:main']).toBeDefined();
    expect(fs.existsSync(transcript1)).toBe(false);
    const archivedPath = result.mutated_stores[0].archived_transcripts[0];
    expect(archivedPath).toMatch(/\.deleted\./);
    expect(fs.existsSync(archivedPath)).toBe(true);
    expect(fs.existsSync(transcript2)).toBe(true);
  });
});
