# Ticket System API Documentation

> For ticket-platform truth and review policy, also see:
> - [`docs/agent-first-run-guide.md`](./agent-first-run-guide.md)
> - [`docs/platform-empty-state-onboarding.md`](./platform-empty-state-onboarding.md)
> - [`docs/ticket-platform-current-state.md`](./ticket-platform-current-state.md)
> - [`docs/ticket-platform-gap-analysis-and-plan.md`](./ticket-platform-gap-analysis-and-plan.md)
> - [`docs/ticket-platform-doc-maintenance-policy.md`](./ticket-platform-doc-maintenance-policy.md)
> - [`docs/reference/api.md`](./reference/api.md)

## Base URL
```
http://127.0.0.1:8788/api
```

---

## 运行态版本（version / live acceptance 先核）

### GET /api/version
无需鉴权，返回运行态版本表面，供 reviewer / live acceptance 首先核对 runtime contract。

响应示例：
```json
{
  "data": {
    "git_commit": "a1b2c3d...",
    "build_time": "2026-03-13T00:00:00.000Z",
    "schema_version": "2026-03-12",
    "bundle_version": "2026-03-12.bundle.v8"
  }
}
```

Reviewer / live acceptance 流程应**先核 version**：调用 `GET /api/version` 并与 live acceptance 响应中的 `runtime_version` 一致后，再继续 bundle、dependency 等校验。详见 `docs/reference/api.md`。

---

## 状态转换 API（核心）

### POST /tickets/:id/transition

**描述**：执行工单状态转换（强制接口，禁止直接 PATCH status）

**请求体**：
```json
{
  "action": "start_work",
  "actor": "beavy",
  "comment": "开始处理",
  // ... 其他必填字段
}
```

**支持的 Actions**：

| Action | From | To | 必填字段 |
|--------|------|-----|---------|
| `queue` | triage | queued | actor |
| `start_work` | queued | running | actor |
| `reset_to_queued` | running/paused | queued | actor, reason |
| `submit_for_review` | running | done | actor, result_summary |
| `start_review` | done | review | actor |
| `request_decision` | running/review | pending_decision | actor, decision_summary |
| `pause` | triage/queued/running/done/review/blocked/pending_decision | paused | actor, pause_reason |
| `resume` | paused | 恢复到挂起前状态（优先用 `paused_from_status`） | actor |
| `approve` | done/review | complete | actor |
| `reject` | done/review | queued | actor, reject_reason |
| `block` | running | blocked | actor, blocker_summary |
| `unblock` | blocked | queued | actor |
| `fail` | running | failed | actor, error |
| `resume_from_decision` | pending_decision | queued | actor |

**响应**：
```json
{
  "success": true,
  "ticket": {
    "id": 22,
    "status": "running",
    "locked_by": "beavy",
    "locked_at": "2026-03-08T15:00:00Z",
    "next_actor": "beavy"
  },
  "message": "状态已从 queued 转换为 running"
}
```

**错误响应**：
```json
{
  "success": false,
  "error": "Cannot submit_for_review from status queued",
  "current_status": "queued",
  "allowed_from": ["running"]
}
```

**同 agent running 门禁（409）**：
```json
{
  "success": false,
  "statusCode": 409,
  "error": "RUNNING_TICKET_CONFLICT",
  "message": "agent beavy 已有进行中的工单 #42，当前工单不能再进入 running",
  "actor": "beavy",
  "attempted_action": "start_work",
  "current_status": "queued",
  "recommended_action": "请先完成/挂起/阻塞当前 running 工单，或稍后再 start_work",
  "conflict_ticket": {
    "id": 42,
    "title": "P0：抽 workflow schema 单一真相源",
    "status": "running",
    "assigned_agent": "beavy",
    "locked_by": "beavy",
    "locked_at": "2026-03-10T01:00:00.000Z"
  }
}
```

> 说明：平台现在对 `start_work` 以及 `paused -> resume -> running` 统一施加 **per-agent running gate**。同一 `assigned_agent` 默认最多只能有 1 张 `running` 工单；`paused/done/pending_decision/blocked/failed/complete` 都会释放该 running 占位。
>
> `reset_to_queued` 是受控**管理动作**：仅用于 running/paused 的误触开工回退，要求填写 `reason`，仅允许 `triage_owner` 执行；提交后会自动清空锁与挂起元信息，并写入包含 `from_status / actor / reason` 的内部审计评论。

---

### GET /api/control/tickets/:id/operational-view

