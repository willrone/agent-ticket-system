function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeText(item)).filter(Boolean))];
}

function parsePreferredRole(preferredRoles, roleType) {
  if (!preferredRoles || typeof preferredRoles !== 'object') return null;
  const value = normalizeText(preferredRoles[roleType]);
  if (!value || value === 'auto') return null;
  return value;
}

function hasAllCapabilities(agent, requiredCapabilities) {
  const agentCapabilities = new Set(Array.isArray(agent?.capabilities) ? agent.capabilities : []);
  return requiredCapabilities.every((capability) => agentCapabilities.has(capability));
}

function scoreAgent(agent, { roleType, requiredCapabilities, preferredAgents, project }) {
  let score = 0;
  const roleTypes = new Set(Array.isArray(agent.role_types) ? agent.role_types : []);
  const capabilities = new Set(Array.isArray(agent.capabilities) ? agent.capabilities : []);

  if (roleTypes.has(roleType)) score += 50;
  for (const capability of requiredCapabilities) {
    if (capabilities.has(capability)) score += 10;
  }
  if (preferredAgents.includes(agent.agent_id)) score += 25;
  if (project && capabilities.has(`${project}.backend`)) score += 4;
  if (project && capabilities.has(`${project}.frontend`)) score += 3;
  if (project && capabilities.has(`${project}.ops`)) score += 3;
  if (agent.trust_level === 'trusted') score += 5;
  if (agent.health_status === 'healthy') score += 4;
  score -= Number(agent.current_load || 0) * 5;
  return score;
}

function pickAgent(agents, roleType, options = {}) {
  const requiredCapabilities = normalizeList(options.requiredCapabilities);
  const preferredAgents = normalizeList(options.preferredAgents);
  const excludedAgents = new Set(normalizeList(options.excludedAgents));
  const explicitAgent = parsePreferredRole(options.preferredRoles, roleType);

  const eligible = agents.filter((agent) => {
    if (!agent?.enabled) return false;
    if (excludedAgents.has(agent.agent_id)) return false;
    if (agent.health_status && !['healthy', 'active', 'unknown'].includes(agent.health_status)) return false;
    if (!Array.isArray(agent.role_types) || !agent.role_types.includes(roleType)) return false;
    return true;
  });

  if (explicitAgent) {
    const match = eligible.find((agent) => agent.agent_id === explicitAgent);
    if (match) {
      return {
        agent_id: match.agent_id,
        reason: `${roleType} explicitly requested as ${match.agent_id}`,
        confidence: hasAllCapabilities(match, requiredCapabilities) ? 'high' : 'medium',
      };
    }
    return {
      agent_id: null,
      reason: `${roleType} explicitly requested as ${explicitAgent}, but no eligible enabled agent matched`,
      confidence: 'none',
    };
  }

  const strict = eligible.filter((agent) => hasAllCapabilities(agent, requiredCapabilities));
  const pool = strict.length > 0 ? strict : eligible;
  if (pool.length === 0) {
    return {
      agent_id: null,
      reason: `no eligible ${roleType} agent found`,
      confidence: 'none',
    };
  }

  const sorted = [...pool].sort((a, b) => {
    const delta = scoreAgent(b, { roleType, requiredCapabilities, preferredAgents, project: options.project })
      - scoreAgent(a, { roleType, requiredCapabilities, preferredAgents, project: options.project });
    if (delta !== 0) return delta;
    return a.agent_id.localeCompare(b.agent_id);
  });
  const selected = sorted[0];
  const capabilityMode = strict.length > 0 ? 'matched required capabilities' : 'no strict capability match; fell back to role eligibility';
  return {
    agent_id: selected.agent_id,
    reason: `${selected.agent_id} selected for ${roleType}: ${capabilityMode}`,
    confidence: strict.length > 0 ? 'high' : 'low',
  };
}

function buildFallbackAgents(agents, selectedIds, excludedAgents) {
  const selected = new Set(selectedIds.filter(Boolean));
  const excluded = new Set(normalizeList(excludedAgents));
  return agents
    .filter((agent) => agent.enabled && !selected.has(agent.agent_id) && !excluded.has(agent.agent_id))
    .map((agent) => agent.agent_id)
    .sort();
}

export function buildRoutingPreview(input = {}, registry = {}) {
  const agents = Array.isArray(registry.agents) ? registry.agents : [];
  const requiredCapabilities = normalizeList(input.required_capabilities || input.requiredCapabilities);
  const preferredAgents = normalizeList(input.preferred_agents || input.preferredAgents);
  const excludedAgents = normalizeList(input.excluded_agents || input.excludedAgents);
  const preferredRoles = input.preferred_roles || input.preferredRoles || {};
  const project = normalizeText(input.project);

  const executor = pickAgent(agents, 'executor', {
    requiredCapabilities,
    preferredAgents,
    excludedAgents,
    preferredRoles,
    project,
  });
  const reviewer = pickAgent(agents, 'reviewer', {
    requiredCapabilities: ['review.quality-gate'],
    preferredAgents,
    excludedAgents: [...excludedAgents, executor.agent_id].filter(Boolean),
    preferredRoles,
    project,
  });
  const auditor = pickAgent(agents, 'auditor', {
    requiredCapabilities: ['audit.governance'],
    preferredAgents,
    excludedAgents,
    preferredRoles,
    project,
  });

  const selectedIds = [executor.agent_id, reviewer.agent_id, auditor.agent_id].filter(Boolean);
  const reasonParts = [executor.reason, reviewer.reason, auditor.reason].filter(Boolean);

  return {
    task_type: normalizeText(input.task_type || input.taskType) || 'software_task',
    project: project || null,
    required_capabilities: requiredCapabilities,
    executor: executor.agent_id,
    reviewer: reviewer.agent_id,
    auditor: auditor.agent_id,
    role_decisions: { executor, reviewer, auditor },
    fallback_agents: buildFallbackAgents(agents, selectedIds, excludedAgents),
    reason: reasonParts.join('; '),
    confidence: selectedIds.length === 3 && [executor, reviewer, auditor].every((item) => item.confidence !== 'none') ? 'ok' : 'partial',
    shadow_mode: true,
  };
}
