# Agent Ticket System

一个基于 React + Express + SQLite 的工单系统，支持多 Agent 协同处理工单、状态流转、评论时间线与通知摘要。

当前状态机已区分 `paused（暂时挂起）` / `blocked（外部阻塞）` / `pending_decision（待决策）`：
- `paused`：责任链主动冻结，后续可恢复到挂起前状态；
- `blocked`：被外部依赖/权限/条件卡住；
- `pending_decision`：等待老大或 reviewer 拍板。
- `pause` 的执行身份按当前 workflow `current_actor` 动态解析，而不是固定 `assigned_agent`；例如 running 通常由执行人 pause，done/review 通常由 reviewer pause。

同时平台新增 **per-agent running gate**：
- 同一 `assigned_agent` 默认最多只能有 **1 张 `running` 工单**；
- 门禁不是只靠 `/api/dispatch/ready` 表面去重，而是直接落在 `POST /api/tickets/:id/transition` 的 `start_work` / `resume` 入口；
- 当该 agent 已有一张 `running` 工单时，第二张票会返回 `409 RUNNING_TICKET_CONFLICT`，并带出占用中的 ticket id、锁定信息和建议动作；
- `paused / done / pending_decision / blocked / failed / complete` 均不占用 running 名额。

## 多 Agent 平台通用化设计

- `docs/multi-agent-platform-design-v1.md`：把当前工单系统升级为通用多 Agent 协作平台的设计文档，定义默认四角色、Agent/Role/Capability/Workflow Template 等核心对象。
- Phase 1/2/3 当前为 **shadow mode**：新增 registry 表、routing preview 和 assignment v2 派生字段，不替换现有 dispatch / notify / assignment 推进行为。
- 当前只读 API：
  - `GET /api/v1/platform/agents`
  - `GET /api/v1/platform/capabilities`
  - `GET /api/v1/platform/role-contracts`
  - `GET /api/v1/platform/workflow-templates`
  - `POST /api/v1/platform/routing/preview`
  - `GET /api/v1/platform/routing/decisions`

## 开发命令

```bash
npm install
npm run dev       # 前端开发服务
npm run dev:api   # 后端 API（默认 8788）
npm test          # 单元测试
npm run build     # 前端构建
npm run lint      # 最小静态检查
npm run repo:hygiene          # 检查仓库内是否混入生成物
npm run repo:hygiene:cleanup  # 清理 api/data test/legacy db 与 .rollout
npm run release:check         # 发布前完整门禁：hygiene/lint/test/build/prod audit/MCP smoke/live fixture
```

## 文档分层（review / onboarding 时按这个顺序读）

- `docs/agent-first-run-guide.md`：**新 agent 第一次收到 assignment 的最短操作指南**；先读这个再干活。
- `docs/platform-empty-state-onboarding.md`：**全新空平台接入第一批 agent 的最小模板**；用于 no-agent 状态下注册 agent / domain / route smoke。
- `docs/examples/empty-platform-first-run-payloads.json`：空平台注册、heartbeat、route resolve、首个 smoke ticket 与首条 report 的机器可读模板。
- `README.md`：仓库入口、开发/运维启动、轮询器与常用命令。
- `docs/API.md`：平台总览、human/admin API、dispatch/notify/session cleanup 等跨角色接口。
- `docs/reference/api.md`：**agent-facing canonical contract**；`/api/v1/agent/*` 的权威参考。
- `docs/ticket-platform-current-state.md`：**live/runtime 现状真值**；review 时先核 live surface 再对照此文。
- `docs/ticket-platform-gap-analysis-and-plan.md`：差距、债务与后续规划，不作为当前 live contract。
- `docs/ticket-platform-doc-maintenance-policy.md`：文档更新与 reviewer gate 规则。

> 简单说：
> - 新 agent 第一次接单 → `docs/agent-first-run-guide.md`
> - 空平台第一次注册 agent → `docs/platform-empty-state-onboarding.md`
> - 想看“现在 live 是什么” → `docs/ticket-platform-current-state.md`
> - 想看“agent 应该怎么调用” → `docs/reference/api.md`
> - 想看“平台还有哪些历史/总览接口” → `docs/API.md`
> - 想看“未来还要补什么” → gap-analysis

## 存储说明（SQLite only）

当前版本仅使用 **SQLite** 持久化，不再支持 JSON 存储切换。

