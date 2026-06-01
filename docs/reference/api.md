# Agent-Facing API Reference

> Related ticket-platform docs:
> - [`docs/ticket-platform-current-state.md`](../ticket-platform-current-state.md)
> - [`docs/ticket-platform-gap-analysis-and-plan.md`](../ticket-platform-gap-analysis-and-plan.md)
> - [`docs/ticket-platform-doc-maintenance-policy.md`](../ticket-platform-doc-maintenance-policy.md)
> - [`docs/API.md`](../API.md)

> 本文档是 ticket-platform 当前 **agent-facing API** 的权威参考，聚焦 Mission Control 风格的命名空间、鉴权、错误模型、`reply_contract` 与 bootstrap 流程。
>
> - canonical namespace: `/api/v1/agent/*`
> - legacy alias: `/api/agent/*`
> - human / console API 仍走原有人类接口与 Bearer 鉴权，不与 agent assignment token 混用

## 1. 设计目标

agent 在收到 assignment 后，应当仅依赖平台下发的 contract 完成：

1. 读取 runtime context / assignment
2. 拉取 skill bundle / playbook bundle
3. 必要时读取 comments / dependencies
4. 只通过 `heartbeat` / `reports` 回写
5. 需要正式写动作时，仅使用受控 ticket action API（create / pause / resume / approve / reject）

平台仍是 **single writer**：
- agent 不直接写 ticket comment
- agent 不直接写 workflow transition
- agent 不直接决定 notify/dispatch
- 所有写入都经由平台解释和落库

---

## 2. 命名空间与兼容策略

### Canonical
- `/api/v1/agent/workflow/schema`
- `/api/v1/agent/runtime/context`
- `/api/v1/agent/participants`
- `/api/v1/agent/participants/:participant_id`
- `/api/v1/agent/routing/resolve`
- `/api/v1/agent/assignments/:assignment_id`
- `/api/v1/agent/assignments/:assignment_id/dependencies`
- `/api/v1/agent/assignments/:assignment_id/comments`
- `/api/v1/agent/assignments/:assignment_id/live-acceptance`
- `/api/v1/agent/assignments/:assignment_id/heartbeat`
- `/api/v1/agent/assignments/:assignment_id/reports`
- `/api/v1/agent/skills/current`
- `/api/v1/agent/playbooks/ticket-handler`
- `/api/v1/agent/tickets`
- `/api/v1/agent/tickets/:id/pause`
- `/api/v1/agent/tickets/:id/resume`
- `/api/v1/agent/tickets/:id/approve`
- `/api/v1/agent/tickets/:id/reject`
- `/api/v1/agent/workboards/stock-tickets`

### Legacy alias
兼容路径 `/api/agent/*` 仍保留，用于平滑迁移，但新 contract 一律以下列 canonical 前缀为准：

```txt
/api/v1/agent
```

---

## 3. 鉴权模型

### 人类 / 控制台 API
- 鉴权：`Authorization: Bearer <token>`
- 适用范围：控制台、运维、人类用户调用的管理接口

### Agent-facing API
- 鉴权：`assignment_token`
- 推荐传输：`X-Assignment-Token`
- 兼容传输：`assignment_token` in query/body

```http
X-Assignment-Token: <assignment_token>
```

约束：
- assignment/read/comment/dependencies/heartbeat/report 都要求 assignment token
- 人类 Bearer token 与 agent assignment token 不混用
- assignment contract 会显式下发推荐 header 名称，agent 不需要猜

---

## 4. 请求 ID 与统一错误模型

所有 agent-facing 响应都应带：

```http
X-Request-Id: <request-id>
```

caller 可透传：

```http
X-Request-Id: req-demo-123
```

若未透传，平台会自动生成。

### 统一错误 JSON

```json
{
  "detail": "assignment_token 无效或缺失",
  "request_id": "req-demo-123"
}
```

### 示例：未携带 assignment token