**描述**：最小控制读模型（单票聚合视图）。只读，返回 `responsibility_view`、`ticket_operational_view`、`execution_guard_view`，与详情页 `control_read_model` 一致，供控制台/大盘消费。

**响应**：
```json
{
  "ticket_id": 1,
  "responsibility_view": { "chain": [...], "current_actor": "...", "current_actor_source": "...", "summary": "..." },
  "ticket_operational_view": { "ticket_id": 1, "title": "...", "status": "...", "bucket": "active", "latest_comment_summary": null, "latest_report_type": null, "worker_stats": null, "reservation": null, "execution_mode": "direct", "audit_flags": [], "parent_child_summary": null },
  "execution_guard_view": { "requires_worker": false, "has_worker_evidence": false, "available_actions": ["queue", "pause", ...] }
}
```

---

### GET /tickets/:id/actions

**描述**：获取工单当前可执行的 actions

**响应**：
```json
{
  "ticket_id": 22,
  "current_status": "running",
  "available_actions": [
    "submit_for_review",
    "request_decision",
    "block",
    "fail"
  ]
}
```

---

## 工单 CRUD API

### GET /inbox/review

**描述**：获取 reviewer 收口收件箱，当前包含 `done` / `review` 状态工单，按 **SLA 剩余时间最紧急优先** 排序。

**响应**：
```json
{
  "items": [
    {
      "id": 12,
      "title": "Ready for reviewer closeout",
      "status": "done",
      "inbox_lane": "review",
      "review_owner": "leoss",
      "next_actor": "leoss",
      "sla_remaining_ms": 300000,
      "sla_remaining_minutes": 5
    }
  ]
}
```

### GET /inbox/decisions

**描述**：获取决策收件箱，当前包含 `pending_decision` 状态工单，按 **SLA 剩余时间最紧急优先** 排序。

**响应**：
```json
{
  "items": [
    {
      "id": 21,
      "title": "Need boss decision",
      "status": "pending_decision",
      "inbox_lane": "decision",
      "decision_owner": "荣晖",
      "next_actor": "荣晖",
      "sla_remaining_ms": -600000,
      "sla_remaining_minutes": -10
    }
  ]
}
```

### GET /tickets

**描述**：获取工单列表

**查询参数**：
- `status`: 按状态筛选
- `platform`: 按平台筛选
- `assigned_agent`: 按执行人筛选

**响应**：
```json
[
  {
    "id": 1,
    "title": "工单标题",
    "status": "queued",
    "assigned_agent": "beavy",
    "next_actor": "beavy",
    "locked_by": null,
    "created": "2026-03-08T10:00:00Z",
    "last_update": "2026-03-08T10:00:00Z"
  }
]
```

---

### GET /tickets/:id

**描述**：获取工单详情。响应中包含 **control_read_model**（最小控制读模型），便于单票一眼看清责任链、阶段/动作、worker gate、reservation/latest report 摘要。

**响应**：
```json
{
  "id": 1,
  "title": "工单标题",
  "description": "工单描述",
  "status": "running",
  "assigned_agent": "beavy",
  "next_actor": "beavy",
  "locked_by": "beavy",
  "locked_at": "2026-03-08T15:00:00Z",
  "priority": "medium",
  "platform": "ticket-platform",
  "result_summary": null,
  "decision_summary": null,
  "comments": [],
  "created": "2026-03-08T10:00:00Z",
  "last_update": "2026-03-08T15:00:00Z",
  "parent_summary": {
    "is_parent": true,
    "child_count": 3,
    "terminal_child_count": 2,
    "open_child_count": 1,
    "by_status": { "complete": 1, "failed": 1, "blocked": 1 },
    "latest_completed_at": "2026-03-19T01:20:00.000Z",
    "blocked_child_count": 1,
    "failed_child_count": 1,
    "attention_required": true,
    "blocking_children": []
  },
  "control_read_model": {
    "responsibility_view": { "chain": [], "current_actor": "...", "current_actor_source": "...", "summary": "..." },
    "ticket_operational_view": { "ticket_id": 1, "status": "...", "bucket": "...", "latest_comment_summary": null, "latest_report_type": null, "worker_stats": null, "reservation": null, "execution_mode": "..." },
    "execution_guard_view": { "requires_worker": false, "has_worker_evidence": false, "reservation": null, "reservation_conflict": null, "suppress_dispatch": false, "reason": null, "available_actions": [] }
  }
}
```

