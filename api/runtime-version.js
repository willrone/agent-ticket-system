/**
 * 运行态版本信息：供 /api/version、启动日志与 live acceptance 使用。
 * 返回 git commit、build time、schema version、bundle version，保证运行态一致性与契约回归可校验。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SCHEMA_VERSION, AGENT_PLAYBOOK_VERSION } from './agent-facing.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
let cached = null;

function findGitRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function getGitCommit() {
  if (process.env.BUILD_COMMIT && String(process.env.BUILD_COMMIT).trim()) {
    return String(process.env.BUILD_COMMIT).trim().slice(0, 40);
  }
  const gitRoot = findGitRoot(process.cwd()) || findGitRoot(path.resolve(MODULE_DIR, '..'));
  if (!gitRoot) {
    return null;
  }
  try {
    const out = execFileSync('git', ['-C', gitRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out).trim().slice(0, 40);
  } catch {
    return null;
  }
}

function getBuildTime() {
  if (process.env.BUILD_TIME && String(process.env.BUILD_TIME).trim()) {
    return String(process.env.BUILD_TIME).trim();
  }
  return new Date().toISOString();
}

/**
 * 返回当前运行态版本信息，供 /api/version、启动日志与 live acceptance 校验。
 * @returns {{ git_commit: string|null, build_time: string, schema_version: string, bundle_version: string }}
 */
export function getRuntimeVersion() {
  if (cached) return cached;
  const gitRoot = findGitRoot(process.cwd()) || findGitRoot(path.resolve(MODULE_DIR, '..'));
  const gitCommit = getGitCommit();
  const buildTime = getBuildTime();
  const schemaVersion = AGENT_SCHEMA_VERSION;
  const bundleVersion = AGENT_PLAYBOOK_VERSION;
  const releaseFingerprint = createHash('sha256')
    .update([gitRoot || path.resolve(MODULE_DIR, '..'), process.cwd(), gitCommit || '', schemaVersion, bundleVersion].join('|'))
    .digest('hex')
    .slice(0, 16);
  cached = {
    git_commit: gitCommit,
    build_time: buildTime,
    schema_version: schemaVersion,
    bundle_version: bundleVersion,
    production_repo: 'agent-ticket-system',
    repo_root: gitRoot || path.resolve(MODULE_DIR, '..'),
    working_directory: process.cwd(),
    release_fingerprint: releaseFingerprint,
    environment: 'production',
  };
  return cached;
}

/**
 * 用于启动时打印与 live acceptance 预期校验的 commit hash（与 getRuntimeVersion().git_commit 一致）。
 */
export function getCommitHashForLog() {
  return getRuntimeVersion().git_commit;
}
