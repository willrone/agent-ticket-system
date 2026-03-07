# 工单存储切换与迁移说明

## 存储类型

| 类型 | 环境变量 | 说明 |
|------|----------|------|
| JSON | `TICKETS_STORE=json`（默认） | 使用 `data/tickets.json` 存储 |
| SQLite | `TICKETS_STORE=sqlite` | 使用 `data/tickets.db` 存储 |

## 如何切换

### 使用 JSON（默认）

```bash
# 不设置或显式设置
export TICKETS_STORE=json
npm run dev:api
```

数据文件：`data/tickets.json`，可通过 `TICKETS_JSON_PATH` 自定义路径。

### 使用 SQLite

```bash
export TICKETS_STORE=sqlite
# 可选：自定义 DB 路径，默认 data/tickets.db
export TICKETS_DB_PATH=/path/to/tickets.db
npm run dev:api
```

## 如何迁移（JSON → SQLite）

1. **执行迁移脚本**（会先备份 `tickets.json` 为 `tickets.json.bak`）：

   ```bash
   npm run migrate
   ```

2. **切换为 SQLite 并启动**：

   ```bash
   export TICKETS_STORE=sqlite
   npm run dev:api
   ```

3. **验证**：确认 API 返回的工单数据与迁移前一致。

迁移脚本支持**幂等执行**：重复运行不会重复导入，按 id upsert 更新。

## 如何回滚（SQLite → JSON）

1. **停止服务**。

2. **恢复 JSON**（若迁移时生成了备份）：

   ```bash
   cp data/tickets.json.bak data/tickets.json
   ```

3. **切换回 JSON 并启动**：

   ```bash
   export TICKETS_STORE=json
   npm run dev:api
   ```

4. **可选**：删除 SQLite 文件 `data/tickets.db`（及 `-wal`、`-shm` 文件）。

## 环境变量汇总

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TICKETS_STORE` | 存储类型：`json` \| `sqlite` | `json` |
| `TICKETS_JSON_PATH` | JSON 文件路径（json 模式） | `data/tickets.json` |
| `TICKETS_DB_PATH` | SQLite 文件路径（sqlite 模式） | `data/tickets.db` |
