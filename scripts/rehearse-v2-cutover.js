#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.join(__dirname, '..');
const DEFAULT_SOURCE_DB = process.env.CUTOVER_SOURCE_DB || path.join(REPO_DIR, 'data', 'tickets.db');
const DEFAULT_TARGET_DB = process.env.CUTOVER_TARGET_DB || path.join(REPO_DIR, 'data', 'ticket-platform-v2.db');

function parseArgs(argv) {
  const options = {
    source: DEFAULT_SOURCE_DB,
    target: DEFAULT_TARGET_DB,
    overwrite: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') options.source = argv[++i];
    else if (arg === '--target') options.target = argv[++i];
    else if (arg === '--overwrite') options.overwrite = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`用法: node scripts/rehearse-v2-cutover.js [--source <legacy.db>] [--target <v2.db>] [--overwrite] [--json]\n\n` +
    `作用:\n` +
    `- 把老库 SQLite 安全复制到 v2 rehearsal DB\n` +
    `- 对常见业务表做行数比对\n` +
    `- 输出 cutover 预演摘要，供 runbook / reviewer 引用\n\n` +
    `默认:\n` +
    `- source: data/tickets.db\n` +
    `- target: data/ticket-platform-v2.db\n`);
}

function ensureReadableFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} 不存在: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`${label} 不是文件: ${filePath}`);
  }
}

function resolveDistinctPaths(source, target) {
  const src = path.resolve(source);
  const dst = path.resolve(target);
  if (src === dst) {
    throw new Error(`source 与 target 不能相同: ${src}`);
  }
  return { src, dst };
}

async function backupSqlite(source, target, overwrite) {
  if (fs.existsSync(target)) {
    if (!overwrite) {
      throw new Error(`target 已存在，若确认覆盖请加 --overwrite: ${target}`);
    }
    fs.rmSync(target, { force: true });
    fs.rmSync(`${target}-wal`, { force: true });
    fs.rmSync(`${target}-shm`, { force: true });
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });

  const srcDb = new Database(source, { readonly: true });
  try {
    srcDb.pragma('busy_timeout = 5000');
    srcDb.prepare('SELECT 1').get();
    await srcDb.backup(target);
  } finally {
    srcDb.close();
  }
}

function listBusinessTables(db) {
  const preferred = [
    'tickets',
    'ticket_comments',
    'ticket_dependencies',
    'ticket_execution_workers',
    'ticket_assignments',
    'execution_reservations',
    'dispatch_events',
    'ticket_projection',
    'worker_projection',
    'dispatch_ready_projection',
    'audit_ready_projection',
    'participant_registry',
    'participant_registry_status',
    'participant_registry_capabilities',
  ];
  const existing = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name)
  );
  return preferred.filter((name) => existing.has(name));
}

function countTables(db, tables) {
  const result = {};
  for (const table of tables) {
    result[table] = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  }
  return result;
}

function compareCounts(source, target) {
  const srcDb = new Database(source, { readonly: true });
  const dstDb = new Database(target, { readonly: true });
  try {
    const tables = Array.from(new Set([...listBusinessTables(srcDb), ...listBusinessTables(dstDb)]));
    const sourceCounts = countTables(srcDb, tables);
    const targetCounts = countTables(dstDb, tables);
    const diffs = tables
      .filter((table) => sourceCounts[table] !== targetCounts[table])
      .map((table) => ({ table, source: sourceCounts[table], target: targetCounts[table] }));
    return { tables, sourceCounts, targetCounts, diffs };
  } finally {
    srcDb.close();
    dstDb.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const { src, dst } = resolveDistinctPaths(options.source, options.target);
  ensureReadableFile(src, 'source DB');
  await backupSqlite(src, dst, options.overwrite);
  const comparison = compareCounts(src, dst);
  const summary = {
    ok: comparison.diffs.length === 0,
    source: src,
    target: dst,
    tables_checked: comparison.tables,
    source_counts: comparison.sourceCounts,
    target_counts: comparison.targetCounts,
    diffs: comparison.diffs,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exit(2);
    return;
  }

  console.log('== v2 cutover rehearsal ==');
  console.log(`source=${src}`);
  console.log(`target=${dst}`);
  console.log(`tables_checked=${comparison.tables.join(', ') || '(none)'}`);
  for (const table of comparison.tables) {
    console.log(`PASS ${table}: source=${comparison.sourceCounts[table]} target=${comparison.targetCounts[table]}`);
  }
  if (summary.ok) {
    console.log('PASS row counts match');
    return;
  }

  console.error('FAIL row count mismatch detected');
  for (const diff of comparison.diffs) {
    console.error(`- ${diff.table}: source=${diff.source} target=${diff.target}`);
  }
  process.exit(2);
}

main().catch((error) => {
  console.error(`[rehearse-v2-cutover] 失败: ${error.message}`);
  process.exit(1);
});
