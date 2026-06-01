/**
 * 最小本地后端 - 仅负责 listen，路由逻辑在 app.js
 */
import app from './app.js';
import { startInternalPollers } from './internal-pollers.js';
import { getRuntimeVersion, getCommitHashForLog } from './runtime-version.js';

const PORT = Number(process.env.TICKET_API_PORT || 8788);
const HOST = process.env.TICKET_API_BIND_HOST || '127.0.0.1';
const LOCAL_BASE_URL = process.env.TICKET_API_LOCAL_BASE_URL || `http://127.0.0.1:${PORT}`;

const server = app.listen(PORT, HOST, () => {
  const version = getRuntimeVersion();
  const commitHash = getCommitHashForLog();
  console.log(`API server running at http://${HOST}:${PORT}`);
  console.log(`[API] runtime version: commit=${commitHash ?? '(none)'} schema=${version.schema_version} bundle=${version.bundle_version}`);

  // 平台直驱：内置 poller 直接投递到目标 session / agent:main:main，不再经 Sheeply
  // - dispatch：按 agent -> sessionKey 直发目标 agent 主会话
  // - notify：直发 agent:main:main
  const pollers = startInternalPollers({
    apiBaseUrl: LOCAL_BASE_URL,
  });

  const gracefulShutdown = () => {
    pollers.stop();
    server.close(() => process.exit(0));
  };

  process.once('SIGINT', gracefulShutdown);
  process.once('SIGTERM', gracefulShutdown);
});