```http
GET /api/v1/agent/runtime/context?assignment_id=asg_xxx
X-Request-Id: req-demo-123
```

```http
HTTP/1.1 401 Unauthorized
X-Request-Id: req-demo-123
```

```json
{
  "detail": "assignment_token 无效或缺失",
  "request_id": "req-demo-123"
}
```

---

## 5. 最小 bootstrap 流程

agent 在收到 assignment / dispatch 后，推荐固定按下列顺序启动：

1. `GET /api/v1/agent/runtime/context?assignment_id=...`
2. `GET /api/v1/agent/assignments/:assignment_id`
3. `GET /api/v1/agent/skills/current`
4. `GET /api/v1/agent/playbooks/ticket-handler`
5. 必要时读取 comments / dependencies
6. 执行中仅使用 `heartbeat` / `reports`

### 为什么先读 runtime context
因为它会返回：
- `api_base_url`
- `namespace.canonical_prefix`
- `auth.preferred_transport`
- `request_id` contract
- `error_model`
- `bootstrap` endpoint map
- `skill_ref` / `playbook_ref`

也就是说，agent 可以通过 runtime context 得到整套最新 contract，而不依赖本地静态 SKILL.md。

---

## 5.1 Runtime version surface（运行态版本）

验收与 reviewer 流程应**先核 version / runtime contract**，再继续 bundle、dependency 等校验。

### GET /api/version
无需鉴权，返回当前运行态版本表面，供 live acceptance 与契约回归基线比对。

响应字段：
- `git_commit`: 当前构建对应的 git commit hash（或 `null`，如未在 git 树中）
- `build_time`: 构建时间 ISO8601 字符串（或进程启动时间）
- `schema_version`: workflow/schema 版本（与 `AGENT_SCHEMA_VERSION` 一致）
- `bundle_version`: 托管 playbook bundle 版本（与 `AGENT_PLAYBOOK_VERSION` 一致）

启动时 API 会打印：`[API] runtime version: commit=<hash> schema=... bundle=...`，便于与 live 环境核对。

### Reviewer / Live acceptance 流程（固定顺序）
1. **先核 version / runtime contract**：调用 `GET /api/version`，确认 `git_commit` / `schema_version` / `bundle_version` 与预期一致；live acceptance 响应中的 `live_surfaces.runtime_version` 或 `live.runtime_version` 应与 `/api/version` 一致。
2. 再按需做 bundle 预期版本、workflow schema、dependency、delivery health 等校验。

### Parent / Child aggregate read model
- `GET /api/tickets/:id`：当工单为母单时，详情会返回 `parent_summary`（与 `parent_child_summary` 等价），包含 `child_count / by_status / latest_completed_at / blocked_child_count / failed_child_count / attention_required / blocking_children`。
- `GET /api/tickets/:id/children`：返回 `{ ticket_id, summary, items }`，其中 `summary` 为同一份父子聚合读模型，`items` 为子单详情列表。
- closeout guard 仍以 workflow/state machine 为准：只要存在非 terminal 子单，`approve/reject` 会收到 `409 PARENT_CLOSEOUT_CHILDREN_INCOMPLETE`。

---

## 5.2 Human console inbox surfaces

以下为控制台 / reviewer UI 使用的人类侧收件箱接口（非 agent-facing，不使用 assignment token）：

### GET /api/inbox/review
- 返回 `done` / `review` 工单
- 排序：按 `sla_remaining_ms` 升序（越小越紧急）
- 用途：独立 Review Inbox 页面 / reviewer 收口列表

### GET /api/inbox/decisions
- 返回 `pending_decision` 工单
- 排序：按 `sla_remaining_ms` 升序（越小越紧急）
- 用途：独立 Decision Inbox 页面 / boss decision 列表

返回对象在 ticket list DTO 基础上附加：
- `inbox_lane`: `review` | `decision`
- `sla_remaining_ms`
- `sla_remaining_minutes`

## 6. 核心读取接口

