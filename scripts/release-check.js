#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const steps = [
  ['repo hygiene', ['npm', ['run', 'repo:hygiene']]],
  ['lint', ['npm', ['run', 'lint']]],
  ['test', ['npm', ['test']]],
  ['build', ['npm', ['run', 'build']]],
  ['prod dependency audit', ['npm', ['audit', '--omit=dev', '--audit-level=moderate']]],
  ['mcp smoke', ['npm', ['run', 'mcp:smoke']]],
  ['live contract fixtures', ['npm', ['run', 'validate:live-contract-fixtures']]],
];

const startedAt = new Date();
const results = [];
for (const [label, [command, args]] of steps) {
  console.log(`\n=== release-check: ${label} ===`);
  const started = Date.now();
  const res = spawnSync(command, args, { stdio: 'inherit', shell: false });
  const durationMs = Date.now() - started;
  results.push({ label, status: res.status === 0 ? 'passed' : 'failed', code: res.status, durationMs });
  if (res.status !== 0) {
    console.error(`\nrelease-check failed at step: ${label}`);
    console.error(JSON.stringify({ started_at: startedAt.toISOString(), results }, null, 2));
    process.exit(res.status || 1);
  }
}
console.log('\nrelease-check passed');
console.log(JSON.stringify({ started_at: startedAt.toISOString(), finished_at: new Date().toISOString(), results }, null, 2));
