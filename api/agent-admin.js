export const AGENT_ADMIN_API_PREFIX = '/api/v1/admin';
export const AGENT_ADMIN_API_LEGACY_PREFIX = '/api/admin';
export const AGENT_ADMIN_DEFAULT_CAPABILITIES = [
  'stock_tickets:read',
  'stock_tickets:create',
  'stock_tickets:comment',
  'stock_tickets:transition',
];

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeText(value, maxLength = 120) {
  const text = String(value || '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeCapabilities(input) {
  const list = Array.isArray(input) ? input : AGENT_ADMIN_DEFAULT_CAPABILITIES;
  const normalized = [...new Set(list.map((item) => normalizeText(item, 120)).filter(Boolean))];
  return normalized.length > 0 ? normalized : [...AGENT_ADMIN_DEFAULT_CAPABILITIES];
}

function normalizeGrantEntry(entryKey, rawGrant) {
  const grant = rawGrant && typeof rawGrant === 'object' ? rawGrant : null;
  if (!grant) return null;

  const token = normalizeText(grant.token || grant.value || grant.secret, 512);
  const agentId = normalizeText(grant.agent_id || grant.agent || grant.subject, 120);
  if (!token || !agentId) return null;

  return {
    id: normalizeText(grant.id || entryKey, 120) || entryKey,
    label: normalizeText(grant.label || entryKey, 240) || entryKey,
    role: 'agent_admin',
    agent_id: agentId,
    token,
    capabilities: normalizeCapabilities(grant.capabilities),
  };
}

export function listAgentAdminGrants() {
  const rawRegistry = parseJsonEnv('TICKET_AGENT_ADMIN_TOKENS_JSON', {});
  const entries = Array.isArray(rawRegistry)
    ? rawRegistry.map((item, index) => [item?.id || `grant_${index + 1}`, item])
    : Object.entries(rawRegistry || {});

  return entries
    .map(([entryKey, rawGrant]) => normalizeGrantEntry(entryKey, rawGrant))
    .filter(Boolean);
}

export function getAgentAdminGrantByToken(token) {
  const normalizedToken = normalizeText(token, 512);
  if (!normalizedToken) return null;
  return listAgentAdminGrants().find((grant) => grant.token === normalizedToken) || null;
}

export function hasAgentAdminCapability(grant, capability) {
  const normalizedCapability = normalizeText(capability, 120);
  if (!normalizedCapability) return true;
  const capabilities = Array.isArray(grant?.capabilities) ? grant.capabilities : [];
  return capabilities.includes(normalizedCapability);
}

export function resolveAgentAdminToken(req) {
  const authHeader = String(req.get('authorization') || '').trim();
  const bearerToken = authHeader.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  return normalizeText(req.get('x-agent-admin-token') || bearerToken, 512) || '';
}

export function buildAgentAdminAuthContract() {
  return {
    scheme: 'agent_admin_token',
    preferred_transport: {
      type: 'header',
      name: 'Authorization',
      format: 'Bearer <agent-admin-token>',
    },
    alternative_transports: [
      {
        type: 'header',
        name: 'X-Agent-Admin-Token',
      },
    ],
    separation: 'agent-admin token 仅用于管理员管理接口；不要与 assignment token 混用。',
    env_config: 'TICKET_AGENT_ADMIN_TOKENS_JSON',
  };
}

export function buildAgentAdminErrorModel() {
  return {
    shape: {
      detail: 'string',
      request_id: 'string',
    },
    request_id_header: 'X-Request-Id',
    examples: [
      {
        status_code: 401,
        body: {
          detail: 'agent-admin token 无效或缺失',
          request_id: 'req_demo_admin_123',
        },
      },
    ],
  };
}