### GET /api/v1/agent/workflow/schema
返回 workflow contract，以及 agent 允许使用的写回语义基础。

### GET /api/v1/agent/runtime/context
查询参数：
- `assignment_id`（必填）

关键字段：
- `api_base_url`
- `namespace`
- `auth`
- `request_id`
- `error_model`
- `bootstrap`
- `skill_ref`
- `playbook_ref`
- `ticket_actions`
- `workboards`
- `feature_flags.participant_registry_api`
- `feature_flags.participant_route_resolve_api`

bootstrap 最小基线（v2 bootstrap 首轮新增）：
- `bootstrap.participant_registry` → `/api/v1/agent/participants`
- `bootstrap.participant_route_resolve` → `/api/v1/agent/routing/resolve`

### GET /api/v1/agent/participants
读取 participant registry 快照；把现有 `agent-topology` 中的 agent/platform/gateway 目录收口成 agent-facing bootstrap contract。

常见 query：
- `platform_id`
- `participant_id`
- `role_key`

关键返回字段：
- `participants[]`
- `platforms[]`
- `routing_roles[]`
- `summary.total_participants / filtered_participants`

### GET /api/v1/agent/participants/:participant_id
读取单个 participant 的最小责任视图（display / role / gateway / platform_roles）。

### GET /api/v1/agent/routing/resolve
participant-based routing skeleton。用于先把“我要找谁”解析成稳定 contract，而不是让 caller 自己猜 `triage_owner / review_owner / development_agent_ids[0]`。

常见 query：
- `participant_id`
- `platform_id`
- `role_key`
- `reason`

关键返回字段：
- `resolved.participant_id`
- `gateway.id / transport`
- `route_target`
- `explain.resolution_source`

### GET /api/v1/agent/assignments/:assignment_id
关键字段：
- `ticket.execution_mode`
- `ticket.execution_mode_source`
- `ticket.execution_rule_key`
- `ticket.worker_stats` / `ticket.current_workers` / `ticket.execution_workers`
- `execution.mode`
- `execution.guidance`
- `execution.worker_evidence_required` / `execution.worker_evidence`
- `execution.writeback_contract`
- `contract.allowed_report_types`
- `reply_contract`
- `permissions.can_direct_ticket_write=false`

### GET /api/v1/agent/assignments/:assignment_id/dependencies
读取 assignment 依赖快照。

### GET /api/v1/agent/assignments/:assignment_id/comments
读取 assignment 评论流。

### GET /api/v1/agent/assignments/:assignment_id/live-acceptance
输出 reviewer 可直接消费的 live acceptance verdict，聚合以下 live surface：
- workflow schema
- runtime context
- hosted skill/playbook bundle
- dependency snapshot
- stale delivery 提示

可选 query：
- `expected_bundle_version`
- `expected_bundle_checksum_sha256`
- `expected_workflow_schema_version`
- `expected_api_base_url`

关键返回字段：
- `verdict`: `pass | partial | live-not-upgraded | contract-mismatch | dependency-not-closed`
- `summary`
- `expected`
- `live`（含 `runtime_version`，与 `GET /api/version` 一致，reviewer 先核此契约）
- `dependency_snapshot`
- `checks[]`

推荐语义：
- `pass`：live contract 与预期一致，且无未闭合 blocks 依赖
- `partial`：live surface 可读，但存在降级/告警项（例如远端 gateway 尚未下发可直连 `api_base_url`）
- `live-not-upgraded`：hosted bundle/version/checksum 未升级到 reviewer 预期版本
- `contract-mismatch`：workflow/runtime contract 与 reviewer 提供的预期不一致
- `dependency-not-closed`：仍有 blocks 依赖未闭合，不满足最终验收

---

## 7. Skill / Playbook bundle

### GET /api/v1/agent/skills/current
返回当前平台托管 bundle：
- `markdown`
- `manifest`
- `ref`
- `auth`
- `request_id`
- `error_model`