**说明**：当工单是母单时，详情响应会额外带出 `parent_summary`（等价于 `parent_child_summary`），用于展示子单总数、状态分布、最近收口时间、阻塞/失败关注信号与未闭环子单列表。

### GET /tickets/:id/children

**描述**：读取指定母单的子单列表及聚合汇总，便于详情页 / dashboard 直接消费。

**响应**：
```json
{
  "ticket_id": 1,
  "summary": {
    "child_count": 3,
    "terminal_child_count": 2,
    "open_child_count": 1,
    "by_status": { "complete": 1, "failed": 1, "blocked": 1 },
    "latest_completed_at": "2026-03-19T01:20:00.000Z",
    "blocked_child_count": 1,
    "failed_child_count": 1,
    "attention_required": true,
    "blocking_children": [
      { "id": 12, "title": "Child blocked", "status": "blocked" }
    ]
  },
  "items": [
    { "id": 12, "title": "Child blocked", "status": "blocked", "parent_ticket_id": 1 }
  ]
}
```

---

### POST /tickets

**描述**：创建工单。未显式传 `status` 时默认为 `triage`（不再默认 queued）。人类/控制台入口允许显式提供 `review_owner`，平台会把它作为 `done/review` 阶段的通用 reviewer routing / notifications 责任人。

**请求体**：
```json
{
  "title": "工单标题",
  "description": "工单描述",
  "status": "triage",
  "assigned_agent": "beavy",
  "triage_owner": "leoss",
  "review_owner": "ronghui",
  "platform": "ticket-platform",
  "request_type": "feature"
}
```

**响应**（未传 status 时默认 triage）：
```json
{
  "id": 1,
  "status": "triage",
  "assigned_agent": "beavy",
  "review_owner": "ronghui",
  "current_actor": "leoss",
  "next_actor": "leoss"
}
```

**说明**：
- `status` 未传时默认为 `triage`；显式传 `queued` 等亦可，但 triage -> queue 须经 transition `action=queue`，且工单须已具备 `assigned_agent`、`review_owner`，缺一则返回 409 `TRIAGE_QUEUE_CHAIN_INCOMPLETE`。
- `triage_owner` 未提供时默认按平台路由：`stock-platform -> cowder`，其余平台默认 `leoss`
- `review_owner` 未提供时默认回退到 `triage_owner`
- 当工单进入 `done/review` 时，`current_actor/next_actor` 会显式切到 `review_owner`，并进入 `/api/dispatch/ready` 的 reviewer 主交接链；`/api/notifications/ready` 不再承担 reviewer 主交接

---

### PATCH /tickets/:id

**描述**：更新工单字段（禁止直接修改 status）。可用于补充/改派 `review_owner`，设置 `review_plan`/`review_state`（多轮多 reviewer 合约），并让 reviewer routing / notifications 立即按新值重算。

**请求体**：
```json
{
  "title": "新标题",
  "description": "新描述",
  "priority": "high",
  "review_owner": "ronghui"
}
```

**注意**：如果尝试修改 `status`，会返回 400 错误：
```json
{
  "error": "Direct status update forbidden",
  "message": "禁止直接修改状态，请使用 POST /api/tickets/:id/transition"
}
```

---

## 评论 API

### POST /tickets/:id/comments

**描述**：添加评论

**请求体**：
```json
{
  "content": "评论内容",
  "author": "Current User",
  "type": "progress",
  "visibility": "internal"
}
```

---

## 派单 API

### GET /dispatch/ready

**描述**：获取待派发工单

**响应**：
```json
{
  "request_id": "req_demo_dispatch_ready_123",
  "ready": [
    {
      "dispatch_id": 123,
      "dispatch_event_id": 123,
      "ticket_id": 22,
      "agent": "donky",
      "status": "running",
      "target_agent": "donky",
      "target_session_key": "agent:donky:ticket:22",
      "target_gateway_id": "pc-stock",
      "transport": "ssh_gateway_call",
      "delivery_intent": "dispatch",
      "message": "🔔 你有 1 个当前阶段待处理工单..."
    }
  ]
}
```

