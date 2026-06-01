export function clampUsage(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

export function getBotLoad(bot = {}) {
  const usage = clampUsage(bot?.usage);
  const queueDepth = Array.isArray(bot?.queue) ? bot.queue.length : 0;
  const hasCurrentTask = Boolean(bot?.currentTask);
  const successRate = Number(bot?.stats?.successRate) || 0;
  const isIdleWithoutWork = !hasCurrentTask && queueDepth === 0 && bot?.status !== 'active';
  const hasActionableTokenPressure = usage >= 85 && !isIdleWithoutWork;
  const hasObservationTokenPressure = usage >= 85;

  return {
    usage,
    queueDepth,
    hasCurrentTask,
    successRate,
    isIdleWithoutWork,
    hasActionableTokenPressure,
    hasObservationTokenPressure,
  };
}

export function getBotHealth(bot = {}) {
  const load = getBotLoad(bot);

  if (load.hasActionableTokenPressure || load.successRate < 85) {
    return {
      level: 'critical',
      label: '需要介入',
      tone: 'border-red-500/40 bg-red-500/10 text-red-200',
      dot: 'bg-red-400',
      summary: load.hasActionableTokenPressure
        ? '资源使用率过高，且当前存在执行负载，存在过载风险。'
        : '成功率偏低，需检查异常票或执行稳定性。',
    };
  }

  if (load.queueDepth >= 3 || (load.hasCurrentTask && load.queueDepth >= 1) || load.usage >= 65 || bot?.status === 'active') {
    return {
      level: 'warning',
      label: '重点关注',
      tone: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
      dot: 'bg-amber-400',
      summary: load.queueDepth >= 3
        ? '队列堆积明显，建议评估分流。'
        : '当前有执行负载，建议持续观察。',
    };
  }

  if (load.hasObservationTokenPressure) {
    return {
      level: 'healthy',
      label: '运行平稳',
      tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
      dot: 'bg-emerald-400',
      summary: '当前无执行负载；token watermark 先作为观察信号保留。',
    };
  }

  return {
    level: 'healthy',
    label: '运行平稳',
    tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
    dot: 'bg-emerald-400',
    summary: '暂无明显风险，保持可接单状态。',
  };
}

export function summarizeBotHealth(payload) {
  const bots = Array.isArray(payload) ? payload : (payload?.bots ?? payload?.data ?? []);
  return (Array.isArray(bots) ? bots : []).reduce((acc, bot) => {
    const health = getBotHealth(bot);

    if (health.level === 'critical') {
      acc.critical += 1;
    } else if (health.level === 'warning') {
      acc.warning += 1;
    } else {
      acc.healthy += 1;
    }
    acc.total += 1;
    return acc;
  }, { total: 0, healthy: 0, warning: 0, critical: 0 });
}
