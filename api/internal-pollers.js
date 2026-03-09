import { spawn } from 'child_process';
import { getDispatchSessionKeyForTicket, getAuditSessionKeyForTicket, NOTIFY_MAIN_SESSION } from './agent-session-router.js';

const DEFAULT_API_BASE_URL = process.env.TICKET_API_BASE_URL || 'http://127.0.0.1:8788';
const DEFAULT_DISPATCH_INTERVAL_MS = parsePositiveInt(process.env.TICKET_DISPATCH_POLL_INTERVAL_MS, 5 * 60 * 1000);
const DEFAULT_NOTIFY_INTERVAL_MS = parsePositiveInt(process.env.TICKET_NOTIFY_POLL_INTERVAL_MS, 2 * 60 * 1000);
const DEFAULT_AUDIT_INTERVAL_MS = parsePositiveInt(process.env.TICKET_AUDIT_POLL_INTERVAL_MS, 10 * 60 * 1000);
const DEFAULT_DELIVERY_TIMEOUT_MS = parsePositiveInt(process.env.TICKET_DELIVERY_TIMEOUT_MS, 30 * 1000);

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseEnabled(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function makeIdempotencyKey(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 调用 OpenClaw chat.send 投递到指定 session。
 * 仅当进程 exit code 为 0 时 resolve；timeout/error/非 0 均 reject，调用方不得 ack。
 */
function sendChatToSession({ sessionKey, message, idempotencyKey }) {
  const params = {
    sessionKey,
    message,
    idempotencyKey,
  };

  return new Promise((resolve, reject) => {
    const child = spawn(
      'openclaw',
      ['gateway', 'call', 'chat.send', '--json', '--params', JSON.stringify(params)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`chat.send failed (code=${code}): ${stderr || stdout}`));
      }
      try {
        const parsed = JSON.parse(stdout || '{}');
        return resolve(parsed);
      } catch {
        return resolve({ raw: stdout.trim() });
      }
    });
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    }),
  ]);
}

async function fetchReady(apiBaseUrl, path) {
  const url = `${apiBaseUrl}${path}`;
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return Array.isArray(data?.ready) ? data.ready : [];
}

async function ackDispatch(apiBaseUrl, dispatchId) {
  const url = `${apiBaseUrl}/api/dispatch/${dispatchId}/ack`;
  const res = await fetch(url, { method: 'POST', headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`ack dispatch ${dispatchId} failed: ${res.status}`);
  }
}

async function ackNotification(apiBaseUrl, eventId) {
  const url = `${apiBaseUrl}/api/notifications/${eventId}/ack`;
  const res = await fetch(url, { method: 'POST', headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`ack notification ${eventId} failed: ${res.status}`);
  }
}

async function ackAudit(apiBaseUrl, auditId) {
  const url = `${apiBaseUrl}/api/audits/${auditId}/ack`;
  const res = await fetch(url, { method: 'POST', headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`ack audit ${auditId} failed: ${res.status}`);
  }
}

function createWorker({ name, intervalMs, tick }) {
  let timer = null;
  let running = false;
  let stopped = false;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error(`[internal-poller:${name}]`, err?.message || err);
    } finally {
      running = false;
    }
  };

  const start = () => {
    if (stopped) return;
    timer = setInterval(run, intervalMs);
    timer.unref?.();
    run();
  };

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };

  return { start, stop };
}

