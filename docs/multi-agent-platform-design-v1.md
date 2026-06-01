# 通用多 Agent 协作平台设计文档 v1

_Last updated: 2026-06-01_

## 0. 背景

当前 `agent-ticket-system` 已经具备较好的工单协作底座：

- workflow schema
- runtime context
- hosted skill/playbook
- dispatch / notification ready queue
- reviewer 阶段
- auditor / stale nudge
- parent / child 聚合与 closeout guard
- 独立 ticket session
- live contract / healthcheck / fixture replay

但现有系统仍然更像“面向当前 OpenClaw 多 Bot 的工单系统”，距离“通用多 Agent 协作平台”还缺少若干抽象层：角色、能力、流程模板、任务团队、上下文包、执行器、治理事件与验收门禁。

本设计目标是在不推倒现有系统的前提下，把当前工单系统升级为一个可配置、可审计、可扩展的多 Agent 协作运行时。

---

## 1. 外部参考

### 1.1 HiClaw

关键词：Manager-Workers、协作房间、Human-in-the-loop、可审计过程、多 runtime 共存。

启发：

- 平台不应只做“派单”，还应提供可见、可干预、可追踪的协作空间。
- Manager / Worker 是天然的多 Agent 协作组织形态。
- 多 runtime 共存需要平台级路由和生命周期管理。

### 1.2 GitPilot

关键词：Explorer / Planner / Coder / Reviewer 四角色、用户审批、Ask / Auto / Plan 模式。

启发：

- 默认角色需要产品化，而不是只作为数据库字段存在。
- Reviewer 应是一等质量门禁。
- 高影响动作需要 approval mode / permission mode。

### 1.3 OpenMultiAgent

关键词：Team、MessageBus、TaskQueue、SharedMemory、AgentPool、dependency graph、parallel run、cascade failure。

启发：

- 复杂任务需要 Team Runtime，不只是 ticket + assignment。
- Task DAG、共享记忆、消息总线、并发池是多 Agent 平台的核心对象。

### 1.4 OpenCognit

关键词：CEO orchestrator、Critic loop、HITL escalation、persistent memory、trust/reputation、budget enforcement、task DAG、model router。

启发：

- Auditor 应升级为 Critic / Governance 层。
- Agent 选择不只看能力，也应看健康、信任、成本、预算。
- 失败恢复、重试、升级、人工介入应是平台内建能力。

### 1.5 vs-code-agents

关键词：职责隔离、文档驱动、质量门禁、handoff、结构化 agent-output。

启发：

- 每个阶段都应有结构化产物，不能只依赖聊天记录。
- Handoff summary / review package 应由平台规范化。

### 1.6 Multica executor/reviewer/auditor issue

关键词：executor 和 reviewer/auditor 一等角色、自动 review、rate-limit fallback。

启发：

- executor 和 reviewer 必须是一等生命周期角色。
- reviewer 独立于 executor，避免“自己验收自己”。
- provider rate limit / capacity failure 应进入平台 fallback/reassign 流程。

---

## 2. 产品定位

平台目标不是做另一个普通 agent framework，而是：

> 带状态机、权限、审计、派单、验收、通知、上下文包的多 Agent 协作平台。

更接近：

```text
Linear/Jira + Temporal + GitHub Actions + Agent Runtime + Review Gate
```

而不是单纯：

```text
CrewAI / AutoGen / LangGraph wrapper
```

---

## 3. 默认四角色

平台默认内置 4 类角色，但允许按 workflow template 扩展。

### 3.1 Planner / Triage Owner

职责：

- 接收需求
- 拆分任务
- 定义目标、非目标、验收标准
- 选择 workflow template
- 指定或建议 executor / reviewer / auditor
- 创建子任务和依赖
- 判断是否需要人类决策

典型现有映射：

- `triage_owner`
- Leoss / 主控

### 3.2 Executor

职责：

- 执行任务
- 回写进度
- 产出 artifact
- 提交 `execution_completed`
- 提供验证证据
- 必要时提交 blocked / decision request / failed