- live DB 路径：`data/tickets.db`
- 可通过环境变量覆盖：`TICKETS_DB_PATH`
- `data/backups/`：仅保留人工确认需要的备份，不应持续混入临时 sidecar
- `api/data/test-*.db*` / `api/data/legacy-*.db*`：测试/迁移生成物，**不应入仓**
- `.rollout/`：本地 rollout / 临时执行产物，**不应入仓**
- `tmp/`：本地 scratch 目录；空目录允许存在，非空会被 `repo:hygiene` 标记为待清理

### 仓库卫生规则（generated artifacts）

默认允许长期留在仓库中的只有：
- 源码、正式文档、脚本、测试代码
- 当前 live 所依赖的 `data/tickets.db`（以及明确保留的人工备份）

默认不应入仓的生成物：
- `api/data/test-*.db*`
- `api/data/legacy-*.db*`
- `data/agent-ticket-system.db*`（本地误生成/迁移副本）
- `data/*.db-shm` / `data/*.db-wal`
- `data/backups/*.db-shm` / `data/backups/*.db-wal`
- `.rollout/`

提交前建议至少执行一次：

```bash
npm run repo:hygiene
```

若只是清理本地生成物：

```bash
npm run repo:hygiene:cleanup
```

## 常驻启动（macOS LaunchAgent）

为了避免手动 `npm run dev:api`，仓库提供了 LaunchAgent 安装脚本：

```bash
./scripts/install-launchagent.sh
```

安装后：
- 服务标签：`ai.openclaw.ticket-platform-api`
- 会自动常驻拉起 `api/server.js`
- 默认 DB：`data/tickets.db`
- 日志路径：`logs/api.out.log` / `logs/api.err.log`
- API/轮询器日志使用结构化 JSON logger；常用环境变量：
  - `TICKET_LOG_LEVEL=debug|info|warn|error|silent`（默认：生产 `info`，测试 `warn`）
  - `TICKET_LOG_FORMAT=json|pretty`（默认：`json`，便于 grep/jq/日志系统采集）
  - `TICKET_LOG_STACKS=true`（仅排障时打开，错误日志会包含 stack）
- logger 会自动脱敏 token/secret/password/api_key/authorization/cookie 等字段，并对重复投递失败类日志做 rate limit 降噪。
- plist 会显式下发 poller / local base URL / delivery timeout / port / bind host / node bin 等环境变量，便于 live healthcheck 与排障对齐
- 如需并行拉 v2，可用 `scripts/create-v2-skeleton.sh` 生成同级 `agent-ticket-system-v2` 骨架；详见 `docs/v2-parallel-runbook.md`

卸载：

```bash
./scripts/uninstall-launchagent.sh
```

### live 8788 一键健康核验

仓库提供了一个**只读** healthcheck，专门核对 live 8788 contract / hosted bundle / poller / LaunchAgent / 端口接管状态，默认**不会自动重启、kill 进程或清队列**：

```bash
npm run healthcheck:live-8788
# 或
./scripts/healthcheck-live-8788.sh
```

默认检查项：
- `/api/version`、`/api/v1/agent/skills/current`、`/api/v1/agent/playbooks/ticket-handler`
- `/api/v1/agent/runtime/context`、`/api/workflow/schema`
- `/api/dispatch/ready`、`/api/notifications/ready`
- LaunchAgent plist 是否存在、`launchctl print` 是否已加载/运行
- 8788 是否只有一个监听进程、`api/server.js` 是否被旧手工进程重复启动
- `logs/api.out.log` 是否出现 internal poller 启动痕迹
- `logs/api.err.log` 最近窗口是否出现明显异常信号

可选环境变量：
- `TICKET_EXPECTED_SKILL_VERSION` / `TICKET_EXPECTED_SKILL_CHECKSUM`：要求 live hosted bundle 与预期版本/校验和一致，否则直接 FAIL
- `TICKET_HEALTHCHECK_VALIDATE_FIXTURES=1`：额外执行 `npm run validate:live-contract-fixtures`
- `TICKET_HEALTHCHECK_REPLAY_FIXTURES=1`：额外执行 `npm run replay:live-contract-fixtures`（更重，适合上线前/后 smoke）

退出码约定：
- `0` = PASS
- `1` = WARN（需要人工复核，但未发现明确硬失败）
- `2` = FAIL（live 未接管 / 旧进程占端口 / checksum 漂移 / 关键接口异常）

