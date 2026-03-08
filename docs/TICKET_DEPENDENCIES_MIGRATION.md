# 工单依赖关系迁移指南

## 背景

工单平台已引入正式的依赖关系模型（`ticket_dependencies` 表），用于表达兄弟子单之间的执行顺序和阻塞关系。

**关键变更：**
- `parent_ticket_id` 只保留"需求容器/层级"语义，不再表达执行顺序
- 兄弟子单的顺序/阻塞关系统一使用 `ticket_dependencies` 表达
- dispatch 层自动过滤未满足依赖的工单（依赖门禁）

## 迁移场景

### 场景 1：假父子顺序 → 兄弟单 + 依赖

**典型案例：#22 和 #23**

**旧模型（错误）：**
```
#22 (parent)
  └─ #23 (child)  // 用 parent_ticket_id 表达"#23 依赖 #22"
```

**新模型（正确）：**
```
#22 (独立工单)
#23 (独立工单) --depends_on--> #22
```

**迁移步骤：**

1. 清除错误的父子关系：
```sql
UPDATE tickets SET parent_ticket_id = NULL WHERE id = 23;
```

2. 添加正式依赖关系：
```sql
INSERT INTO ticket_dependencies (ticket_id, depends_on_ticket_id, dependency_type, created_at)
VALUES (23, 22, 'blocks', datetime('now'));
```

3. 验证依赖门禁：
```bash
# 测试：#22 未完成时，#23 不应出现在 dispatch ready
curl http://127.0.0.1:8788/api/dispatch/ready | jq '.ready[] | select(.ticket_id == 23)'
# 预期：无结果

# 测试：#22 完成后，#23 应出现在 dispatch ready
curl -X PATCH http://127.0.0.1:8788/api/tickets/22 \
  -H "Content-Type: application/json" \
  -d '{"status": "complete"}'

curl http://127.0.0.1:8788/api/dispatch/ready | jq '.ready[] | select(.ticket_id == 23)'
# 预期：返回 #23
```

### 场景 2：需求容器单 + 多个兄弟子单

**示例：**
```
#100 (需求容器单："实现用户认证系统")
  ├─ #101 (子单："后端 API")
  ├─ #102 (子单："前端 UI") --depends_on--> #101
  └─ #103 (子单："文档") --depends_on--> #102
```

**实现方式：**

1. 创建需求容器单：
```sql
INSERT INTO tickets (title, description, status, assigned_agent)
VALUES ('实现用户认证系统', '需求容器单', 'triage', 'leoss');
-- 假设返回 id = 100
```

2. 创建兄弟子单（保留 parent_ticket_id 表达容器关系）：
```sql
INSERT INTO tickets (title, parent_ticket_id, status, assigned_agent)
VALUES 
  ('后端 API', 100, 'queued', 'beavy'),  -- id = 101
  ('前端 UI', 100, 'queued', 'beavy'),   -- id = 102
  ('文档', 100, 'queued', 'beavy');      -- id = 103
```

3. 添加依赖关系（表达执行顺序）：
```sql
INSERT INTO ticket_dependencies (ticket_id, depends_on_ticket_id, dependency_type)
VALUES 
  (102, 101,  -- #102 依赖 #101
  (103, 102, 'blocks');  -- #103 依赖 #102
```

## API 使用

### 查询依赖关系

```bash
# 获取工单的依赖关系
curl http://127.0.0.1:8788/api/tickets/23/dependencies

# 返回格式：
{
  "dependencies": [
    {
      "id": 1,
      "ticket_id": 23,
      "depends_on_ticket_id": 22,
      "dependency_type": "blocks",
      "created_at": "2026-03-08T12:14:28.107Z",
      "title": "P1：Telegram 单入口只读查看版",
      "status": "running"
    }
  ],
  "dependents": []
}
```

### 添加依赖关系

```bash
curl -X POST http://127.0.0.1:8788/api/tickets/23/dependencies \
  -H "Content-Type: application/json" \
  -d '{"depends_on_ticket_id": 22, "dependency_type": "blocks"}'
```

### 删除依赖关系

```bash
curl -X DELETE http://127.0.0.1:8788/api/tickets/23/dependencies/22
```

## 依赖门禁规则

**dispatch ready 过滤逻辑：**

1. 工单进入 dispatch 候选池的条件：
   - `should_notify = true`
   - `next_actor` 不为空
   - **所有依赖的工单状态为 `complete` 或 `done`**

2. 未满足依赖的工单会被自动过滤，不会进入 dispatch ready

3. 依赖状态检查：
```javascript
// 后端实现（api/store-sqlite.js）
export function hasUnmetDependencies(ticketId) {
  const deps = database.prepare(`
    SELECT COUNT(*) as count
    FROM ticket_dependencies d
    JOIN tickets t ON d.depends_on_ticket_id = t.id
    WHERE d.ticket_id = ? AND t.status NOT IN ('complete', 'done')
  `).get(ticketId);
  return deps.count > 0;
}
```

## 前端使用

### 查询依赖关系

```javascript
import { fetchTicketDependencies } from '../api/tickets';

const { dependencies, dependents } = await fetchTicketDependencies(ticketId);
```

### 添加依赖

```javascript
import { addTicketDependency } from '../api/tickets';

await addTicketDependency(ticketId, dependsOnTicketId, 'blocks');
```

### 删除依赖

```javascript
import { removeTicketDependency } from '../api/tickets';

await removeTicketDependency(ticketId, dependsOnTicketId);
```

## 验证清单

迁移完成后，请验证以下项：

- [ ] 旧的 parent_ticket_id 关系已清除（如果是假父子顺序）
- [ ] 正式依赖关系已添加到 ticket_dependencies 表
- [ ] 依赖门禁生效：未满足依赖的工单不出现在 dispatch ready
- [ ] 前端可以查看依赖关系（dependencies/dependents）
- [ ] 前端可以添加/删除依赖关系

## 常见问题

**Q: 什么时候应该使用 parent_ticket_id？**
A: 只在表达"需求容器/层级"关系时使用，例如一个大需求拆分成多个子任务。不要用来表达执行顺序。

**Q: 什么时候应该使用 ticket_dependencies？**
A: 表达兄弟子单之间的执行顺序和阻塞关系时使用，例如"前端 UI 依赖后端 API 完成"。

**Q: 依赖关系支持哪些类型？**
A: 当前支持 `blocks` 类型，表示"阻塞"关系。未来可扩展其他类型（如 `relates_to`）。

**Q: 如何处理循环依赖？**
A: 当前系统不会自动检测循环依赖，需要人工避免。建议在添加依赖前检查是否会形成循环。

## 相关文件

- 数据库 schema: `api/store-sqlite.js` (initSchema)
- 依赖管理函数: `api/store-sqlite.js` (addDependency, removeDependency, etc.)
- dispatch 门禁: `api/app.js` (GET /api/dispatch/ready)
- 前端 API: `src/api/tickets.js` (fetchTicketDependencies, addTicketDependency, removeTicketDependency)
- 前端展示: `src/pages/TicketDetail.jsx` (待实现)
