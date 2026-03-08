/**
 * Bot 状态管理 - 从 OpenClaw 获取真实 agent 状态
 */
import { spawn } from 'child_process';

const OPENCLAW_CLI = process.env.OPENCLAW_CLI || 'openclaw';

// Bot 配置（emoji 和显示名）
const BOT_CONFIG = {
  beavy: { emoji: '🦫', displayName: '小李' },
  cowder: { emoji: '🐮', displayName: '小牛' },
  donky: { emoji: '🫏', displayName: '小驴' },
  doggy: { emoji: '🐕', displayName: '小狗' },
  marely: { emoji: '🐴', displayName: '小马' },
  auditor: { emoji: '🐑', displayName: '小羊', nickname: 'sheeply' },
};

/**
 * 从 OpenClaw 获取所有 agent 的会话状态
 */
async function fetchAgentSessions() {
  return new Promise((resolve, reject) => {
    const args = ['sessions', '--all-agents', '--json'];
    const proc = spawn(OPENCLAW_CLI, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });

    proc.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    proc.on('error', (err) => {
      reject(new Error(`OpenClaw CLI 不可达: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `OpenClaw 退出码 ${code}`));
        return;
      }

      try {
        const data = JSON.parse(stdout.trim());
        resolve(data.sessions || []);
      } catch (e) {
        reject(new Error(`解析 sessions 失败: ${e.message}`));
      }
    });
  });
}

/**
 * 获取所有 Bot 的状态
 */
export async function getBots() {
  try {
    const sessions = await fetchAgentSessions();

    // 按 agent 分组统计，并保留无会话 agent 以便工单明确指派
    const agentStats = Object.fromEntries(
      Object.entries(BOT_CONFIG).map(([agentId, config]) => [agentId, {
        name: agentId,
        displayName: config.displayName,
        emoji: config.emoji,
        sessions: [],
        totalTokens: 0,
        contextTokens: 200000,
      }])
    );

    for (const session of sessions) {
      const agentId = session.key?.split(':')[1]; // agent:beavy:main -> beavy
      if (!agentId || !BOT_CONFIG[agentId]) continue;

      agentStats[agentId].sessions.push(session);
      agentStats[agentId].totalTokens += session.totalTokens || 0;
      agentStats[agentId].contextTokens = session.contextTokens || 200000;
    }

    // 转换为前端需要的格式
    const bots = Object.values(agentStats).map((agent) => {
      const hasRecentActivity = agent.sessions.some(
        (s) => Date.now() - s.updatedAt < 5 * 60 * 1000 // 5分钟内有活动
      );

      const usage = agent.contextTokens > 0
        ? Math.round((agent.totalTokens / agent.contextTokens) * 100)
        : 0;

      return {
        name: BOT_CONFIG[agent.name]?.nickname || agent.name,
        displayName: agent.displayName,
        status: hasRecentActivity ? 'active' : 'idle',
        tokens: `${Math.round(agent.totalTokens / 1000)}k/${Math.round(agent.contextTokens / 1000)}k`,
        usage: Math.min(usage, 100),
        emoji: agent.emoji,
        currentTask: null, // TODO: 从工单系统获取
        queue: [], // TODO: 从工单系统获取
        stats: {
          todayCompleted: 0, // TODO: 统计今天完成的工单
          avgResponseTime: '—',
          successRate: 0,
          uptime: '—',
        },
        recentTasks: [], // TODO: 从工单系统获取
      };
    });

    return bots;
  } catch (err) {
    console.error('[Bots] 获取状态失败:', err.message);
    // 返回默认的 bot 列表（降级方案）
    return Object.entries(BOT_CONFIG).map(([name, config]) => ({
      name: config.nickname || name,
      displayName: config.displayName,
      status: 'idle',
      tokens: '0k/200k',
      usage: 0,
      emoji: config.emoji,
      currentTask: null,
      queue: [],
      stats: { todayCompleted: 0, avgResponseTime: '—', successRate: 0, uptime: '—' },
      recentTasks: [],
    }));
  }
}
