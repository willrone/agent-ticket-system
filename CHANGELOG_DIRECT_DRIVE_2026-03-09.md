# 2026-03-09 变更说明：平台直驱 dispatch/notify

## 背景

本次改造把工单平台从：

- 平台内置 poller -> Sheeply -> 目标 session / 老大通知

调整为：

- 平台内置 poller -> 直接投递目标 session / `agent:main:main`

目标是让 **Sheeply 退出派单/通知执行链路，只保留工单审计角色**。

---

## 核心变化

### 1. 平台直驱 dispatch
- `dispatch poller` 不再唤醒 `agent:auditor:main`
- 直接根据 `dispatch/ready` 中的 `agent` 路由到目标主会话
- 当前显式路由：
  - `beavy -> agent:beavy:main`
  - `donky -> agent:donky:main`
  - `cowder -> agent:cowder:main`
  - `doggy -> agent:doggy:main`
  - `marely -> agent:marely:main`
  - `leoss -> agent:main:main`
- 未知 agent / 人名类目标（如 `荣晖`）回退到 `agent:main:main`

### 2. 平台直驱 notify
- `notify poller` 直接把 `notifications/ready` 投递到 `agent:main:main`
- 不再通过 Sheeply 中转

### 3. ack 规则收紧
- 只有在 **明确投递成功** 后才 ack
- `timeout / error / 未知结果` 一律**不 ack**
- `pending_decision` 继续保持 **notify-only**，不进入 `dispatch/ready`

### 4. Sheeply 角色收口
- Sheeply 不再负责派单/结果通知执行
- Sheeply 后续只保留：
  - 工单巡检
  - 流程异常审计
  - `workflow_mismatch` 识别与告警

---

## 真机验收结论

### dispatch
真机日志已确认：
- `dispatch_id=68 -> agent:main:main`
- `dispatch_id=69 -> agent:beavy:main`

说明 dispatch 已经由平台直接投递并成功 ack。

### notify
真机测试单 `#31 [E2E TEST] direct-drive pending_decision notify` 已确认：
- 不进入 `/api/dispatch/ready`
- 只进入 `/api/notifications/ready`
- 最终成功投递到 `agent:main:main` 并 ack：`event_id=51`

---

## 顺手修复的实现偏差

### `leoss` 路由修正
直驱初版曾把 `leoss` 错映射到 `agent:leoss:main`。

已修正为：
- `leoss -> agent:main:main`

这样不会出现“看似投递成功，实则打到错误会话”的假成功。

---

## 相关提交

- `b7c40b3` `refactor: 平台直驱 dispatch/notify，Sheeply 仅保留审计角色`
- `13dcb42` `fix(dispatch): route leoss to main session`

---

## 后续建议

1. 保持 Sheeply 不再回到 dispatch/notify 执行链路
2. 后续若再做投递增强，优先补：
   - 更明确的 delivery success 语义
   - route config 可配置化
   - 针对 `workflow_mismatch` 的误报降噪