## 内置轮询线程（平台直驱）

`npm run dev:api` / `node api/server.js` 启动后会内置 2 个轮询线程，**由平台直接投递到目标会话**，不再经 Sheeply 中转：

1. **dispatch poller**（默认 5 分钟）
   - 检测 `/api/dispatch/ready`
   - 先由 **agent delivery router** 解析 `target_gateway_id / transport / target_session_key`
   - 当前内建 topology：`mac-main` 承载 `beavy/leoss/...`，`pc-stock` 承载 `cowder/donky`
   - 本地 agent 走 `local_cli`；PC 远端 agent 走 `ssh_gateway_call`（SSH 到远端执行 `openclaw gateway call chat.send`）
   - 未知 agent（如 workflow_mismatch 告警对象）回退到 `mac-main` 的 `agent:main:ticket:<ticket_id>`
   - 仅当 OpenClaw `chat.send` 成功（且未超时）时才调用 `/api/dispatch/:id/ack`，超时/错误一律不 ack
   - 每次投递都会记录 `target_gateway_id / transport / target_session_key / ok / error` 到 `delivery_attempts`
   - 派单文案会显式要求执行会话在推进状态前先把关键进展写入自身工作区记忆，避免主会话不知道发生了什么
2. **notify poller**（默认 2 分钟）
   - 检测 `/api/notifications/ready`
   - **不再承担 reviewer 主交接**；`done/review -> reviewer` 统一走 `dispatch poller + dispatch_receipt`
   - `pending_decision/complete/failed`：强制回 `mac-main` 主控，不继续发给远端执行位
   - dispatch / notify ready 现都显式返回 `reason / dedupe_key / escalation_tier`，用于解释路由、去重与升级层级
   - 仅 delivery 成功后才 ack 对应 notification 事件；失败会保留 ready 以便重试

> **Sheeply（agent:auditor:main）** 仅保留工单审计等角色，**不再参与 dispatch/notify 执行链路**。业务判断仍由 `/api/dispatch/ready` 与 `/api/notifications/ready` 的 API 决定；平台只负责按 ready 结果直驱投递与严格 ack。
>
> 额外约束：dispatch 不再打到 agent 主会话，而是按 `ticket_id` 进入独立 ticket session。这样能避免 agent 主会话上下文被持续堆爆；同时要求执行会话在完成当前阶段前把关键进展写入共享工作区记忆，让主会话与后续会话都能接上上下文。

3. **audit poller**（默认 10 分钟）
   - 检测 `/api/audits/ready`，识别长期未动工单
   - 按 `ticket_id` 投递到 Sheeply 独立审计会话：`agent:auditor:audit:<ticket_id>`
   - Sheeply **仅做审计判断**，通过 `POST /api/audits/:id/result` 回传结构化结果；平台统一写回系统评论并决定是否生成催办 nudge
   - 仅当 `chat.send` 成功时才 ack，timeout/error 不 ack；若已 ack 但长时间未收到 result，会按 `AUDIT_REQUEST_RETRY_MINUTES` 重试同一审计请求
   - 审计触发条件（阈值可通过环境变量配置）：
     - `running` 超过 30 分钟无更新
     - `review` 超过 2 小时无更新
     - `pending_decision` 超过 12 小时无更新
   - 审计结果只负责判断，不直接改状态；平台会基于结果生成统一催办闭环：
     - `queued`：平台直接发 `queued_stale` 催办给执行位
     - `running`：Sheeply 回传判断后，平台发 `audit_result` 催办给建议责任人
     - `review`：Sheeply 回传判断后，平台发 `audit_result` 催办给 reviewer / 建议责任人
   - 审计事件与催办事件都会在评论、worker 活动、状态切换后重置，避免旧判断长期残留

### Ticket session 安全清理

为避免 `agent:<agent>:ticket:<ticket_id>` 型独立 ticket session 长期堆积，平台新增了**定向清理**能力：

- 仅匹配 `agent:*:ticket:*`，**不会触碰主会话**（如 `agent:beavy:main` / `agent:main:telegram:direct:*`）
- 默认只清理 `complete / failed` 工单对应的 ticket session
- 默认保留期 `14` 天
- 默认 `dry-run`，先输出将命中的 sessionKey / ticket_id / store_path
- `enforce` 时会：
  1. 先备份对应 `sessions.json` 为 `sessions.json.bak.ticket-cleanup.<timestamp>`
  2. 从 session store 删除命中的 ticket session entry
  3. 将 transcript 重命名为 `*.jsonl.deleted.<timestamp>`，便于回滚

