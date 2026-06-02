import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

export const RESOURCE_DEFINITIONS = [
  {
    name: 'version',
    uri: 'ticket-platform://version',
    title: 'Ticket Platform Version',
    description: 'Runtime version contract from GET /api/version.',
    method: 'GET',
    path: '/api/version',
    includeAssignmentToken: false,
  },
  {
    name: 'workflow_schema',
    uri: 'ticket-platform://workflow/schema',
    title: 'Ticket Platform Workflow Schema',
    description: 'Agent-facing workflow schema from GET /api/v1/agent/workflow/schema.',
    method: 'GET',
    path: '/api/v1/agent/workflow/schema',
  },
  {
    name: 'runtime_context',
    uriTemplate: 'ticket-platform://runtime/context/{assignment_id}',
    title: 'Ticket Platform Runtime Context',
    description: 'Assignment-scoped runtime context from GET /api/v1/agent/runtime/context.',
    method: 'GET',
    path: '/api/v1/agent/runtime/context',
    queryFromVariables: ({ assignment_id }) => ({ assignment_id }),
  },
  {
    name: 'assignment',
    uriTemplate: 'ticket-platform://assignments/{assignment_id}',
    title: 'Ticket Platform Assignment',
    description: 'Assignment contract from GET /api/v1/agent/assignments/:assignment_id.',
    method: 'GET',
    pathFromVariables: ({ assignment_id }) => `/api/v1/agent/assignments/${encodeURIComponent(assignment_id)}`,
  },
  {
    name: 'assignment_comments',
    uriTemplate: 'ticket-platform://assignments/{assignment_id}/comments',
    title: 'Ticket Platform Assignment Comments',
    description: 'Assignment comment stream from GET /api/v1/agent/assignments/:assignment_id/comments.',
    method: 'GET',
    pathFromVariables: ({ assignment_id }) => `/api/v1/agent/assignments/${encodeURIComponent(assignment_id)}/comments`,
  },
  {
    name: 'assignment_dependencies',
    uriTemplate: 'ticket-platform://assignments/{assignment_id}/dependencies',
    title: 'Ticket Platform Assignment Dependencies',
    description: 'Dependency snapshot from GET /api/v1/agent/assignments/:assignment_id/dependencies.',
    method: 'GET',
    pathFromVariables: ({ assignment_id }) => `/api/v1/agent/assignments/${encodeURIComponent(assignment_id)}/dependencies`,
  },
  {
    name: 'skills_current',
    uri: 'ticket-platform://skills/current',
    title: 'Ticket Platform Current Skill Bundle',
    description: 'Hosted skill bundle from GET /api/v1/agent/skills/current.',
    method: 'GET',
    path: '/api/v1/agent/skills/current',
  },
  {
    name: 'playbook_ticket_handler',
    uri: 'ticket-platform://playbooks/ticket-handler',
    title: 'Ticket Platform Ticket Handler Playbook',
    description: 'Hosted ticket-handler playbook from GET /api/v1/agent/playbooks/ticket-handler.',
    method: 'GET',
    path: '/api/v1/agent/playbooks/ticket-handler',
  },
  {
    name: 'participants',
    uri: 'ticket-platform://participants',
    title: 'Ticket Platform Participants',
    description: 'Participant registry snapshot from GET /api/v1/agent/participants.',
    method: 'GET',
    path: '/api/v1/agent/participants',
  },
];

function variableValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeVariables(variables = {}) {
  return Object.fromEntries(
    Object.entries(variables).map(([key, value]) => [key, String(variableValue(value) || '').trim()])
  );
}

export function jsonResourceContents(uri, payload) {
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: 'application/json',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export async function readTicketPlatformResource(definition, client, uri, variables = {}) {
  const normalizedVariables = normalizeVariables(variables);
  const path = definition.pathFromVariables
    ? definition.pathFromVariables(normalizedVariables)
    : definition.path;
  const query = definition.queryFromVariables
    ? definition.queryFromVariables(normalizedVariables)
    : undefined;
  const payload = await client.request(definition.method || 'GET', path, {
    query,
    includeAssignmentToken: definition.includeAssignmentToken !== false,
  });
  return jsonResourceContents(uri, payload);
}

export function registerTicketPlatformResources(server, client) {
  RESOURCE_DEFINITIONS.forEach((definition) => {
    const config = {
      title: definition.title,
      description: definition.description,
      mimeType: 'application/json',
    };
    const read = (uri, variables = {}) => readTicketPlatformResource(definition, client, uri, variables);

    if (definition.uriTemplate) {
      server.registerResource(
        definition.name,
        new ResourceTemplate(definition.uriTemplate, { list: undefined }),
        config,
        read
      );
      return;
    }

    server.registerResource(definition.name, definition.uri, config, (uri) => read(uri));
  });
}
