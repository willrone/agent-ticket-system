/**
 * @vitest-environment node
 * 多 Agent 平台 registry shadow-mode API 测试
 */
/* global process */
import './test-setup.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from './app.js';
import * as store from './store-sqlite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, 'data');
const ORIGINAL_DB_PATH = process.env.TICKETS_DB_PATH;

function resetStore() {
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  const dbPath = path.join(TEST_DIR, `platform-registry-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.TICKETS_DB_PATH = dbPath;
  store._resetDbForTesting();
}

function cleanupStore() {
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
}

describe('platform registry shadow-mode APIs', () => {
  beforeEach(resetStore);
  afterEach(cleanupStore);

  it('seeds default platform agents without changing ticket flow', async () => {
    const res = await request(app).get('/api/v1/platform/agents').expect(200);

    expect(res.body.agents.map((agent) => agent.agent_id)).toEqual(
      expect.arrayContaining(['leoss', 'beavy', 'auditor', 'cowder', 'donky'])
    );

    const beavy = res.body.agents.find((agent) => agent.agent_id === 'beavy');
    expect(beavy.role_types).toContain('executor');
    expect(beavy.capabilities).toContain('ticket-platform.backend');
    expect(beavy.session_policy).toBe('ticket_session');
  });

  it('exposes default four role contracts', async () => {
    const res = await request(app).get('/api/v1/platform/role-contracts').expect(200);
    const roles = res.body.role_contracts;

    expect(roles.map((role) => role.role_type).sort()).toEqual(['auditor', 'executor', 'planner', 'reviewer']);

    const reviewer = roles.find((role) => role.role_type === 'reviewer');
    expect(reviewer.allowed_actions).toEqual(expect.arrayContaining(['review_submission', 'approve', 'reject']));
    expect(reviewer.required_reports).toContain('review_submission');
    expect(reviewer.can_close).toBe(true);
  });

  it('exposes capabilities used by default agents', async () => {
    const res = await request(app).get('/api/v1/platform/capabilities').expect(200);
    const keys = res.body.capabilities.map((capability) => capability.capability_key);

    expect(keys).toEqual(expect.arrayContaining([
      'ticket-platform.backend',
      'review.quality-gate',
      'audit.governance',
      'stock-platform.backtest',
    ]));
  });

  it('exposes software_task_v1 workflow template in shadow mode', async () => {
    const res = await request(app).get('/api/v1/platform/workflow-templates').expect(200);
    const template = res.body.workflow_templates.find((item) => item.template_key === 'software_task_v1');

    expect(template).toBeDefined();
    expect(template.enabled).toBe(true);
    expect(template.role_schema).toEqual(['planner', 'executor', 'reviewer', 'auditor']);
    expect(template.status_schema).toEqual(expect.arrayContaining(['triage', 'running', 'review', 'complete']));
    expect(template.gate_policy.shadow_mode).toBe(true);
  });

  it('previews capability routing without mutating dispatch behavior', async () => {
    const res = await request(app)
      .post('/api/v1/platform/routing/preview')
      .send({
        task_type: 'software_task',
        project: 'ticket-platform',
        required_capabilities: ['ticket-platform.backend'],
        needs_review: true,
      })
      .expect(200);

    expect(res.body.routing).toEqual(expect.objectContaining({
      executor: 'beavy',
      reviewer: 'leoss',
      auditor: 'auditor',
      shadow_mode: true,
      confidence: 'ok',
    }));
    expect(res.body.routing.decision_id).toEqual(expect.any(Number));
    expect(res.body.routing.reason).toContain('beavy selected for executor');

    const decisions = await request(app).get('/api/v1/platform/routing/decisions').expect(200);
    expect(decisions.body.decisions[0]).toEqual(expect.objectContaining({
      id: res.body.routing.decision_id,
      routing_reason: res.body.routing.reason,
    }));
  });

  it('honors explicit preferred role and excluded agents in routing preview', async () => {
    const res = await request(app)
      .post('/api/v1/platform/routing/preview')
      .send({
        required_capabilities: ['stock-platform.backtest'],
        preferred_roles: { executor: 'donky', reviewer: 'cowder' },
        excluded_agents: ['auditor'],
      })
      .expect(200);

    expect(res.body.routing.executor).toBe('donky');
    expect(res.body.routing.reviewer).toBe('cowder');
    expect(res.body.routing.auditor).toBeNull();
    expect(res.body.routing.confidence).toBe('partial');
    expect(res.body.routing.role_decisions.auditor.reason).toContain('no eligible auditor');
  });
});

