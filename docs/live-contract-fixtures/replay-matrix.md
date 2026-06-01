# Live Contract Fixture Replay Matrix

把现有 live baseline / incident fixtures 从“只读样本”升级成“可执行 replay 回归套件”的最小矩阵。

## 一键入口

```bash
npm run replay:live-contract-fixtures
```

入口脚本：`scripts/replay-live-contract-fixtures.js`

特点：
- 直接复用 `api/app.js`、`supertest`、SQLite test DB
- 复用现有状态流转 / dispatch ready / notifications ready / assignment reports / live acceptance 接口
- 不新造 mock 状态机，只把 fixture 映射成可执行断言
- 每条断言都带 `contract_category`，失败时可直接定位 guard / contract 类别

## fixture -> 断言矩阵

| Fixture | Replay 断言 | Contract / Guard 类别 | 复用接口 / 语义 |
| --- | --- | --- | --- |
| `incidents/terminal-stage-should-not-enter-dispatch.json` | `complete` / `failed` 不进入 `dispatch/ready`，但进入 `notifications/ready` | `dispatch_ready.guard.terminal_stage_boundary` | `POST /api/tickets/:id/transition` + `GET /api/dispatch/ready` + `GET /api/notifications/ready` |
| `incidents/pending-decision-should-not-enter-dispatch.json` | `pending_decision` 只进通知，不进派发，且校验 notify dedupe key | `dispatch_ready.guard.pending_decision_notify_only` | `request_decision` + ready 查询 |
| `incidents/dispatch-receipt-cross-ticket-or-event-mismatch.error.json` | `dispatch_receipt` 校验 `dispatch_id` / `ticket_id` 绑定，不允许串票或串旧事件 | `assignment_write.contract.dispatch_receipt_binding` | `POST /api/dispatch/:id/ack` + `POST /api/agent/assignments/:id/reports` |
| `incidents/dispatch-dedupe-ticket-agent-status-contract.json` | dispatch / notify 去重必须保留 `stage + reason + actor` 语义，不能退化 | `ready_projection.contract.dedupe_key_semantics` | `dispatch/ready` + `notifications/ready` + workflow mismatch comment |
| `incidents/dependency-not-closed-live-acceptance.json` | 依赖未闭合时 live acceptance verdict 必须是 `dependency-not-closed`，且 ready 被门禁挡住 | `live_acceptance.guard.dependency_not_closed` | `POST /dependencies` + `GET /live-acceptance` + `GET /api/dispatch/ready` |

## 当前覆盖的 5 类核心断言

1. `failed/terminal-stage` 不进入 dispatch ready
2. `pending_decision` 不进入 dispatch
3. `dispatch_receipt` 校验 ticket / dispatch 绑定不串票
4. 去重至少识别 `stage + reason + actor`，不退化成粗粒度 ticket+agent+status
5. `dependency` 未满足不能进入 ready，且 live acceptance 输出 `dependency-not-closed`

## 与前端 / agent-facing baseline 的衔接

本矩阵之外，前端共享 fixture 还会额外固化一层 **agent-facing action matrix baseline**：

- 来源：`fixtures/ticket-platform-live/2026-03-15T1115+08-baseline/agent-runtime-context.json` 的 `ticket_actions`
- 落点：`src/test/frontend-acceptance-fixtures.js`
- 断言：`src/test/frontend-acceptance-fixtures.test.js`

目标不是重放按钮点击，而是保证前端 reviewer/agent 面看到的动作语义，和 hosted runtime context 公布给 agent 的 `allowed_statuses` 保持同一张基线表。

## 输出形式

replay 脚本输出 machine-readable JSON：
- `matrix`: fixture -> assertion -> contract_category
- `results`: 每个 fixture 的 pass/fail、具体 artifacts
- `status`: 整体结果

若断言失败，结果中至少包含：
- `fixture`
- `assertion`
- `contract_category`
- `error`
- `details`

便于直接归因到 guard / contract 层，而不是只得到一段松散日志。