典型现有映射：

- `assigned_agent`
- Beavy / Cowder / Donky / remote agent / ACP agent

### 3.3 Reviewer

职责：

- 独立验收 executor 结果
- 审查 artifact、测试、风险、子任务状态
- approve / reject / request decision
- 提交结构化 `review_submission`

典型现有映射：

- `review_owner`
- Leoss / auditor / 专职 reviewer agent

### 3.4 Auditor / Watchdog

职责：

- stale 检查
- 缺证据检查
- 错路由检查
- assignment stale 检查
- ack / delivery 失败检查
- parent-child closeout 风险检查
- 触发 nudge / reassign / escalation / decision request

典型现有映射：

- auditor / 小羊

---

## 4. 核心领域对象

### 4.1 Agent Registry

用于描述平台可调度的所有 agent / runtime。

建议字段：

```text
agents
- id
- agent_id
- display_name
- enabled
- role_types            # planner/executor/reviewer/auditor
- capabilities          # backend/frontend/research/ops/ticket-platform/stock 等
- runtime_type          # openclaw_session/subagent/acp/remote_agent/script_job/human/external_service
- gateway_id            # mac-main/pc-stock/...
- session_policy        # main/ticket_session/ephemeral
- concurrency_limit
- current_load
- health_status
- cost_class
- trust_level
- metadata_json
- created_at
- updated_at
```

### 4.2 Role Contract

角色不是简单名字，而是一套权限与义务协议。

建议字段：

```text
role_contracts
- id
- role_type
- allowed_actions_json
- required_reports_json
- can_spawn_child
- can_request_decision
- can_close
- conflict_rules_json
- description
```

关键规则：

- executor 默认不能 approve 自己的任务。
- reviewer 必须提交 review_submission 后才能 approve/reject。
- auditor 默认不能直接 complete，只能 nudge / recommend / escalate。
- planner 可以拆任务，但不能伪造 executor 完成结果。

### 4.3 Capability

能力是路由和治理的基础。

建议字段：

```text
capabilities
- id
- capability_key
- display_name
- category
- description
```

示例：

- `ticket-platform.backend`
- `ticket-platform.frontend`
- `stock-platform.backtest`
- `ops.launchctl`
- `browser.automation`
- `research.github`

### 4.4 Workflow Template

把状态机、角色、动作、SLA 和 required outputs 模板化。

建议字段：

```text
workflow_templates
- id
- template_key
- version
- display_name
- description
- status_schema_json
- role_schema_json
- transition_schema_json
- required_outputs_json
- sla_policy_json
- gate_policy_json
- closeout_policy_json
- enabled
```

第一批模板：

- `software_task_v1`
- `research_task_v1`
- `ops_incident_v1`
- `decision_task_v1`
- `content_task_v1`
- `long_running_experiment_v1`

当前既有工单流应沉淀为 `software_task_v1`。

### 4.5 Assignment Contract v2

Assignment 是“当前阶段处理凭证 + 权限凭证 + 上下文入口”。

建议字段：

```text
assignments
- assignment_id
- ticket_id
- workflow_template
- stage
- role_type
- actor_agent_id
- assignment_token
- allowed_actions_json
- required_outputs_json
- context_bundle_id
- playbook_ref
- deadline_at
- stale_after_at
- receipt_required
- superseded_by
- status
- created_at
- updated_at
```

Agent 收到 assignment 后，必须能明确：

- 我是谁
- 当前阶段是什么
- 我能做什么
- 我必须提交什么
- 什么算完成
- 什么时候算 stale
- 是否允许 spawn 子 agent
- 是否需要人工批准

### 4.6 Context Bundle

结构化上下文包，避免多 Agent 依赖聊天记录交接。

建议字段：

```text
context_bundles
- id
- ticket_id
- original_request
- goal
- non_goals
- constraints_json
- acceptance_criteria_json
- current_plan
- decisions_json
- progress_summary
- artifacts_json
- changed_files_json
- verification_json
- risks_json
- open_questions_json
- child_summary_json
- updated_by
- updated_at
```