CLI：

```bash
npm run ticket-sessions:cleanup
node scripts/ticket-session-cleanup.js --dry-run
node scripts/ticket-session-cleanup.js --enforce
node scripts/ticket-session-cleanup.js --dry-run --retention-days 30 --statuses complete,failed
```

API：

```bash
curl -X POST http://127.0.0.1:8788/api/admin/ticket-sessions/cleanup \
  -H 'Content-Type: application/json' \
  -d '{"dry_run":true}'

curl -X POST http://127.0.0.1:8788/api/admin/ticket-sessions/cleanup \
  -H 'Content-Type: application/json' \
  -d '{"enforce":true,"retention_days":14,"cleanup_statuses":["complete","failed"]}'
```

回滚：

1. 用生成的 `sessions.json.bak.ticket-cleanup.<timestamp>` 覆盖原 `sessions.json`
2. 将 `*.jsonl.deleted.<timestamp>` 重命名回原始 `*.jsonl`
3. 再执行一次 `openclaw sessions --all-agents --json` 或最小业务验证，确认 session 恢复

> 说明：这里是围绕工单平台 ticket session 做定向治理；OpenClaw 通用 `openclaw sessions cleanup` 仍负责全局 age/count 维护。两者职责分离：平台负责“选谁能删”，OpenClaw 负责“全局维护与健康检查”。

### 相关环境变量

- `TICKET_INTERNAL_POLLERS_ENABLED`：是否启用内置轮询（代码默认 `true`；LaunchAgent 安装脚本默认显式写入 `true`）
- `TICKET_DISPATCH_POLL_INTERVAL_MS`：dispatch 轮询间隔（代码默认 `5000`；LaunchAgent 安装脚本默认显式写入 `5000`）
- `TICKET_NOTIFY_POLL_INTERVAL_MS`：notify 轮询间隔（代码默认 `5000`；LaunchAgent 安装脚本默认显式写入 `5000`）
- `TICKET_AUDIT_POLL_INTERVAL_MS`：audit 轮询间隔（代码默认 `30000`；LaunchAgent 安装脚本默认显式写入 `30000`）
- `AUDIT_REQUEST_RETRY_MINUTES`：audit 已投递但迟迟未收到 result 时的重试窗口（默认 `30` 分钟）
- `QUEUED_NUDGE_STALE_MINUTES`：queued 工单进入平台催办的滞留阈值（默认 `30` 分钟）
- `TICKET_NUDGE_THROTTLE_MINUTES`：同一 ticket + agent + nudge_key 的催办节流窗口（默认 `60` 分钟）
- `TICKET_DELIVERY_TIMEOUT_MS`：单次 chat.send 超时（默认 `30000`），超时则不 ack
- `TICKET_API_BIND_HOST`：API 监听地址（默认 `127.0.0.1`）；需要让 PC 远端 agent 直连时，可显式设为 `0.0.0.0`
- `TICKET_API_LOCAL_BASE_URL`：API 进程内部/poller 回环地址（默认 `http://127.0.0.1:8788`），即使对外绑定 `0.0.0.0` 也建议保持 loopback
- `TICKET_AGENT_API_BASE_URL`：下发给 agent-facing assignment contract 的外部可访问 API 地址；远端 Gateway 场景必须显式配置，避免给 PC agent 错发 `127.0.0.1:8788`
- `review_owner`：平台级显式 reviewer 字段；human/console create/edit 可直接设置，agent-facing create 仍禁止直接覆盖，由平台统一控制 review routing / dispatch / approve/reject contract
- `TICKET_AGENT_ADMIN_TOKENS_JSON`：agent-admin token registry；用于 `/api/v1/admin/*` stock 管理接口，典型 grant 形如 `{ "cowder_stock_admin": { "token": "...", "agent_id": "cowder", "capabilities": ["stock_tickets:read","stock_tickets:comment","stock_tickets:transition"] } }`

## Stock Agent Admin API

用于 **stock-platform 工单管理员角色** 的受控管理接口；与 assignment token 的 agent-facing API 分离。

