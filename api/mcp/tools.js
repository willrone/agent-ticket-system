import { TicketPlatformHttpError } from './ticket-platform-client.js';
import { toolInputSchemas } from './schema.js';

function jsonText(payload) {
  return JSON.stringify(payload, null, 2);
}

function toStructuredContent(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
  return { data: payload };
}

export function toToolResult(payload) {
  return {
    structuredContent: toStructuredContent(payload),
    content: [
      {
        type: 'text',
        text: jsonText(payload),
      },
    ],
  };
}

export function toToolErrorResult(err) {
  const payload = err instanceof TicketPlatformHttpError
    ? err.toJSON()
    : {
        detail: err instanceof Error ? err.message : String(err),
        request_id: null,
        status: 0,
      };
  return {
    isError: true,
    structuredContent: payload,
    content: [
      {
        type: 'text',
        text: jsonText(payload),
      },
    ],
  };
}

function compactQuery(input, keys) {
  return Object.fromEntries(
    keys
      .map((key) => [key, input[key]])
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}

function requireAssignmentId(args, config = {}) {
  const assignmentId = String(args.assignment_id || config.assignmentId || '').trim();
  if (!assignmentId) {
    throw new Error('assignment_id is required unless TICKET_ASSIGNMENT_ID is configured');
  }
  return assignmentId;
}

function removeKeys(input, keys) {
  const output = { ...(input || {}) };
  keys.forEach((key) => {
    delete output[key];
  });
  return output;
}

function extractHttpData(body) {
  return body && typeof body === 'object' && 'data' in body ? body.data : body;
}

function extractAllowedReportTypes(skillBody) {
  const data = extractHttpData(skillBody) || {};
  const candidates = [
    data.manifest?.allowed_report_types,
    data.manifest?.constraints?.allowed_report_types,
    data.contract?.allowed_report_types,
    data.allowed_report_types,
  ];
  return candidates.find((value) => Array.isArray(value)) || [];
}

async function assertAllowedReportType(client, reportType) {
  const skillBody = await client.get('/api/v1/agent/skills/current');
  const allowed = extractAllowedReportTypes(skillBody);
  if (!allowed.includes(reportType)) {
    throw new Error(`report_type ${reportType} is not allowed by hosted skill manifest`);
  }
}

function extractTicketActions(contractBody) {
  const data = extractHttpData(contractBody) || {};
  const candidates = [
    data.ticket_actions,
    data.discoverability?.ticket_actions,
    data.agent_contract?.ticket_actions,
  ];
  const actionObjects = candidates.find((value) => Array.isArray(value)) || [];
  const supported = Array.isArray(data.agent_contract?.ticket_actions_supported)
    ? data.agent_contract.ticket_actions_supported.map((key) => ({ key }))
    : [];
  return [...actionObjects, ...supported];
}

async function discoverTicketAction(client, action, assignmentId) {
  const runtimeOrWorkflow = assignmentId
    ? await client.get('/api/v1/agent/runtime/context', { query: { assignment_id: assignmentId } })
    : await client.get('/api/v1/agent/workflow/schema');
  let actions = extractTicketActions(runtimeOrWorkflow);

  if (actions.length === 0 && assignmentId) {
    actions = extractTicketActions(await client.get('/api/v1/agent/workflow/schema'));
  }

  const discovered = actions.find((item) => item?.key === action || item?.action === action);
  if (!discovered) {
    throw new Error(`ticket action ${action} is not discoverable in runtime context or workflow schema`);
  }
  if (!discovered.endpoint) {
    throw new Error(`ticket action ${action} is discoverable but does not provide an HTTP endpoint`);
  }
  return discovered;
}

function buildActionPath(endpoint, ticketId) {
  return String(endpoint).replace(':id', encodeURIComponent(String(ticketId)));
}

export function createTicketPlatformToolDefinitions(client, config = {}) {
  return [
    {
      name: 'get_runtime_context',
      title: 'Get Runtime Context',
      description: 'Read assignment-scoped runtime context via GET /api/v1/agent/runtime/context.',
      inputSchema: toolInputSchemas.get_runtime_context,
      handler: async (args) => {
        const assignmentId = requireAssignmentId(args, config);
        return toToolResult(await client.get('/api/v1/agent/runtime/context', { query: { assignment_id: assignmentId } }));
      },
    },
    {
      name: 'get_assignment',
      title: 'Get Assignment',
      description: 'Read assignment contract via GET /api/v1/agent/assignments/:assignment_id.',
      inputSchema: toolInputSchemas.get_assignment,
      handler: async (args) => {
        const assignmentId = requireAssignmentId(args, config);
        return toToolResult(await client.get(`/api/v1/agent/assignments/${encodeURIComponent(assignmentId)}`));
      },
    },
    {
      name: 'read_comments',
      title: 'Read Comments',
      description: 'Read assignment comments via GET /api/v1/agent/assignments/:assignment_id/comments.',
      inputSchema: toolInputSchemas.read_comments,
      handler: async (args) => {
        const assignmentId = requireAssignmentId(args, config);
        const query = compactQuery(args, ['limit', 'cursor']);
        return toToolResult(await client.get(`/api/v1/agent/assignments/${encodeURIComponent(assignmentId)}/comments`, { query }));
      },
    },
    {
      name: 'read_dependencies',
      title: 'Read Dependencies',
      description: 'Read assignment dependencies via GET /api/v1/agent/assignments/:assignment_id/dependencies.',
      inputSchema: toolInputSchemas.read_dependencies,
      handler: async (args) => {
        const assignmentId = requireAssignmentId(args, config);
        return toToolResult(await client.get(`/api/v1/agent/assignments/${encodeURIComponent(assignmentId)}/dependencies`));
      },
    },
    {
      name: 'list_participants',
      title: 'List Participants',
      description: 'Read participant registry via GET /api/v1/agent/participants.',
      inputSchema: toolInputSchemas.list_participants,
      handler: async (args) => toToolResult(await client.get('/api/v1/agent/participants', {
        query: compactQuery(args, ['platform_id', 'participant_id', 'role_key']),
      })),
    },
    {
      name: 'resolve_route',
      title: 'Resolve Route',
      description: 'Resolve participant route via GET /api/v1/agent/routing/resolve.',
      inputSchema: toolInputSchemas.resolve_route,
      handler: async (args) => toToolResult(await client.get('/api/v1/agent/routing/resolve', {
        query: compactQuery(args, ['participant_id', 'platform_id', 'role_key', 'reason', 'intent', 'capability', 'session_kind', 'ticket_id']),
      })),
    },
    {
      name: 'send_heartbeat',
      title: 'Send Heartbeat',
      description: 'Send assignment heartbeat via POST /api/v1/agent/assignments/:assignment_id/heartbeat.',
      inputSchema: toolInputSchemas.send_heartbeat,
      handler: async (args) => {
        const assignmentId = requireAssignmentId(args, config);
        const body = removeKeys(args, ['assignment_id']);
        return toToolResult(await client.post(`/api/v1/agent/assignments/${encodeURIComponent(assignmentId)}/heartbeat`, body));
      },
    },
    {
      name: 'submit_report',
      title: 'Submit Report',
      description: 'Submit structured assignment report via POST /api/v1/agent/assignments/:assignment_id/reports.',
      inputSchema: toolInputSchemas.submit_report,
      handler: async (args) => {
        const assignmentId = requireAssignmentId(args, config);
        await assertAllowedReportType(client, args.report_type);
        const body = {
          report_type: args.report_type,
          ...(args.idempotency_key ? { idempotency_key: args.idempotency_key } : {}),
          ...(args.payload || {}),
        };
        return toToolResult(await client.post(`/api/v1/agent/assignments/${encodeURIComponent(assignmentId)}/reports`, body));
      },
    },
    {
      name: 'create_ticket',
      title: 'Create Ticket',
      description: 'Create a new ticket through the agent-facing HTTP contract.',
      inputSchema: toolInputSchemas.create_ticket,
      handler: async (args) => toToolResult(await client.post('/api/v1/agent/tickets', args)),
    },
    {
      name: 'ticket_action',
      title: 'Ticket Action',
      description: 'Run a discoverable ticket action through the agent-facing HTTP contract.',
      inputSchema: toolInputSchemas.ticket_action,
      handler: async (args) => {
        const assignmentId = String(args.assignment_id || config.assignmentId || '').trim();
        const action = String(args.action || '').trim();
        const discovered = await discoverTicketAction(client, action, assignmentId);
        const body = {
          ...removeKeys(args, ['ticket_id', 'action', 'payload']),
          ...(args.payload || {}),
        };
        return toToolResult(await client.post(buildActionPath(discovered.endpoint, args.ticket_id), body));
      },
    },
  ];
}

export function registerTicketPlatformTools(server, client, config = {}) {
  createTicketPlatformToolDefinitions(client, config).forEach((definition) => {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
      },
      async (args) => {
        try {
          return await definition.handler(args || {});
        } catch (err) {
          return toToolErrorResult(err);
        }
      }
    );
  });
}
