#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'docs/live-contract-fixtures/manifest/fixtures.manifest.json');
const testDbPath = path.join(root, 'api/data/test-live-contract-replay.db');

process.chdir(root);
process.env.TICKETS_DB_PATH = testDbPath;

const request = (await import('supertest')).default;
const app = (await import(pathToFileURL(path.join(root, 'api/app.js')).href)).default;
const storeSqlite = await import(pathToFileURL(path.join(root, 'api/store-sqlite.js')).href);
const dispatch = await import(pathToFileURL(path.join(root, 'api/dispatch.js')).href);
const { detectWorkflowMismatch } = await import(pathToFileURL(path.join(root, 'api/workflow-mismatch.js')).href);

const { _resetDbForTesting } = storeSqlite;
const { _resetDbForTesting: _resetDispatchForTesting } = dispatch;

function readJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

function ensureCleanStore() {
  _resetDbForTesting();
  _resetDispatchForTesting();
  const dir = path.dirname(testDbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function ensure(condition, message) {
  assert.ok(condition, message);
}

function stringify(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function normalizeActorPlaceholder(value, actor = '荣晖') {
  return stringify(value).replaceAll('<actor>', actor);
}

async function createTicket(payload = {}) {
  const res = await request(app)
    .post('/api/tickets')
    .send({
      title: 'Replay fixture ticket',
      description: 'replay fixture',
      assigned_agent: 'beavy',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      ...payload,
    })
    .expect(201);
  return res.body;
}

async function transition(ticketId, action, extra = {}, expectedStatus = 200) {
  return request(app)
    .post(`/api/tickets/${ticketId}/transition`)
    .send({ action, ...extra })
    .expect(expectedStatus);
}

async function getDispatchReady() {
  const res = await request(app).get('/api/dispatch/ready').expect(200);
  return res.body.ready || [];
}

async function getNotificationsReady() {
  const res = await request(app).get('/api/notifications/ready').expect(200);
  return res.body.ready || [];
}

async function createReadyAssignment(overrides = {}) {
  const {
    status: targetStatus = 'queued',
    title = 'Replay ready assignment',
    description = 'replay ready assignment',
    assigned_agent = 'beavy',
    triage_owner = 'leoss',
    review_owner = 'leoss',
    execution_mode = 'direct',
    implementation_scope = 'replay harness',
    constraints = '保持 additive',
    ...rest
  } = overrides;

  const ticket = await createTicket({
    title,
    description,
    assigned_agent,
    triage_owner,
    review_owner,
    execution_mode,
    implementation_scope,
    constraints,
    ...rest,
  });

  if (['queued', 'running', 'done', 'review'].includes(targetStatus)) {
    await transition(ticket.id, 'queue', { actor: triage_owner });
  }

  if (['running', 'done', 'review'].includes(targetStatus)) {
    await transition(ticket.id, 'start_work', { actor: assigned_agent });
  }

  if (['done', 'review'].includes(targetStatus)) {
    await transition(ticket.id, 'submit_for_review', {
      actor: assigned_agent,
      result_summary: 'ready for review',
    });
  }

  if (targetStatus === 'review') {
    await transition(ticket.id, 'start_review', { actor: review_owner });
  }

  const ready = (await getDispatchReady()).find((item) => item.ticket_id === ticket.id);
  ensure(ready, `ticket #${ticket.id} should appear in dispatch ready for status=${targetStatus}`);
  ensure(ready.assignment?.assignment_token, `ticket #${ticket.id} should expose assignment token`);
  return { ticket, ready };
}

async function replayNotificationsReadySnapshot(fixture) {
  const ready = await getNotificationsReady();
  assert.equal(ready.length, fixture.expected.ready_count, 'notifications ready count mismatch');
  assert.deepEqual(ready, fixture.expected.ready, 'notifications ready payload mismatch');
  return {
    assertions: 2,
    details: [`ready_count=${ready.length}`],
  };
}

async function replayDispatchReadySnapshot(fixture) {
  const { ready } = await createReadyAssignment({
    status: 'running',
    title: 'Replay dispatch-ready running snapshot',
    execution_mode: 'direct',
  });

  assert.equal(ready.status, fixture.ready_entry_snapshot.status, 'dispatch ready status mismatch');
  assert.equal(ready.agent, fixture.ready_entry_snapshot.agent, 'dispatch ready agent mismatch');
  assert.equal(ready.reason, fixture.ready_entry_snapshot.reason, 'dispatch ready reason mismatch');
  assert.equal(ready.dedupe_key, fixture.ready_entry_snapshot.dedupe_key, 'dispatch ready dedupe_key mismatch');

  for (const field of fixture.expected.ready_entry_contract) {
    ensure(field in ready, `dispatch ready entry missing field: ${field}`);
  }

  return {
    assertions: 4 + fixture.expected.ready_entry_contract.length,
    details: [
      `assignment_id=${ready.assignment_id}`,
      `dispatch_id=${ready.dispatch_id}`,
      `dedupe_key=${ready.dedupe_key}`,
    ],
  };
}

async function replayDispatchReceiptBridge(fixture) {
  const { ticket, ready } = await createReadyAssignment({
    status: 'queued',
    title: 'Replay dispatch receipt bridge',
    execution_mode: 'direct',
  });
  const token = ready.assignment.assignment_token;

  await request(app).post(`/api/dispatch/${ready.dispatch_id}/ack`).expect(200);

  const reportRes = await request(app)
    .post(`/api/v1/agent/assignments/${ready.assignment_id}/reports`)
    .set('x-assignment-token', token)
    .send({
      report_type: 'dispatch_receipt',
      idempotency_key: `replay-${fixture.fixture_id}`,
      receipt: {
        dispatch_id: ready.dispatch_id,
        ticket_id: ticket.id,
        stage: 'queued',
        agent: 'beavy',
        decision: 'accepted',
        message: 'replay harness: accepted queued assignment',
      },
    })
    .expect(201);

  assert.equal(reportRes.body.assignment_status, fixture.expected.assignment_status_after_report, 'assignment status after receipt mismatch');
  assert.equal(reportRes.body.interpreter_result.transition_preview.action, fixture.expected.transition_preview.action, 'transition preview action mismatch');
  assert.equal(reportRes.body.interpreter_result.transition_preview.suggested_status, fixture.expected.transition_preview.suggested_status, 'transition preview suggested_status mismatch');
  assert.equal(Boolean(reportRes.body.interpreter_result.transition_preview.applied), Boolean(fixture.expected.transition_preview.applied), 'transition preview applied mismatch');
  assert.deepEqual(reportRes.body.interpreter_result.transition_preview.bridge_actions, fixture.expected.transition_preview.bridge_actions, 'transition preview bridge actions mismatch');

  const ticketAfter = await request(app).get(`/api/tickets/${ticket.id}`).expect(200);
  assert.equal(ticketAfter.body.status, fixture.expected.ticket_status_after, 'ticket status after receipt mismatch');

  const receiptComment = (ticketAfter.body.comments || []).find((comment) => String(comment.content || '').includes('【agent_report】dispatch_receipt'));
  ensure(receiptComment, 'dispatch receipt should create progress comment');
  assert.equal(receiptComment.author, fixture.expected.comment_contract.author, 'receipt comment author mismatch');
  assert.equal(receiptComment.type, fixture.expected.comment_contract.type, 'receipt comment type mismatch');
  ensure(String(receiptComment.content || '').includes(fixture.expected.comment_contract.content_contains), 'receipt comment content mismatch');

  return {
    assertions: 10,
    details: [
      `ticket_status_after=${ticketAfter.body.status}`,
      `successor_assignment=${reportRes.body.interpreter_result.successor_assignment?.assignment_id || 'n/a'}`,
    ],
  };
}

async function replayDispatchReceiptValidationError(fixture) {
  const { ticket, ready } = await createReadyAssignment({
    status: 'queued',
    title: 'Replay invalid dispatch receipt',
  });
  const token = ready.assignment.assignment_token;

  await request(app).post(`/api/dispatch/${ready.dispatch_id}/ack`).expect(200);

  const res = await request(app)
    .post(`/api/v1/agent/assignments/${ready.assignment_id}/reports`)
    .set('x-assignment-token', token)
    .send({
      report_type: fixture.input.report_type,
      idempotency_key: `replay-${fixture.fixture_id}`,
      receipt: {
        dispatch_id: fixture.input.receipt.dispatch_id,
        ticket_id: ticket.id,
        stage: fixture.input.receipt.stage,
        agent: fixture.input.receipt.agent,
        decision: fixture.input.receipt.decision,
        message: 'replay harness invalid dispatch id',
      },
    })
    .expect(fixture.expected.http_status);

  assert.equal(res.body.code, fixture.expected.code, 'validation error code mismatch');
  ensure(Boolean(res.body.validation_audit_id) === Boolean(fixture.expected.validation_audit_id_required), 'validation_audit_id presence mismatch');
  ensure(Boolean(res.body.machine_readable) === Boolean(fixture.expected.machine_readable_required), 'machine_readable presence mismatch');
  assert.equal(res.body.machine_readable.code, fixture.expected.machine_readable.code, 'machine_readable.code mismatch');
  for (const code of fixture.expected.machine_readable.codes_contains) {
    ensure(res.body.machine_readable.codes.includes(code), `machine_readable.codes missing ${code}`);
  }
  ensure(Array.isArray(res.body.machine_readable.errors) && res.body.machine_readable.errors.length > 0, 'machine_readable.errors should be non-empty');

  return {
    assertions: 6,
    details: [`code=${res.body.code}`],
  };
}

async function replayCrossTicketOrEventMismatch(fixture) {
  const { ticket, ready } = await createReadyAssignment({
    status: 'running',
    title: 'Replay cross-ticket receipt mismatch',
  });
  const token = ready.assignment.assignment_token;

  await request(app).post(`/api/dispatch/${ready.dispatch_id}/ack`).expect(200);

  let assertions = 0;
  const details = [];

  for (const testCase of fixture.cases) {
    const body = {
      report_type: testCase.input.report_type,
      idempotency_key: `replay-${fixture.fixture_id}-${testCase.name}`,
      receipt: {
        dispatch_id: testCase.input.receipt.dispatch_id === 999999 ? 999999 : ready.dispatch_id,
        ticket_id: testCase.input.receipt.ticket_id === 999 ? 999 : ticket.id,
        stage: testCase.input.receipt.stage,
        agent: testCase.input.receipt.agent,
        decision: testCase.input.receipt.decision,
        message: `replay mismatch case ${testCase.name}`,
      },
    };

    const res = await request(app)
      .post(`/api/v1/agent/assignments/${ready.assignment_id}/reports`)
      .set('x-assignment-token', token)
      .send(body)
      .expect(fixture.expected.http_status);

    assert.equal(res.body.code, testCase.expected_error_code, `${testCase.name}: returned code mismatch`);
    ensure(fixture.expected.codes.includes(res.body.code), `${testCase.name}: code not listed in fixture.expected.codes`);
    ensure(Boolean(res.body.machine_readable) === fixture.expected.machine_readable_required, `${testCase.name}: machine_readable presence mismatch`);
    details.push(`${testCase.name}=${res.body.code}`);
    assertions += 3;
  }

  return { assertions, details };
}

async function replayPendingDecisionBoundary(fixture) {
  const ticket = await createTicket({
    title: 'Replay pending_decision boundary',
    decision_owner: '荣晖',
  });

  await transition(ticket.id, 'queue', { actor: 'leoss' });
  await transition(ticket.id, 'start_work', { actor: 'beavy' });
  await transition(ticket.id, 'request_decision', {
    actor: 'beavy',
    decision_summary: '需要老大拍板',
  });

  const dispatchReady = await getDispatchReady();
  const notifyReady = await getNotificationsReady();
  const notifyItem = notifyReady.find((item) => item.ticket_id === ticket.id);

  ensure(!dispatchReady.find((item) => item.ticket_id === ticket.id), 'pending_decision should not enter dispatch ready');
  ensure(notifyItem, 'pending_decision should enter notifications ready');
  assert.equal(notifyItem.type, fixture.expected.status, 'pending_decision notify type mismatch');
  assert.equal(notifyItem.status, fixture.expected.status, 'pending_decision notify status mismatch');
  assert.equal(notifyItem.dedupe_key, normalizeActorPlaceholder(fixture.expected.notify_dedupe_key), 'pending_decision dedupe key mismatch');

  await request(app)
    .post('/api/notifications/ack')
    .send({ event_id: notifyItem.event_id })
    .expect(200);

  const notifyAfterAck = await getNotificationsReady();
  ensure(!notifyAfterAck.find((item) => item.ticket_id === ticket.id), 'notification should disappear after ack');

  return {
    assertions: 6,
    details: [`dedupe_key=${notifyItem.dedupe_key}`],
  };
}

async function replayTerminalStageBoundary(fixture) {
  const details = [];
  let assertions = 0;

  const completeTicket = await createTicket({ title: 'Replay complete terminal boundary' });
  await transition(completeTicket.id, 'queue', { actor: 'leoss' });
  await transition(completeTicket.id, 'start_work', { actor: 'beavy' });
  await transition(completeTicket.id, 'submit_for_review', { actor: 'beavy', result_summary: 'done' });
  await transition(completeTicket.id, 'approve', { actor: 'leoss' });

  let dispatchReady = await getDispatchReady();
  let notifyReady = await getNotificationsReady();
  let completeNotify = notifyReady.find((item) => item.ticket_id === completeTicket.id);
  ensure(!dispatchReady.find((item) => item.ticket_id === completeTicket.id), 'complete ticket should not enter dispatch ready');
  ensure(completeNotify, 'complete ticket should enter notifications ready');
  assert.equal(completeNotify.type, 'complete', 'complete notify type mismatch');
  assertions += 3;
  details.push(`complete=${completeNotify.type}`);
  await request(app).post('/api/notifications/ack').send({ event_id: completeNotify.event_id }).expect(200);

  const failedTicket = await createTicket({ title: 'Replay failed terminal boundary' });
  await transition(failedTicket.id, 'queue', { actor: 'leoss' });
  await transition(failedTicket.id, 'start_work', { actor: 'beavy' });
  await transition(failedTicket.id, 'fail', { actor: 'beavy', error: '测试失败' });

  dispatchReady = await getDispatchReady();
  notifyReady = await getNotificationsReady();
  const failedNotify = notifyReady.find((item) => item.ticket_id === failedTicket.id);
  ensure(!dispatchReady.find((item) => item.ticket_id === failedTicket.id), 'failed ticket should not enter dispatch ready');
  ensure(failedNotify, 'failed ticket should enter notifications ready');
  assert.equal(failedNotify.type, 'failed', 'failed notify type mismatch');
  assertions += 3;
  details.push(`failed=${failedNotify.type}`);

  return { assertions, details };
}

async function replayDispatchDedupeContract(fixture) {
  let assertions = 0;
  const details = [];

  const running = await createReadyAssignment({
    status: 'running',
    title: 'Replay dedupe running assignment',
  });
  assert.equal(running.ready.dedupe_key, fixture.cases.find((item) => item.case_id === 'running_assignment').dedupe_key, 'running assignment dedupe mismatch');
  assertions += 1;
  details.push(`running_assignment=${running.ready.dedupe_key}`);

  ensureCleanStore();

  const mismatchTicket = await createTicket({
    title: 'Replay workflow mismatch dedupe',
    decision_owner: '荣晖',
  });
  await transition(mismatchTicket.id, 'queue', { actor: 'leoss' });
  await transition(mismatchTicket.id, 'start_work', { actor: 'beavy' });
  await request(app)
    .post(`/api/tickets/${mismatchTicket.id}/comments`)
    .send({
      author: 'beavy',
      type: 'decision',
      content: '需要老大拍板，是否继续推进',
    })
    .expect(201);
  const mismatchReady = (await getDispatchReady()).find((item) => item.ticket_id === mismatchTicket.id);
  ensure(mismatchReady, 'workflow mismatch ticket should enter dispatch ready');
  assert.equal(mismatchReady.kind, 'workflow_mismatch', 'workflow mismatch kind mismatch');
  assert.equal(mismatchReady.dedupe_key, fixture.cases.find((item) => item.case_id === 'running_workflow_mismatch').dedupe_key, 'workflow mismatch dedupe mismatch');
  assertions += 2;
  details.push(`workflow_mismatch=${mismatchReady.dedupe_key}`);

  ensureCleanStore();

  const pendingDecision = await createTicket({
    title: 'Replay notify dedupe',
    decision_owner: '荣晖',
  });
  await transition(pendingDecision.id, 'queue', { actor: 'leoss' });
  await transition(pendingDecision.id, 'start_work', { actor: 'beavy' });
  await transition(pendingDecision.id, 'request_decision', {
    actor: 'beavy',
    decision_summary: '需要老大拍板',
  });
  const notifyItem = (await getNotificationsReady()).find((item) => item.ticket_id === pendingDecision.id);
  ensure(notifyItem, 'pending_decision notify item should exist');
  assert.equal(notifyItem.dedupe_key, fixture.cases.find((item) => item.case_id === 'pending_decision_notify').dedupe_key, 'notify dedupe mismatch');
  assertions += 1;
  details.push(`pending_decision_notify=${notifyItem.dedupe_key}`);

  return { assertions, details };
}

async function replayDependencyGate(fixture) {
  const { ready } = await createReadyAssignment({
    title: 'Replay dependency gate',
    execution_mode: 'direct',
  });
  const token = ready.assignment.assignment_token;

  const dep = await createTicket({
    title: 'Replay open dependency',
    assigned_agent: 'doggy',
    review_owner: 'leoss',
  });
  await transition(dep.id, 'queue', { actor: 'leoss' });
  await transition(dep.id, 'start_work', { actor: 'doggy' });

  await request(app)
    .post(`/api/tickets/${ready.ticket_id}/dependencies`)
    .send({ depends_on_ticket_id: dep.id, dependency_type: 'blocks' })
    .expect(200);

  const res = await request(app)
    .get(`/api/v1/agent/assignments/${ready.assignment_id}/live-acceptance`)
    .set('x-assignment-token', token)
    .expect(200);

  assert.equal(res.body.verdict, fixture.expected.verdict, 'live acceptance verdict mismatch');
  const unresolved = res.body.dependency_snapshot?.unresolved || [];
  ensure(unresolved.some((item) => item.ticket_id === dep.id && item.status === 'running' && item.blocking === true && item.satisfied === false), 'dependency snapshot should include unresolved blocking dependency');
  ensure((res.body.checks || []).some((item) => item.key === 'dependencies' && item.status === 'fail'), 'dependencies check should fail');

  return {
    assertions: 3,
    details: [`verdict=${res.body.verdict}`],
  };
}

async function replayLiveContractMismatchVerdicts(fixture) {
  const { ready } = await createReadyAssignment({
    title: 'Replay live contract mismatch verdicts',
    execution_mode: 'direct',
  });
  const token = ready.assignment.assignment_token;

  const liveNotUpgraded = await request(app)
    .get(`/api/v1/agent/assignments/${ready.assignment_id}/live-acceptance`)
    .set('x-assignment-token', token)
    .query({ expected_bundle_version: '2099-12-31.bundle.v999' })
    .expect(200);
  assert.equal(liveNotUpgraded.body.verdict, fixture.cases.find((item) => item.case_id === 'live_not_upgraded').verdict, 'live-not-upgraded verdict mismatch');
  ensure(fixture.expected.allowed_verdicts.includes(liveNotUpgraded.body.verdict), 'live-not-upgraded verdict not allowed by fixture');

  const contractMismatch = await request(app)
    .get(`/api/v1/agent/assignments/${ready.assignment_id}/live-acceptance`)
    .set('x-assignment-token', token)
    .query({ expected_workflow_schema_version: 'v999' })
    .expect(200);
  assert.equal(contractMismatch.body.verdict, fixture.cases.find((item) => item.case_id === 'contract_mismatch').verdict, 'contract-mismatch verdict mismatch');
  ensure(fixture.expected.allowed_verdicts.includes(contractMismatch.body.verdict), 'contract-mismatch verdict not allowed by fixture');

  return {
    assertions: 4,
    details: [
      `live_not_upgraded=${liveNotUpgraded.body.verdict}`,
      `contract_mismatch=${contractMismatch.body.verdict}`,
    ],
  };
}

async function replayWorkflowMismatchCases(fixture) {
  let assertions = 0;
  const details = [];
  for (const testCase of fixture.cases) {
    const result = detectWorkflowMismatch({
      status: 'running',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      decision_owner: '荣晖',
      ...testCase.ticket,
    });

    if (!testCase.expected_result.should_mismatch) {
      assert.equal(result, null, `${testCase.case_id}: should not mismatch`);
      assertions += 1;
      details.push(`${testCase.case_id}=null`);
      continue;
    }

    ensure(result, `${testCase.case_id}: mismatch should exist`);
    assert.equal(result.category, testCase.expected_result.category, `${testCase.case_id}: category mismatch`);
    assert.equal(result.recommended_status, testCase.expected_result.recommended_status, `${testCase.case_id}: recommended_status mismatch`);
    assertions += 3;
    details.push(`${testCase.case_id}=${result.category}`);
  }

  return { assertions, details };
}

const replayHandlers = {
  'notifications-ready-snapshot': replayNotificationsReadySnapshot,
  'dispatch-ready-running-33-snapshot': replayDispatchReadySnapshot,
  'dispatch-receipt-accepted-bridge-to-running': replayDispatchReceiptBridge,
  'dispatch-receipt-invalid-dispatch-id-error': replayDispatchReceiptValidationError,
  'dispatch-receipt-cross-ticket-or-event-mismatch': replayCrossTicketOrEventMismatch,
  'pending-decision-should-not-enter-dispatch': replayPendingDecisionBoundary,
  'terminal-stage-should-not-enter-dispatch': replayTerminalStageBoundary,
  'dispatch-dedupe-ticket-agent-status-contract': replayDispatchDedupeContract,
  'dependency-not-closed-live-acceptance': replayDependencyGate,
  'live-contract-mismatch-verdicts': replayLiveContractMismatchVerdicts,
  'workflow-mismatch-false-positive-before-after': replayWorkflowMismatchCases,
};

function loadFixtures() {
  const manifest = readJson(manifestPath);
  return [...(manifest.baseline || []), ...(manifest.incidents || [])]
    .filter((item) => item.kind === 'json-fixture')
    .map((item) => {
      const absPath = path.normalize(path.join(path.dirname(manifestPath), item.path));
      return {
        manifestItem: item,
        path: absPath,
        fixture: readJson(absPath),
      };
    });
}

async function main() {
  const fixtureFilter = process.argv.includes('--fixture')
    ? process.argv[process.argv.indexOf('--fixture') + 1]
    : null;

  const loaded = loadFixtures();
  const targets = loaded.filter(({ fixture }) => replayHandlers[fixture.fixture_id]);
  const selected = fixtureFilter
    ? targets.filter(({ fixture }) => fixture.fixture_id === fixtureFilter)
    : targets;

  if (fixtureFilter && selected.length === 0) {
    console.error(`No replay fixture matched --fixture=${fixtureFilter}`);
    process.exit(1);
  }

  const summary = {
    passed: 0,
    failed: 0,
    skipped: loaded.length - targets.length,
    assertions: 0,
    failures: [],
  };

  console.log(`Replaying ${selected.length} live-contract fixtures...`);

  for (const { fixture, path: fixturePath } of selected) {
    ensureCleanStore();
    const startedAt = Date.now();
    try {
      const result = await replayHandlers[fixture.fixture_id](fixture);
      const durationMs = Date.now() - startedAt;
      summary.passed += 1;
      summary.assertions += result.assertions || 0;
      console.log(`PASS ${fixture.fixture_id} (${durationMs}ms)`);
      for (const detail of result.details || []) {
        console.log(`  - ${detail}`);
      }
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      summary.failed += 1;
      summary.failures.push({
        fixture_id: fixture.fixture_id,
        path: path.relative(root, fixturePath),
        message: error instanceof Error ? error.message : String(error),
      });
      console.error(`FAIL ${fixture.fixture_id} (${durationMs}ms)`);
      console.error(`  - ${error instanceof Error ? error.stack || error.message : error}`);
    }
  }

  console.log('');
  console.log(JSON.stringify({
    status: summary.failed === 0 ? 'passed' : 'failed',
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    assertions: summary.assertions,
    failures: summary.failures,
  }, null, 2));

  if (summary.failed > 0) {
    process.exit(1);
  }
}

main().finally(() => {
  ensureCleanStore();
});