- canonical namespace：`/api/v1/admin/*`
- legacy alias：`/api/admin/*`
- 鉴权：`Authorization: Bearer <agent-admin-token>`（推荐）或 `X-Agent-Admin-Token`
- token 来源：`TICKET_AGENT_ADMIN_TOKENS_JSON`
- 角色：`agent_admin`
- capabilities：`stock_tickets:read` / `stock_tickets:comment` / `stock_tickets:transition`
- scope：仅允许管理 `platform=stock-platform` 工单

当前接口：
- `GET /api/v1/admin/stock-tickets`
- `GET /api/v1/admin/stock-tickets/:id`
- `GET /api/v1/admin/stock-tickets/:id/actions`
- `GET /api/v1/admin/stock-tickets/:id/comments`
- `POST /api/v1/admin/stock-tickets/:id/comments`
- `POST /api/v1/admin/stock-tickets/:id/transition`

约束：
- agent-admin token **不要**与 `assignment_token` 混用
- comment / transition 不允许伪装其他 `author` / `actor`
- 非 stock ticket 会返回 `AGENT_ADMIN_SCOPE_FORBIDDEN`

更完整的请求/错误模型说明见 `docs/API.md`；agent-facing canonical contract 仍以 `docs/reference/api.md` 为准。

## Agent-Facing Skill / Playbook Bundle

平台会托管一份 versioned 的 `ticket-handler` operating bundle，供本地/远端 agent 统一拉取，不依赖宿主机预置静态 `SKILL.md`。

> Agent-facing API 的权威参考见 `docs/reference/api.md`。该文档以 `/api/v1/agent/*` 为 canonical namespace，`/api/agent/*` 仅作为 legacy alias 说明。

### 设计目标
- `assignment` / `runtime context` 只负责下发当前任务与 bootstrap 入口
- `GET /api/v1/agent/skills/current` / `GET /api/v1/agent/playbooks/ticket-handler` 返回当前 bundle（legacy alias：`/api/agent/...` 仍保留）
- bundle 同时包含：
  - `markdown`：给 agent/人阅读的执行说明
  - `manifest`：machine-readable contract（`skill_id/version/checksum/allowed_report_types/rules/constraints/bootstrap/execution_mode_guidance/writeback_templates`）
- 仍保持 single-writer：agent 只能 read / heartbeat / report，不能直接写 ticket comment / transition

### 当前 bundle 关键字段
- `skill_id=ticket-handler`
- `version=2026-03-12.bundle.v8`
- `constraints.single_writer=true`
- `constraints.direct_ticket_write_allowed=false`
- `allowed_report_types` 与 `/api/v1/agent/workflow/schema` / report interpreter 保持一致
- `manifest.execution_mode_guidance`：统一 direct / subagent / acp 的下沉策略、ticket session 协调职责与摘要模板
- `manifest.writeback_templates`：统一 heartbeat / dispatch_receipt / progress_update / execution_completed / blocked_report / decision_request / execution_failed 示例负载

### 最小 bootstrap path
1. `GET /api/v1/agent/runtime/context`
2. `GET /api/v1/agent/assignments/:assignment_id`（先看 `ticket.execution_mode` / `execution`）
3. `GET /api/v1/agent/skills/current`（或 `GET /api/v1/agent/playbooks/ticket-handler`，读取 `execution_mode_guidance` / `writeback_templates`）
4. 需要更多上下文时再读 assignment comments / dependencies
5. assignment 送达后先提交 `dispatch_receipt`；执行过程中继续仅使用 heartbeat / reports 回写，由平台解释为 comment / transition / notify

### report interpreter 当前桥接规则
- `dispatch_receipt`：只有 `decision=accepted` 才推进 workflow / 收口 reviewer 收单语义
  - `stage=queued`：推进 `start_work`（`queued -> running`）
  - `stage=done`：推进 `start_review`（`done -> review`）
  - `stage=review`：不推进新状态，只把这次派单记为 reviewer 已正式接单并停止重派
  - 非 `accepted`：只记录 receipt/comment，不推进状态
