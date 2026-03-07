/**
 * 最小本地后端 - 仅负责 listen，路由逻辑在 app.js
 */
import app from './app.js';

const PORT = 8788;
const HOST = '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`API server running at http://${HOST}:${PORT}`);
});