关键 manifest 字段：
- `skill_id`
- `playbook_key`
- `version`
- `checksum_sha256`
- `allowed_report_types`
- `rules`
- `constraints`
- `bootstrap`
- `execution_mode_guidance`
- `writeback_templates`
- `reply_contract`

### GET /api/v1/agent/playbooks/ticket-handler
按 playbook key 获取指定 bundle；当前 `ticket-handler` 为 agent handling 的平台托管 contract。

---

## 8. Reply Contract

`reply_contract` 会在 assignment read 中显式下发，至少包含：

- `kind=agent.reply_contract`
- `transport=http`
- `auth`
- `request_id`
- `error_model`
- `legacy_aliases`
- `channels.heartbeat`
- `channels.reports`
- `reply_types`

### Heartbeat channel
```http
POST /api/v1/agent/assignments/:assignment_id/heartbeat
```

示例：

```json
{
  "assignment_token": "<assignment_token>",
  "idempotency_key": "ticket-75-kickoff",
  "progress": {
    "status": "in_progress",
    "percent": 20,
    "message": "已按 execution_mode=subagent 下沉执行，ticket session 正在统一回写。"
  }
}
```

### Reports channel
```http
POST /api/v1/agent/assignments/:assignment_id/reports
```

当前允许的 `report_type`：
- `progress_update`
- `dispatch_receipt`
- `analysis_result`
- `execution_completed`
- `execution_failed`
- `blocked_report`
- `decision_request`
- `review_submission`
- `triage_structured_report`
- `artifact_upload`
- `workflow_warning`
- `handoff_note`

### 平台桥接规则
平台会把 report 解释为 workflow/comment/notify：
- `triage_structured_report`
  - 当 `triage.verdict=queue`、`triage.is_executable=true`、route target=`queued` 且责任链完整（至少 `triage_owner/assigned_agent/review_owner`）时：自动桥接 `queue`（`triage -> queued`）
  - 若责任链不完整：保持 `triage`，并在 interpreter result 中返回 machine-readable reason（默认 `TRIAGE_QUEUE_CHAIN_INCOMPLETE`）与 `missing_fields`
- `execution_completed` / `review_submission`
  - `queued`：自动桥接 `start_work -> submit_for_review`
  - `running`：直接提交到 `done`
- `decision_request` / `blocked_report` / `execution_failed`
  - `queued`：先自动桥接 `start_work`，再落到对应目标状态

agent 不需要直接写 transition API。

---

## 9. 受控写动作 API

这些接口依然由平台统一执行 workflow 写入；它们不是 direct DB write，也不是绕过 single-writer。

### POST /api/v1/agent/tickets
用途：创建 triage 新工单（默认仅能创建 triage，不再直接创建 queued）。

约束：
- 只能创建 `triage`
- 不允许通过 create 直接创建 `queued/running/done/complete`
- `triage_owner` / `assigned_agent` / `review_owner` 可在 agent-facing create 显式指定；留空时按平台默认责任链回退
- 仍不允许直接覆盖 `decision_owner` / `next_actor`（以及 `review_plan` / `review_state` 等平台收口字段）
- `platform=ticket-platform` 时，`assigned_agent` / `target_agent` 仍只允许 `beavy`

说明：
- triage -> queue 须责任链已落链：工单须具备 `assigned_agent`、`review_owner`；缺一则 `POST /api/tickets/:id/transition` action=queue 返回 409，错误码 `TRIAGE_QUEUE_CHAIN_INCOMPLETE`。
- `triage_owner` 未显式提供时，默认按平台路由：`stock-platform -> cowder`，其余平台默认 `leoss`。
- `review_owner` 未显式提供时，默认回退到 `triage_owner`；工单进入 `done/review` 时，reviewer routing / dispatch 也会按该字段接管。
- `decision_owner` / `next_actor` 仍由平台 single writer 统一推导与收口，避免 agent-facing create 绕过 workflow 责任链。