- `triage_structured_report`：当 `triage.verdict=queue`、`triage.is_executable=true`、目标状态为 `queued`，且责任链至少补齐 `triage_owner/assigned_agent/review_owner` 时，平台自动桥接 `triage -> queue`；若缺链则保持 `triage`，并返回 machine-readable reason（默认 `TRIAGE_QUEUE_CHAIN_INCOMPLETE`）
- `execution_completed` / `review_submission`：`queued` 会自动桥接 `start_work -> submit_for_review`，`running` 直接 `submit_for_review`
- 但 `execution_mode=subagent/acp` 时，若 `ticket.worker_stats/current_workers/execution_workers` 看不到真实 worker 证据，则不会自动提审
- `decision_request` / `blocked_report` / `execution_failed`：若 ticket 仍在 `queued`，会先自动 `start_work`，再落到目标状态
- 这样 agent 不需要为了合法 workflow 先额外手动补一层 `start_work`
- `TICKET_GATEWAY_PC_STOCK_SSH_DESTINATION`：PC 远端 Gateway 的 SSH 目标（优先，如 `willrone@192.168.3.89`）
- `TICKET_GATEWAY_PC_STOCK_SSH_HOST` / `TICKET_GATEWAY_PC_STOCK_SSH_USER` / `TICKET_GATEWAY_PC_STOCK_SSH_PORT`：未提供 destination 时的拆分配置
- `TICKET_GATEWAY_PC_STOCK_OPENCLAW_BIN`：远端 openclaw 可执行路径（默认 `openclaw`）
- `TICKET_GATEWAY_REGISTRY_JSON` / `TICKET_AGENT_GATEWAY_OVERRIDES_JSON`：覆盖默认 topology / agent->gateway 映射
- `AUDIT_STALE_RUNNING_MINUTES`：running 状态审计阈值（默认 `30`，即 30 分钟）
- `AUDIT_STALE_REVIEW_MINUTES`：review 状态审计阈值（默认 `10`，即 10 分钟）
- `AUDIT_STALE_PENDING_DECISION_MINUTES`：pending_decision 状态审计阈值（默认 `720`，即 12 小时）

## 评论增强 v2 API

### 1) 新增评论

`POST /api/tickets/:id/comments`

请求体：

```json
{
  "content": "阻塞 @ops 需要确认",
  "author": "donky",
  "type": "blocker",
  "visibility": "internal",
  "thread_id": "th-ops",
  "mentions": ["qa"]
}
```

字段约束：
- `type`: `progress|blocker|decision|result|system`
- `visibility`: `internal|public`
- `content`: 必填，长度 <= 10000
- `thread_id`: 可选，长度 <= 256
- `author`: 可选，自动截断到 64 字符

响应示例：

```json
{
  "id": 1741300000000123,
  "author": "donky",
  "timestamp": "2026-03-07T00:00:00.000Z",
  "content": "阻塞 @ops 需要确认",
  "type": "blocker",
  "visibility": "internal",
  "thread_id": "th-ops",
  "mentions": ["qa", "ops"],
  "notify_targets": ["qa", "ops", "leader"]
}
```

> 规则：仅当存在 `mentions` 时，`notify_targets = mentions + watchers`（去重）。

### 2) 评论列表（支持过滤）

`GET /api/tickets/:id/comments?type=blocker&visibility=internal&thread_id=th-ops`

响应示例：

```json
{
  "ticket_id": 11,
  "filters": {
    "type": "blocker",
    "visibility": "internal",
    "thread_id": "th-ops"
  },
  "total": 1,
  "comments": [
    {
      "id": 1741300000000123,
      "author": "donky",
      "timestamp": "2026-03-07T00:00:00.000Z",
      "content": "阻塞 @ops 需要确认",
      "type": "blocker",
      "visibility": "internal",
      "thread_id": "th-ops",
      "mentions": ["qa", "ops"],
      "notify_targets": ["qa", "ops", "leader"]
    }
  ]
}
```

### 3) 更新 watchers / reviewer

`PATCH /api/tickets/:id`

请求体示例：

```json
{
  "watchers": ["leader", "ops"],
  "review_owner": "ronghui"
}
```

说明：
- `review_owner` 现在是平台级通用显式能力
- human/console 可在创建或编辑工单时直接设置
- 一旦工单处于 `done/review`，`review_owner` 会直接决定当前 reviewer 责任人与 `/api/dispatch/ready` 的主交接目标；`/api/notifications/ready` 不再承担 reviewer 主交接

## 已知说明

- 当前无用户认证，`author` 仍属于“客户端可传”模式；生产环境建议接入鉴权并由服务端注入作者身份。
- 测试日志里可能有 React `act(...)` 警告，不影响用例通过。
