# ticket-platform MCP server 与 agent harness 实施方案

_Last updated: 2026-06-02_

## 0. 范围与原则

本方案只规划第一阶段可落地的最小集成：在现有 ticket-platform HTTP contract 外包一层 MCP server，并在 agent harness 内置 MCP client，让 agent 可以通过 MCP 完成 bootstrap、读上下文、回写心跳和提交结构化报告。

原则：
- MCP server 只做协议适配，不重新实现 workflow/state machine，不直接读写 SQLite。
- 现有 `/api/v1/agent/*` 是 agent contract 的单一来源；`/api/dispatch/*` 只作为投递/回执平面。
- 平台继续保持 single writer：agent 不直接写 comment、不直接改 status、不直接决定 dispatch/notify。
- 第一阶段优先 assignment-scoped 使用；dispatch polling 可以作为 harness runner 模式的受控扩展。

## 1. ticket-platform MCP server 最小工具/资源列表

### 1.1 Server 配置

最小运行配置：

| 配置项 | 用途 |
|---|---|
| `TICKET_API_BASE_URL` | ticket-platform HTTP API base，例如 `http://127.0.0.1:8788` |
| `TICKET_ASSIGNMENT_ID` | 当前 agent assignment id；assignment-scoped 模式必填 |
| `TICKET_ASSIGNMENT_TOKEN` | 当前 assignment token；通过 `X-Assignment-Token` 转发 |
| `TICKET_AGENT_ADMIN_TOKEN` | 可选；仅用于 dispatch polling / admin workboard 等非 assignment-scoped 操作 |
| `TICKET_MCP_REQUEST_ID_PREFIX` | 可选；生成 `X-Request-Id`，便于 trace |

### 1.2 Resources

Resources 用于稳定、只读、可被模型作为上下文引用的 contract。第一阶段建议暴露以下 resource templates：

| Resource URI | 来源 HTTP surface | 鉴权 | 内容 |
|---|---|---|---|
| `ticket-platform://version` | `GET /api/version` | 无 | `git_commit`、`schema_version`、`bundle_version`、`build_time` |
| `ticket-platform://workflow/schema` | `GET /api/v1/agent/workflow/schema` | 无或 assignment token | workflow 状态、角色、notify policy、可用 action 基线 |
| `ticket-platform://runtime/context/{assignment_id}` | `GET /api/v1/agent/runtime/context?assignment_id=...` | assignment token | namespace、auth、error model、bootstrap endpoints、skill/playbook refs、ticket actions |
| `ticket-platform://assignments/{assignment_id}` | `GET /api/v1/agent/assignments/:assignment_id` | assignment token | assignment、ticket、reply_contract、delivery snapshot |
| `ticket-platform://assignments/{assignment_id}/comments` | `GET /api/v1/agent/assignments/:assignment_id/comments` | assignment token | assignment 相关评论流 |
| `ticket-platform://assignments/{assignment_id}/dependencies` | `GET /api/v1/agent/assignments/:assignment_id/dependencies` | assignment token | 依赖快照、阻塞关系 |
| `ticket-platform://skills/current` | `GET /api/v1/agent/skills/current` | assignment token | hosted skill bundle |
| `ticket-platform://playbooks/ticket-handler` | `GET /api/v1/agent/playbooks/ticket-handler` | assignment token | hosted playbook bundle |
| `ticket-platform://participants` | `GET /api/v1/agent/participants` | assignment token | participant registry 快照 |

可选 resource template：
- `ticket-platform://workboards/stock-tickets?status=...&bucket=...&group_by=...`：对应 `GET /api/v1/agent/workboards/stock-tickets`，用于 stock-platform 管理面或 reviewer 盘面。
- `ticket-platform://tickets/{ticket_id}/operational-view`：对应 `GET /api/control/tickets/:id/operational-view`，用于 reviewer / auditor 聚合视图；第一阶段可先不接入 agent 默认上下文。

### 1.3 Tools

Tools 用于需要参数校验、写入、回执或受控 action 的操作。第一阶段最小列表：

