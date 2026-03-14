# Ticket Processing Governance Checklist

> 目标：列出当前流程治理缺口，并按优先级排给 beavy / leoss 收口。

## P0（必须优先修）

### P0-1. 阶段变化后自动刷新 assignment
**问题**：ticket 跨阶段后，旧 assignment stale，但平台未同步补发新阶段 assignment。

**风险**：
- `409 ASSIGNMENT_STALE`
- running / review 阶段 hosted write path 断链
- agent 无法合法继续推进当前阶段

**要求**：
- `triage -> queued` 补 queued assignment
- `queued -> running` 补 running assignment
- `done -> review` 补 review assignment
- 旧 assignment 进入 superseded / stale 语义，不允许跨阶段续写

---

### P0-2. 平台把阶段派给 agent 时，必须保证存在合法推进链
**问题**：历史上出现过 workflow 有 `queue`，但 agent-facing contract 未暴露 queue action，导致 triage 已完成却不能进入 queued。

**要求**：
- 任何可被派发的阶段，都必须至少满足二选一：
  1. 有受控 action API
  2. 有 report interpreter 自动桥接
- 不允许“责任已派给 agent，但平台没有合法推进入口”

---

### P0-3. 工单平台需求执行人约束入平台规则
**问题**：工单平台相关单曾误派给 donky / cowder。

**要求**：
- 对 `platform=ticket-platform` 的执行单，默认执行人只允许 `beavy`
- `leoss` 保留 triage / review / 母单统筹
- 平台在 queue / dispatch 前应校验执行人是否符合该业务域约束

---

### P0-4. 母单 / 子单职责硬区分
**问题**：母单既做统筹又被当成长执行单，容易状态错位。

**要求**：
- 母单：治理 / 汇总 / 验收矩阵 / 问题归档
- 子单：实现 / 修复 / smoke / 回归
- 平台应支持父单引用子单结果进行汇总，而不是逼母单自己 running 很久

---

## P1（强烈建议尽快修）

### P1-1. ready projection / ticket detail / 日志 / dispatch 真相四层一致
**问题**：曾出现 detail 显示无冲突，但 dispatch/ready 仍误判 conflict。

**要求**：
- ticket detail
- dispatch/ready
- ready projection
- poller 日志
必须对同一 ticket 得出一致结论。

---

### P1-2. 催办成功判定改成“收到回复才算成功”
**问题**：历史上存在一次审计 / 催办后即停止重复催办的粗暴去重。

**要求**：
- 催办消息若未收到回复，不算成功
- 按 cooldown 周期继续催
- 回复可以是 receipt / progress / comment / assignment write 等合法回执

---

### P1-3. 审计与外部提醒体验对齐
**问题**：底层已有多轮 nudge，但外部体验像“没催”。

**要求**：
- ticket 内 comment
- dispatch nudge
- 外部提醒（如 Sheeply / 主会话提示）
要形成可见的一致体验。

---

### P1-4. blocked / paused / pending_decision 恢复链清晰化
**问题**：blocked 原因已解除，但 ticket 仍停留在 blocked。

**要求**：
- 给出明确恢复入口
- 平台能在条件满足后恢复到正确下一阶段
- 不要让 blocked 成为“垃圾桶状态”

---

## P2（治理增强）

### P2-1. 平台管理面手动修复接口
建议补：
- reconcile
- refresh-assignment
- release-reservation
- redispatch
- rebuild projection
- 受控 admin actions

原则：让平台自己修，不要靠裸改状态。

---

### P2-2. 流程文档与 live contract 自动对齐
**问题**：workflow schema、playbook、API 文档、页面提示可能漂移。

**要求**：
- 关键 action 从单一 schema 生成
- 文档与 runtime context 同源
- 减少“文档说有 / live 没有”的漂移

---

### P2-3. 默认字段兜底规则显性化
**问题**：默认 `assigned_agent=donky` 之类的历史口径容易误派。

**要求**：
- 所有默认值可审计
- queue 前强校验关键字段
- 对父单 / 治理单加特别校验

---

## 建议执行顺序
1. P0-1 assignment stage refresh
2. P0-2 合法推进链完备性
3. P0-3 工单平台执行人域约束
4. P0-4 母单/子单职责硬区分
5. P1-2 催办成功判定
6. P1-1 四层一致性
7. P1-3 审计提醒体验
8. P1-4 blocked/paused 恢复链
9. P2 其余治理项

---

## 一句话总结

> 当前最大的治理目标不是再加更多状态，而是让“每个阶段都可合法推进、每次跨阶段都刷新 assignment、每次催办都以收到回复为成功”。
