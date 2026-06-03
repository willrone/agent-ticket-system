/**
 * API 测试环境变量设置，必须在 import app/store 之前执行。
 *
 * Vitest may run test files in parallel workers. Use a per-process sqlite file
 * instead of one shared api/data/test-tickets.db to avoid cross-file FK/data
 * pollution during release:check.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(__dirname, 'data', `test-tickets-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  fs.rmSync(`${testDbPath}${suffix}`, { force: true });
}
process.env.TICKETS_DB_PATH = testDbPath;


function cleanupTestDb() {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${testDbPath}${suffix}`, { force: true });
  }
}

process.once('exit', cleanupTestDb);
process.once('SIGINT', () => { cleanupTestDb(); process.exit(130); });
process.once('SIGTERM', () => { cleanupTestDb(); process.exit(143); });
