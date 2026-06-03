/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { TicketPlatformHttpError } from './ticket-platform-client.js';
import { createTicketPlatformToolDefinitions, toToolErrorResult } from './tools.js';

function makeFakeClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    async get(path, options = {}) {
      calls.push({ method: 'GET', path, options });
      if (overrides.get) return overrides.get(path, options, calls);
      if (path === '/api/v1/agent/skills/current') {
        return {
          data: {
            manifest: {
              allowed_report_types: ['progress_update', 'execution_completed'],
            },
          },
        };
      }
      if (path === '/api/v1/agent/runtime/context') {
        return {
          data: {
            ticket_actions: [
              { key: 'pause', endpoint: '/api/v1/agent/tickets/:id/pause' },
              { key: 'resume_from_decision', endpoint: '/api/v1/agent/tickets/:id/resume-from-decision' },
            ],
          },
        };
      }
      return { data: { path, query: options.query || null } };
    },
    async post(path, body, options = {}) {
      calls.push({ method: 'POST', path, body, options });
      if (overrides.post) return overrides.post(path, body, options, calls);
      return { accepted: true, path, body };
    },
  };
}

function getTool(definitions, name) {
  const tool = definitions.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe('ticket-platform MCP tools', () => {
  it('declares the required first-phase tool surface', () => {
    const definitions = createTicketPlatformToolDefinitions(makeFakeClient(), { assignmentId: 'assign-env' });

    expect(definitions.map((item) => item.name)).toEqual([
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
    ]);
  });

  it('sends heartbeat payload through the assignment HTTP contract', async () => {
    const client = makeFakeClient();
    const tool = getTool(createTicketPlatformToolDefinitions(client), 'send_heartbeat');

    await tool.handler({
      assignment_id: 'assign-1',
      status: 'running',
      message: 'still working',
      progress: { percent: 30 },
      idempotency_key: 'heartbeat-1',
    });

    expect(client.calls).toEqual([
      {
        method: 'POST',
        path: '/api/v1/agent/assignments/assign-1/heartbeat',
        body: {
          status: 'running',
          message: 'still working',
          progress: { percent: 30 },
          idempotency_key: 'heartbeat-1',
        },
        options: {},
      },
    ]);
  });

  it('validates report_type against hosted skill manifest and flattens payload to the HTTP contract', async () => {
    const client = makeFakeClient();
    const tool = getTool(createTicketPlatformToolDefinitions(client), 'submit_report');

    await tool.handler({
      assignment_id: 'assign-1',
      report_type: 'progress_update',
      idempotency_key: 'report-1',
      payload: {
        progress: { status: 'in_progress', percent: 50 },
        summary: 'halfway',
      },
    });

    expect(client.calls).toEqual([
      {
        method: 'GET',
        path: '/api/v1/agent/skills/current',
        options: {},
      },
      {
        method: 'POST',
        path: '/api/v1/agent/assignments/assign-1/reports',
        body: {
          report_type: 'progress_update',
          idempotency_key: 'report-1',
          progress: { status: 'in_progress', percent: 50 },
          summary: 'halfway',
        },
        options: {},
      },
    ]);
  });

  it('rejects unknown report_type before posting', async () => {
    const client = makeFakeClient();
    const tool = getTool(createTicketPlatformToolDefinitions(client), 'submit_report');

    await expect(tool.handler({
      assignment_id: 'assign-1',
      report_type: 'unknown_report',
      payload: {},
    })).rejects.toThrow('report_type unknown_report is not allowed');

    expect(client.calls).toEqual([
      {
        method: 'GET',
        path: '/api/v1/agent/skills/current',
        options: {},
      },
    ]);
  });

  it('discovers ticket action endpoint from runtime context before posting', async () => {
    const client = makeFakeClient();
    const tool = getTool(createTicketPlatformToolDefinitions(client), 'ticket_action');

    await tool.handler({
      assignment_id: 'assign-1',
      ticket_id: 33,
      action: 'pause',
      actor: 'beavy',
      payload: {
        pause_reason: 'waiting on reviewer',
      },
    });

    expect(client.calls).toEqual([
      {
        method: 'GET',
        path: '/api/v1/agent/runtime/context',
        options: { query: { assignment_id: 'assign-1' } },
      },
      {
        method: 'POST',
        path: '/api/v1/agent/tickets/33/pause',
        body: {
          assignment_id: 'assign-1',
          actor: 'beavy',
          pause_reason: 'waiting on reviewer',
        },
        options: {},
      },
    ]);
  });

  it('preserves HTTP error fields in MCP tool error result', () => {
    const result = toToolErrorResult(new TicketPlatformHttpError('stale', {
      status: 409,
      detail: 'assignment 已过期',
      requestId: 'api_req_409',
      body: { code: 'ASSIGNMENT_STALE' },
    }));

    expect(result).toEqual(expect.objectContaining({
      isError: true,
      structuredContent: expect.objectContaining({
        detail: 'assignment 已过期',
        request_id: 'api_req_409',
        status: 409,
        body: { code: 'ASSIGNMENT_STALE' },
      }),
    }));
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });
});
