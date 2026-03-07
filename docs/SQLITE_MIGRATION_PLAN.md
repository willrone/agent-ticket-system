# 工单存储 JSON → SQLite 迁移计划

## 一、一页式摘要

| 维度 | 现状 (tickets.json) | 目标 (SQLite) |
|------|---------------------|---------------|
| **存储方式** | 全量读写 JSON 文件 | 单表 + 评论子表，按需读写 |
| **性能** | O(n) 每次操作，工单多时线性劣化 | O(1) 单条 CRUD，索引查询 |
| **并发** | 无锁，多进程/多请求易写坏 | WAL + 事务，多读单写 |
| **可靠性** | 写中断易损坏，无原子性 | ACID，崩溃恢复 |
| **可维护性** | 无 schema、无迁移、难扩展 | 显式 schema、迁移脚本、易扩展 |
| **工期** | - | 保守 5–7 天 / 激进 3–4 天 |

**核心策略**：保持 `store.js` 对外 API 不变，内部实现替换为 SQLite；数据迁移幂等、可重试；分 Phase0~3 渐进上线，每阶段可回滚。

---

## 二、现状问题清单

### 2.1 性能

| 问题 | 描述 | 影响 |
|------|------|------|
| 全量读 | 每次 `readAll()` 读整个 JSON | 工单 1000+ 时，单次请求 ~10–50ms |
| 全量写 | 每次 `writeAll()` 覆盖整个文件 | 同上，写放大严重 |
| 重复读 | `updateTicket` 内 read→改→write，`getTicketById` 再 read | 单次 PATCH 实际 2 读 1 写 |
| 无索引 | 按 status/assigned_agent 过滤需全表扫描 | `/api/tickets/pull`、dashboard 统计随数据量线性变慢 |

### 2.2 并发

| 问题 | 描述 | 影响 |
|------|------|------|
| 无锁 | 多 Agent 同时 PATCH 或多人同时评论 | 后写覆盖前写，数据丢失 |
| 竞态 | createTicket 的 `nextId = max(id)+1` 非原子 | 并发创建可能 ID 冲突 |
| 单文件 | 所有操作争抢同一文件 | 高并发下不可预测 |

### 2.3 可靠性

| 问题 | 描述 | 影响 |
|------|------|------|
| 写中断 | `writeFileSync` 中途崩溃 | JSON 截断或损坏，需人工恢复 |
| 无原子性 | read→modify→write 非原子 | 崩溃可导致部分更新丢失 |
| 无备份 | 无内置快照/版本 | 误删难恢复 |

### 2.4 可维护性

| 问题 | 描述 | 影响 |
|------|------|------|
| 无 schema | 字段靠注释约定 | 易出现不一致、难做校验 |
| 无迁移 | 加字段需改代码+手工处理旧数据 | 易漏、难回滚 |
| comments 内嵌 | JSON 内嵌数组，查询/扩展不便 | 无法按评论检索、分页 |

---

## 三、目标架构

### 3.1 表结构

```sql
-- 工单主表
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  assigned_agent TEXT,
  priority TEXT DEFAULT 'medium',
  session_key TEXT,
  run_id TEXT,
  created TEXT NOT NULL,
  last_update TEXT NOT NULL,
  result_summary TEXT,
  error TEXT
);

-- 评论子表
CREATE TABLE ticket_comments (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  content TEXT NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

-- 索引
CREATE INDEX idx_tickets_status ON tickets(status);
CREATE INDEX idx_tickets_assigned_agent ON tickets(assigned_agent);
CREATE INDEX idx_tickets_last_update ON tickets(last_update);
CREATE INDEX idx_ticket_comments_ticket_id ON ticket_comments(ticket_id);
```

### 3.2 事务与 WAL

- **事务**：`createTicket`、`updateTicket`、`addComment` 均包在 `BEGIN; ... COMMIT;` 中，失败则 `ROLLBACK`
- **WAL 模式**：`PRAGMA journal_mode=WAL;`，支持多读单写，读不阻塞写
- **回滚**：迁移失败时删除 `.db` 文件，恢复使用 `tickets.json`（需保留备份）

