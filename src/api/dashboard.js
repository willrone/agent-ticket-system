import { apiRequest } from './client';

export function fetchDashboardMetrics() {
  return apiRequest('/api/metrics/dashboard');
}
