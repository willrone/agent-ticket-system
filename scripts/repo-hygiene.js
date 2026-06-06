#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const GENERATED_PATTERNS = [
  { label: 'api sqlite runtime db', dir: 'api/data', match: (name) => /^(?!test-|legacy-).*\.db(?:-shm|-wal)?$/.test(name) },
  { label: 'api test sqlite db', dir: 'api/data', match: (name) => /^test-.*\.db(?:-shm|-wal)?$/.test(name) },
  { label: 'api legacy sqlite db', dir: 'api/data', match: (name) => /^legacy-.*\.db(?:-shm|-wal)?$/.test(name) },
  { label: 'stray local sqlite db clone', dir: 'data', match: (name) => /^agent-ticket-system\.db(?:-shm|-wal)?$/.test(name) },
  { label: 'untracked sqlite runtime db', dir: 'data', match: (name) => /^(dispatch|ticket-platform-v2|ticket-system)\.sqlite(?:-shm|-wal)?$/.test(name) || /^(dispatch|ticket-platform-v2|ticket-system)\.db(?:-shm|-wal)?$/.test(name) },
  { label: 'sqlite backup/corrupt artifact', dir: 'data', match: (name) => /^tickets\.db\.(bak|corrupt).*|^tickets\.pre-reset.*\.db(?:-shm|-wal)?$/.test(name) },
  { label: 'backup sqlite sidecar', dir: 'data/backups', match: (name) => /^.*\.db(?:-shm|-wal)$/.test(name) },
  
  { label: 'memory scratch directory', dir: '.', match: (name) => name === 'memory' },
  {
    label: 'tmp scratch directory',
    dir: '.',
    match: (name, absPath) => name === 'tmp' && !isDirectoryEmpty(absPath),
  },
  { label: 'root rollout artifacts', dir: '.', match: (name) => name === '.rollout' },
];

function isDirectoryEmpty(absPath) {
  try {
    if (!fs.statSync(absPath).isDirectory()) return false;
    return fs.readdirSync(absPath).length === 0;
  } catch {
    return false;
  }
}

function walkMatches() {
  const matches = [];
  for (const rule of GENERATED_PATTERNS) {
    const absDir = path.join(repoRoot, rule.dir);
    if (!fs.existsSync(absDir)) continue;
    for (const name of fs.readdirSync(absDir)) {
      const absPath = path.join(absDir, name);
      if (!rule.match(name, absPath)) continue;
      const relPath = path.relative(repoRoot, absPath);
      matches.push({ ...rule, absPath, relPath, type: fs.statSync(absPath).isDirectory() ? 'dir' : 'file' });
    }
  }
  return matches.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function removePath(target) {
  if (target.type === 'dir') {
    fs.rmSync(target.absPath, { recursive: true, force: true });
  } else {
    fs.rmSync(target.absPath, { force: true });
  }
}

function printSummary(matches, mode) {
  console.log(JSON.stringify({
    mode,
    repo_root: repoRoot,
    total: matches.length,
    items: matches.map(({ relPath, label, type }) => ({ path: relPath, label, type })),
  }, null, 2));
}

const args = new Set(process.argv.slice(2));
const doCleanup = args.has('--cleanup');
const doCheck = args.has('--check') || !doCleanup;

const matches = walkMatches();
if (doCheck) {
  printSummary(matches, doCleanup ? 'cleanup+check' : 'check');
}
if (doCleanup) {
  for (const match of matches) removePath(match);
  console.log(`Removed ${matches.length} generated artifact(s).`);
}
if (matches.length > 0 && !doCleanup) {
  process.exitCode = 1;
}