### POST /api/v1/agent/tickets/:id/pause
用途：对当前 ticket 执行 workflow `pause`。

约束：
- 必须在 `available_actions` 包含 `pause` 时调用
- `actor` 必须匹配当前 workflow 解释出的允许身份（即该状态下解析出的 `current_actor`；例如 running 通常是 `assigned_agent`，done/review 通常是 `review_owner`）

### POST /api/v1/agent/tickets/:id/resume
用途：对 paused ticket 执行 workflow `resume`。

约束：
- 只有 paused ticket 可调用
- `actor` 必须匹配 `paused_by`
- 若恢复目标是 `running`，仍受 per-agent running gate 约束

### POST /api/v1/agent/tickets/:id/approve
用途：由 `review_owner` 对 `done/review` ticket 执行 workflow `approve`。无 `review_plan` 时推进到 `complete`；有 `review_plan` 时按多轮/多 reviewer 合约记录当前 reviewer 通过，当前轮全部 required reviewers 通过后进入下一轮，最后一轮全部通过后推进到 `complete`。

约束：
- 必须在 `available_actions` 包含 `approve` 时调用
- `actor` 必须匹配当前 workflow 解析出的 `review_owner`
- **review 阶段必须携带当前 `assignment_id + assignment_token`，且在 approve 前已通过 report API 成功提交至少一条 `review_submission`**
- 可选 `approve_reviewer`：记录为通过者（缺省为 actor），用于多 reviewer 时区分实际确认人

### POST /api/v1/agent/tickets/:id/reject
用途：由 `review_owner` 对 `done/review` ticket 执行 workflow `reject`，打回 `queued`。有 `review_plan` 时同时重置 `review_state` 到待重新评审的初始态。

约束：
- 必须在 `available_actions` 包含 `reject` 时调用
- `actor` 必须匹配当前 workflow 解析出的 `review_owner`
- **review 阶段必须携带当前 `assignment_id + assignment_token`，且在 reject 前已通过 report API 成功提交至少一条 `review_submission`**
- `reject_reason` 必填
- 可选 `reject_reviewer`：记录为打回操作者（缺省为 actor）

### 多 reviewer / 多轮 review 合约（最小）
- 工单可持有 `review_plan`（JSON）、`review_state`（JSON），存 SQLite TEXT。
- `review_plan` 形状示例：`{ "rounds": [ { "required_reviewers": ["id1","id2"] }, { "required_reviewers": ["id1"] } ] }` 表示两轮，第一轮需 id1、id2 均通过，第二轮需 id1 通过后 complete。
- 无 `review_plan` 的工单保持单 reviewer 语义（approve 直接 complete，reject 直接 queued）。
- 有 `review_plan` 时 approve 更新 `review_state` 记录当前 reviewer/轮次；当前轮全部通过才进下一轮；最后一轮全部通过才 complete。reject 将 status 置为 queued 并重置 `review_state`。
- 发现性：GET 工单/列表会返回 `review_plan`、`review_state`（若有）；PATCH 可更新 `review_plan`（human/console）。

---

## 10. Discoverability

### GET /api/v1/agent/workboards/stock-tickets
返回 stock-platform 工单盘面。

支持的典型查询：
- `status`
- `bucket`
- `assigned_agent`
- `current_actor`
- `review_owner`
- `has_dependencies`
- `parent_ticket_id`
- `group_by`
- `sort`
- `limit`
- `offset`

示例：

```http
GET /api/v1/agent/workboards/stock-tickets?status=running&group_by=current_actor
```

---

## 11. Execution Mode Contract

assignment 与 bundle manifest 都会显式下发 execution mode guidance。

当前支持：
- `direct`
- `subagent`
- `acp`

### direct
当前 ticket session 直接处理；不再下沉子 worker。

### subagent
当前 ticket session 只做协调、心跳、汇总与统一回写；长执行下沉到子代理。

