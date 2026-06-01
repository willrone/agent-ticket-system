import { apiRequest } from './client';

export function fetchDashboardMetrics() {
  return apiRequest('/api/metrics/dashboard');
}

export function fetchBots() {
  return apiRequest('/api/bots');
}

export function fetchAgentTopology() {
  return apiRequest('/api/agent-topology');
}
