# Ticket Processing Flow v1

> 目标：把工单平台当前真实处理流程收成统一口径，明确 **平台负责状态推进，agent 负责 receipt / report / action 调用**，避免状态、assignment、dispatch、worker、audit 链路理解混乱。

## 1. 总原则

### 1.1 平台负责状态推进
agent / reviewer / triage_owner **不能直接改状态**。

agent 能做的只有三类动作：
- `dispatch_receipt`
- 结构化 `report`
- 调用平台公开的受控 `action`

真正把 ticket 从一个 workflow 阶段推进到下一个阶段的，是 **平台**。

### 1.2 创建工单只能创建成 triage
`POST /api/tickets` 与 agent-facing create 都只允许创建 `triage`。
任何执行态 / 审核态 / 终态都必须通过后续 workflow transition 进入。

### 1.3 assignment 只代表“当前阶段处理凭证”
assignment 不是 ticket 本身，而是平台针对“当前阶段 + 当前责任人”下发的一张处理凭证。

**重要约束**：一旦 ticket 跨阶段，平台必须同步刷新 assignment；旧 assignment 不应跨阶段续写。

### 1.4 工单平台相关需求执行人约束
涉及 `platform=ticket-platform` 的需求：
- `leoss`：分诊 / review / 母单统筹
- `beavy`：唯一执行人
- `donky / cowder`：不参与工单平台需求执行

---

## 2. 五条并行链路

平台当前运行态不是单一 status，而是五条链并行：

### 2.1 业务状态链
- `triage`
- `queued`
- `running`
- `paused`
- `done`
- `review`
- `pending_decision`
- `blocked`
- `failed`
- `complete`

### 2.2 责任人链
- `triage_owner`
- `assigned_agent`
- `review_owner`
- `decision_owner`
- `current_actor`
- `next_actor`

### 2.3 派单握手链
- `pending_delivery`
- `awaiting_receipt`
- `receipt_accepted`
- `receipt_declined`
- `receipt_overdue`

### 2.4 assignment 生命周期链
- triage assignment
- queued assignment
- running assignment
- review assignment
- 以及阶段变化后的 stale / superseded 处理

### 2.5 worker / execution 链
适用于 `execution_mode=subagent/acp`：
- worker 是否创建
- worker 是否 running
- worker 是否 finished
- worker 是否与当前 assignment / 当前阶段对齐

---

## 3. 标准主流程

### 3.1 create -> triage
创建工单后默认进入 `triage`。

责任人：`triage_owner`

当前阶段目标：
- 补齐范围
- 明确执行人
- 明确 reviewer
- 明确交付物 / 约束 / 验收标准

合法输入：
- `dispatch_receipt`
- `triage_structured_report`
- `queue`
- 或必要时 `pause / blocked_report / decision_request`

平台动作：
- 当 triage 条件满足时，通过 `queue` 推进到 `queued`

### 3.2 queued -> running
责任人：`assigned_agent`

当前阶段目标：
- 正式接单
- 合法进入开工态

合法输入：
- `dispatch_receipt`
- `start_work`
- 或 `blocked_report / decision_request / execution_failed / pause`

平台动作：
- 派发 queued assignment
- receipt accepted 后允许 `start_work`
- 如 execution_mode 需要 worker，先校验 worker evidence
- 通过后推进到 `running`

### 3.3 running -> done / blocked / pending_decision / failed / paused
责任人：`assigned_agent`

当前阶段目标：
- 持续回写进度
- 最终进入待验收或异常分支

合法输入：
- `progress_update`
- `execution_completed`
- `blocked_report`
- `decision_request`
- `execution_failed`
- `pause`

平台动作：
- 正常 happy path：`execution_completed -> done`
- 异常路径：转到 `blocked / pending_decision / failed / paused`

### 3.4 done -> review
责任人：`review_owner`

当前阶段目标：
- reviewer 正式接单并进入验收态

