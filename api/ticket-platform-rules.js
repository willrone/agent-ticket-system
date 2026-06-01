const TICKET_PLATFORM_ID = 'ticket-platform';
const TICKET_PLATFORM_EXECUTOR = 'beavy';
const STOCK_PLATFORM_ID = 'stock-platform';
const STOCK_PLATFORM_DEFAULT_TRIAGE_OWNER = 'cowder';

function cleanText(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text || null;
}

export function isTicketPlatform(value) {
  return cleanText(value) === TICKET_PLATFORM_ID;
}

export function getTicketPlatformExecutor() {
  return TICKET_PLATFORM_EXECUTOR;
}

export function resolveDefaultTriageOwner(platform, fallback = 'leoss') {
  if (cleanText(platform) === STOCK_PLATFORM_ID) return STOCK_PLATFORM_DEFAULT_TRIAGE_OWNER;
  return cleanText(fallback) || 'leoss';
}

export function resolveTicketPlatformAssignedAgent(platform, assignedAgent, { defaultToExecutor = false } = {}) {
  if (!isTicketPlatform(platform)) return cleanText(assignedAgent);
  const normalizedAgent = cleanText(assignedAgent);
  if (!normalizedAgent && defaultToExecutor) return TICKET_PLATFORM_EXECUTOR;
  return normalizedAgent;
}

export function validateTicketPlatformAssignedAgent(platform, assignedAgent, options = {}) {
  const normalizedPlatform = cleanText(platform);
  if (!isTicketPlatform(normalizedPlatform)) {
    return { ok: true };
  }

  const normalizedAgent = cleanText(assignedAgent);
  const allowEmpty = options.allowEmpty === true;
  if (!normalizedAgent) {
    if (allowEmpty) return { ok: true };
    return {
      ok: false,
      error: 'TICKET_PLATFORM_ASSIGNED_AGENT_REQUIRED',
      message: `platform=${TICKET_PLATFORM_ID} 时 assigned_agent 必须为 ${TICKET_PLATFORM_EXECUTOR}`,
      platform: TICKET_PLATFORM_ID,
      allowed_assigned_agents: [TICKET_PLATFORM_EXECUTOR],
    };
  }

  if (normalizedAgent !== TICKET_PLATFORM_EXECUTOR) {
    return {
      ok: false,
      error: 'TICKET_PLATFORM_ASSIGNED_AGENT_INVALID',
      message: `platform=${TICKET_PLATFORM_ID} 时 assigned_agent/target_agent 只能为 ${TICKET_PLATFORM_EXECUTOR}`,
      platform: TICKET_PLATFORM_ID,
      assigned_agent: normalizedAgent,
      allowed_assigned_agents: [TICKET_PLATFORM_EXECUTOR],
    };
  }

  return { ok: true };
}
