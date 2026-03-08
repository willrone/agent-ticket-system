#!/usr/bin/env node

/**
 * 工单依赖关系迁移脚本
 * 
 * 用途：将假父子顺序关系迁移为正式的依赖关系
 * 
 * 使用方式：
 *   node scripts/migrate-dependencies.js --dry-run  # 预览迁移
 *   node scripts/migrate-dependencies.js            # 执行迁移
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'tickets.db');

const dryRun = process.argv.includes('--dry-run');

console.log('工单依赖关系迁移脚本');
console.log('='.repeat(50));
console.log(`模式: ${dryRun ? '预览（不会修改数据）' : '执行'}`);
console.log(`数据库: ${dbPath}`);
console.log('');

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

// 迁移规则：假父子顺序 → 兄弟单 + 依赖
const migrations = [
  {
    name: '#22/#23 迁移',
    description: '#23 从 #22 的子单改为独立单，并添加依赖关系',
    childId: 23,
    parentId: 22,
    dependencyType: 'blocks',
  },
];

console.log('发现的迁移任务：');
migrations.forEach((m, i) => {
  console.log(`${i + 1}. ${m.name}: ${m.description}`);
});
console.log('');

// 执行迁移
let successCount = 0;
let skipCount = 0;
let errorCount = 0;

for (const migration of migrations) {
  console.log(`处理: ${migration.name}`);
  
  try {
    // 检查工单是否存在
    const child = db.prepare('SELECT id, title, parent_ticket_id FROM tickets WHERE id = ?').get(migration.childId);
    const parent = db.prepare('SELECT id, title FROM tickets WHERE id = ?').get(migration.parentId);
    
    if (!child) {
      console.log(`  ⚠️  跳过: 工单 #${migration.childId} 不存在`);
      skipCount++;
      continue;
    }
    
    if (!parent) {
      console.log(`  ⚠️  跳过: 工单 #${migration.parentId} 不存在`);
      skipCount++;
      continue;
    }
    
    console.log(`  子单: #${child.id} ${child.title}`);
    console.log(`  父单: #${parent.id} ${parent.title}`);
    console.log(`  当前 parent_ticket_id: ${child.parent_ticket_id || 'NULL'}`);
    
    // 检查是否已有依赖关系
    const existingDep = db.prepare(`
      SELECT id FROM ticket_dependencies 
      WHERE ticket_id = ? AND depends_on_ticket_id = ?
    `).get(migration.childId, migration.parentId);
    
    if (existingDep) {
      console.log(`  ℹ️  依赖关系已存在，跳过`);
      skipCount++;
      continue;
    }
    
    if (!dryRun) {
      // 清除 parent_ticket_id（如果是假父子关系）
      if (child.parent_ticket_id === migration.parentId) {
        db.prepare('UPDATE tickets SET parent_ticket_id = NULL WHERE id = ?').run(migration.childId);
        console.log(`  ✅ 已清除 parent_ticket_id`);
      }
      
      // 添加依赖关系
      db.prepare(`
        INSERT INTO ticket_dependencies (ticket_id, depends_on_ticket_id, dependency_type, created_at)
        VALUES (?, ?, ?, datetime('now'))
      `).run(migration.childId, migration.parentId, migration.dependencyType);
      
      console.log(`  ✅ 已添加依赖关系: #${migration.childId} depends_on #${migration.parentId} (${migration.dependencyType})`);
      successCount++;
    } else {
      console.log(`  [预览] 将清除 parent_ticket_id`);
      console.log(`  [预览] 将添加依赖关系: #${migration.childId} depends_on #${migration.parentId} (${migration.dependencyType})`);
      successCount++;
    }
    
  } catch (err) {
    console.log(`  ❌ 错误: ${err.message}`);
    errorCount++;
  }
  
  console.log('');
}

// 汇总
console.log('='.repeat(50));
console.log('迁移汇总：');
console.log(`  成功: ${successCount}`);
console.log(`  跳过: ${skipCount}`);
console.log(`  错误: ${errorCount}`);

if (dryRun) {
  console.log('');
  console.log('这是预览模式，没有修改任何数据。');
  console.log('要执行迁移，请运行: node scripts/migrate-dependencies.js');
} else {
  console.log('');
  console.log('迁移完成！');
  
  // 验证
  console.log('');
  console.log('验证依赖关系：');
  for (const migration of migrations) {
    const dep = db.prepare(`
      SELECT d.*, t.title, t.status 
      FROM ticket_dependencies d
      JOIN tickets t ON d.depends_on_ticket_id = t.id
      WHERE d.ticket_id = ?
    `).get(migration.childId);
    
    if (dep) {
      console.log(`  ✅ #${migration.childId} depends_on #${dep.depends_on_ticket_id} (${dep.title}, status: ${dep.status})`);
    } else {
      console.log(`  ⚠️  #${migration.childId} 没有依赖关系`);
    }
  }
}

db.close();
