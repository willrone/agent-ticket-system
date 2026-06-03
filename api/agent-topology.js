const MAIN_GATEWAY_ID = 'mac-main';
const REMOTE_GATEWAY_ID = 'pc-stock';

const DEFAULT_GATEWAYS = {};


const DEFAULT_AGENT_GATEWAY_MAP = {};

const DEFAULT_AGENT_DIRECTORY = {
  example_agent: {
    id: 'example_agent',
    display_name: 'Example Agent',
    emoji: '🤖',
    role_type: 'support',
    ownership_layer: 'support',
    primary_platform: 'example-platform',
    session_base: 'agent:example',
    responsibility_summary: '示例 agent。生产环境请通过 TICKET_AGENT_DIRECTORY_JSON 注入实际配置。',
    responsibilities: ['support'],
    collaborates_with: [],
  },
};

const DEFAULT_PLATFORM_DIRECTORY = {
  'example-platform': {
    id: 'example-platform',
    display_name: 'Example Platform',
    summary: '示例平台。生产环境请通过 TICKET_PLATFORM_DIRECTORY_JSON 注入实际配置。',
  },
};

const DEFAULT_RESPONSIBILITY_LAYERS = [
  {
    key: 'platform_owner',
    label: '平台责任',
    summary: '谁对平台方向、责任边界和组织归属负责。',
  },
  {
    key: 'triage',
    label: '创建 / 分诊责任',
    summary: '谁接需求入口、澄清范围、把任务路由到正确执行链。',
  },
  {
    key: 'development',
    label: '开发责任',
    summary: '谁真正实现功能、修复问题并完成最小回归。',
  },
  {
    key: 'review',
    label: '审核责任',
    summary: '谁对交付结果做验收、批准或打回。',
  },
];

function normalizeAgent(agent) {
  return String(agent || '').trim().toLowerCase();
}

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

function buildMergedGateways() {
  const gatewayOverrides = parseJsonEnv('TICKET_GATEWAY_REGISTRY_JSON', {});
  return Object.fromEntries(
    Object.entries({ ...DEFAULT_GATEWAYS, ...gatewayOverrides }).map(([gatewayId, gateway]) => [
      gatewayId,
      {
        id: gatewayId,
        ...gateway,
      },
    ])
  );
}

function buildAgentGatewayMap() {
  const agentOverrides = parseJsonEnv('TICKET_AGENT_GATEWAY_OVERRIDES_JSON', {});
  const agentGatewayMap = { ...DEFAULT_AGENT_GATEWAY_MAP };
  for (const [agent, gatewayId] of Object.entries(agentOverrides)) {
    const normalized = normalizeAgent(agent);
    if (!normalized) continue;
    agentGatewayMap[normalized] = String(gatewayId || '').trim() || MAIN_GATEWAY_ID;
  }
  return agentGatewayMap;
}

function buildAgentDirectory(agentGatewayMap) {
  const directoryOverrides = parseJsonEnv('TICKET_AGENT_DIRECTORY_JSON', {});
  const merged = { ...DEFAULT_AGENT_DIRECTORY, ...directoryOverrides };

  return Object.fromEntries(
    Object.entries(merged).map(([agentId, item]) => {
      const normalized = normalizeAgent(agentId);
      return [normalized, {
        id: normalized,
        display_name: item.display_name || normalized,
        emoji: item.emoji || '🤖',
        role_type: item.role_type || 'support',
        ownership_layer: item.ownership_layer || 'support',
        primary_platform: item.primary_platform || null,
        gateway_id: agentGatewayMap[normalized] || MAIN_GATEWAY_ID,
        host_gateway_id: agentGatewayMap[normalized] || MAIN_GATEWAY_ID,
        session_base: item.session_base || `agent:${normalized}`,
        responsibility_summary: item.responsibility_summary || '',
        responsibilities: Array.isArray(item.responsibilities) ? item.responsibilities : [],
        collaborates_with: Array.isArray(item.collaborates_with) ? item.collaborates_with.map(normalizeAgent).filter(Boolean) : [],
      }];
    })
  );
}