合法输入：
- `dispatch_receipt`

平台动作：
- `decision=accepted && stage=done` -> `start_review`（`done -> review`）

### 3.5 review -> complete / queued
责任人：`review_owner`

当前阶段目标：
- 形成 reviewer 结论
- 通过或打回

合法输入顺序（强制）：
1. `dispatch_receipt`
2. `review_submission`
3. `approve / reject`

平台动作：
- `approve` -> `complete`
- `reject` -> `queued`

---

## 4. 各状态的处理目标

### triage
目标：把“待分诊需求”收敛成可执行工单。

### queued
目标：把“可执行工单”派给正确执行人，并准备进入 running。

### running
目标：执行人与 worker 真正干活，并持续回写进度。

### paused
目标：合法挂起，等待未来恢复。

### done
目标：执行已完成，等待 reviewer 接手。

### review
目标：reviewer 验收并给出通过 / 打回结论。

### pending_decision
目标：等待上级/人类拍板。

### blocked
目标：外部依赖未满足，当前无法继续。

### failed
目标：当前阶段已失败，等待后续处置。

### complete
目标：工单正式关单。

---

## 5. 审计 / 催办口径（当前 live）

### 平台检查频率
- audit poller：30 秒一次

### stale 阈值
- `triage`：5 分钟
- `queued`：10 分钟（单独 queued stale 催办）
- `running`：10 分钟
- `done`：10 分钟
- `review`：10 分钟
- `paused`：240 分钟
- `blocked`：240 分钟
- `pending_decision`：720 分钟

### 催办口径
- queued / stale audit 催办的重复节流：10 分钟
- 催办等待回复超时：10 分钟
- 原则：**催办必须得到回复，没得到回复就不算成功，未成功则继续催**

---

## 6. 当前已知混乱根源

### 6.1 状态变了，但 assignment 没刷新
典型现象：ticket 已进 `running`，agent 手里仍是旧 `queued assignment`，写回报 `409 ASSIGNMENT_STALE`。

### 6.2 平台没有公开合法推进入口
典型现象：workflow schema 有 action，但 agent-facing contract 没暴露，导致业务判断完成却无法合规触发平台推进。

### 6.3 ticket detail / dispatch ready / 日志 / projection 不一致
典型现象：票面看着可派，ready 列表没有；日志还在报旧冲突。

### 6.4 母单 / 子单职责混乱
母单应做统筹与汇总，不宜承担长执行；执行应落到子单。

### 6.5 默认 assigned_agent / 历史残留未清理
典型现象：queue 前没纠正 `assigned_agent`，平台按旧值派错执行人。

### 6.6 审计催办体验与底层事件不一致
底层多轮 nudge 已发生，但外部提醒未充分显性化，造成“看起来没催”的错觉。

---

## 7. 强约束（必须成立）

1. **平台负责状态推进，agent 不直写状态**
2. **create 只能是 triage**
3. **任何跨阶段都必须刷新 assignment**
4. **平台把阶段派给 agent 时，必须同时存在合法的受控推进链**
5. **工单平台需求执行人默认只能是 beavy**
6. **催办以收到回复为成功；无回复必须继续催**
7. **ticket detail / ready projection / 日志 / assignment 需要四层一致**

---

## 8. 当前推荐实践

### 母单
- 用于统筹、矩阵、汇总、验收方法论
- 不直接承担长执行

### 子单
- 承担具体实现 / smoke / 修复 / 回归
- 在 live 上完成 receipt / report / action / review 收口

### 长任务
- 可在 ticket session 下挂 subagent worker
- 但平台最终收口仍由当前 ticket 会话完成

---

## 9. 一句话总结

> 工单平台真正的复杂度，不在“状态多”，而在 **状态、责任人、assignment、派单握手、worker、审计** 六条链必须同步。只要其中一条没跟上，现场就会表现为“状态管理混乱”。