**说明**：
- 顶层 `request_id` 与 `X-Request-Id` 响应头一致，供 poller / gateway / API 日志串联。
- `dispatch_event_id` 是 `dispatch_id` 的显式链路别名，便于投递/回执/埋点统一引用。
- `target_gateway_id` / `transport` 是投递 contract；poller 必须按该 metadata 选择本地还是远端 Gateway。
- `done/review` 也会出现在 dispatch ready，并投给 `review_owner`；平台只在后续 `dispatch_receipt.decision=accepted` 时推进 `done -> review`。
- `pending_decision` 不会进入 dispatch ready。
- `kind` 为空表示正常派单；`kind = workflow_mismatch` 表示责任链/状态异常告警；`kind = nudge` 表示平台统一催办（如 `queued_stale` / `audit_result` / `manual`）。
- `reason / dedupe_key / escalation_tier` 是事件治理 contract：dispatch 至少按 `stage + reason + actor` 可解释，不能再退化成粗粒度 ticket 级去重。
- 当前 tier 约定：正常派单 `delivery/review`，workflow mismatch `warning`，平台催办使用 `L1 / L2 / L3`。
- transport 投递成功后调用 `/dispatch/ack`，ready 项会进入 `awaiting_receipt`；若在 deadline 前未收到 `dispatch_receipt`，平台会暴露 `dispatch_state / dispatch_ack_deadline_at / dispatch_retry_count / next_dispatch_retry_at` 并允许重派。

### POST /dispatch/ack

**描述**：确认 transport 投递成功；这一步只表示 message 已送达目标 session，不等同于 agent 已正式接单。

**请求体**：
```json
{
  "dispatch_id": 123
}
```

**响应关键字段**：
- `dispatch_state=awaiting_receipt`
- `awaiting_receipt_from`
- `dispatch_ack_deadline_at`
- `next_dispatch_retry_at`

---

## 通知 API

### GET /notifications/ready

**描述**：获取待通知事件

**响应**：
```json
{
  "request_id": "req_demo_notifications_ready_456",
  "ready": [
    {
      "event_id": 456,
      "notification_event_id": 456,
      "type": "done",
      "ticket_id": 22,
      "title": "修复待验收通知路由",
      "status": "done",
      "target_actor": "cowder",
      "target_session_key": "agent:cowder:ticket:22",
      "target_gateway_id": "pc-stock",
      "transport": "ssh_gateway_call",
      "delivery_intent": "notify:done",
      "message": "📋 工单待验收\n\n#22 修复待验收通知路由\n结果：已完成"
    }
  ]
}
```

**路由规则**：
- 顶层 `request_id` 与 `X-Request-Id` 响应头一致，供通知投递日志与 ack 链路串联。
- `notification_event_id` 是 `event_id` 的显式链路别名，便于通知投递与重试日志统一引用。
- `pending_decision / complete / failed`：强制回主控 `mac-main`，不继续派给远端执行位
- reviewer 主交接不再出现在 notification queue；`done/review -> reviewer` 统一走 `/dispatch/ready` + `dispatch_receipt`
- `reason / dedupe_key / escalation_tier` 同样是 notification contract；notify 去重至少按 `stage + reason + actor` 生效，而不是只按 `type=status`
- 当前 tier 约定：待决策通知 `decision`，complete/failed 结果通知 `result`
- 投递失败不 ack，恢复后会继续出现在 ready 结果里供重试

### POST /notifications/ack

**描述**：确认通知

**请求体**：
```json
{
  "event_id": "evt_456"
}
```

---

## 拓扑 API

### GET /agent-topology

**描述**：返回当前 agent 宿主拓扑与 gateway registry，用于核对 `agent -> gateway -> transport` 映射。

**响应**：
```json
{
  "data": {
    "main_gateway_id": "mac-main",
    "agent_gateway_map": {
      "beavy": "mac-main",
      "cowder": "pc-stock",
      "donky": "pc-stock"
    },
    "gateways": {
      "mac-main": {
        "id": "mac-main",
        "label": "Mac 主平台",
        "transport": "local_cli"
      },
      "pc-stock": {
        "id": "pc-stock",
        "label": "PC 远端 Gateway",
        "transport": "ssh_gateway_call"
      }
    }
  }
}
```

---

## Agent-Facing API

> 更完整、可验收的 agent-facing 参考请优先查看 `docs/reference/api.md`。本节保留平台总览；canonical namespace 以 `/api/v1/agent/*` 为准，`/api/agent/*` 仅作兼容别名。


### GET /api/v1/agent/workflow/schema

**描述**：返回 agent-facing workflow contract。canonical prefix 为 `/api/v1/agent`，legacy alias `/api/agent` 仍保留。

### GET /api/v1/agent/skills/current

**描述**：返回当前平台托管的 skill/playbook bundle。