export function startInternalPollers(options = {}) {
  const enabled = parseEnabled(process.env.TICKET_INTERNAL_POLLERS_ENABLED, true);
  if (!enabled) {
    console.log('[internal-poller] disabled by TICKET_INTERNAL_POLLERS_ENABLED');
    return { stop: () => {} };
  }

  const apiBaseUrl = options.apiBaseUrl || DEFAULT_API_BASE_URL;
  const dispatchIntervalMs = options.dispatchIntervalMs || DEFAULT_DISPATCH_INTERVAL_MS;
  const notifyIntervalMs = options.notifyIntervalMs || DEFAULT_NOTIFY_INTERVAL_MS;
  const auditIntervalMs = options.auditIntervalMs || DEFAULT_AUDIT_INTERVAL_MS;
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;

  const dispatchWorker = createWorker({
    name: 'dispatch',
    intervalMs: dispatchIntervalMs,
    tick: async () => {
      const ready = await fetchReady(apiBaseUrl, '/api/dispatch/ready');
      if (ready.length === 0) return;

      for (const item of ready) {
        const { dispatch_id, ticket_id, agent, message } = item;
        if (!dispatch_id || !message) continue;
        const sessionKey = getDispatchSessionKeyForTicket(agent, ticket_id);
        const idempotencyKey = makeIdempotencyKey(`dispatch-${dispatch_id}`);
        try {
          await withTimeout(
            sendChatToSession({ sessionKey, message, idempotencyKey }),
            deliveryTimeoutMs,
            'dispatch chat.send',
          );
          await ackDispatch(apiBaseUrl, dispatch_id);
          console.log(`[internal-poller:dispatch] delivered and acked dispatch_id=${dispatch_id} -> ${sessionKey}`);
        } catch (err) {
          console.error(`[internal-poller:dispatch] delivery failed for dispatch_id=${dispatch_id}, no ack:`, err?.message || err);
        }
      }
    },
  });

  const notifyWorker = createWorker({
    name: 'notify',
    intervalMs: notifyIntervalMs,
    tick: async () => {
      const ready = await fetchReady(apiBaseUrl, '/api/notifications/ready');
      if (ready.length === 0) return;

      for (const item of ready) {
        const { event_id, message } = item;
        if (!event_id || !message) continue;
        const idempotencyKey = makeIdempotencyKey(`notify-${event_id}`);
        try {
          await withTimeout(
            sendChatToSession({
              sessionKey: NOTIFY_MAIN_SESSION,
              message,
              idempotencyKey,
            }),
            deliveryTimeoutMs,
            'notify chat.send',
          );
          await ackNotification(apiBaseUrl, event_id);
          console.log(`[internal-poller:notify] delivered and acked event_id=${event_id} -> ${NOTIFY_MAIN_SESSION}`);
        } catch (err) {
          console.error(`[internal-poller:notify] delivery failed for event_id=${event_id}, no ack:`, err?.message || err);
        }
      }
    },
  });

  const auditWorker = createWorker({
    name: 'audit',
    intervalMs: auditIntervalMs,
    tick: async () => {
      const ready = await fetchReady(apiBaseUrl, '/api/audits/ready');
      if (ready.length === 0) return;

      for (const item of ready) {
        const { audit_id, ticket_id, message } = item;
        if (!audit_id || !message) continue;
        const sessionKey = getAuditSessionKeyForTicket(ticket_id);
        const idempotencyKey = makeIdempotencyKey(`audit-${audit_id}`);
        try {
          await withTimeout(
            sendChatToSession({ sessionKey, message, idempotencyKey }),
            deliveryTimeoutMs,
            'audit chat.send',
          );
          await ackAudit(apiBaseUrl, audit_id);
          console.log(`[internal-poller:audit] delivered and acked audit_id=${audit_id} -> ${sessionKey}`);
        } catch (err) {
          console.error(`[internal-poller:audit] delivery failed for audit_id=${audit_id}, no ack:`, err?.message || err);
        }
      }
    },
  });

  dispatchWorker.start();
  notifyWorker.start();
  auditWorker.start();

  console.log('[internal-poller] started (direct-drive)', {
    apiBaseUrl,
    dispatchIntervalMs,
    notifyIntervalMs,
    auditIntervalMs,
    deliveryTimeoutMs,
    notifySession: NOTIFY_MAIN_SESSION,
  });

  return {
    stop: () => {
      dispatchWorker.stop();
      notifyWorker.stop();
      auditWorker.stop();
    },
  };
}