### 3.3 兼容性

- `store.js` 导出接口保持不变：`getAllTickets`、`getTicketById`、`createTicket`、`updateTicket`、`addComment`
- 返回数据结构与现有 JSON 完全一致（含 `comments` 数组）

---

## 四、分阶段迁移计划

### Phase 0：准备与双写（可回滚）

| 项目 | 内容 |
|------|------|
| **改动点** | 1) 引入 `better-sqlite3`；2) 新增 `store-sqlite.js` 实现相同 API；3) 环境变量 `TICKETS_STORE=json|sqlite` 切换；4) 默认仍为 `json` |
| **风险** | 低，不影响现有行为 |
| **回滚** | 删除 `store-sqlite.js`，移除切换逻辑，保持 `store.js` 为唯一实现 |
| **验收** | 单元测试 `store-sqlite` 与 `store` 行为一致；`TICKETS_STORE=json` 时全量测试通过 |

### Phase 1：数据迁移脚本（幂等）

| 项目 | 内容 |
|------|------|
| **改动点** | 1) 编写 `scripts/migrate-json-to-sqlite.js`；2) 读取 `tickets.json` → 写入 SQLite；3) 幂等：若 DB 已有数据则跳过或按 id  upsert；4) 迁移前备份 `tickets.json` 为 `tickets.json.bak` |
| **风险** | 中，需验证 comments 等嵌套结构正确 |
| **回滚** | 删除 `.db`，恢复 `tickets.json` 从备份 |
| **验收** | 迁移后 `getAllTickets` 与迁移前 JSON 解析结果逐条对比一致 |

### Phase 2：切换默认存储（可回滚）

| 项目 | 内容 |
|------|------|
| **改动点** | 1) `store.js` 改为根据 `TICKETS_STORE` 选择 `store-json.js` 或 `store-sqlite.js`；2) 默认 `TICKETS_STORE=sqlite`；3) 测试环境用 `test.db` 或内存 DB |
| **风险** | 中，需充分回归 |
| **回滚** | `TICKETS_STORE=json`，重启服务 |
| **验收** | 现有 API 测试全绿；手动创建/更新/评论流程正常 |

### Phase 3：移除 JSON 实现（可选）

| 项目 | 内容 |
|------|------|
| **改动点** | 1) 删除 `store-json.js`（或保留为 fallback）；2) 移除 `TICKETS_JSON_PATH`；3) 文档更新 |
| **风险** | 低 |
| **回滚** | 从 git 恢复 `store-json.js` 及切换逻辑 |
| **验收** | 无 JSON 依赖，CI 全绿 |

---

## 五、API 兼容策略

- **接口不变**：`app.js` 仅 `import * as store from './store.js'`，不感知底层实现
- **数据形状一致**：
  - `getAllTickets()` → `[{ id, title, description, status, ... }]`
  - `getTicketById(id)` → `{ id, title, ..., comments: [{ id, author, timestamp, content }] }`
  - `createTicket` / `updateTicket` / `addComment` 返回与现有一致
- **ID 类型**：保持 `id` 为 number，SQLite `AUTOINCREMENT` 与现有 `max(id)+1` 语义兼容

---

## 六、数据迁移方案

### 6.1 幂等设计

```text
1. 若 data/tickets.db 不存在 → 创建空库 + 建表
2. 若 tickets 表为空 → 从 tickets.json 全量导入
3. 若 tickets 表非空 → 按 id 做 INSERT OR REPLACE（幂等）
4. 每次迁移前：cp tickets.json tickets.json.bak
```

### 6.2 失败恢复

| 场景 | 处理 |
|------|------|
| JSON 解析失败 | 记录错误，退出，不写 DB；保留原 JSON |
| 写入 DB 失败 | ROLLBACK，记录错误，退出；保留 .bak |
| 部分写入后崩溃 | 下次运行幂等脚本，从 .bak 重新迁移 |

