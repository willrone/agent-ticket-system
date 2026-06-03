import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTicketPlatformClient } from './ticket-platform-client.js';
import { registerTicketPlatformResources } from './resources.js';
import { registerTicketPlatformTools } from './tools.js';

export function loadMcpConfigFromEnv(env = process.env) {
  return {
    baseUrl: env.TICKET_API_BASE_URL || env.TICKET_AGENT_API_BASE_URL || 'http://127.0.0.1:8788',
    assignmentId: String(env.TICKET_ASSIGNMENT_ID || '').trim(),
    assignmentToken: String(env.TICKET_ASSIGNMENT_TOKEN || '').trim(),
    requestIdPrefix: env.TICKET_MCP_REQUEST_ID_PREFIX || 'mcp',
  };
}

export function createTicketPlatformMcpServer({ client = null, env = process.env, config = null } = {}) {
  const resolvedConfig = config || loadMcpConfigFromEnv(env);
  const resolvedClient = client || createTicketPlatformClient({
    baseUrl: resolvedConfig.baseUrl,
    assignmentToken: resolvedConfig.assignmentToken,
    requestIdPrefix: resolvedConfig.requestIdPrefix,
  });
  const server = new McpServer({
    name: 'ticket-platform',
    version: '0.1.0',
  });

  registerTicketPlatformResources(server, resolvedClient);
  registerTicketPlatformTools(server, resolvedClient, resolvedConfig);

  return server;
}

export async function runStdioServer({ env = process.env } = {}) {
  const server = createTicketPlatformMcpServer({ env });
  await server.connect(new StdioServerTransport());
  return server;
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  runStdioServer().catch((err) => {
    console.error('[ticket-platform-mcp] failed to start:', err);
    process.exit(1);
  });
}