### 4.7 Review Package

由 executor completion + context bundle + gate verdict 生成，供 reviewer 验收。

建议字段：

```text
review_packages
- id
- ticket_id
- assignment_id
- summary
- artifacts_json
- tests_run_json
- verification_json
- risks_json
- handoff_notes
- gate_verdict
- gate_details_json
- created_at
```

目标：Reviewer 不需要翻完整聊天记录即可验收。

### 4.8 Team Run

复杂任务的一等运行时对象。

建议字段：

```text
team_runs
- id
- root_ticket_id
- workflow_template
- status
- members_json
- shared_context_bundle_id
- task_graph_json
- started_at
- completed_at
```

用于承载：

- parent/child
- dependency DAG
- shared context
- parallel task
- synthesis
- cascade failure

### 4.9 Governance Event

Auditor / platform 产生的治理事件。

建议字段：

```text
governance_events
- id
- ticket_id
- assignment_id
- event_type
- severity
- actor
- target_role
- target_agent
- reason
- evidence_json
- recommendation_json
- status
- dedupe_key
- created_at
- resolved_at
```

事件类型示例：

- `stale_assignment`
- `missing_evidence`
- `routing_mismatch`
- `executor_reviewer_conflict`
- `delivery_ack_failed`
- `context_handoff_missing`
- `parent_closeout_blocked`
- `rate_limited`
- `agent_offline`

### 4.10 Acceptance Gate

机器辅助验收门禁。

建议字段：

```text
acceptance_gate_runs
- id
- ticket_id
- workflow_template
- gate_key
- verdict             # pass/partial/blocked/failed/insufficient_evidence/contract_mismatch
- checks_json
- evidence_json
- created_at
```

---

## 5. 关键系统能力

### 5.1 Capability-based Routing Engine

输入：

```json
{
  "task_type": "software_task",
  "required_capabilities": ["ticket-platform.backend", "sqlite"],
  "project": "ticket-platform",
  "priority": "high",
  "preferred_agents": [],
  "excluded_agents": [],
  "needs_review": true
}
```

输出：

```json
{
  "executor": "beavy",
  "reviewer": "leoss",
  "auditor": "auditor",
  "reason": "beavy has ticket-platform/backend capability and no active running ticket",
  "fallback_agents": []
}
```

必须持久化 routing reason，方便审计。

### 5.2 Handoff Protocol

阶段流转必须提交结构化 handoff。

Executor `running -> done` 最低要求：

```json
{
  "summary": "...",
  "artifacts": [],
  "tests_run": [],
  "verification": "...",
  "risks": [],
  "handoff_notes": "..."
}
```

Reviewer `review -> complete/reject` 最低要求：

```json
{
  "verdict": "approve|reject|decision_required",
  "review_summary": "...",
  "evidence_checked": [],
  "issues": [],
  "recommendation": "..."
}
```

### 5.3 Execution Mode

平台需要支持多执行器：

- `openclaw_session`
- `subagent`
- `acp`
- `remote_agent`
- `script_job`
- `human`
- `external_service`

每种 mode 需要定义：

- start
- heartbeat
- progress
- cancel
- timeout
- artifact collection
- failure handling

### 5.4 Reviewer Workbench

Reviewer 页面/API 应聚合：

- 待我验收
- Review Package
- Context Bundle
- Acceptance Gate verdict
- 子任务状态
- approve/reject/request decision 操作

目标：Reviewer 3 分钟内能做出可信判断。

### 5.5 Auditor Workbench

Auditor 页面/API 应聚合：

- stale tickets
- missing evidence
- routing mismatch
- assignment stale
- delivery/ack failure
- context handoff missing
- parent closeout blocked

Auditor 产出 governance event，而不是散落的评论和临时 nudge。

---

## 6. 迁移策略

### Phase 0：不破坏现有链路的文档与 schema 准备