| Tool | HTTP surface | 入参 | 出参 | 说明 |
|---|---|---|---|---|
| `ticket_platform_get_runtime_context` | `GET /api/v1/agent/runtime/context` | `assignment_id` | runtime context | 允许 harness 显式刷新上下文 |
| `ticket_platform_get_assignment` | `GET /api/v1/agent/assignments/:assignment_id` | `assignment_id` | assignment contract | agent 每次执行前的主读取入口 |
| `ticket_platform_read_comments` | `GET /api/v1/agent/assignments/:assignment_id/comments` | `assignment_id` | comments | 只读 |
| `ticket_platform_read_dependencies` | `GET /api/v1/agent/assignments/:assignment_id/dependencies` | `assignment_id` | dependencies | 只读 |
| `ticket_platform_list_participants` | `GET /api/v1/agent/participants` | `platform_id?`、`participant_id?`、`role_key?` | participants | 路由与协作者发现 |
| `ticket_platform_resolve_route` | `GET /api/v1/agent/routing/resolve` | `participant_id?`、`platform_id?`、`role_key?`、`reason?` | route contract | 避免 harness 猜测责任链 |
| `ticket_platform_send_heartbeat` | `POST /api/v1/agent/assignments/:assignment_id/heartbeat` | `assignment_id`、`status`、`message?`、`progress?` | heartbeat result | 执行中活性信号 |
| `ticket_platform_submit_report` | `POST /api/v1/agent/assignments/:assignment_id/reports` | `assignment_id`、`report_type`、`payload` | interpreted report result | 支持 `progress_update`、`dispatch_receipt`、`execution_completed`、`execution_failed`、`blocked_report`、`decision_request`、`review_submission` 等 |
| `ticket_platform_create_ticket` | `POST /api/v1/agent/tickets` | `title`、`description?`、`platform?`、`triage_owner?`、`assigned_agent?`、`review_owner?`、`parent_ticket_id?` | created ticket | 仍由平台负责责任链和默认值 |
| `ticket_platform_ticket_action` | `POST /api/v1/agent/tickets/:id/:action` | `ticket_id`、`action`、`actor`、`reason/result_summary/reject_reason/...` | updated ticket / error | 受控 action：`queue`、`start_work`、`pause`、`resume`、`resume_from_decision`、`approve`、`reject`、`deprecate` |

runner 模式可选工具：

| Tool | HTTP surface | 入参 | 说明 |
|---|---|---|---|
| `ticket_platform_list_dispatch_ready` | `GET /api/dispatch/ready` | `agent?`、`limit?` | 需要 admin/transport 级凭据，不默认给普通 assignment-scoped agent |
| `ticket_platform_ack_dispatch` | `POST /api/dispatch/ack` | `dispatch_id` | 只表示 transport 已送达，不代表 agent 接单 |
| `ticket_platform_list_notifications_ready` | `GET /api/notifications/ready` | `target?`、`limit?` | 仅用于通知 runner，不作为 agent 主工作入口 |

### 1.4 MCP 到 HTTP 的适配约束

- 所有 assignment-scoped 调用统一带 `X-Assignment-Token`。
- 所有调用透传或生成 `X-Request-Id`，并把 HTTP 错误 `{detail, request_id}` 原样映射到 MCP tool error。
- MCP server 不缓存写请求结果；只可对 version、workflow schema、skill/playbook bundle 做短 TTL 只读缓存。
- `ticket_platform_submit_report` 必须校验 `report_type` 是否属于当前 hosted manifest 允许集合。
- `ticket_platform_ticket_action` 必须从 runtime context 的 `ticket_actions` 或 workflow schema 校验 action 是否 discoverable，避免硬编码旧动作。

## 2. agent harness 内置 MCP client 的最小架构

### 2.1 组件

```text
agent harness
├─ mcpClient
│  ├─ connection manager
│  ├─ tool/resource registry cache
│  ├─ request-id / trace middleware
│  └─ retry / timeout policy
├─ ticketPlatformAdapter
│  ├─ bootstrapAssignment()
│  ├─ loadExecutionContext()
│  ├─ heartbeatLoop()
│  ├─ submitReport()
│  └─ closeout()
├─ contextAssembler
│  ├─ runtime context
│  ├─ assignment contract
│  ├─ workflow schema
│  ├─ skill/playbook bundle
│  ├─ comments / dependencies
│  └─ summarized prompt context
└─ executionController
   ├─ direct mode executor
   ├─ subagent mode handoff
   ├─ cancellation / pause handling
   └─ final report guard
```

### 2.2 Bootstrap 流程

assignment-scoped 模式：

