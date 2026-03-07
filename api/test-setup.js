/**
 * API 测试环境变量设置，必须在 import app 之前执行
 */
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.TICKETS_DB_PATH = path.join(__dirname, 'data', 'test-tickets.db');
