import { getAuditSessionKeyForTicket, NOTIFY_MAIN_SESSION } from './agent-session-router.js';
import * as store from './store.js';
import * as dispatchEvents from './dispatch.js';
import { deliverChatToGateway } from './delivery-transport.js';
import { createLogger } from './logger.js';

const logger = createLogger('internal-poller');

const DEFAULT_API_BASE_URL = process.env.TICKET_API_BASE_URL || 'http://127.0.0.1:8788';
const DEFAULT_DISPATCH_INTERVAL_MS = parsePositiveInt(process.env.TICKET_DISPATCH_POLL_INTERVAL_MS, 5 * 1000);
const DEFAULT_NOTIFY_INTERVAL_MS = parsePositiveInt(process.env.TICKET_NOTIFY_POLL_INTERVAL_MS, 5 * 1000);
const DEFAULT_AUDIT_INTERVAL_MS = parsePositiveInt(process.env.TICKET_AUDIT_POLL_INTERVAL_MS, 30 * 1000);
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
  if (res.status === 404) {
    return { ok: false, missing: true, status: 404 };
  }
  if (!res.ok) {
    throw new Error(`ack dispatch ${dispatchId} failed: ${res.status}`);
  }
  return { ok: true, missing: false, status: res.status };
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

export function autoLockDeliveredQueuedTicket({ ticketId, actor, dispatchId }) {
  void ticketId;
  void actor;
  void dispatchId;
  return { changed: false, reason: 'receipt_driven_dispatch' };
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
      logger.error('worker tick failed', { worker: name, error: err });
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
    logger.info('disabled by TICKET_INTERNAL_POLLERS_ENABLED');
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
        const {
          dispatch_id,
          ticket_id,
          message,
          target_gateway_id,
          transport,
          target_session_key,
          reset_session,
          session_reset_reason,
          kind,
          dedupe_key,
          reason,
          nudge_source,
        } = item;
        if (!dispatch_id || !message) continue;
        const idempotencyKey = makeIdempotencyKey(`dispatch-${dispatch_id}`);
        try {
          const result = await withTimeout(
            deliverChatToGateway({
              targetGatewayId: target_gateway_id,
              transport,
              targetSessionKey: target_session_key,
              message,
              idempotencyKey,
              resetSession: reset_session === true,
              resetReason: session_reset_reason || 'assignment_refresh',
            }),
            deliveryTimeoutMs,
            'dispatch chat.send',
          );
          dispatchEvents.recordDeliveryAttempt({
            eventKind: 'dispatch',
            eventId: dispatch_id,
            ticketId: ticket_id,
            targetGatewayId: target_gateway_id,
            transport,
            targetSessionKey: target_session_key,
            ok: true,
            result,
          });
          store.markAssignmentDeliveredByDispatchEvent(dispatch_id, {
            assignment_status: 'delivered',
            target_session_key: target_session_key,
            transport,
          });
          if (kind === 'nudge') {
            dispatchEvents.resolvePendingForward('dispatch_nudge', dispatch_id, { channel: 'telegram', resolution: 'delivered' });
            const unresolved = dispatchEvents.listPendingForwards({ channel: 'telegram', unresolvedOnly: true, ticketId: ticket_id, limit: 50 });
            for (const row of unresolved) {
              if (row.event_kind !== 'dispatch_nudge') continue;
              const sameSession = (row.target_session_key || null) === (target_session_key || null);
              const sameDedupe = dedupe_key && (row.dedupe_key || null) === dedupe_key;
              if (!sameSession && !sameDedupe) continue;
              dispatchEvents.resolvePendingForward('dispatch_nudge', row.event_id, { channel: 'telegram', resolution: 'delivered' });
            }
          }
          const ackResult = await ackDispatch(apiBaseUrl, dispatch_id);
          if (ackResult?.missing) {
            logger.warn('dispatch vanished before ack after successful delivery; treated as stale-cleared', {
              worker: 'dispatch',
              dispatch_id,
              ticket_id,
            });
          } else {
            logger.info('dispatch delivered and acked; waiting for dispatch_receipt before workflow transition', {
              worker: 'dispatch',
              dispatch_id,
              ticket_id,
              target_session_key,
              target_gateway_id,
              transport,
            });
          }
        } catch (err) {
          const errorMessage = err?.message || String(err);
          dispatchEvents.recordDeliveryAttempt({
            eventKind: 'dispatch',
            eventId: dispatch_id,
            ticketId: ticket_id,
            targetGatewayId: target_gateway_id,
            transport,
            targetSessionKey: target_session_key,
            ok: false,
            error: errorMessage,
          });
          if (kind === 'nudge') {
            dispatchEvents.upsertPendingForward({
              eventKind: 'dispatch_nudge',
              eventId: dispatch_id,
              ticketId: ticket_id,
              channel: 'telegram',
              targetGatewayId: target_gateway_id,
              transport,
              targetSessionKey: target_session_key,
              dedupeKey: dedupe_key || null,
              lastError: errorMessage,
              metadata: {
                reason: reason || null,
                nudge_source: nudge_source || null,
              },
            });
          }
          const retryState = dispatchEvents.markDispatchDeliveryFailed(dispatch_id);
          store.markAssignmentDeliveryFailedByDispatchEvent(dispatch_id, errorMessage);
          if (retryState?.next_dispatch_retry_at) {
            logger.warn('dispatch delivery degraded; backing off', {
              worker: 'dispatch',
              dispatch_id,
              ticket_id,
              target_session_key,
              target_gateway_id,
              transport,
              next_dispatch_retry_at: retryState.next_dispatch_retry_at,
              error: errorMessage,
            }, { rateLimitKey: `dispatch-degraded:${dispatch_id}:${errorMessage}`, rateLimitMs: 60_000 });
          } else {
            logger.error('dispatch delivery failed without ack', {
              worker: 'dispatch',
              dispatch_id,
              ticket_id,
              target_session_key,
              target_gateway_id,
              transport,
              error: errorMessage,
            }, { rateLimitKey: `dispatch-failed:${dispatch_id}:${errorMessage}`, rateLimitMs: 60_000 });
          }
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
        const { event_id, message, ticket_id, target_session_key, target_gateway_id, transport, dedupe_key, reason, type } = item;
        if (!event_id || !message) continue;
        const idempotencyKey = makeIdempotencyKey(`notify-${event_id}`);
        try {
          const result = await withTimeout(
            deliverChatToGateway({
              targetGatewayId: target_gateway_id,
              transport,
              targetSessionKey: target_session_key,
              message,
              idempotencyKey,
            }),
            deliveryTimeoutMs,
            'notify chat.send',
          );
          dispatchEvents.recordDeliveryAttempt({
            eventKind: 'notification',
            eventId: event_id,
            ticketId: ticket_id,
            targetGatewayId: target_gateway_id,
            transport,
            targetSessionKey: target_session_key,
            ok: true,
            result,
          });
          dispatchEvents.resolvePendingForward('notification', event_id, { channel: 'telegram', resolution: 'delivered' });
          await ackNotification(apiBaseUrl, event_id);
          logger.info('notification delivered and acked', {
            worker: 'notify',
            event_id,
            ticket_id,
            target_session_key,
            target_gateway_id,
            transport,
          });
        } catch (err) {
          dispatchEvents.recordDeliveryAttempt({
            eventKind: 'notification',
            eventId: event_id,
            ticketId: ticket_id,
            targetGatewayId: target_gateway_id,
            transport,
            targetSessionKey: target_session_key,
            ok: false,
            error: err?.message || String(err),
          });
          dispatchEvents.upsertPendingForward({
            eventKind: 'notification',
            eventId: event_id,
            ticketId: ticket_id,
            channel: 'telegram',
            targetGatewayId: target_gateway_id,
            transport,
            targetSessionKey: target_session_key,
            dedupeKey: dedupe_key || null,
            lastError: err?.message || String(err),
            metadata: {
              reason: reason || null,
              type: type || null,
            },
          });
          logger.error('notification delivery failed without ack', {
            worker: 'notify',
            event_id,
            ticket_id,
            target_session_key,
            target_gateway_id,
            transport,
            error: err,
          }, { rateLimitKey: `notify-failed:${event_id}:${err?.message || err}`, rateLimitMs: 60_000 });
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
        const targetSessionKey = getAuditSessionKeyForTicket(ticket_id);
        const idempotencyKey = makeIdempotencyKey(`audit-${audit_id}`);
        try {
          const result = await withTimeout(
            deliverChatToGateway({
              targetGatewayId: 'mac-main',
              transport: 'local_cli',
              targetSessionKey,
              message,
              idempotencyKey,
            }),
            deliveryTimeoutMs,
            'audit chat.send',
          );
          dispatchEvents.recordDeliveryAttempt({
            eventKind: 'audit',
            eventId: audit_id,
            ticketId: ticket_id,
            targetGatewayId: 'mac-main',
            transport: 'local_cli',
            targetSessionKey,
            ok: true,
            result,
          });
          await ackAudit(apiBaseUrl, audit_id);
          logger.info('audit delivered and acked', {
            worker: 'audit',
            audit_id,
            ticket_id,
            target_session_key: targetSessionKey,
          });
        } catch (err) {
          dispatchEvents.recordDeliveryAttempt({
            eventKind: 'audit',
            eventId: audit_id,
            ticketId: ticket_id,
            targetGatewayId: 'mac-main',
            transport: 'local_cli',
            targetSessionKey,
            ok: false,
            error: err?.message || String(err),
          });
          logger.error('audit delivery failed without ack', {
            worker: 'audit',
            audit_id,
            ticket_id,
            target_session_key: targetSessionKey,
            error: err,
          }, { rateLimitKey: `audit-failed:${audit_id}:${err?.message || err}`, rateLimitMs: 60_000 });
        }
      }
    },
  });

  dispatchWorker.start();
  notifyWorker.start();
  auditWorker.start();

  logger.info('started direct-drive pollers', {
    api_base_url: apiBaseUrl,
    dispatch_interval_ms: dispatchIntervalMs,
    notify_interval_ms: notifyIntervalMs,
    audit_interval_ms: auditIntervalMs,
    delivery_timeout_ms: deliveryTimeoutMs,
    notify_session: NOTIFY_MAIN_SESSION,
  });

  return {
    stop: () => {
      dispatchWorker.stop();
      notifyWorker.stop();
      auditWorker.stop();
    },
  };
}