- 新增本设计文档。
- 新增 schema / fixture，不改变 live 行为。
- 把当前工单流声明为未来 `software_task_v1` 的基线。

### Phase 1：Registry + Template 基础表

新增：

- `agents`
- `capabilities`
- `role_contracts`
- `workflow_templates`

并提供只读 API：

- `GET /api/v1/platform/agents`
- `GET /api/v1/platform/capabilities`
- `GET /api/v1/platform/role-contracts`
- `GET /api/v1/platform/workflow-templates`

要求：

- 不影响现有 `/api/v1/agent/*` contract。
- 默认 seed 当前 agent 拓扑：leoss、beavy、doggy、marely、auditor、cowder、donky。

### Phase 2：Routing Engine v1

新增 route preview API：

- `POST /api/v1/platform/routing/preview`

能力：

- 根据 capability / role / health / concurrency 给出 executor/reviewer/auditor 建议。
- 记录 routing reason。
- 初期只 preview，不直接替换 dispatch。

### Phase 3：Assignment Contract v2 shadow mode

在现有 assignment 上增加 v2 contract 字段或旁路视图：

- allowed_actions
- required_outputs
- context_bundle_ref
- stale_after
- superseded_by

shadow mode 下只读展示，不改变现有状态推进。

### Phase 4：Context Bundle + Review Package

新增结构化上下文包与验收包。

- completion report 生成 review package。
- reviewer 页面优先展示 review package。
- 缺失 handoff 时生成 governance event。

### Phase 5：Governance Event + Auditor Workbench

把 stale / missing evidence / routing mismatch / delivery failure 等统一成 governance event。

### Phase 6：Team Run / Task DAG

把 parent/child/dependency 升级为 team run + task graph。

---

## 7. 第一阶段实施建议

第一阶段目标是低风险建立通用平台抽象，不改现有核心工作流。

建议 Codex 优先实施：

1. 新增设计文档：`docs/multi-agent-platform-design-v1.md`
2. 新增平台 schema module：`api/platform-registry.js` 或等价位置
3. 新增 SQLite migration / ensure table 逻辑
4. seed 当前 agents / capabilities / role contracts / software_task_v1 template
5. 新增只读 API：
   - `GET /api/v1/platform/agents`
   - `GET /api/v1/platform/capabilities`
   - `GET /api/v1/platform/role-contracts`
   - `GET /api/v1/platform/workflow-templates`
6. 新增测试：
   - seed 后能读到默认 4 role contracts
   - seed 后能读到当前 agent 拓扑
   - `software_task_v1` 存在且 enabled
   - API 不影响既有测试
7. 更新 README 或 current-state 文档，说明这是 shadow-mode 平台抽象，不改变 live dispatch 行为。

---

## 8. 验收标准

第一阶段完成标准：

- `npm test` 通过。
- 新增平台 registry API 有测试覆盖。
- 当前 live agent-facing contract 不变。
- 当前 dispatch / notify 逻辑不变。
- 数据库初始化可自动创建新表。
- 新表有默认 seed。
- 文档明确说明 Phase 1 是 shadow mode。

---

## 9. 非目标

第一阶段不做：

- 不替换现有 dispatch route。
- 不改现有 assignment token 语义。
- 不强制 running -> done 提交新 handoff schema。
- 不改前端核心看板。
- 不引入大规模 DAG engine。
- 不接入新的外部 agent runtime。

---

## 10. 总结

平台下一阶段的核心不是“多几个 Agent 名字”，而是建立以下一等对象：

```text
Agent
Role
Capability
Workflow Template
Assignment Contract
Context Bundle
Review Package
Team Run
Governance Event
Acceptance Gate
```

Phase 1 先建立 Agent / Role / Capability / Workflow Template 四个抽象，并以 shadow mode 暴露只读 API。这样可以在不破坏现有工单链路的情况下，为后续 capability routing、context bundle、review package、auditor governance 和 team DAG 打基础。
