/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { RESOURCE_DEFINITIONS, readTicketPlatformResource } from './resources.js';

function makeFakeClient() {
  const calls = [];
  return {
    calls,
    async request(method, path, options = {}) {
      calls.push({ method, path, options });
      return { data: { method, path, query: options.query || null } };
    },
  };
}

describe('ticket-platform MCP resources', () => {
  it('maps version resource to GET /api/version without assignment token', async () => {
    const client = makeFakeClient();
    const definition = RESOURCE_DEFINITIONS.find((item) => item.name === 'version');

    const result = await readTicketPlatformResource(definition, client, new URL('ticket-platform://version'));

    expect(client.calls).toEqual([
      {
        method: 'GET',
        path: '/api/version',
        options: {
          query: undefined,
          includeAssignmentToken: false,
        },
      },
    ]);
    expect(JSON.parse(result.contents[0].text)).toEqual({
      data: {
        method: 'GET',
        path: '/api/version',
        query: null,
      },
    });
  });

  it('maps assignment comments template to the assignment-scoped HTTP route', async () => {
    const client = makeFakeClient();
    const definition = RESOURCE_DEFINITIONS.find((item) => item.name === 'assignment_comments');

    await readTicketPlatformResource(
      definition,
      client,
      new URL('ticket-platform://assignments/assign-1/comments'),
      { assignment_id: 'assign-1' }
    );

    expect(client.calls[0]).toEqual({
      method: 'GET',
      path: '/api/v1/agent/assignments/assign-1/comments',
      options: {
        query: undefined,
        includeAssignmentToken: true,
      },
    });
  });

  it('declares the required first-phase resource surface', () => {
    expect(RESOURCE_DEFINITIONS.map((item) => item.name)).toEqual([
      'version',
      'workflow_schema',
      'runtime_context',
      'assignment',
      'assignment_comments',
      'assignment_dependencies',
      'skills_current',
      'playbook_ticket_handler',
      'participants',
    ]);
  });
});
