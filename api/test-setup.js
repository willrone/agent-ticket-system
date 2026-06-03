/**
 * API 测试环境变量设置，必须在 import app/store 之前执行。
 *
 * Vitest may run test files in parallel workers. Use a per-process sqlite file
 * instead of one shared api/data/test-tickets.db to avoid cross-file FK/data
 * pollution during release:check.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(__dirname, 'data', `test-tickets-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  fs.rmSync(`${testDbPath}${suffix}`, { force: true });
}
process.env.TICKETS_DB_PATH = testDbPath;


function cleanupTestDb() {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${testDbPath}${suffix}`, { force: true });
  }
}

process.once('exit', cleanupTestDb);
process.once('SIGINT', () => { cleanupTestDb(); process.exit(130); });
process.once('SIGTERM', () => { cleanupTestDb(); process.exit(143); });

/**
 * Inject fixture agent/gateway/Platform topology for all API tests.
 * These replace the now-minimal DEFAULT_* constants in agent-topology.js
 * so tests can continue using familiar agent names like beavy, leoss, donky, cowder.
 * Production deployments inject real values via environment variables.
 */
process.env.TICKET_AGENT_GATEWAY_OVERRIDES_JSON = JSON.stringify({
  beavy: 'mac-main',
  leoss: 'mac-main',
  doggy: 'mac-main',
  marely: 'mac-main',
  auditor: 'mac-main',
  cowder: 'pc-stock',
  donky: 'pc-stock',
  xiaoying: 'pc-stock',
});
process.env.TICKET_GATEWAY_REGISTRY_JSON = JSON.stringify({
  'mac-main': {
    id: 'mac-main',
    label: 'Mac 主网关',
    transport: 'local_cli',
    role: 'primary',
    host_label: 'Main Mac',
    host_type: 'macOS_host',
    platform_scope: ['ticket-platform', 'stock-platform'],
  },
  'pc-stock': {
    id: 'pc-stock',
    label: 'PC 远端网关',
    transport: 'ssh_gateway_call',
    role: 'remote',
    host_label: 'PC Remote',
    host_type: 'windows_or_remote_host',
    platform_scope: ['stock-platform'],
    ssh_destination: 'tester@example.com',
    openclaw_bin: 'openclaw',
  },
});
process.env.TICKET_AGENT_DIRECTORY_JSON = JSON.stringify({
  leoss: { id: 'leoss', display_name: 'Leoss', emoji: '🧭', role_type: 'owner', ownership_layer: 'platform_owner', primary_platform: 'ticket-platform', session_base: 'agent:main', responsibility_summary: 'Fixtures owner', responsibilities: ['platform_owner', 'triage', 'review'], collaborates_with: ['beavy', 'auditor'] },
  beavy: { id: 'beavy', display_name: 'Beavy', emoji: '🦫', role_type: 'builder', ownership_layer: 'development', primary_platform: 'ticket-platform', session_base: 'agent:beavy', responsibility_summary: 'Fixture builder', responsibilities: ['development'], collaborates_with: ['leoss'] },
  cowder: { id: 'cowder', display_name: 'Cowder', emoji: '🐮', role_type: 'owner', ownership_layer: 'platform_owner', primary_platform: 'stock-platform', session_base: 'agent:cowder', responsibility_summary: 'Fixture stock owner', responsibilities: ['platform_owner'], collaborates_with: ['donky', 'xiaoying'] },
  donky: { id: 'donky', display_name: 'Donky', emoji: '🫏', role_type: 'builder', ownership_layer: 'development', primary_platform: 'stock-platform', session_base: 'agent:donky', responsibility_summary: 'Fixture stock builder', responsibilities: ['development'], collaborates_with: ['cowder', 'xiaoying'] },
  xiaoying: { id: 'xiaoying', display_name: 'Xiaoying', emoji: '🦅', role_type: 'reviewer', ownership_layer: 'review', primary_platform: 'stock-platform', session_base: 'agent:xiaoying', responsibility_summary: 'Fixture stock reviewer', responsibilities: ['review'], collaborates_with: ['cowder', 'donky'] },
  auditor: { id: 'auditor', display_name: 'Auditor', emoji: '🐑', role_type: 'auditor', ownership_layer: 'audit', primary_platform: 'ticket-platform', session_base: 'agent:auditor', responsibility_summary: 'Fixture auditor', responsibilities: ['audit'], collaborates_with: ['leoss'] },
  doggy: { id: 'doggy', display_name: 'Doggy', emoji: '🐕', role_type: 'support', ownership_layer: 'support', primary_platform: 'ticket-platform', session_base: 'agent:doggy', responsibility_summary: 'Fixture support', responsibilities: ['support'], collaborates_with: ['leoss'] },
  marely: { id: 'marely', display_name: 'Marely', emoji: '🐴', role_type: 'support', ownership_layer: 'support', primary_platform: 'ticket-platform', session_base: 'agent:marely', responsibility_summary: 'Fixture support', responsibilities: ['support'], collaborates_with: ['leoss'] },
});
process.env.TICKET_PLATFORM_DIRECTORY_JSON = JSON.stringify({
  'ticket-platform': { id: 'ticket-platform', display_name: '工单平台', summary: '负责工单生命周期', owner_agent_id: 'leoss', triage_owner_agent_id: 'leoss', review_owner_agent_id: 'leoss', delivery_gateway_id: 'mac-main', development_agent_ids: ['beavy'], audit_agent_ids: ['auditor'] },
  'stock-platform': { id: 'stock-platform', display_name: '股票平台', summary: '负责股票业务', owner_agent_id: 'cowder', triage_owner_agent_id: 'cowder', review_owner_agent_id: 'xiaoying', delivery_gateway_id: 'pc-stock', development_agent_ids: ['donky'], audit_agent_ids: [] },
});
process.env.TICKET_NOTIFY_MAIN_GATEWAY_ID = 'mac-main';
process.env.TICKET_HUMAN_PRINCIPAL_ALIASES = 'example_human_operator,荣晖,ronghui';
process.env.TICKET_NOTIFY_MAIN_HUMAN_ALIASES = '荣晖,ronghui';
process.env.TICKET_NOTIFY_MAIN_SESSION_KEY = 'agent:main:telegram:direct:8290057699';
process.env.TICKET_NOTIFY_MAIN_SESSION_KEY = 'agent:main:telegram:direct:8290057699';
