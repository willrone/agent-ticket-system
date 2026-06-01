#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const manifestPath = path.join(root, 'docs/live-contract-fixtures/manifest/fixtures.manifest.json');

function fail(message) {
  console.error(`VALIDATION_FAILED: ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`OK: ${message}`);
}

function readJson(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (error) {
    fail(`invalid json: ${path.relative(root, absPath)} (${error.message})`);
    return null;
  }
}

if (!fs.existsSync(manifestPath)) {
  fail(`manifest not found: ${manifestPath}`);
  process.exit();
}

const manifest = readJson(manifestPath);
if (!manifest) process.exit();

if (manifest.catalog !== 'live-contract-fixtures') {
  fail('manifest.catalog must be live-contract-fixtures');
}

const requiredPaths = manifest.validation?.required_paths || [];
for (const rel of requiredPaths) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    fail(`missing required path: ${rel}`);
  } else {
    ok(`required path exists: ${rel}`);
  }
}

const sourceRefs = new Set();
for (const group of [manifest.baseline || [], manifest.incidents || []]) {
  for (const item of group) {
    for (const source of item.sources || []) sourceRefs.add(source);
  }
}
for (const item of manifest.missing_fixtures || []) {
  for (const source of item.derived_from || []) sourceRefs.add(source);
}

for (const rel of sourceRefs) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    fail(`missing source ref: ${rel}`);
  } else {
    ok(`source ref exists: ${rel}`);
  }
}

const linkedItems = [...(manifest.baseline || []), ...(manifest.incidents || [])];
for (const item of linkedItems) {
  if (!item.path) continue;
  const abs = path.normalize(path.join(path.dirname(manifestPath), item.path));
  if (!fs.existsSync(abs)) {
    fail(`manifest linked path missing: ${path.relative(root, abs)}`);
    continue;
  }
  ok(`manifest linked path exists: ${path.relative(root, abs)}`);
}

const schema = manifest.validation?.json_fixture_schema || {};
const requiredFields = schema.required_fields || [];
const historicalMin = schema.historical_wrong_behavior_min || 1;
const seenFixtureIds = new Map();

function validateFixtureTypeSpecific(data, relPath) {
  switch (data.fixture_type) {
    case 'dispatch-ready-snapshot':
    case 'notifications-ready-snapshot':
      if (!('ready_count' in (data.expected || {})) && !('should_be_ready' in (data.expected || {})) && !('queue_boundary_contract' in (data.expected || {}))) {
        fail(`${relPath}: snapshot fixture must declare ready_count / should_be_ready / queue_boundary_contract in expected`);
      }
      break;
    case 'dispatch-receipt-bridge':
      if (data.input?.report_type !== 'dispatch_receipt') {
        fail(`${relPath}: dispatch-receipt-bridge must declare input.report_type=dispatch_receipt`);
      }
      if (!data.expected?.transition_preview) {
        fail(`${relPath}: dispatch-receipt-bridge must declare expected.transition_preview`);
      }
      break;
    case 'dispatch-receipt-validation-error':
      if (!data.expected?.code && !data.expected?.machine_readable_required) {
        fail(`${relPath}: dispatch receipt validation error fixture must declare expected.code or machine_readable_required`);
      }
      break;
    case 'workflow-mismatch-case':
      if (!Array.isArray(data.cases) || data.cases.length === 0) {
        fail(`${relPath}: workflow-mismatch-case must declare non-empty cases[]`);
      }
      break;
    default:
      break;
  }
}

for (const item of linkedItems) {
  if (item.kind !== 'json-fixture') continue;
  const abs = path.normalize(path.join(path.dirname(manifestPath), item.path));
  const relPath = path.relative(root, abs);
  const data = readJson(abs);
  if (!data) continue;

  for (const field of requiredFields) {
    if (!(field in data)) {
      fail(`${relPath}: missing required field ${field}`);
    }
  }

  if (!Array.isArray(data.source_refs) || data.source_refs.length === 0) {
    fail(`${relPath}: source_refs must be a non-empty array`);
  }
  if (typeof data.expected !== 'object' || data.expected === null || Array.isArray(data.expected)) {
    fail(`${relPath}: expected must be an object`);
  }
  if (!Array.isArray(data.historical_wrong_behavior) || data.historical_wrong_behavior.length < historicalMin) {
    fail(`${relPath}: historical_wrong_behavior must contain at least ${historicalMin} item(s)`);
  }

  const fixtureId = data.fixture_id;
  if (typeof fixtureId !== 'string' || !fixtureId.trim()) {
    fail(`${relPath}: fixture_id must be a non-empty string`);
  } else if (seenFixtureIds.has(fixtureId)) {
    fail(`${relPath}: duplicate fixture_id ${fixtureId} (already seen in ${seenFixtureIds.get(fixtureId)})`);
  } else {
    seenFixtureIds.set(fixtureId, relPath);
    ok(`fixture_id unique: ${fixtureId}`);
  }

  for (const ref of data.source_refs || []) {
    const refAbs = path.join(root, ref);
    if (!fs.existsSync(refAbs)) {
      fail(`${relPath}: fixture source_ref missing ${ref}`);
    }
  }

  validateFixtureTypeSpecific(data, relPath);
  ok(`json fixture schema valid: ${relPath}`);
}

const summary = {
  baseline: (manifest.baseline || []).length,
  incidents: (manifest.incidents || []).length,
  missing_fixtures: (manifest.missing_fixtures || []).length,
  validated_json_fixtures: linkedItems.filter((item) => item.kind === 'json-fixture').length,
  status: process.exitCode ? 'failed' : 'passed'
};
console.log(JSON.stringify(summary, null, 2));
