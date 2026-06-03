import { randomUUID } from 'node:crypto';

export class TicketPlatformHttpError extends Error {
  constructor(message, { status = 0, detail = null, requestId = null, body = null, url = null } = {}) {
    super(message);
    this.name = 'TicketPlatformHttpError';
    this.status = status;
    this.detail = detail || message;
    this.request_id = requestId || null;
    this.body = body || null;
    this.url = url || null;
  }

  toJSON() {
    return {
      detail: this.detail,
      request_id: this.request_id,
      status: this.status,
      body: this.body,
      url: this.url,
    };
  }
}

function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl || '').trim() || 'http://127.0.0.1:8788';
  return value.replace(/\/+$/, '');
}

function appendQuery(url, query = {}) {
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== undefined && item !== null && item !== '') {
          url.searchParams.append(key, String(item));
        }
      });
      return;
    }
    url.searchParams.set(key, String(value));
  });
}

function getHeader(headers, key) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(key);
  return headers[key] || headers[key.toLowerCase()] || null;
}

async function readResponseBody(response) {
  const contentType = String(getHeader(response.headers, 'content-type') || '');
  if (contentType.includes('application/json') && typeof response.json === 'function') {
    return response.json();
  }
  if (typeof response.text !== 'function') return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createRequestIdGenerator(prefix = 'mcp') {
  const normalizedPrefix = String(prefix || 'mcp').trim() || 'mcp';
  return () => `${normalizedPrefix}_${randomUUID()}`;
}

export function createTicketPlatformClient({
  baseUrl = process.env.TICKET_API_BASE_URL || process.env.TICKET_AGENT_API_BASE_URL,
  assignmentToken = process.env.TICKET_ASSIGNMENT_TOKEN,
  requestIdPrefix = process.env.TICKET_MCP_REQUEST_ID_PREFIX || 'mcp',
  fetchImpl = globalThis.fetch,
  requestIdGenerator = createRequestIdGenerator(requestIdPrefix),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('ticket-platform MCP client requires a fetch implementation');
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const defaultAssignmentToken = String(assignmentToken || '').trim();

  async function request(method, path, options = {}) {
    const url = String(path || '').startsWith('http://') || String(path || '').startsWith('https://')
      ? new URL(path)
      : new URL(`${normalizedBaseUrl}${String(path || '').startsWith('/') ? '' : '/'}${path || ''}`);
    appendQuery(url, options.query);

    const requestId = String(options.requestId || requestIdGenerator()).trim();
    const token = options.assignmentToken !== undefined
      ? String(options.assignmentToken || '').trim()
      : defaultAssignmentToken;
    const includeAssignmentToken = options.includeAssignmentToken !== false;
    const headers = {
      ...(options.headers || {}),
      'X-Request-Id': requestId,
    };

    if (includeAssignmentToken && token) {
      headers['X-Assignment-Token'] = token;
    }

    const fetchOptions = {
      method,
      headers,
    };

    if (options.body !== undefined) {
      fetchOptions.headers = {
        ...fetchOptions.headers,
        'Content-Type': 'application/json',
      };
      fetchOptions.body = JSON.stringify(options.body);
    }

    let response;
    try {
      response = await fetchImpl(url.toString(), fetchOptions);
    } catch (err) {
      throw new TicketPlatformHttpError(err instanceof Error ? err.message : String(err), {
        status: 0,
        detail: err instanceof Error ? err.message : String(err),
        requestId,
        url: url.toString(),
      });
    }

    const body = response.status === 204 ? null : await readResponseBody(response);
    if (!response.ok) {
      const responseRequestId = typeof body === 'object' && body
        ? body.request_id
        : null;
      const detail = typeof body === 'object' && body
        ? (body.detail || body.message || body.error)
        : null;
      throw new TicketPlatformHttpError(detail || `ticket-platform HTTP ${response.status}`, {
        status: response.status,
        detail: detail || `ticket-platform HTTP ${response.status}`,
        requestId: responseRequestId || getHeader(response.headers, 'x-request-id') || requestId,
        body,
        url: url.toString(),
      });
    }

    return body;
  }

  return {
    baseUrl: normalizedBaseUrl,
    get: (path, options = {}) => request('GET', path, options),
    post: (path, body, options = {}) => request('POST', path, { ...options, body }),
    request,
  };
}

export function createTicketPlatformClientFromEnv(env = process.env, options = {}) {
  return createTicketPlatformClient({
    baseUrl: env.TICKET_API_BASE_URL || env.TICKET_AGENT_API_BASE_URL,
    assignmentToken: env.TICKET_ASSIGNMENT_TOKEN,
    requestIdPrefix: env.TICKET_MCP_REQUEST_ID_PREFIX || 'mcp',
    ...options,
  });
}