### acp
当前 ticket session 只做 ACP 编排协调、节流和统一回写；长执行下沉到 ACP harness。

---

## 12. 验收口径

对于 agent-facing API，验收至少应覆盖：

1. canonical `/api/v1/agent/*` 可用
2. legacy `/api/agent/*` 仍可兼容访问
3. agent auth 优先走 `X-Assignment-Token`
4. 错误统一返回 `{detail, request_id}`
5. 所有响应带 `X-Request-Id`
6. assignment read 中可见 `reply_contract`
7. hosted bundle / playbook manifest 中可见 `auth / request_id / error_model / execution_mode_guidance / writeback_templates`

---

## 13. 相关文件

- 运行时实现：`api/app.js`
- contract 生成：`api/agent-facing.js`
- 回归测试：`api/app.test.js`
- 平台总览文档：`docs/API.md`

如需看平台当前 live contract，请优先访问：
- `GET /api/v1/agent/runtime/context`
- `GET /api/v1/agent/assignments/:assignment_id`
- `GET /api/v1/agent/skills/current`
- `GET /api/v1/agent/playbooks/ticket-handler`

如需先做仓库卫生检查，再提交 agent-facing 相关改动，可执行：
- `npm run repo:hygiene`
- `npm run repo:hygiene:cleanup`

---

## 14. Agent Admin API（stock 工单管理员接口）

> 这组接口不是 assignment-scoped agent-facing API，而是给特定管理员 agent（当前主要是 `cowder`）管理 `stock-platform` 工单使用的受控管理面。

### Namespace
- canonical: `/api/v1/admin/*`
- legacy alias: `/api/admin/*`

### 鉴权
- 走 **agent-admin token**，不要与 assignment token 混用
- 推荐：`Authorization: Bearer <agent-admin-token>`
- 兼容：`X-Agent-Admin-Token: <agent-admin-token>`
- token registry 环境变量：`TICKET_AGENT_ADMIN_TOKENS_JSON`

示例 registry：

```json
{
  "cowder_stock_admin": {
    "token": "<secret>",
    "agent_id": "cowder",
    "capabilities": [
      "stock_tickets:read",
      "stock_tickets:comment",
      "stock_tickets:transition"
    ]
  }
}
```

### 能力模型
- `stock_tickets:read`：读取 stock 工单盘面 / 详情 / actions / comments
- `stock_tickets:comment`：以 grant 绑定的 `agent_id` 身份写评论
- `stock_tickets:transition`：以 grant 绑定的 `agent_id` 身份执行 transition

### 统一错误模型
与 agent-facing 一样，返回：

```json
{
  "detail": "agent-admin token 无效或缺失",
  "request_id": "req_demo_admin_123"
}
```

### 读取接口
- `GET /api/v1/admin/stock-tickets`
- `GET /api/v1/admin/stock-tickets/:id`
- `GET /api/v1/admin/stock-tickets/:id/actions`
- `GET /api/v1/admin/stock-tickets/:id/comments`

约束：
- 仅允许访问 `platform=stock-platform` 的工单
- `/stock-tickets` 支持 `status / bucket / assigned_agent / current_actor / review_owner / has_dependencies / parent_ticket_id / group_by / sort / limit / offset`

### 写接口
- `POST /api/v1/admin/stock-tickets/:id/comments`
- `POST /api/v1/admin/stock-tickets/:id/transition`

约束：
- comment / transition **不允许伪装**为其他 `author/actor`
- `author` 或 `actor` 必须等于当前 grant 绑定的 `agent_id`
- transition 仍受 workflow `available_actions` 与 running gate 约束；agent-admin 只是受控管理面，不绕过 single writer / state machine

### 验收建议
至少补三类证据：
1. 无 token 访问返回 `401 + {detail,request_id}`
2. 带有效 token 可读 stock workboard / detail / actions
3. 带有效 token 可 comment / transition，且非 stock 工单会返回 scope 级 `403`
