const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createApiError(message, status, details) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function getBaseUrl() {
  return (import.meta.env.VITE_API_BASE_URL || '').trim();
}

async function parseResponse(response, path) {
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const text = await response.text();

  if (path.startsWith('/api') && !isJson) {
    throw createApiError(
      'API 返回了非 JSON 响应（可能是 index.html），请检查 VITE_API_BASE_URL/代理配置以及后端服务是否已启动。',
      response.status,
      { raw: text?.slice(0, 200) }
    );
  }

  const body = isJson ? JSON.parse(text) : text;

  if (!response.ok) {
    const message = isJson
      ? body?.message || body?.error || `Request failed with ${response.status}`
      : `Request failed with ${response.status}`;
    throw createApiError(message, response.status, body);
  }

  return body;
}

export async function apiRequest(path, options = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    retries = DEFAULT_RETRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = options;

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path}`;

  let attempt = 0;
  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal || controller.signal,
      });

      clearTimeout(timer);
      return await parseResponse(response, path);
    } catch (error) {
      clearTimeout(timer);

      const isAbort = error.name === 'AbortError';
      const isNetworkError = error instanceof TypeError;
      const canRetry = attempt < retries && (isAbort || isNetworkError || (error.status >= 500 && error.status < 600));

      if (!canRetry) {
        if (isAbort) {
          throw createApiError('请求超时，请稍后重试', 408);
        }
        if (isNetworkError && path.startsWith('/api')) {
          throw createApiError(
            '无法连接后端服务，请检查 VITE_API_BASE_URL/代理配置以及后端是否已启动。',
            0,
            { originalMessage: error?.message }
          );
        }
        throw error;
      }

      attempt += 1;
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw createApiError('请求失败，请稍后重试', 500);
}
