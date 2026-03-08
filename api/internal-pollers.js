import { spawn } from 'child_process';

const DEFAULT_API_BASE_URL = process.env.TICKET_API_BASE_URL || 'http://127.0.0.1:8788';
const DEFAULT_SHEEPLY_SESSION_KEY = process.env.TICKET_SHEEPLY_SESSION_KEY || 'agent:auditor:main';
const DEFAULT_DISPATCH_INTERVAL_MS = parsePositiveInt(process.env.TICKET_DISPATCH_POLL_INTERVAL_MS, 5 * 60 * 1000);
const DEFAULT_NOTIFY_INTERVAL_MS = parsePositiveInt(process.env.TICKET_NOTIFY_POLL_INTERVAL_MS, 2 * 60 * 1000);

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
  const sheeplySessionKey = options.sheeplySessionKey || DEFAULT_SHEEPLY_SESSION_KEY;
  const dispatchIntervalMs = options.dispatchIntervalMs || DEFAULT_DISPATCH_INTERVAL_MS;
  const notifyIntervalMs = options.notifyIntervalMs || DEFAULT_NOTIFY_INTERVAL_MS;

  const dispatchWorker = createWorker({
    name: 'dispatch',
    intervalMs: dispatchIntervalMs,
    tick: async () => {
      const ready = await fetchReady(apiBaseUrl, '/api/dispatch/ready');
      if (ready.length === 0) return;

      const ids = ready.map((item) => item.dispatch_id).filter(Boolean);
      const message = [
        '🛰️ [ticket-platform internal dispatch poller]',
        `检测到待派单事件：${ready.length} 条`,
        ids.length ? `dispatch_ids: ${ids.join(',')}` : null,
        '',
        '请立即按最新规则处理 /api/dispatch/ready：',
        '1) 向目标 agent 派单',
        '2) 派单成功后 ack 对应 dispatch 事件',
        '3) 异常时回报 leoss',
      ].filter(Boolean).join('\n');

      await sendChatToSession({
        sessionKey: sheeplySessionKey,
        message,
        idempotencyKey: makeIdempotencyKey('ticket-dispatch-poller'),
      });

      console.log(`[internal-poller:dispatch] nudged Sheeply for ${ready.length} ready event(s)`);
    },
  });

  const notifyWorker = createWorker({
    name: 'notify',
    intervalMs: notifyIntervalMs,
    tick: async () => {
      const ready = await fetchReady(apiBaseUrl, '/api/notifications/ready');
      if (ready.length === 0) return;

      const ids = ready.map((item) => item.event_id).filter(Boolean);
      const message = [
        '📣 [ticket-platform internal notify poller]',
        `检测到待通知事件：${ready.length} 条`,
        ids.length ? `event_ids: ${ids.join(',')}` : null,
        '',
        '请立即按最新规则处理 /api/notifications/ready：',
        '1) 给老大发结果通知',
        '2) 发送成功后 ack 对应 notification 事件',
        '3) 发送失败不要 ack，保留重试',
      ].filter(Boolean).join('\n');

      await sendChatToSession({
        sessionKey: sheeplySessionKey,
        message,
        idempotencyKey: makeIdempotencyKey('ticket-notify-poller'),
      });

      console.log(`[internal-poller:notify] nudged Sheeply for ${ready.length} ready event(s)`);
    },
  });

  dispatchWorker.start();
  notifyWorker.start();

  console.log('[internal-poller] started', {
    apiBaseUrl,
    sheeplySessionKey,
    dispatchIntervalMs,
    notifyIntervalMs,
  });

  return {
    stop: () => {
      dispatchWorker.stop();
      notifyWorker.stop();
    },
  };
}
