import fs from 'fs';
import os from 'os';
import path from 'path';
import * as store from './store.js';

export const DEFAULT_TICKET_SESSION_RETENTION_DAYS = 14;
export const DEFAULT_TICKET_SESSION_CLEANUP_STATUSES = ['complete', 'failed', 'deprecated'];

const TICKET_SESSION_KEY_RE = /^agent:([^:]+):ticket:(\d+)$/i;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_STALE_MS = 30_000;

function normalizeStatuses(statuses) {
  const values = Array.isArray(statuses)
    ? statuses
    : typeof statuses === 'string'
      ? statuses.split(',')
      : DEFAULT_TICKET_SESSION_CLEANUP_STATUSES;

  const normalized = [...new Set(values
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean))];

  return normalized.length > 0 ? normalized : [...DEFAULT_TICKET_SESSION_CLEANUP_STATUSES];
}

function normalizeRetentionDays(retentionDays) {
  const parsed = Number(retentionDays);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_TICKET_SESSION_RETENTION_DAYS;
  }
  return parsed;
}

function parseDateMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value) {
  if (!Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

function formatArchiveTimestamp(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().replace(/:/g, '-');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOpenClawHome(openclawHome) {
  if (openclawHome) return path.resolve(openclawHome);
  if (process.env.OPENCLAW_HOME) return path.resolve(process.env.OPENCLAW_HOME);
  return path.join(os.homedir(), '.openclaw');
}

function isPathInside(parentDir, candidatePath) {
  const parent = path.resolve(parentDir);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolveSessionStoreTargets(openclawHome) {
  const resolvedHome = getOpenClawHome(openclawHome);
  const targets = [];
  const agentsDir = path.join(resolvedHome, 'agents');

  try {
    const agentEntries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of agentEntries) {
      if (!entry.isDirectory()) continue;
      const storePath = path.join(agentsDir, entry.name, 'sessions', 'sessions.json');
      if (!fs.existsSync(storePath)) continue;
      targets.push({ agent_id: entry.name, store_path: storePath });
    }
  } catch {
    // ignore missing OpenClaw home
  }

  const legacyStorePath = path.join(resolvedHome, 'sessions', 'sessions.json');
  if (fs.existsSync(legacyStorePath)) {
    targets.push({ agent_id: 'legacy', store_path: legacyStorePath });
  }

  return targets.sort((a, b) => a.store_path.localeCompare(b.store_path));
}

function buildTicketMap() {
  return new Map(
    store.getAllTickets().map((ticket) => [Number(ticket.id), ticket])
  );
}

function resolveTranscriptFiles(storePath, entry) {
  const sessionsDir = path.dirname(storePath);
  const candidates = new Set();

  if (entry?.sessionFile && isPathInside(sessionsDir, entry.sessionFile)) {
    candidates.add(path.resolve(entry.sessionFile));
  }

  if (entry?.sessionId) {
    candidates.add(path.join(sessionsDir, `${entry.sessionId}.jsonl`));
  }

  return [...candidates].filter((candidatePath) => fs.existsSync(candidatePath));
}

function buildPlan(options = {}) {
  const cleanupStatuses = normalizeStatuses(options.cleanupStatuses ?? options.statuses);
  const retentionDays = normalizeRetentionDays(options.retentionDays);
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const openclawHome = getOpenClawHome(options.openclawHome);
  const ticketMap = buildTicketMap();
  const targets = Array.isArray(options.storeTargets) && options.storeTargets.length > 0
    ? options.storeTargets
    : resolveSessionStoreTargets(openclawHome);

  const candidates = [];
  const skipped = [];
  const stores = [];
  let scannedSessionCount = 0;

  for (const target of targets) {
    const storePath = target.store_path;
    const sessionStore = readJsonFile(storePath);
    let scannedTicketSessionCount = 0;
    const storeCandidates = [];

    for (const [sessionKey, entry] of Object.entries(sessionStore)) {
      const match = TICKET_SESSION_KEY_RE.exec(String(sessionKey));
      if (!match) continue;

      scannedSessionCount += 1;
      scannedTicketSessionCount += 1;
      const ticketId = Number(match[2]);
      const ticket = ticketMap.get(ticketId);

      if (!ticket) {
        skipped.push({
          store_path: storePath,
          session_key: sessionKey,
          ticket_id: ticketId,
          reason: 'ticket_not_found',
        });
        continue;
      }

      const ticketStatus = String(ticket.status ?? '').trim().toLowerCase();
      if (!cleanupStatuses.includes(ticketStatus)) {
        skipped.push({
          store_path: storePath,
          session_key: sessionKey,
          ticket_id: ticketId,
          ticket_status: ticketStatus || null,
          reason: 'status_protected',
        });
        continue;
      }

      const ticketLastUpdateMs = parseDateMs(ticket.last_update) ?? parseDateMs(ticket.updated) ?? parseDateMs(ticket.created);
      const sessionUpdatedAtMs = Number.isFinite(entry?.updatedAt) ? Number(entry.updatedAt) : null;
      const lastActivityMs = Math.max(ticketLastUpdateMs ?? 0, sessionUpdatedAtMs ?? 0);

      if (!Number.isFinite(lastActivityMs) || lastActivityMs <= 0) {
        skipped.push({
          store_path: storePath,
          session_key: sessionKey,
          ticket_id: ticketId,
          ticket_status: ticketStatus,
          reason: 'missing_activity_timestamp',
        });
        continue;
      }

      const ageMs = Math.max(0, nowMs - lastActivityMs);
      if (ageMs < retentionMs) {
        skipped.push({
          store_path: storePath,
          session_key: sessionKey,
          ticket_id: ticketId,
          ticket_status: ticketStatus,
          reason: 'within_retention',
          age_days: Number((ageMs / 86_400_000).toFixed(2)),
        });
        continue;
      }

      const candidate = {
        store_path: storePath,
        session_key: sessionKey,
        session_id: entry?.sessionId ?? null,
        ticket_id: ticketId,
        ticket_status: ticketStatus,
        retention_days: retentionDays,
        age_days: Number((ageMs / 86_400_000).toFixed(2)),
        ticket_last_update: toIso(ticketLastUpdateMs),
        session_updated_at: toIso(sessionUpdatedAtMs),
        last_activity_at: toIso(lastActivityMs),
        transcript_files: resolveTranscriptFiles(storePath, entry),
      };

      candidates.push(candidate);
      storeCandidates.push(candidate);
    }

    stores.push({
      agent_id: target.agent_id,
      store_path: storePath,
      scanned_ticket_session_count: scannedTicketSessionCount,
      eligible_count: storeCandidates.length,
      eligible_session_keys: storeCandidates.map((item) => item.session_key),
    });
  }

  return {
    dry_run: true,
    now: new Date(nowMs).toISOString(),
    openclaw_home: openclawHome,
    retention_days: retentionDays,
    cleanup_statuses: cleanupStatuses,
    scanned_store_count: targets.length,
    scanned_session_count: scannedSessionCount,
    eligible_count: candidates.length,
    skipped_count: skipped.length,
    stores,
    candidates,
    skipped,
  };
}

async function acquireStoreLock(storePath, options = {}) {
  const lockPath = `${path.resolve(storePath)}.lock`;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = Number.isFinite(options.staleMs) ? Number(options.staleMs) : DEFAULT_LOCK_STALE_MS;
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    try {
      const handle = await fs.promises.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2), 'utf8');
      await handle.close();
      return {
        lock_path: lockPath,
        release: async () => {
          await fs.promises.rm(lockPath, { force: true }).catch(() => {});
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const stat = await fs.promises.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        await fs.promises.rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      await sleep(Math.min(1000, 50 * attempt));
    }
  }

  throw new Error(`timeout waiting for session store lock: ${storePath}`);
}

async function writeJsonAtomic(filePath, data) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const json = `${JSON.stringify(data, null, 2)}\n`;
  await fs.promises.writeFile(tmpPath, json, 'utf8');
  await fs.promises.rename(tmpPath, filePath);
}

async function archiveTranscriptFiles(files, nowMs) {
  const suffix = `.deleted.${formatArchiveTimestamp(nowMs)}`;
  const archived = [];

  for (const filePath of files) {
    if (!fs.existsSync(filePath)) continue;
    const archivedPath = `${filePath}${suffix}`;
    await fs.promises.rename(filePath, archivedPath);
    archived.push(archivedPath);
  }

  return archived;
}

export function previewTicketSessionCleanup(options = {}) {
  return buildPlan(options);
}

export async function runTicketSessionCleanup(options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const initialPlan = buildPlan({ ...options, nowMs });
  const storeTargets = initialPlan.stores
    .filter((item) => item.eligible_count > 0)
    .map((item) => ({ agent_id: item.agent_id, store_path: item.store_path }));

  const mutatedStores = [];
  let deletedCount = 0;
  let archivedTranscriptCount = 0;

  for (const target of storeTargets) {
    const lock = await acquireStoreLock(target.store_path, options);
    try {
      const freshPlan = buildPlan({
        ...options,
        nowMs,
        storeTargets: [target],
      });

      if (freshPlan.candidates.length === 0) {
        continue;
      }

      const currentStore = readJsonFile(target.store_path);
      const backupPath = `${target.store_path}.bak.ticket-cleanup.${formatArchiveTimestamp(nowMs)}`;
      await fs.promises.copyFile(target.store_path, backupPath);

      for (const candidate of freshPlan.candidates) {
        delete currentStore[candidate.session_key];
      }

      await writeJsonAtomic(target.store_path, currentStore);

      const archivedTranscripts = [];
      for (const candidate of freshPlan.candidates) {
        const archived = await archiveTranscriptFiles(candidate.transcript_files, nowMs);
        archivedTranscripts.push(...archived);
      }

      deletedCount += freshPlan.candidates.length;
      archivedTranscriptCount += archivedTranscripts.length;
      mutatedStores.push({
        agent_id: target.agent_id,
        store_path: target.store_path,
        backup_path: backupPath,
        deleted_session_keys: freshPlan.candidates.map((item) => item.session_key),
        archived_transcripts: archivedTranscripts,
      });
    } finally {
      await lock.release();
    }
  }

  return {
    ...initialPlan,
    dry_run: false,
    deleted_count: deletedCount,
    archived_transcript_count: archivedTranscriptCount,
    mutated_store_count: mutatedStores.length,
    mutated_stores: mutatedStores,
  };
}
