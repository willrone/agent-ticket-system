# Ticket Platform v2 Bootstrap（首轮骨架）

_Updated: 2026-03-20_

这份文档不是空想版 v2，而是基于当前工作树里**已经存在**的 runtime / workflow / topology 能力，给 ticket #174 以及 child tickets #175 / #176 / #177 一个可直接并行推进的 bootstrap 切口。

> 当前 canonical v2 独立验收入口固定为：`http://127.0.0.1:8790`
>
> - 宿主目录：`/Users/ronghui/Projects/agent-ticket-system-v2`
> - DB：`/Users/ronghui/Projects/agent-ticket-system-v2/data/tickets-v2.db`
> - 启动脚本：`/Users/ronghui/Projects/agent-ticket-system-v2/scripts/run-api-v2.sh`
> - LaunchAgent label：`ai.openclaw.ticket-platform-api-v2`
> - 8788 仅作为 live 对照面，不作为本轮 v2 默认验收入口

## 1. 现状证据（为什么这里最适合先落）

当前仓库已经具备三块可复用地基：

1. **agent-facing runtime bootstrap 已存在**
   - `GET /api/v1/agent/runtime/context`
   - `GET /api/v1/agent/workflow/schema`
   - `GET /api/v1/agent/skills/current`
   - `GET /api/v1/agent/playbooks/ticket-handler`

2. **agent / platform / gateway 目录已存在，但还停留在 topology 视角**
   - `api/agent-topology.js`
   - 已包含 `agent_directory / platforms / gateways / responsibility_layers / topology_edges`

3. **participant-based routing 所需字段已在工单模型落链**
   - `triage_owner`
   - `assigned_agent`
   - `review_owner`
   - `next_actor / current_actor`

因此，v2 第一刀不该先做复杂 orchestrator，而应该先把：

- topology → **participant registry contract**
- role field guessing → **participant-based routing resolve contract**
- docs scattered wording → **bootstrap entrypoint contract**

先固化出来。

---

## 2. 本轮已落的最小骨架

### 2.1 Participant registry skeleton
新增：`GET /api/v1/agent/participants`

用途：
- 给 agent/runtime/bootstrap 一个稳定的 participant registry 视图
- 把 `agent-topology` 的内部结构收口为 agent-facing contract
- 支撑 child #176（participant registry）

当前返回最小字段：
- `participants[]`
  - `participant_id`
  - `display_name`
  - `role_type`
  - `ownership_layer`
  - `primary_platform`
  - `responsibilities`
  - `platform_roles`
  - `gateway`
- `platforms[]`
- `routing_roles[]`
- `summary`

支持最小 query：
- `platform_id`
- `participant_id`
- `role_key`

### 2.2 Participant detail skeleton
新增：`GET /api/v1/agent/participants/:participant_id`

用途：
- 给 bootstrap / 调试 / explainability 一个单 participant 最小读取面
- 避免调用方重复在 runtime context / topology / docs 里拼 participant 信息

### 2.3 Participant-based routing skeleton
新增：`GET /api/v1/agent/routing/resolve`

用途：
- 给 caller 一个统一“按 platform + role 解析目标 participant”的 contract
- 先解决 child #177 的**可落最小切口**：不要再让调用方自己猜
  - `platform.triage_owner_agent_id`
  - `platform.review_owner_agent_id`
  - `platform.development_agent_ids[0]`
  - `platform.audit_agent_ids[0]`

当前支持：
- `participant_id` 直查
- `platform_id + role_key` 解析
- 返回 `resolved + gateway + route_target + explain`

> 这是 skeleton，不是最终 dispatcher。它的价值是先把 participant-based routing 的**解释 contract** 固化下来，后续 dispatch/notify/poller 才能安全迁移到同一入口。

### 2.4 Runtime bootstrap contract 扩展
已把 runtime context 的 `bootstrap` 扩成：
- `bootstrap.participant_registry`
- `bootstrap.participant_route_resolve`

并新增 feature flags：
- `feature_flags.participant_registry_api=true`
- `feature_flags.participant_route_resolve_api=true`

这样 child #175 的“并行工程骨架”就有了可引用的 bootstrap contract，而不是继续靠口头约定。

---

## 3. 对 child tickets 的直接对应

### child #175：并行工程骨架
本轮可直接复用：
- `runtime_context.bootstrap.*`
- `docs/ticket-platform-v2-bootstrap.md`
- `participant registry / route resolve` 的 API skeleton

建议下一步：
1. 给 hosted skill/playbook bundle 增加 “bootstrap order v2” 说明
2. 在 live acceptance 中加入 `required_bootstrap_endpoints=participant_registry,participant_route_resolve`
3. 为 runtime context 增加 `bootstrap_contract_version`

### child #176：participant registry
本轮已给出最小 contract：
- `GET /api/v1/agent/participants`
- `GET /api/v1/agent/participants/:participant_id`

建议下一步：
1. 加 `participant_capabilities / availability / accepts_assignment_types`
2. 区分 human participant 与 agent participant
3. 给 registry 增加 checksum / version pin

### child #177：participant-based routing
本轮已给出最小切口：
- `GET /api/v1/agent/routing/resolve`

建议下一步：
1. 把 dispatch/notify 的 participant 解析逐步收敛到这里
2. 增加 `route_intent`（dispatch / notify / escalate / review_handoff）
3. 增加 machine-readable fallback reason，而不是只有 explain 文本

---

## 4. 为什么这轮先不做更重的东西

本轮故意**不**直接上：
- 新 DB 表
- 新 worker orchestrator
- 新 dispatch engine 重写
- 多 participant 写路径

原因：
1. 当前仓库已经有 runtime / workflow / topology；缺的是统一 bootstrap contract，不是又一个系统。
2. 如果 participant registry / routing contract 还没收口，后续任何 dispatch/notify 重构都会再次散落成多份解释逻辑。
3. 先把 skeleton 固化，可以让 docs / api / tests 同步推进，并支持子票并行开发。

---

## 5. 建议下一轮最小增量

优先级建议：

### P0
1. `live-acceptance` 增加 bootstrap endpoints 校验样例
2. hosted bundle 文案明确引用 `participants` / `routing/resolve`
3. `routing/resolve` 增加 `route_intent`

### P1
4. dispatch ready / notification ready 的 participant 解析逐步改成走 resolver
5. UI（BotStatus / TicketDetail）引入 participant registry 只读展示

### P2
6. participant registry 增加 capability / status / eligibility 字段
7. 为 parent/child closeout 提供 participant-aware reviewer summary

---

## 6. 本轮结论

v2 bootstrap 第一刀已经明确：

> **先把 participant registry + participant-based routing 变成 agent-facing bootstrap contract，再让并行工程、registry 扩展、routing 收敛三条子线往前走。**

这比继续泛泛讨论 “v2 要不要重构成事件驱动 / orchestrator / 多 worker 中枢” 更可执行，也更符合当前工作树现状。