### 6.3 迁移脚本调用

```bash
# 首次迁移
node scripts/migrate-json-to-sqlite.js

# 验证
sqlite3 data/tickets.db "SELECT COUNT(*) FROM tickets;"
```

---

## 七、测试计划

### 7.1 单元测试

| 范围 | 内容 |
|------|------|
| store-sqlite | `getAllTickets`、`getTicketById`、`createTicket`、`updateTicket`、`addComment` 各方法独立测试，使用内存 DB |
| 边界 | 空库、单条、comments 空/多条、特殊字符、长文本 |

### 7.2 集成测试

| 范围 | 内容 |
|------|------|
| API | 沿用 `app.test.js`，仅将 `TICKETS_JSON_PATH` 改为 `TICKETS_STORE=sqlite` + 测试用 DB 路径 |
| 迁移 | 用 fixtures 的 JSON 跑迁移脚本，再跑 API 测试验证 |

### 7.3 压测（可选）

| 场景 | 目标 |
|------|------|
| 并发创建 | 10 个并发 POST /api/tickets，无 ID 冲突、无 500 |
| 并发更新 | 5 个 PATCH 同工单，最终状态一致、无丢失 |
| 大列表 | 1000 工单时 GET /api/tickets < 200ms |

---

## 八、最终执行清单

```text
[ ] 1. 安装 better-sqlite3，添加 TICKETS_STORE、TICKETS_DB_PATH 环境变量
[ ] 2. 实现 store-sqlite.js（getAllTickets/getTicketById/createTicket/updateTicket/addComment）
[ ] 3. 实现 store-json.js（从现有 store.js 重命名），store.js 做路由
[ ] 4. 编写 store-sqlite 单测
[ ] 5. 编写 migrate-json-to-sqlite.js（幂等+备份）
[ ] 6. 用 fixtures 验证迁移脚本
[ ] 7. 更新 test-setup：测试用 sqlite + 内存或 test.db
[ ] 8. 跑全量 API 测试，确保 sqlite 模式下通过
[ ] 9. 默认切换为 sqlite，本地跑迁移脚本
[ ] 10. 部署前备份 tickets.json，执行迁移，切换配置，验证
[ ] 11. （可选）移除 JSON 实现，更新文档
```

---

## 九、技术细节补充

### 9.1 better-sqlite3 配置

```javascript
import Database from 'better-sqlite3';

const dbPath = process.env.TICKETS_DB_PATH || path.join(__dirname, '..', 'data', 'tickets.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
```

### 9.2 comments 序列化

- 写入：`INSERT INTO ticket_comments (id, ticket_id, author, timestamp, content) VALUES (?, ?, ?, ?, ?)`
- 读取：`SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY id`，组装为 `comments` 数组

### 9.3 测试环境

```javascript
// test-setup.js
process.env.TICKETS_STORE = 'sqlite';
process.env.TICKETS_DB_PATH = ':memory:';  // 或 path.join(__dirname, 'data', 'test.db')
```

---

## 十、风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 迁移脚本漏数据 | 中 | 高 | 迁移后全量对比脚本；保留 .bak |
| SQLite 文件权限/路径 | 低 | 中 | 明确 TICKETS_DB_PATH，文档说明 |
| better-sqlite3 原生依赖 | 低 | 中 | 使用可选依赖或 Docker 固定环境 |
| 并发下 ID 冲突 | 低 | 高 | 使用 AUTOINCREMENT，事务内插入 |
| 旧 Node 不支持 | 低 | 低 | 声明 Node >= 18 |

---

## 十一、工期估算

| 阶段 | 保守 | 激进 |
|------|------|------|
| Phase 0 | 1.5 天 | 1 天 |
| Phase 1 | 1.5 天 | 1 天 |
| Phase 2 | 1.5 天 | 1 天 |
| Phase 3 | 0.5 天 | 0.5 天 |
| 测试与文档 | 1 天 | 0.5 天 |
| **合计** | **5–7 天** | **3–4 天** |
