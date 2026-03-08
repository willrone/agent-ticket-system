/**
 * 最小本地后端 - 仅负责 listen，路由逻辑在 app.js
 */
import app from './app.js';
import { startInternalPollers } from './internal-pollers.js';

const PORT = 8788;
const HOST = '127.0.0.1';

const server = app.listen(PORT, HOST, () => {
  console.log(`API server running at http://${HOST}:${PORT}`);

  // 用平台内轮询替代外部 cron：
  // - dispatch 线程：检测 /api/dispatch/ready 后唤醒 Sheeply 派单
  // - notify 线程：检测 /api/notifications/ready 后唤醒 Sheeply 通知
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