function buildPlatformDirectory() {
  const platformOverrides = parseJsonEnv('TICKET_PLATFORM_DIRECTORY_JSON', {});
  return Object.fromEntries(
    Object.entries({ ...DEFAULT_PLATFORM_DIRECTORY, ...platformOverrides }).map(([platformId, platform]) => [
      platformId,
      {
        id: platformId,
        ...platform,
      },
    ])
  );
}

function buildResponsibilityMap(platforms) {
  return DEFAULT_RESPONSIBILITY_LAYERS.map((layer) => ({
    ...layer,
    assignments: Object.values(platforms).map((platform) => {
      const actorId = layer.key === 'platform_owner'
        ? platform.owner_agent_id
        : layer.key === 'triage'
          ? platform.triage_owner_agent_id
          : layer.key === 'development'
            ? platform.development_agent_ids?.join(', ')
            : platform.review_owner_agent_id;
      return {
        platform_id: platform.id,
        platform_name: platform.display_name,
        actor_id: actorId || '未定义',
      };
    }),
  }));
}

function buildTopologyEdges(agentDirectory, platforms) {
  const edges = [];

  for (const agent of Object.values(agentDirectory)) {
    if (agent.gateway_id) {
      edges.push({
        type: 'agent_to_gateway',
        source: agent.id,
        target: agent.gateway_id,
      });
    }
    if (agent.primary_platform) {
      edges.push({
        type: 'agent_to_platform',
        source: agent.id,
        target: agent.primary_platform,
      });
    }
    for (const peer of agent.collaborates_with || []) {
      edges.push({
        type: 'collaboration',
        source: agent.id,
        target: peer,
      });
    }
  }

  for (const platform of Object.values(platforms)) {
    if (platform.delivery_gateway_id) {
      edges.push({
        type: 'platform_to_gateway',
        source: platform.id,
        target: platform.delivery_gateway_id,
      });
    }
  }

  return edges;
}

export function getAgentTopologyRegistry() {
  const gateways = buildMergedGateways();
  const agent_gateway_map = buildAgentGatewayMap();
  const agent_directory = buildAgentDirectory(agent_gateway_map);
  const platforms = buildPlatformDirectory();
  const responsibility_layers = buildResponsibilityMap(platforms);
  const topology_edges = buildTopologyEdges(agent_directory, platforms);

  return {
    main_gateway_id: MAIN_GATEWAY_ID,
    gateways,
    agent_gateway_map,
    agent_directory,
    platforms,
    responsibility_layers,
    topology_edges,
    summary: {
      total_gateways: Object.keys(gateways).length,
      total_agents: Object.keys(agent_directory).length,
      total_platforms: Object.keys(platforms).length,
      total_responsibility_layers: responsibility_layers.length,
    },
  };
}

export function resolveGatewayIdForAgent(agent) {
  const registry = getAgentTopologyRegistry();
  const normalized = normalizeAgent(agent);
  return registry.agent_gateway_map[normalized] || registry.main_gateway_id;
}

export function getGatewayById(gatewayId) {
  const registry = getAgentTopologyRegistry();
  return registry.gateways[gatewayId] || null;
}

export function getGatewayForAgent(agent) {
  const gatewayId = resolveGatewayIdForAgent(agent);
  return getGatewayById(gatewayId);
}

export function getSshDestination(gateway) {
  if (!gateway) return null;
  if (gateway.ssh_destination) return gateway.ssh_destination;
  if (gateway.ssh_user && gateway.ssh_host) return `${gateway.ssh_user}@${gateway.ssh_host}`;
  if (gateway.ssh_host) return gateway.ssh_host;
  return null;
}

export { MAIN_GATEWAY_ID, REMOTE_GATEWAY_ID };
