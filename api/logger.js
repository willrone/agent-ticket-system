const LEVEL_VALUES = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const SENSITIVE_KEY_PATTERN = /(token|secret|password|api[_-]?key|authorization|cookie)/i;
const rateLimitState = new Map();

function normalizeLevel(value, fallback = 'info') {
  const level = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVEL_VALUES, level) ? level : fallback;
}

function getConfiguredLevel() {
  const fallback = process.env.NODE_ENV === 'test' ? 'warn' : 'info';
  return normalizeLevel(process.env.TICKET_LOG_LEVEL, fallback);
}

function getConfiguredFormat() {
  const format = String(process.env.TICKET_LOG_FORMAT || 'json').trim().toLowerCase();
  return format === 'pretty' ? 'pretty' : 'json';
}

function serializeError(error) {
  if (!error || typeof error !== 'object') return error;
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    code: error.code,
    statusCode: error.statusCode,
    stack: process.env.TICKET_LOG_STACKS === 'true' ? error.stack : undefined,
  };
}

function redact(value, key = '') {
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== 'object') return value;

  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    output[childKey] = redact(childValue, childKey);
  }
  return output;
}

function cleanRecord(record) {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, value]) => value !== undefined),
  );
}

function shouldLog(level) {
  return LEVEL_VALUES[level] >= LEVEL_VALUES[getConfiguredLevel()];
}

function shouldEmitRateLimited(key, windowMs) {
  if (!key || !Number.isFinite(windowMs) || windowMs <= 0) return true;
  const now = Date.now();
  const existing = rateLimitState.get(key);
  if (!existing || now - existing.lastEmittedAt >= windowMs) {
    rateLimitState.set(key, {
      lastEmittedAt: now,
      suppressed: existing?.suppressed || 0,
    });
    return true;
  }
  existing.suppressed += 1;
  return false;
}

function getSuppressedCount(key) {
  const existing = key ? rateLimitState.get(key) : null;
  if (!existing) return 0;
  const suppressed = existing.suppressed || 0;
  existing.suppressed = 0;
  return suppressed;
}

function writeLog(level, component, message, fields = {}, options = {}) {
  if (!shouldLog(level)) return;

  const rateLimitKey = options.rateLimitKey ? `${component}:${level}:${options.rateLimitKey}` : null;
  if (!shouldEmitRateLimited(rateLimitKey, options.rateLimitMs)) return;

  const record = cleanRecord({
    ts: new Date().toISOString(),
    level,
    component,
    msg: message,
    suppressed_count: getSuppressedCount(rateLimitKey) || undefined,
    ...redact(fields),
  });

  if (getConfiguredFormat() === 'pretty') {
    const suffix = Object.keys(record).filter((key) => !['ts', 'level', 'component', 'msg'].includes(key)).length > 0
      ? ` ${JSON.stringify(Object.fromEntries(Object.entries(record).filter(([key]) => !['ts', 'level', 'component', 'msg'].includes(key))))}`
      : '';
    const line = `${record.ts} ${level.toUpperCase()} [${component}] ${message}${suffix}`;
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
    return;
  }

  const line = JSON.stringify(record);
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

export function createLogger(component, baseFields = {}) {
  const scopedComponent = String(component || 'app').trim() || 'app';
  const withBase = (fields = {}) => ({ ...baseFields, ...fields });
  return {
    debug(message, fields, options) {
      writeLog('debug', scopedComponent, message, withBase(fields), options);
    },
    info(message, fields, options) {
      writeLog('info', scopedComponent, message, withBase(fields), options);
    },
    warn(message, fields, options) {
      writeLog('warn', scopedComponent, message, withBase(fields), options);
    },
    error(message, fields, options) {
      writeLog('error', scopedComponent, message, withBase(fields), options);
    },
    child(childComponent, childFields = {}) {
      return createLogger(`${scopedComponent}.${childComponent}`, { ...baseFields, ...childFields });
    },
  };
}

export function _resetLoggerForTesting() {
  rateLimitState.clear();
}
