import { NOTIFY_MAIN_SESSION, getDispatchSessionKeyForTicket, isHumanPrincipal } from './agent-session-router.js';
import { getGatewayById, getAgentTopologyRegistry, MAIN_GATEWAY_ID } from './agent-topology.js';
import { resolveParticipantRoute } from './participant-registry.js';

const NOTIFICATION_DELIVERY_POLICY = {
  done: {
    session: 'reviewer_ticket',
    gateway: 'route_or_main',
  },
  review: {
    session: 'reviewer_ticket',
    gateway: 'route_or_main',
  },
  complete: {
    session: 'main',
    gateway: 'main',
  },
  failed: {
    session: 'main',
    gateway: 'main',
  },
  pending_decision: {
    session: 'main',
    gateway: 'main',
  },
  blocked: {
    session: 'main',
    gateway: 'main',
  },
};

function getNotificationDeliveryPolicy(status) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  return NOTIFICATION_DELIVERY_POLICY[normalizedStatus] || {
    session: 'main',
    gateway: 'main',
  };
}

function getGatewayIdForPrincipal(agent) {
  const normalized = String(agent || '').trim().toLowerCase();
  if (!normalized) return null;
  const registry = getAgentTopologyRegistry();
  return registry?.agent_gateway_map?.[normalized] || null;
}

function buildDeliveryMetadata({
  ticketId,
  targetAgent,
  targetSessionKey,
  targetGatewayId,
  deliveryIntent,
  route = null,
}) {
  const gateway = getGatewayById(targetGatewayId) || getGatewayById(MAIN_GATEWAY_ID) || {
    id: MAIN_GATEWAY_ID,
    transport: 'local_cli',
  };

  return {
    ticket_id: ticketId,
    delivery_intent: deliveryIntent,
    target_agent: targetAgent || null,
    target_session_key: targetSessionKey,
    target_gateway_id: gateway.id,
    transport: gateway.transport || 'local_cli',
    gateway_role: gateway.role || null,
    gateway_label: gateway.label || gateway.id,
    route_explain: route?.explain || null,
    route_target: route?.route_target || null,
  };
}

export function resolveDispatchDelivery({ agent, ticketId, kind, nudgeSource = null, platformId = null }) {
  const deliveryIntent = kind === 'workflow_mismatch' ? 'workflow_mismatch' : 'dispatch';
  const humanPrincipal = isHumanPrincipal(agent);
  const forceTicketSession = kind === 'nudge' && nudgeSource !== 'audit_result';
  const preferMainSession = kind === 'nudge' && nudgeSource === 'audit_result';
  const fallbackSessionKey = getDispatchSessionKeyForTicket(agent, ticketId);
  const route = resolveParticipantRoute({
    participant_id: agent,
    platform_id: platformId,
    reason: kind || 'dispatch',
    intent: deliveryIntent,
    session_kind: (humanPrincipal && !forceTicketSession) ? 'main' : 'ticket',
    ticket_id: ticketId,
  });
  const routedSessionKey = route?.route_target?.target_session_key || null;
  const targetSessionKey = forceTicketSession
    ? fallbackSessionKey
    : (preferMainSession
      ? NOTIFY_MAIN_SESSION
      : (humanPrincipal && routedSessionKey === NOTIFY_MAIN_SESSION
        ? fallbackSessionKey
        : (routedSessionKey || fallbackSessionKey)));
  const targetGatewayId = preferMainSession
    ? MAIN_GATEWAY_ID
    : (route?.route_target?.gateway_id || MAIN_GATEWAY_ID);

  return buildDeliveryMetadata({
    ticketId,
    targetAgent: preferMainSession
      ? null
      : (humanPrincipal && !forceTicketSession ? null : agent),
    targetSessionKey,
    targetGatewayId,
    deliveryIntent,
    route,
  });
}

export function resolveNotificationDelivery({ status, reviewOwner, ticketId, targetActor, platformId = null }) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const policy = getNotificationDeliveryPolicy(normalizedStatus);
  const principal = targetActor || reviewOwner || null;
  const humanPrincipal = isHumanPrincipal(principal);
  const shouldRouteReviewerTicket = policy.session === 'reviewer_ticket' && !humanPrincipal;
  const sessionKind = shouldRouteReviewerTicket ? 'ticket' : 'main';
  const routePrincipal = shouldRouteReviewerTicket ? principal : null;
  const route = shouldRouteReviewerTicket
    ? resolveParticipantRoute({
        participant_id: routePrincipal,
        platform_id: platformId,
        reason: `notify:${normalizedStatus || 'unknown'}`,
        intent: 'notify',
        session_kind: sessionKind,
        ticket_id: ticketId,
      })
    : null;

  return buildDeliveryMetadata({
    ticketId,
    targetAgent: shouldRouteReviewerTicket ? principal : null,
    targetSessionKey: shouldRouteReviewerTicket
      ? (route?.route_target?.target_session_key || NOTIFY_MAIN_SESSION)
      : NOTIFY_MAIN_SESSION,
    targetGatewayId: shouldRouteReviewerTicket && policy.gateway !== 'main'
      ? (route?.route_target?.gateway_id || getGatewayIdForPrincipal(principal) || MAIN_GATEWAY_ID)
      : MAIN_GATEWAY_ID,
    deliveryIntent: `notify:${normalizedStatus || 'unknown'}`,
    route,
  });
}
