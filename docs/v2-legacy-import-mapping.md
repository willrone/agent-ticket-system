# ticket-platform v2 老库导入映射（#178）

_Updated: 2026-03-20_

本文只定义 **老库 SQLite → v2 rehearsal/cutover contract** 的最小映射口径，目标是支撑 #178 的导入校验与 cutover 预演；**不**在本轮引入生产写路径变更，也**不**直接改 live 8788 库结构。

## 1. 导入策略

- **导入单位**：以 SQLite DB 文件为单位复制（`tickets.db -> ticket-platform-v2.db`）
- **导入方式**：`scripts/rehearse-v2-cutover.js` 使用 SQLite backup 复制到 rehearsal DB
- **校验方式**：对关键业务表做行数一致性校验
- **运行方式**：v2 仅指向 rehearsal DB 启动，poller 默认关闭

这意味着本轮“导入”不是逐表 transform，而是：

1. 先保留老库事实表 / 投影视图 / assignment/worker 证据
2. 再用 v2 runtime/bootstrap/participant contract 在新宿主上读同一份事实
3. 通过 rehearsal 证明 cutover 可回滚、可验证、不会直接污染 live

## 2. 关键表映射

| 老库 / 当前 live SQLite 表 | v2 口径 | 本轮处理 |
|---|---|---|
| `tickets` | 工单主事实表 | 原样复制，校验行数 |
| `ticket_comments` | 评论流 / report interpreter 产物 | 原样复制，校验行数 |
| `ticket_dependencies` | 工单依赖关系 | 原样复制，校验行数 |
| `ticket_execution_workers` | subagent/acp worker 证据 | 原样复制，校验行数 |
| `ticket_assignments` | hosted assignment contract | 原样复制，校验行数 |
| `execution_reservations` | 单 agent running lane / worker gate 保留区 | 原样复制，校验行数 |
| `dispatch_events` | dispatch/receipt 历史 | 原样复制，校验行数 |
| `ticket_projection` | ticket read model | 原样复制，校验行数 |
| `worker_projection` | worker read model | 原样复制，校验行数 |
| `dispatch_ready_projection` | dispatch ready 投影 | 原样复制，校验行数 |
| `audit_ready_projection` | audit ready 投影 | 原样复制，校验行数 |
| `participant_registry` | participant registry 主表 | 原样复制，校验行数 |
| `participant_registry_status` | participant availability/status | 原样复制，校验行数 |
| `participant_registry_capabilities` | participant capability 视图 | 原样复制，校验行数 |

## 3. 字段口径说明

### 3.1 ticket workflow / actor chain
- `tickets.status` → 继续作为 workflow status 真值
- `tickets.assigned_agent / review_owner / triage_owner` → 继续作为 participant-based routing 的角色来源
- `tickets.current_actor / next_actor / next_actor_override` → 继续作为 live responsibility chain 的解释输入

### 3.2 assignment / worker evidence
- `ticket_assignments.assignment_id` → 继续作为 hosted assignment 主键
- `ticket_execution_workers.worker_key / session_key / run_id / status` → 继续作为 `execution.worker_evidence` 的直接证据
- `execution_reservations` → 保留 running lane 冲突控制与 stale reservation 清理语义

### 3.3 participant v2 contract
- `participant_registry*` 三张表不是额外迁移目标，而是 v2 bootstrap contract 的底座
- #178 本轮的 cutover 预演重点是：**确认这些 participant contract 相关表在 rehearsal DB 中能与 ticket / assignment / worker 一起被完整带起**

## 4. 验收口径

本轮认为导入/预演通过，至少满足：

1. `scripts/rehearse-v2-cutover.js` 成功输出 `ok=true`
2. 上述关键表在 source/target 行数一致
3. v2 进程能指向 rehearsal DB 启动
4. `GET /api/version` 与 `GET /api/v1/agent/runtime/context` 可访问
5. rollback 只需停 v2 / 删除 rehearsal DB，不触碰 live 8788 DB

## 5. 风险与边界

- **边界**：本轮不做 schema transform、不做 live 写路径切换、不做生产 cutover 执行
- **风险**：若只看 DB 可复制而不看 8790 运行态 smoke，容易出现“数据在、runtime 不通”的假通过
- **缓解**：rehearsal 必须同时保留脚本输出 + 8790 smoke/healthcheck 结果
- **回滚**：删除 `ticket-platform-v2.db`、停止 v2 进程即可；live 8788 继续保持原状
