/**
 * Sheeply e2e 专用测试环境，使用独立 SQLite 文件避免与其他测试并发串库
 */
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.TICKETS_DB_PATH = path.join(__dirname, 'data', 'test-sheeply-e2e.db');