**关键字段**：
- `skill_id` / `playbook_key` / `version`
- `checksum_sha256`
- `markdown`（含 execution_mode 适配规则与统一回写模板）
- `manifest.allowed_report_types`（包含 `dispatch_receipt`）
- `manifest.rules`
- `manifest.constraints.single_writer=true`
- `manifest.execution_mode_guidance`
- `manifest.writeback_templates`

### GET /api/v1/agent/playbooks/:key

**描述**：按 key 返回指定 playbook bundle；当前支持 `ticket-handler`。

### GET /api/v1/agent/runtime/context?assignment_id=... （assignment_token 优先放 X-Assignment-Token）

**描述**：返回 assignment 对应的运行时上下文。assignment/read/comment/dependencies/heartbeat/report 统一采用 `X-Assignment-Token`（body/query 仅保留兼容）。

**关键字段**：
- `api_base_url`：agent 应访问的平台 API 地址
- `skill_ref` / `playbook_ref`：当前 assignment 应使用的 bundle 版本引用
- `bootstrap`：最小 bootstrap path（runtime/assignment/skill fetch/report endpoints）
- `bootstrap.participant_registry`：`/api/v1/agent/participants`
- `bootstrap.participant_route_resolve`：`/api/v1/agent/routing/resolve`
- `feature_flags.participant_registry_api=true`
- `feature_flags.participant_route_resolve_api=true`
- 本地 gateway 默认可回 `http://127.0.0.1:8788`
- 远端 gateway 若未配置 `TICKET_AGENT_API_BASE_URL`，返回 `null`，避免错误下发 localhost

### GET /api/v1/agent/assignments/:assignment_id

**描述**：读取 assignment contract。

**关键字段**：
- `skill_ref` / `playbook_ref`
- `ticket.execution_mode` / `ticket.execution_mode_source` / `ticket.execution_rule_key` / `ticket.max_active_workers`
- `ticket.worker_stats` / `ticket.current_workers` / `ticket.execution_workers`（subagent/acp 的真实 worker 证据；可直接写成 `current_workers=[{agent_id, status, runtime, started_at}]`、`execution_workers=[{worker_id, kind, status, evidence_ref}]`、`worker_stats={total_workers, active_workers, running_workers, succeeded_workers}`）
- `ticket.dispatch_state` / `ticket.awaiting_receipt_from` / `ticket.dispatch_ack_deadline_at` / `ticket.dispatch_retry_count` / `ticket.next_dispatch_retry_at`
- `execution.mode` / `execution.guidance` / `execution.worker_evidence_required` / `execution.worker_evidence` / `execution.writeback_contract`
- `runtime_context.bootstrap`
- `contract.single_writer=true`
- `contract.allowed_report_types`

### GET /api/v1/agent/assignments/:assignment_id/dependencies

**描述**：读取 assignment 依赖快照。

### GET /api/v1/agent/assignments/:assignment_id/comments

**描述**：读取 assignment 评论流。

### POST /api/v1/agent/assignments/:assignment_id/heartbeat

**描述**：提交 assignment 心跳；支持 `idempotency_key` 幂等。经 **assignment write validation gateway** 校验：assignment 与 ticket 一致、delivery 非 stale 才接受；成功/失败均写 validation audit，响应含 `validation_audit_id`。

### Assignment Write Validation Gateway

heartbeat / reports（及可选带 assignment_token 的 reviewer 写动作）统一经网关校验：

- **身份**：assignment_id + assignment_token 已由 `loadAssignmentAccess` 校验。
- **Expected truth**：assignment.ticket_id 与 ticket.id 一致。
- **Stale/live**：若 ticket 状态在派单后已变更（或 supplemental 主单已 complete），视为 stale，写操作返回 **409**，`code: ASSIGNMENT_STALE`。
- **dispatch_receipt 强校验**：receipt 的 `dispatch_id` / `ticket_id` / `stage` / `agent` 须与 assignment 及 dispatch 事件一致；否则 **400**，machine-readable `code` 见下。

**Machine-readable 错误码**：`ASSIGNMENT_TICKET_MISMATCH`、`ASSIGNMENT_STALE`、`DISPATCH_RECEIPT_DISPATCH_ID_INVALID`、`DISPATCH_RECEIPT_TICKET_ID_MISMATCH`、`DISPATCH_RECEIPT_STAGE_MISMATCH`、`DISPATCH_RECEIPT_AGENT_MISMATCH`、`DISPATCH_RECEIPT_MISSING_FIELDS`。错误响应含 `code`、`validation_audit_id`、`machine_readable: { code, codes, errors[] }`。

