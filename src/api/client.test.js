import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiRequest } from './client';

describe('apiRequest', () => {
  beforeEach(() => {
    vi.stubGlobal('import.meta', { env: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws clear error when /api returns non-JSON (e.g. index.html)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: () => Promise.resolve('<!DOCTYPE html><html>'),
    }));

    await expect(apiRequest('/api/bots')).rejects.toThrow(
      /API 返回了非 JSON 响应.*请检查 VITE_API_BASE_URL\/代理配置以及后端服务是否已启动/
    );
  });

  it('throws clear error when backend unreachable (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(apiRequest('/api/tickets')).rejects.toThrow(
      /无法连接后端服务.*请检查 VITE_API_BASE_URL\/代理配置以及后端是否已启动/
    );
  });
});
