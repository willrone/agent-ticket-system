import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REQUIRED_TOOLS = [
  'get_assignment',
  'send_heartbeat',
  'submit_report',
  'create_ticket',
  'ticket_action',
];

const REQUIRED_RESOURCES = [
  'ticket-platform://version',
  'ticket-platform://participants',
];

const REQUIRED_RESOURCE_TEMPLATES = [
  'ticket-platform://assignments/{assignment_id}',
];

function requireAll(label, actual, required) {
  const actualSet = new Set(actual);
  const missing = required.filter((item) => !actualSet.has(item));
  if (missing.length > 0) {
    throw new Error(`${label} missing required entries: ${missing.join(', ')}`);
  }
}

async function main() {
  const client = new Client({
    name: 'ticket-platform-mcp-smoke',
    version: '0.1.0',
  });
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['api/mcp/server.js'],
  });

  try {
    await client.connect(transport);

    const toolsResult = await client.listTools();
    const resourcesResult = await client.listResources();
    const templatesResult = await client.listResourceTemplates();

    const toolNames = toolsResult.tools.map((tool) => tool.name);
    const resourceUris = resourcesResult.resources.map((resource) => resource.uri);
    const templateUris = templatesResult.resourceTemplates.map((template) => template.uriTemplate);

    requireAll('tools', toolNames, REQUIRED_TOOLS);
    requireAll('resources', resourceUris, REQUIRED_RESOURCES);
    requireAll('resource templates', templateUris, REQUIRED_RESOURCE_TEMPLATES);

    console.log('MCP smoke passed:', JSON.stringify({
      tools: REQUIRED_TOOLS,
      resources: REQUIRED_RESOURCES,
      resourceTemplates: REQUIRED_RESOURCE_TEMPLATES,
    }));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('MCP smoke failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
