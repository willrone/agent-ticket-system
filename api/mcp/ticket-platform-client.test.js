/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { createTicketPlatformClient, TicketPlatformHttpError } from './ticket-platform-client.js';

function makeHeaders(headers = {}) {
  return {
    get(key) {
      return headers[key] || headers[key.toLowerCase()] || null;
    },
  };
}

function makeResponse(status, body, headers = { 'content-type': 'application/json' }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: makeHeaders(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('ticket-platform MCP HTTP client', () => {
  it('normalizes base URL and sends assignment token plus request id', async () => {
    const calls = [];
    const client = createTicketPlatformClient({
      baseUrl: 'http://ticket-platform.test///',
      assignmentToken: 'assignment-token-1',
      requestIdGenerator: () => 'mcp_req_1',
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return makeResponse(200, { data: { ok: true } });
      },
    });

    const result = await client.get('/api/v1/agent/assignments/a-1', {
      query: { cursor: 10 },
    });

    expect(result).toEqual({ data: { ok: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://ticket-platform.test/api/v1/agent/assignments/a-1?cursor=10');
    expect(calls[0].options.headers).toEqual(expect.objectContaining({
      'X-Assignment-Token': 'assignment-token-1',
      'X-Request-Id': 'mcp_req_1',
    }));
  });

  it('can omit assignment token for public resources such as version', async () => {
    const calls = [];
    const client = createTicketPlatformClient({
      baseUrl: 'http://ticket-platform.test',
      assignmentToken: 'assignment-token-1',
      requestIdGenerator: () => 'mcp_req_2',
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return makeResponse(200, { data: { schema_version: 'v1' } });
      },
    });

    await client.get('/api/version', { includeAssignmentToken: false });

    expect(calls[0].options.headers['X-Assignment-Token']).toBeUndefined();
    expect(calls[0].options.headers['X-Request-Id']).toBe('mcp_req_2');
  });

  it('maps HTTP errors with detail and request_id preserved', async () => {
    const client = createTicketPlatformClient({
      baseUrl: 'http://ticket-platform.test',
      requestIdGenerator: () => 'mcp_req_3',
      fetchImpl: async () => makeResponse(409, {
        detail: 'assignment 已过期',
        request_id: 'api_req_409',
        code: 'ASSIGNMENT_STALE',
      }),
    });

    await expect(client.post('/api/v1/agent/assignments/a-1/heartbeat', { status: 'running' }))
      .rejects
      .toMatchObject({
        name: 'TicketPlatformHttpError',
        status: 409,
        detail: 'assignment 已过期',
        request_id: 'api_req_409',
        body: expect.objectContaining({ code: 'ASSIGNMENT_STALE' }),
      });
  });

  it('serializes TicketPlatformHttpError to MCP-friendly JSON', () => {
    const err = new TicketPlatformHttpError('forbidden', {
      status: 403,
      detail: 'actor 不允许执行 action',
      requestId: 'api_req_403',
      body: { detail: 'actor 不允许执行 action' },
      url: 'http://ticket-platform.test/api/v1/agent/tickets/1/pause',
    });

    expect(err.toJSON()).toEqual({
      detail: 'actor 不允许执行 action',
      request_id: 'api_req_403',
      status: 403,
      body: { detail: 'actor 不允许执行 action' },
      url: 'http://ticket-platform.test/api/v1/agent/tickets/1/pause',
    });
  });
});
