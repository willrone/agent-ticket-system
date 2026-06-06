const KNOWN_NOISE_PATTERNS = [
  {
    code: 'git-not-repository-noise',
    pattern: /fatal: not a git repository/i,
    isNoise: ({ liveRepoExists }) => !liveRepoExists,
    message: '非 git working directory 下的 git_commit 探测历史噪音',
  },
  {
    code: 'dist-index-missing-noise',
    pattern: /ENOENT: no such file or directory, stat .*\/dist\/index\.html/i,
    isNoise: ({ rootOk, rootHtmlOk, distIndexExists }) => Boolean(rootOk && rootHtmlOk && distIndexExists),
    message: 'root page 已通过时的历史 dist/index.html 缺失尾迹',
  },
];

export function collectIncidentSignals(logTail = '') {
  const text = String(logTail || '');
  if (!text.trim()) return [];
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line, line_no: index + 1 }))
    .filter(({ line }) => /(\[internal-poller:|Error:|Unhandled|EADDRINUSE|SQLITE_|ECONNREFUSED|timeout after|fatal: not a git repository|RangeError:)/i.test(line));
}

export function classifyLogIncident({
  logTail = '',
  rootOk = false,
  rootHtmlOk = false,
  distIndexExists = false,
  liveRepoExists = true,
  errLogMtimeEpoch = null,
  liveServerStartedEpoch = null,
  nowEpoch = null,
  staleMinutes = 60,
} = {}) {
  const signals = collectIncidentSignals(logTail);
  const matchedSignals = [];
  const freshSignals = [];
  const knownNoiseSignals = [];

  for (const signal of signals) {
    const match = KNOWN_NOISE_PATTERNS.find((item) => item.pattern.test(signal.line));
    if (!match) {
      freshSignals.push({
        ...signal,
        code: 'generic-error-signal',
        classification: 'fresh_signal',
      });
      continue;
    }
    matchedSignals.push(signal);
    if (match.isNoise({ rootOk, rootHtmlOk, distIndexExists, liveRepoExists })) {
      knownNoiseSignals.push({
        ...signal,
        code: match.code,
        classification: 'known_noise',
        message: match.message,
      });
    } else {
      freshSignals.push({
        ...signal,
        code: match.code,
        classification: 'fresh_signal',
        message: match.message,
      });
    }
  }

  const normalizedNowEpoch = Number.isFinite(Number(nowEpoch)) ? Number(nowEpoch) : Math.floor(Date.now() / 1000);
  const normalizedErrMtime = Number.isFinite(Number(errLogMtimeEpoch)) ? Number(errLogMtimeEpoch) : null;
  const normalizedStarted = Number.isFinite(Number(liveServerStartedEpoch)) ? Number(liveServerStartedEpoch) : null;
  const silentMinutes = normalizedErrMtime == null ? null : Math.max(0, Math.floor((normalizedNowEpoch - normalizedErrMtime) / 60));
  const staleByProcess = normalizedErrMtime != null && normalizedStarted != null && normalizedErrMtime < normalizedStarted;
  const staleBySilence = normalizedErrMtime != null && silentMinutes != null && silentMinutes >= Number(staleMinutes || 60);
  const healthySurface = Boolean(rootOk && rootHtmlOk && distIndexExists);

  let verdict = 'clean';
  let category = 'no_signal';
  let summary = '未检测到 incident signal';

  if (signals.length > 0 && staleByProcess) {
    verdict = 'pass';
    category = 'stale_history';
    summary = '命中旧日志尾迹，但最后写入早于当前 live 进程启动时间';
  } else if (signals.length > 0 && healthySurface && staleBySilence) {
    verdict = 'pass';
    category = 'stale_history';
    summary = `命中旧日志尾迹，但已静默 ${silentMinutes} 分钟，按 age-aware stale history 降噪`;
  } else if (freshSignals.length > 0) {
    verdict = healthySurface ? 'warn' : 'fail';
    category = 'fresh_incident';
    summary = healthySurface
      ? '检测到 fresh incident signal，但当前 live surface 仍可用；需人工复核是否刚恢复'
      : '检测到 fresh incident signal，且 live surface 未恢复';
  } else if (signals.length > 0) {
    if (knownNoiseSignals.length === signals.length) {
      verdict = 'pass';
      category = 'known_noise';
      summary = '命中已知历史噪音，且已被上下文条件证明可降噪';
    } else {
      verdict = healthySurface ? 'warn' : 'fail';
      category = 'fresh_incident';
      summary = '存在未被降噪的 incident signal';
    }
  }

  return {
    verdict,
    category,
    summary,
    signal_count: signals.length,
    fresh_signal_count: freshSignals.length,
    known_noise_count: knownNoiseSignals.length,
    stale_by_process: staleByProcess,
    stale_by_silence: staleBySilence,
    healthy_surface: healthySurface,
    silent_minutes: silentMinutes,
    stale_minutes_threshold: Number(staleMinutes || 60),
    signals,
    fresh_signals: freshSignals,
    known_noise_signals: knownNoiseSignals,
  };
}