### POST /api/v1/agent/assignments/:assignment_id/reports

**描述**：提交结构化 report；经 assignment write validation gateway 校验后，平台统一解释为 comment / transition / notify / audit。成功/失败均写 validation audit，响应含 `validation_audit_id`。

> 约束：`execution_mode=subagent/acp` 的 `execution_completed` / `review_submission` 在没有真实 worker 证据（`ticket.worker_stats/current_workers/execution_workers`）时不会自动提审，避免 ticket session 直接冒充下沉执行闭环。
>
> **Loop 约束**：若 `execution_mode=subagent/acp` 的当前任务目标属于实现 / 修复 / 回归闭环，主 ticket session 不得只派一次性 analysis 子代理；必须使用 Loop skill（或等价迭代控制）持续驱动子代理，直到达到当前阶段走单标准、显式达到迭代上限，或确认需要人工决策。
>
> **reviewer 硬约束**：对 `done/review` 阶段的 reviewer assignment，必须遵循 `dispatch_receipt -> review_submission -> approve/reject` 顺序。仅有 `dispatch_receipt` 不足以直接 complete/queued；若未先成功提交 `review_submission`，agent-facing `approve/reject` 会返回冲突错误。
#### subagent / acp worker 登记字段模板

当 execution_mode=subagent/acp 或外部开发团队实际接单时，派单说明里要直接告诉执行方：先登记真实 worker 证据，再继续回单。下面这组字段可以直接复制到派单内容里：

```json
{
  "ticket": {
    "execution_mode": "subagent",
    "max_active_workers": 1
  },
  "current_workers": [
    {
      "agent_id": "cowder",
      "status": "running",
      "runtime": "subagent",
      "started_at": "2026-03-24T15:00:00+08:00",
      "evidence_ref": "worker-session-1"
    }
  ],
  "execution_workers": [
    {
      "worker_id": "worker-session-1",
      "kind": "subagent",
      "status": "running",
      "evidence_ref": "session:worker-session-1"
    }
  ],
  "worker_stats": {
    "total_workers": 1,
    "active_workers": 1,
    "running_workers": 1,
    "succeeded_workers": 0
  },
  "summary": "已登记真实 worker；后续继续用 progress_update / execution_completed 汇总回单，不再只回自然语言。"
}
```

登记成功的判定条件很简单：`assignment.ticket.worker_stats / current_workers / execution_workers` 至少能读到一名真实 worker，且 `current_workers` / `execution_workers` 不是空数组；只有这样，subagent/acp 任务才算具备了可被平台识别的执行证据。

**当前 workflow bridge 规则**：
- `dispatch_receipt`：
  - `decision=accepted && stage=queued`：推进 `start_work`（`queued -> running`）

**当前 workflow bridge 规则**：
- `dispatch_receipt`：
  - `decision=accepted && stage=queued`：推进 `start_work`（`queued -> running`）
  - `decision=accepted && stage=done`：推进 `start_review`（`done -> review`）
  - `decision=accepted && stage=review`：**不再推进新状态**；仅表示 reviewer 已正式接单，平台记录 receipt、停止重派，并保持 `review`
  - 非 `accepted`：只记录 receipt/comment，不推进状态
- `execution_completed` / `review_submission`：
  - `queued`：自动桥接 `start_work -> submit_for_review`
  - `running`：直接执行 `submit_for_review`
  - `done/review/complete`：不重复推进状态，但 `review_submission` 仍作为 reviewer 验收结论留痕，并可作为后续 approve/reject 的前置证据
- `decision_request` / `blocked_report` / `execution_failed`：在 `queued` 场景下也会先自动桥接 `start_work`，再落到目标状态
- assignment 只有在 ticket 真正到达对应 workflow 阶段（或已处于等价终态）后，才会进入 `submitted / waiting_on_decision / waiting_on_dependency / failed_execution`

**远端 Gateway 注意事项**：
- 如果 agent 运行在 `pc-stock` 一类远端宿主，平台必须同时满足：
  1. `TICKET_AGENT_API_BASE_URL` 指向远端可访问地址
  2. API 服务监听地址允许远端访问（如 `TICKET_API_BIND_HOST=0.0.0.0`）
- 否则 assignment contract 会显式返回 `api_base_url=null`，提醒先配置可达地址，而不是误发 `127.0.0.1:8788`。

---

## Stock Agent Admin API

