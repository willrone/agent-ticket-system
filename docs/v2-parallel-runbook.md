# ticket-platform v2 并行运行骨架（最小闭环）

目标：在不影响现有 8788 老平台的前提下，拉起一个可并行运行的 v2 骨架。

## 隔离约定
- 主工程：`/Users/ronghui/Projects/agent-ticket-system`
- v2 骨架：`/Users/ronghui/Projects/agent-ticket-system-v2`
- 老平台端口：`8788`
- v2 端口：`8790`（本轮唯一 canonical 验收入口）
- 老平台 DB：`data/tickets.db`
- v2 DB：`data/ticket-platform-v2.db`
- 老平台 LaunchAgent：`ai.openclaw.ticket-platform-api`
- v2 LaunchAgent：`ai.openclaw.ticket-platform-api-v2`
- 8788 只作为 live 对照面；**不是**本轮 v2 验收入口
- v2 poller：默认关闭，避免误动现网 ready/notify/audit 链路

## 创建 v2 骨架
```bash
cd /Users/ronghui/Projects/agent-ticket-system
./scripts/create-v2-skeleton.sh
```

脚本策略：
- 基于 rsync 同步最小必要源码
- 排除 `.git` / `node_modules` / `dist` / `data` / `logs`
- 自动创建空 `data/`、`logs/`、`tmp/`
- 自动把 `node_modules` 做成指向主工程的符号链接，避免复制巨型依赖

## 启动 v2
```bash
cd /Users/ronghui/Projects/agent-ticket-system-v2
./scripts/run-api-v2.sh
```

默认环境：
- `TICKET_API_PORT=8790`
- `TICKETS_DB_PATH=$REPO_DIR/data/tickets-v2.db`
- `TICKET_INTERNAL_POLLERS_ENABLED=false`
- `TICKET_BACKUP_BEFORE_START=false`

## 老库导入 + cutover 预演
### 1) 复制老库到 v2 rehearsal DB
```bash
cd /Users/ronghui/Projects/agent-ticket-system
node scripts/rehearse-v2-cutover.js \
  --source data/tickets.db \
  --target data/ticket-platform-v2.db \
  --overwrite --json
```

脚本行为：
- 只读打开老库 `data/tickets.db`
- 用 SQLite backup 方式复制到 `data/ticket-platform-v2.db`
- 对 `tickets / ticket_comments / ticket_dependencies / ticket_execution_workers / ticket_assignments / execution_reservations / dispatch_events / ticket_projection / worker_projection / dispatch_ready_projection / audit_ready_projection / participant_registry*` 中存在的表做行数比对
- 输出 machine-readable JSON，适合贴到工单/review 里做 rehearsal 证据

### 2) 用复制出的 rehearsal DB 启动 v2
```bash
cd /Users/ronghui/Projects/agent-ticket-system-v2
TICKETS_DB_PATH=$PWD/data/tickets-v2.db ./scripts/run-api-v2.sh
```

### 3) smoke / healthcheck
```bash
curl http://127.0.0.1:8790/api/version
curl http://127.0.0.1:8790/api/v1/agent/runtime/context
./scripts/healthcheck-v2.sh
```

### 4) 回滚原则
- rehearsal 只操作 `ticket-platform-v2.db`，不直接改 8788 live 库
- 若预演失败，删除 v2 DB / 停 v2 进程即可
- 生产 cutover 前仍应保留 `backup-tickets-db.sh` 产出的 live 备份

## 安装 v2 LaunchAgent
```bash
cd /Users/ronghui/Projects/agent-ticket-system-v2
./scripts/install-launchagent-v2.sh
```

## 老库导入（rehearsal DB）
如果要做“老库导入 + cutover 预演”，不要直接让 v2 指向现网 `data/tickets.db`，而是先复制出一份 rehearsal DB：

```bash
npm run cutover:rehearse:v2 -- \
  --source data/tickets.db \
  --target tmp/ticket-platform-v2-rehearsal.db \
  --overwrite
```

通过标准：
- source / target 路径不同
- 关键表行数比对一致
- 输出可留痕到 ticket / review

更完整步骤见：`docs/ticket-platform-v2-cutover-rehearsal.md`

## 最小 smoke
```bash
curl http://127.0.0.1:8788/api/version
curl http://127.0.0.1:8790/api/version
curl -X POST http://127.0.0.1:8790/api/tickets \
  -H 'Content-Type: application/json' \
  -d '{"title":"v2 smoke","assigned_agent":"beavy"}'
curl http://127.0.0.1:8790/api/tickets/1
```

## 参考文档
- `docs/v2-legacy-import-mapping.md`：老库字段 / 表到 v2 contract 的最小映射口径

## 回滚
- 停止 v2 进程即可，不影响 8788
- 若使用 LaunchAgent：`./scripts/uninstall-launchagent-v2.sh`
- v2 数据、日志均只在 v2 目录内，删除 `agent-ticket-system-v2` 即可整体回滚
