import { getAgentTopologyRegistry, getGatewayById, MAIN_GATEWAY_ID } from './agent-topology.js';
import {
  getParticipantRegistryEntry,
  listParticipantRegistryEntries,
  syncParticipantRegistryFromTopology,
} from './store.js';

function cleanText(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

const HUMAN_PRINCIPAL_ALIASES = new Set(['ronghui', '荣晖', 'example-human-operator']);
const NOTIFY_MAIN_SESSION = 'agent:main:telegram:direct:8290057699';

function isHumanPrincipal(value) {
  if (!value || typeof value !== 'string') return false;
  const text = String(value).trim();
  const normalized = text.toLowerCase();
  return HUMAN_PRINCIPAL_ALIASES.has(normalized) || HUMAN_PRINCIPAL_ALIASES.has(text);
}

function getSessionBaseForParticipant(participant = {}) {
  if (isHumanPrincipal(participant.participant_id) || isHumanPrincipal(participant.display_name)) {
    return 'agent:main';
  }
  return cleanText(participant.session_base)
    || cleanText(participant.binding?.session_base)
    || (participant.participant_id ? `agent:${normalizeId(participant.participant_id)}` : 'agent:main');
}

function buildSessionKey({ participant, sessionKind = 'main', ticketId = null } = {}) {
  if (!participant) return null;
  if (isHumanPrincipal(participant.participant_id) || isHumanPrincipal(participant.display_name)) {
    return NOTIFY_MAIN_SESSION;
  }
  const base = getSessionBaseForParticipant(participant);
  if (sessionKind === 'ticket') {
    const normalizedTicketId = Number.parseInt(String(ticketId ?? ''), 10);
    if (Number.isFinite(normalizedTicketId) && normalizedTicketId > 0) {
      return `${base}:ticket:${normalizedTicketId}`;
    }
  }
  return `${base}:main`;
}

function getPlatformRoleAssignments(platform = {}) {
  return {
    platform_owner: cleanText(platform.owner_agent_id),
    triage_owner: cleanText(platform.triage_owner_agent_id),
    review_owner: cleanText(platform.review_owner_agent_id),
    development: unique(Array.isArray(platform.development_agent_ids) ? platform.development_agent_ids.map(normalizeId) : []),
    audit: unique(Array.isArray(platform.audit_agent_ids) ? platform.audit_agent_ids.map(normalizeId) : []),
  };
}

function resolveParticipantRoleSet(participantId, registry) {
  const normalizedId = normalizeId(participantId);
  const roles = new Set();
  for (const platform of Object.values(registry.platforms || {})) {
    const assignments = getPlatformRoleAssignments(platform);
    if (assignments.platform_owner === normalizedId) roles.add('platform_owner');
    if (assignments.triage_owner === normalizedId) roles.add('triage_owner');
    if (assignments.review_owner === normalizedId) roles.add('review_owner');
    if (assignments.development.includes(normalizedId)) roles.add('development');
    if (assignments.audit.includes(normalizedId)) roles.add('audit');
  }
  return [...roles].sort();
}

function inferParticipantCapabilities(participant = {}, platformRoles = []) {
  const caps = new Set();
  const responsibilities = Array.isArray(participant.responsibilities) ? participant.responsibilities : [];
  for (const item of [...responsibilities, ...platformRoles]) {
    const key = normalizeId(item);
    if (!key) continue;
    caps.add(key);
    caps.add(`role:${key}`);
  }
  if (participant.primary_platform) {
    caps.add(`platform:${participant.primary_platform}`);
  }
  if (participant.role_type) {
    caps.add(`participant_type:${participant.role_type}`);
  }
  return [...caps].sort();
}

function seedPersistentRegistry(registry) {
  const topologyParticipants = Object.values(registry.agent_directory || {}).map((participant) => {
    const platform_roles = resolveParticipantRoleSet(participant.id, registry);
    return {
      participant_id: normalizeId(participant.id),
      display_name: participant.display_name,
      emoji: participant.emoji || null,
      participant_type: 'agent',
      role_type: participant.role_type || null,
      ownership_layer: participant.ownership_layer || null,
      primary_platform: participant.primary_platform || null,
      responsibilities: Array.isArray(participant.responsibilities) ? participant.responsibilities : [],
      collaborates_with: Array.isArray(participant.collaborates_with) ? participant.collaborates_with : [],
      responsibility_summary: participant.responsibility_summary || '',
      gateway_id: participant.gateway_id || null,
      session_base: participant.session_base || `agent:${normalizeId(participant.id)}`,
      source_kind: 'topology',
      capabilities: inferParticipantCapabilities(participant, platform_roles),
    };
  });
  syncParticipantRegistryFromTopology(topologyParticipants);
}

function buildParticipantRecord(participantId, registry, persistedMap = new Map()) {
  const normalizedId = normalizeId(participantId);
  const rawId = cleanText(participantId) || normalizedId;
  const topologyParticipant = registry.agent_directory?.[normalizedId];
  const persisted = persistedMap.get(normalizedId) || null;
  if (!topologyParticipant && !persisted && !isHumanPrincipal(rawId)) return null;

  const humanPrincipal = !topologyParticipant && !persisted && isHumanPrincipal(rawId);
  const base = humanPrincipal ? {
    participant_id: rawId,
    id: normalizedId || rawId,
    display_name: rawId,
    participant_type: 'human',
    role_type: 'human_principal',
    ownership_layer: 'decision',
    primary_platform: null,
    responsibilities: ['decision'],
    collaborates_with: [],
    responsibility_summary: '人类主责/决策主体',
    gateway_id: MAIN_GATEWAY_ID,
    session_base: 'agent:main',
  } : (topologyParticipant || persisted);
  const gatewayId = persisted?.gateway_id || topologyParticipant?.gateway_id || base.gateway_id || null;
  const knownGateway = gatewayId ? getGatewayById(gatewayId) : null;
  const gateway = knownGateway || (gatewayId ? {
    id: gatewayId,
    label: gatewayId,
    transport: null,
    host_label: null,
    host_type: null,
    role: null,
  } : null);
  const persistedResponsibilities = Array.isArray(persisted?.responsibilities) ? persisted.responsibilities : [];
  const platform_roles = unique([
    ...resolveParticipantRoleSet(normalizedId, registry),
    ...persistedResponsibilities.filter((item) => ['platform_owner', 'triage_owner', 'review_owner', 'development', 'audit'].includes(item)),
  ]).sort();
  const capabilities = Array.isArray(persisted?.capabilities) && persisted.capabilities.length > 0
    ? persisted.capabilities
    : inferParticipantCapabilities(base, platform_roles);

  return {
    participant_id: base.participant_id || base.id || normalizedId,
    display_name: persisted?.display_name || topologyParticipant?.display_name || base.display_name || normalizedId,
    emoji: persisted?.emoji ?? topologyParticipant?.emoji ?? base.emoji ?? null,
    participant_type: persisted?.participant_type || topologyParticipant?.participant_type || base.participant_type || 'agent',
    role_type: persisted?.role_type || topologyParticipant?.role_type || base.role_type || null,
    ownership_layer: persisted?.ownership_layer || topologyParticipant?.ownership_layer || base.ownership_layer || null,
    primary_platform: persisted?.primary_platform || topologyParticipant?.primary_platform || base.primary_platform || null,
    responsibilities: Array.isArray(persisted?.responsibilities)
      ? persisted.responsibilities
      : (Array.isArray(topologyParticipant?.responsibilities) ? topologyParticipant.responsibilities : (Array.isArray(base.responsibilities) ? base.responsibilities : [])),
    platform_roles,
    capabilities,
    status: persisted?.status || {
      availability_status: 'active',
      eligibility_status: 'eligible',
      accepts_assignment_types: [],
      status_reason: null,
      effective_from: null,
      metadata: {},
      updated_at: null,
    },
    gateway: gateway ? {
      id: gateway.id,
      label: gateway.label || gateway.id,
      transport: gateway.transport || null,
      host_label: gateway.host_label || null,
      host_type: gateway.host_type || null,
      role: gateway.role || null,
    } : null,
    collaborates_with: Array.isArray(persisted?.collaborates_with)
      ? persisted.collaborates_with
      : (Array.isArray(topologyParticipant?.collaborates_with) ? topologyParticipant.collaborates_with : []),
    responsibility_summary: persisted?.responsibility_summary || topologyParticipant?.responsibility_summary || '',
    source_kind: persisted?.source_kind || 'topology',
    persisted_at: persisted?.updated_at || null,
    session_base: persisted?.session_base || topologyParticipant?.session_base || `agent:${normalizedId}`,
    binding: {
      gateway_id: gateway?.id || gatewayId || MAIN_GATEWAY_ID,
      transport: gateway?.transport || null,
      session_base: persisted?.session_base || topologyParticipant?.session_base || `agent:${normalizedId}`,
      main_session_key: buildSessionKey({ participant: { participant_id: normalizedId, display_name: persisted?.display_name || topologyParticipant?.display_name || normalizedId, session_base: persisted?.session_base || topologyParticipant?.session_base || `agent:${normalizedId}` }, sessionKind: 'main' }),
    },
  };
}

function getPersistedParticipantMap() {
  const rows = listParticipantRegistryEntries();
  return new Map(rows.map((item) => [normalizeId(item.participant_id), item]));
}

export function buildParticipantRegistrySnapshot() {
  const registry = getAgentTopologyRegistry();
  seedPersistentRegistry(registry);
  const persistedMap = getPersistedParticipantMap();

  const participantIds = unique([
    ...Object.keys(registry.agent_directory || {}),
    ...[...persistedMap.keys()],
  ]).sort();

  const participants = participantIds
    .map((participantId) => buildParticipantRecord(participantId, registry, persistedMap))
    .filter(Boolean);

  const platforms = Object.values(registry.platforms || {}).map((platform) => ({
    platform_id: platform.id,
    display_name: platform.display_name || platform.id,
    summary: platform.summary || '',
    owner_agent_id: cleanText(platform.owner_agent_id),
    triage_owner_agent_id: cleanText(platform.triage_owner_agent_id),
    review_owner_agent_id: cleanText(platform.review_owner_agent_id),
    development_agent_ids: Array.isArray(platform.development_agent_ids) ? platform.development_agent_ids.map(normalizeId) : [],
    audit_agent_ids: Array.isArray(platform.audit_agent_ids) ? platform.audit_agent_ids.map(normalizeId) : [],
    delivery_gateway_id: cleanText(platform.delivery_gateway_id),
  }));

  const statusSummary = participants.reduce((acc, item) => {
    const availability = item.status?.availability_status || 'active';
    acc[availability] = (acc[availability] || 0) + 1;
    return acc;
  }, {});

  return {
    kind: 'agent.participant_registry',
    version: '2026-03-20.registry.v2',
    generated_at: new Date().toISOString(),
    main_gateway_id: registry.main_gateway_id,
    participants,
    platforms,
    summary: {
      total_participants: participants.length,
      total_platforms: platforms.length,
      total_gateways: Object.keys(registry.gateways || {}).length,
      active_participants: statusSummary.active || 0,
      paused_participants: statusSummary.paused || 0,
      unavailable_participants: statusSummary.unavailable || 0,
    },
    routing_roles: [
      { key: 'platform_owner', description: '平台 owner / 需求归属负责人。' },
      { key: 'triage_owner', description: '创建 / 分诊责任人。' },
      { key: 'review_owner', description: '验收责任人。' },
      { key: 'development', description: '默认开发执行链。' },
      { key: 'audit', description: '审计 / 升级责任链。' },
    ],
  };
}

export function getParticipantById(participantId) {
  const registry = getAgentTopologyRegistry();
  seedPersistentRegistry(registry);
  const persisted = getParticipantRegistryEntry(participantId);
  return buildParticipantRecord(participantId, registry, new Map(persisted ? [[normalizeId(participantId), persisted]] : []));
}

export function resolveParticipantRoute(input = {}) {
  const registry = getAgentTopologyRegistry();
  seedPersistentRegistry(registry);
  const persistedMap = getPersistedParticipantMap();
  const participantId = normalizeId(input.participant_id);
  const roleKey = cleanText(input.role_key);
  const platformId = cleanText(input.platform_id);
  const reason = cleanText(input.reason);
  const intent = cleanText(input.intent) || 'dispatch';
  const capability = cleanText(input.capability);
  const sessionKind = cleanText(input.session_kind) || (intent === 'notify' ? 'main' : 'ticket');
  const ticketId = Number.parseInt(String(input.ticket_id ?? ''), 10);
  const platform = platformId ? registry.platforms?.[platformId] || null : null;

  let resolvedParticipantId = participantId || null;
  let resolutionSource = participantId ? 'participant_id' : null;
  let roleAssignments = null;

  if (!resolvedParticipantId && platform && roleKey) {
    roleAssignments = getPlatformRoleAssignments(platform);
    if (roleKey === 'development') {
      resolvedParticipantId = roleAssignments.development[0] || null;
      resolutionSource = 'platform.development_agent_ids[0]';
    } else if (roleKey === 'audit') {
      resolvedParticipantId = roleAssignments.audit[0] || null;
      resolutionSource = 'platform.audit_agent_ids[0]';
    } else {
      resolvedParticipantId = roleAssignments[roleKey] || null;
      resolutionSource = `platform.${roleKey}`;
    }
  }

  const participant = resolvedParticipantId ? buildParticipantRecord(resolvedParticipantId, registry, persistedMap) : null;
  const gateway = participant?.gateway || null;
  const targetSessionKey = participant
    ? buildSessionKey({ participant, sessionKind, ticketId: Number.isFinite(ticketId) ? ticketId : null })
    : null;
  const capabilitySatisfied = capability
    ? Boolean(participant?.capabilities?.includes(capability))
    : null;

  return {
    kind: 'agent.participant_route',
    version: '2026-03-20.registry.v2',
    requested: {
      participant_id: participantId || null,
      role_key: roleKey || null,
      platform_id: platformId || null,
      reason: reason || null,
      intent,
      capability: capability || null,
      session_kind: sessionKind,
      ticket_id: Number.isFinite(ticketId) ? ticketId : null,
    },
    resolved: participant ? {
      participant_id: participant.participant_id,
      display_name: participant.display_name,
      participant_type: participant.participant_type,
      role_type: participant.role_type,
      ownership_layer: participant.ownership_layer,
      primary_platform: participant.primary_platform,
      platform_roles: participant.platform_roles,
      capabilities: participant.capabilities,
      status: participant.status,
      source_kind: participant.source_kind,
      binding: participant.binding,
    } : null,
    gateway,
    route_target: participant ? {
      gateway_id: gateway?.id || participant.binding?.gateway_id || MAIN_GATEWAY_ID,
      transport: gateway?.transport || participant.binding?.transport || null,
      participant_id: participant.participant_id,
      session_kind: sessionKind,
      target_session_key: targetSessionKey,
    } : null,
    explain: {
      platform_found: Boolean(platform),
      role_assignments: roleAssignments,
      resolution_source: resolutionSource,
      capability_required: capability || null,
      capability_satisfied: capabilitySatisfied,
      session_base: participant?.binding?.session_base || null,
      intent,
      reason: participant ? 'ok' : 'PARTICIPANT_ROUTE_NOT_RESOLVED',
    },
  };
}
