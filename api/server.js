/**
 * 最小本地后端 - 仅负责 listen，路由逻辑在 app.js
 */
import app from './app.js';
import { startInternalPollers } from './internal-pollers.js';

const PORT = 8788;
const HOST = '127.0.0.1';

const server = app.listen(PORT, HOST, () => {
  console.log(`API server running at http://${HOST}:${PORT}`);

  // 平台直驱：内置 poller 直接投递到目标 session / agent:main:main，不再经 Sheeply
  // - dispatch：按 agent -> sessionKey 直发目标 agent 主会话
  // - notify：直发 agent:main:main
  const pollers = startInternalPollers({
    apiBaseUrl: `http://${HOST}:${PORT}`,
  });

  const gracefulShutdown = () => {
    pollers.stop();
    server.close(() => process.exit(0));
  };

  process.once('SIGINT', gracefulShutdown);
  process.once('SIGTERM', gracefulShutdown);
});
