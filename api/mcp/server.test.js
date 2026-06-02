/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TicketPlatformHttpError } from './ticket-platform-client.js';
import { createTicketPlatformMcpServer, loadMcpConfigFromEnv } from './server.js';

function makeSdkFakeClient({ failHeartbeat = false } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, path, options = {}) {
      calls.push({ method, path, options });
      return { data: { method, path, query: options.query || null } };
    },
    async get(path, options = {}) {
      calls.push({ method: 'GET', path, options });
      if (path === '/api/v1/agent/skills/current') {
        return { data: { manifest: { allowed_report_types: ['progress_update'] } } };
      }
      if (path === '/api/v1/agent/runtime/context') {
        return {
          data: {
            ticket_actions: [
              { key: 'pause', endpoint: '/api/v1/agent/tickets/:id/pause' },
            ],
          },
        };
      }
      return { data: { path, query: options.query || null } };
    },
    async post(path, body, options = {}) {
      calls.push({ method: 'POST', path, body, options });
      if (failHeartbeat && path.endsWith('/heartbeat')) {
        throw new TicketPlatformHttpError('stale', {
          status: 409,
          detail: 'assignment 已过期',
          requestId: 'api_req_stale',
          body: { code: 'ASSIGNMENT_STALE' },
          url: `http://ticket-platform.test${path}`,
        });
      }
      return { accepted: true, path, body };
    },
  };
}

async function connectServer(fakeClient, config = { assignmentId: 'assign-env' }) {
  const server = createTicketPlatformMcpServer({ client: fakeClient, config });
  const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

describe('ticket-platform MCP server', () => {
  it('loads MCP config from env', () => {
    expect(loadMcpConfigFromEnv({
      TICKET_API_BASE_URL: 'http://ticket-platform.test',
      TICKET_ASSIGNMENT_ID: 'assign-1',
      TICKET_ASSIGNMENT_TOKEN: 'token-1',
      TICKET_MCP_REQUEST_ID_PREFIX: 'ticket-mcp',
    })).toEqual({
      baseUrl: 'http://ticket-platform.test',
      assignmentId: 'assign-1',
      assignmentToken: 'token-1',
      requestIdPrefix: 'ticket-mcp',
    });
  });

  it('registers required tools and resources through the MCP SDK', async () => {
    const fakeClient = makeSdkFakeClient();
    const { server, client } = await connectServer(fakeClient);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'get_runtime_context',
        'get_assignment',
        'read_comments',
        'read_dependencies',
        'list_participants',
        'resolve_route',
        'send_heartbeat',
        'submit_report',
        'create_ticket',
        'ticket_action',
      ]));

      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toEqual(expect.arrayContaining([
        'ticket-platform://version',
        'ticket-platform://workflow/schema',
        'ticket-platform://skills/current',
        'ticket-platform://playbooks/ticket-handler',
        'ticket-platform://participants',
      ]));

      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toEqual(expect.arrayContaining([
        'ticket-platform://runtime/context/{assignment_id}',
        'ticket-platform://assignments/{assignment_id}',
        'ticket-platform://assignments/{assignment_id}/comments',
        'ticket-platform://assignments/{assignment_id}/dependencies',
      ]));

      const readResult = await client.readResource({ uri: 'ticket-platform://version' });
      expect(JSON.parse(readResult.contents[0].text)).toEqual({
        data: {
          method: 'GET',
          path: '/api/version',
          query: null,
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('uses configured assignment id for assignment-scoped tool calls', async () => {
    const fakeClient = makeSdkFakeClient();
    const { server, client } = await connectServer(fakeClient, { assignmentId: 'assign-env' });

    try {
      const result = await client.callTool({
        name: 'send_heartbeat',
        arguments: {
          status: 'running',
          progress: { percent: 10 },
        },
      });

      expect(result.structuredContent).toEqual(expect.objectContaining({
        accepted: true,
        path: '/api/v1/agent/assignments/assign-env/heartbeat',
      }));
      expect(fakeClient.calls).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: 'POST',
          path: '/api/v1/agent/assignments/assign-env/heartbeat',
          body: {
            status: 'running',
            progress: { percent: 10 },
          },
        }),
      ]));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns MCP tool errors with HTTP status and request id preserved', async () => {
    const fakeClient = makeSdkFakeClient({ failHeartbeat: true });
    const { server, client } = await connectServer(fakeClient, { assignmentId: 'assign-env' });

    try {
      const result = await client.callTool({
        name: 'send_heartbeat',
        arguments: {
          status: 'running',
        },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(expect.objectContaining({
        detail: 'assignment 已过期',
        request_id: 'api_req_stale',
        status: 409,
      }));
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