> 该组接口用于 **stock-platform 工单管理员角色**，与 agent-facing assignment API 分离。
>
> - canonical namespace：`/api/v1/admin/*`
> - legacy alias：`/api/admin/*`
> - 鉴权：`Authorization: Bearer <agent-admin-token>`（推荐）或 `X-Agent-Admin-Token`
> - token registry：`TICKET_AGENT_ADMIN_TOKENS_JSON`
> - role：`agent_admin`
> - capabilities：`stock_tickets:read` / `stock_tickets:comment` / `stock_tickets:transition`
> - scope：仅允许管理 `platform=stock-platform` 工单

### Token registry 示例

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

### GET /api/v1/admin/stock-tickets

**描述**：返回 stock 工单管理员盘面；同时回显 `auth.role=agent_admin`、capabilities、鉴权 contract 与统一错误模型。

### GET /api/v1/admin/stock-tickets/:id

**描述**：读取单张 stock ticket 详情与 `available_actions`。

### GET /api/v1/admin/stock-tickets/:id/actions

**描述**：读取当前动作 contract，包含 `current_actor/current_actor_source/next_actor_override/manual_override_active`。

### GET /api/v1/admin/stock-tickets/:id/comments

**描述**：读取该 stock ticket 的评论流。

### POST /api/v1/admin/stock-tickets/:id/comments

**描述**：以当前 `agent_admin` 身份写评论；若显式传入其他 `author`，返回 `AGENT_ADMIN_FORBIDDEN`。

### POST /api/v1/admin/stock-tickets/:id/transition

**描述**：以当前 `agent_admin` 身份执行 workflow action；若显式传入其他 `actor`，返回 `AGENT_ADMIN_FORBIDDEN`。

### 统一错误与安全边界

- 缺 token / token 无效：`401`，统一返回 `detail + request_id`
- capability 不足：`403 AGENT_ADMIN_FORBIDDEN`
- 非 stock ticket：`403 AGENT_ADMIN_SCOPE_FORBIDDEN`
- agent-admin token **不要**与 `assignment_token` 混用

---

## Ticket Session Cleanup API

### POST /api/admin/ticket-sessions/cleanup

**描述**：仅针对工单平台创建的独立 ticket session（`agent:*:ticket:*`）做安全清理。默认 dry-run。

**请求体**：
```json
{
  "dry_run": true,
  "retention_days": 14,
  "cleanup_statuses": ["complete", "failed"]
}
```

或执行真实清理：
```json
{
  "enforce": true,
  "retention_days": 14,
  "cleanup_statuses": ["complete", "failed"]
}
```

**响应示例（dry-run）**：
```json
{
  "dry_run": true,
  "retention_days": 14,
  "cleanup_statuses": ["complete", "failed"],
  "eligible_count": 1,
  "candidates": [
    {
      "store_path": "/Users/me/.openclaw/agents/beavy/sessions/sessions.json",
      "session_key": "agent:beavy:ticket:26",
      "ticket_id": 26,
      "ticket_status": "complete",
      "age_days": 18.4,
      "transcript_files": [
        "/Users/me/.openclaw/agents/beavy/sessions/xxxx.jsonl"
      ]
    }
  ]
}
```

**安全边界**：
- 仅匹配 `agent:*:ticket:*`
- `running/done/review/pending_decision` 默认不会进入清理集合
- 主会话 / Telegram 主会话不会命中
- `enforce` 前会备份 `sessions.json`
- transcript 采用 `*.deleted.<timestamp>` 归档，支持手工回滚

## 状态转换示例

### 完整工单流转

```bash
# 1. 创建工单
curl -X POST http://127.0.0.1:8788/api/tickets \
  -H "Content-Type: application/json" \
  -d '{
    "title": "测试工单",
    "assigned_agent": "beavy"
  }'

# 2. 开工
curl -X POST http://127.0.0.1:8788/api/tickets/1/transition \
  -H "Content-Type: application/json" \
  -d '{
    "action": "start_work",
    "actor": "beavy",
    "comment": "开始处理"
  }'

# 3. 提交验收
curl -X POST http://127.0.0.1:8788/api/tickets/1/transition \
  -H "Content-Type: application/json" \
  -d '{
    "action": "submit_for_review",
    "actor": "beavy",
    "result_summary": "已完成功能开发",
    "comment": "请 review"
  }'

# 4. 通过关单
curl -X POST http://127.0.0.1:8788/api/tickets/1/transition \
  -H "Content-Type: application/json" \
  -d '{
    "action": "approve",
    "actor": "leoss",
    "comment": "验收通过"
  }'
```