1. harness 从 env / launch payload 读取 `assignment_id` 和 `assignment_token`。
2. `mcpClient` 连接 ticket-platform MCP server，列出 tools/resources。
3. 先读 `ticket-platform://version`，记录 runtime version。
4. 调用 `ticket_platform_get_runtime_context`。
5. 调用 `ticket_platform_get_assignment`。
6. 并行读取 workflow schema、skill bundle、playbook bundle、comments、dependencies。
7. `contextAssembler` 生成 agent 初始上下文。
8. `heartbeatLoop` 开始周期性调用 `ticket_platform_send_heartbeat`。
9. 执行器只通过 `ticket_platform_submit_report` 和受控 `ticket_platform_ticket_action` 回写。

runner 模式：

1. harness 使用 admin/transport 凭据调用 `ticket_platform_list_dispatch_ready`。
2. 对 ready item 执行 transport 投递后调用 `ticket_platform_ack_dispatch`。
3. 被投递的 agent session 仍回到 assignment-scoped 模式执行。

### 2.3 最小状态机

harness 内部不复制平台 workflow，只维护本地执行状态：

| Harness state | 含义 | 允许输出 |
|---|---|---|
| `bootstrapping` | 正在读取 version/context/assignment | 无写入，除 request log |
| `ready` | 上下文完整，可开始执行 | `dispatch_receipt=accepted` |
| `running` | agent 正在处理 | heartbeat、progress report |
| `blocked` | agent 判断无法继续 | `blocked_report` 或 `decision_request` |
| `submitting` | 正在提交完成/失败/评审报告 | `execution_completed`、`execution_failed`、`review_submission` |
| `closed` | 本地执行结束 | 停止 heartbeat |
| `failed_local` | harness 本地失败 | `execution_failed`；若无法提交则落本地审计日志 |

### 2.4 错误、重试与幂等

- GET/resource 读取：可重试 2 次，指数退避，总超时不超过 10 秒。
- heartbeat：失败不阻断主执行，但连续失败需要进入本地 warning，并在最终 report 附带失败窗口。
- report / ticket action：不做盲目无限重试；若 HTTP/MCP 返回 `request_id`，记录到本地 trace。
- dispatch receipt、execution completed、review submission 等关键 report 需要由 payload 提供 `idempotency_key` 或由 harness 基于 `assignment_id + report_type + phase` 生成。
- 遇到 401/403 立即停止写入，提示 assignment token 失效，不尝试改用 human bearer token。

### 2.5 Context 注入边界

harness 给 agent 的上下文应包含：
- 当前 runtime version、workflow schema version、bundle version。
- assignment id、ticket id、title、status、current actor、reply contract。
- 可调用 MCP tools 的简短说明。
- comments/dependencies 的压缩摘要。
- 明确禁止事项：不要直接调用非 contract HTTP route，不要绕过 report API 写状态。

不应包含：
- assignment token 明文。
- admin token。
- 与当前 assignment 无关的全量 ticket DB。
- 未经压缩的超长历史评论，除非 agent 明确请求读取。

## 3. 第一阶段可落地文件清单

以下清单按最小闭环排序，不要求一次全部上线；每项都应有对应测试。

### 3.1 ticket-platform MCP server

| 文件 | 类型 | 内容 |
|---|---|---|
| `api/mcp/server.js` | 新增 | MCP server 启动入口；注册 resources/tools；读取 env 配置 |
| `api/mcp/ticket-platform-client.js` | 新增 | HTTP client 封装；统一 base URL、headers、request id、错误映射 |
| `api/mcp/resources.js` | 新增 | resource templates：version、workflow schema、runtime context、assignment、comments、dependencies、skills、playbook、participants |
| `api/mcp/tools.js` | 新增 | tool handlers：读 assignment、heartbeat、submit report、create ticket、ticket action、route resolve |
| `api/mcp/schema.js` | 新增 | tool input JSON schema；report type、ticket action、query 参数校验 |
| `api/mcp/server.test.js` | 新增 | MCP 初始化、工具注册、错误映射 smoke test |
| `api/mcp/tools.test.js` | 新增 | 使用 mocked HTTP client 验证 header、payload、错误 passthrough |

### 3.2 agent harness 内置 MCP client

如果 harness 已有独立仓库，应在 harness 仓库落地；若先放在本仓库验证，可放到 `harness/` 目录作为 PoC。