### 请求决策流程

```bash
# 1. 开工
curl -X POST http://127.0.0.1:8788/api/tickets/2/transition \
  -H "Content-Type: application/json" \
  -d '{
    "action": "start_work",
    "actor": "beavy"
  }'

# 2. 请求决策
curl -X POST http://127.0.0.1:8788/api/tickets/2/transition \
  -H "Content-Type: application/json" \
  -d '{
    "action": "request_decision",
    "actor": "beavy",
    "decision_summary": "需要老大拍板 A/B 方案",
    "decision_context": "A 方案快但不稳定，B 方案慢但可靠",
    "comment": "请老大决策"
  }'

# 3. 恢复执行（老大决策后）
curl -X POST http://127.0.0.1:8788/api/tickets/2/transition \
  -H "Content-Type: application/json" \
  -d '{
    "action": "resume_from_decision",
    "actor": "荣晖",
    "comment": "采用 A 方案，继续执行"
  }'
```

---

## 错误码

| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 201 | 创建成功 |
| 400 | 请求参数错误 |
| 403 | 工单已锁定 |
| 404 | 工单不存在 |
| 500 | 服务器错误 |

---

## 注意事项

1. **禁止直接 PATCH status**：所有状态变更必须走 `POST /tickets/:id/transition`
2. **工单锁定**：`start_work` 会自动锁定工单，其他人无法操作
3. **自动路由**：状态转换会自动设置 `next_actor`
4. **必填字段**：不同 action 有不同的必填字段，缺失会返回 400
5. **状态约束**：只能从合法起始状态转换，否则返回 400

---

## 前端集成

### React 示例

```jsx
import { getTicketActions, transitionTicket } from '../api/tickets';

// 获取可执行 actions
const actions = await getTicketActions(ticketId);
console.log(actions.available_actions); // ['start_work', 'submit_for_review']

// 执行状态转换
const result = await transitionTicket(ticketId, {
  action: 'start_work',
  actor: 'beavy',
  comment: '开始处理'
});

if (result.success) {
  console.log('状态已更新:', result.ticket.status);
}
```

---

---

## Agent Admin API（stock 工单管理员管理面）

### Base URL
```txt
http://127.0.0.1:8788/api/v1/admin
```

### 用途
为 `stock-platform` 提供管理员管理面，让持有 **agent-admin token** 的 agent（如 `cowder`）可以在不依赖单个 assignment token 的前提下，读取盘面、查看详情、写评论、执行受控状态流转。

### 鉴权
推荐：
```http
Authorization: Bearer <agent-admin-token>
```

兼容：
```http
X-Agent-Admin-Token: <agent-admin-token>
```

环境变量：
- `TICKET_AGENT_ADMIN_TOKENS_JSON`

示例：
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

### 读接口
- `GET /stock-tickets`
- `GET /stock-tickets/:id`
- `GET /stock-tickets/:id/actions`
- `GET /stock-tickets/:id/comments`

### 写接口
- `POST /stock-tickets/:id/comments`
- `POST /stock-tickets/:id/transition`

### 关键约束
1. 仅允许管理 `platform=stock-platform` 的工单
2. comment/transition 不允许伪装成其他 `author/actor`
3. transition 仍受现有 workflow allowed actions 与 running gate 约束
4. agent-admin token 与 assignment token 分离，不混用

### 示例：读取 stock 管理盘面
```bash
curl http://127.0.0.1:8788/api/v1/admin/stock-tickets?assigned_agent=cowder \
  -H 'Authorization: Bearer <agent-admin-token>'
```

### 示例：以 cowder 身份写评论
```bash
curl -X POST http://127.0.0.1:8788/api/v1/admin/stock-tickets/76/comments \
  -H 'Authorization: Bearer <agent-admin-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "author": "cowder",
    "content": "已确认 stock 管理面 smoke 通过。",
    "type": "progress"
  }'
```

### 示例：以 cowder 身份提交验收
```bash
curl -X POST http://127.0.0.1:8788/api/v1/admin/stock-tickets/76/transition \
  -H 'Authorization: Bearer <agent-admin-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "submit_for_review",
    "actor": "cowder",
    "result_summary": "agent-admin 路由、鉴权与 stock 管理面已闭环。"
  }'
```

### 统一错误模型
```json
{
  "detail": "agent-admin token 无效或缺失",
  "request_id": "req_demo_admin_123"
}
```

**最后更新**：2026-03-12
**版本**：v2.1（含 agent-admin stock 管理面）