| 文件 | 类型 | 内容 |
|---|---|---|
| `harness/mcp/client.js` | 新增 | MCP connection manager；tool/resource discovery；timeout/retry |
| `harness/ticket-platform/adapter.js` | 新增 | `bootstrapAssignment()`、`loadExecutionContext()`、`sendHeartbeat()`、`submitReport()` |
| `harness/ticket-platform/context-assembler.js` | 新增 | 把 MCP resources/tools 结果组装为 agent prompt/runtime context |
| `harness/ticket-platform/heartbeat-loop.js` | 新增 | 周期心跳、停止条件、失败窗口记录 |
| `harness/ticket-platform/run-assignment.js` | 新增 | assignment-scoped CLI/entrypoint |
| `harness/ticket-platform/runner.js` | 可选新增 | dispatch ready polling runner；第一阶段可暂缓 |
| `harness/ticket-platform/*.test.js` | 新增 | bootstrap、context assembly、heartbeat、report closeout 单测 |

### 3.3 文档与脚本

| 文件 | 类型 | 内容 |
|---|---|---|
| `docs/mcp-platform-harness-plan.md` | 当前文档 | 方案与落地清单 |
| `docs/reference/api.md` | 后续更新 | 增补 MCP 适配说明和与 HTTP contract 的映射 |
| `package.json` | 后续更新 | 增加 `dev:mcp`、`test:mcp`、可选 `harness:run-assignment` script |

## 4. 风险和测试

### 4.1 主要风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| MCP server 复制 workflow 逻辑 | 与平台状态机漂移，产生错误 action | MCP 只调用现有 HTTP contract；action 从 runtime context/schema 发现 |
| assignment token 泄露给模型 | agent 可越权调用平台 | token 只留在 MCP server/harness middleware，不进入 prompt/context |
| dispatch polling 与 assignment-scoped 权限混用 | 普通 agent 获得 transport/admin 能力 | runner 模式单独配置 admin token；默认禁用 dispatch tools |
| report 重试造成重复状态推进 | 重复 closeout、重复 receipt | 使用 idempotency key；服务端继续保持 single writer 和 dedupe |
| heartbeat 失败误判 agent 死亡 | 平台错误 stale nudge 或重派 | harness 记录失败窗口；平台侧 stale 策略继续看 last heartbeat 和 dispatch state |
| resource 缓存过期 | workflow schema / bundle version 不一致 | version 先核；schema/bundle 短 TTL，并在 version 变化时清缓存 |
| MCP 错误吞掉 HTTP request id | 难以追踪线上问题 | tool error 必须保留 `detail`、`request_id`、HTTP status |
| context 过大 | agent prompt 失焦或超 token | comments/dependencies 默认摘要，按需再读取完整资源 |

### 4.2 测试分层

单元测试：
- `ticket-platform-client`：base URL、`X-Assignment-Token`、`X-Request-Id`、401/409/500 错误映射。
- `resources`：每个 resource URI 正确映射到 HTTP route。
- `tools`：heartbeat/report/action payload 不被改写；禁止未知 `report_type` 和未知 action。
- `context-assembler`：不泄露 token；压缩 comments/dependencies；保留 version/schema/bundle 信息。

契约测试：
- 对比 MCP `ticket-platform://runtime/context/{assignment_id}` 与 HTTP `GET /api/v1/agent/runtime/context` 的关键字段。
- 对比 MCP `ticket_platform_submit_report` 与 HTTP report API 的响应和错误模型。
- 复用现有 live contract fixture，验证 workflow schema、skill/playbook bundle、assignment reply_contract 不漂移。

集成测试：
- 启动 API server + MCP server，用测试 assignment 完成 bootstrap。
- 提交 `dispatch_receipt=accepted`，再提交 `progress_update` 和 `execution_completed`。
- reviewer assignment 提交 `review_submission` 后再调用 `approve` 或 `reject`，验证平台 guard 生效。
- 模拟 401 token 失效，确认 harness 停止写入且不改用 human bearer。

回归测试命令建议：

```bash
npm run test
npm run validate:live-contract-fixtures
npm run replay:live-contract-fixtures
```

第一阶段验收标准：
- MCP server 能列出所有最小 resources/tools。
- assignment-scoped harness 能完成 version -> runtime context -> assignment -> bundle -> heartbeat -> report 的闭环。
- 所有写入都能在 ticket-platform 现有 API / dispatch / comment / report 读模型中追踪到 request id。
- 无任何新路径绕过现有 workflow/state machine。
