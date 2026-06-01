# Dispatch / Notify / Receipt / Live Acceptance Baseline

## 目标

给当前仓库里与 dispatch / notify / receipt / live acceptance contract 相关的基线证据做统一入口，先解决“材料分散、事故复盘难、fixture 不成目录”的问题。

## 基线来源

### 文档
- `docs/API.md`
  - `/api/dispatch/ready`
  - `/api/notifications/ready`
  - `dispatch_receipt`
  - assignment manifest / writeback / machine-readable errors
- `docs/reference/api.md`
  - `GET /api/v1/agent/assignments/:assignment_id/live-acceptance`
  - live acceptance gate / manifest / runtime surface
- `docs/ticket-processing-flow-v1.md`
  - `dispatch_receipt` 顺序与阶段交接
- `docs/ticket-platform-current-state.md`
  - dispatch / notification / live acceptance 当前读模型说明
- `docs/pubsub-event-driven/2026-03-13-工单平台事件清单与Command Contract v1.md`
  - `dispatch_receipt(stage=queued, accepted)` 等事件 contract

### 测试
- `api/sheeply-e2e.test.js`
  - dispatch ready -> ack -> review dispatch -> complete notification -> ack
  - pending_decision notify ready -> ack
  - blocked notify ready -> ack
- `api/app.test.js`
  - queued `dispatch_receipt accepted` 后桥接到 running
  - successor running assignment refresh / stale assignment 校验
  - receipt timeout / retry metadata
  - reviewer `done -> review` receipt bridge
  - `assignment write validation` machine-readable 错误
  - live acceptance verdict（pass / partial / live-not-upgraded / contract-mismatch / dependency-not-closed）
- `api/assignment-write-validation.js`
  - `dispatch_receipt` 强校验：dispatch_id / ticket_id / stage / agent

### live capture
- `fixtures/ticket-platform-live/2026-03-15T1115+08-baseline/capture-manifest.json`
- `fixtures/ticket-platform-live/2026-03-15T1115+08-baseline/dispatch-ready.json`
- `fixtures/ticket-platform-live/2026-03-15T1115+08-baseline/agent-assignment-running-33.json`
- `fixtures/ticket-platform-live/2026-03-15T1115+08-baseline/agent-runtime-context.json`
- `fixtures/ticket-platform-live/2026-03-15T1115+08-baseline/agent-skills-current.json`

## 当前 catalog 覆盖面

| contract area | baseline source | 当前状态 |
| --- | --- | --- |
| dispatch ready | `docs/API.md`, `api/app.test.js`, live capture #33 | 已有文档 + 测试 + live snapshot |
| notification ready | `docs/API.md`, `api/sheeply-e2e.test.js` | 已有文档 + e2e 证据 |
| dispatch receipt bridge | `docs/API.md`, `docs/reference/api.md`, `api/app.test.js` | 已有较强基线 |
| dispatch receipt validation | `api/assignment-write-validation.js`, `api/app.test.js` | 已有 machine-readable error contract |
| assignment live acceptance | `docs/reference/api.md`, `api/app.test.js`, live runtime capture | 已有 verdict + runtime 断面 |
| replay fixture snapshot | `docs/live-contract-fixtures/**/*.json` | 已有 machine-readable MVP |

## 当前已落地的 JSON fixtures

### baseline
- `baseline/dispatch-ready.running-33.snapshot.json`

### incidents
- `incidents/terminal-stage-should-not-enter-dispatch.json`
- `incidents/dispatch-receipt-cross-ticket-or-event-mismatch.error.json`
- `incidents/pending-decision-should-not-enter-dispatch.json`
- `incidents/dispatch-dedupe-ticket-agent-status-contract.json`
- `incidents/dependency-not-closed-live-acceptance.json`
- `incidents/live-contract-mismatch-verdicts.json`

## 已识别并固化的基线事实

1. reviewer 主交接已统一走 `/api/dispatch/ready` + `dispatch_receipt`
2. `/api/notifications/ready` 主要承担 `pending_decision` / `complete` / `failed` / `blocked` 等通知，不承担 reviewer 主交接
3. `dispatch_receipt` 已有强校验，必须同时对齐 `dispatch_id / ticket_id / stage / agent`
4. live acceptance 已有 reviewer 可消费的 verdict：`pass / partial / live-not-upgraded / contract-mismatch / dependency-not-closed`
5. 去重 contract 不能退化成 ticket 粗粒度，至少要保留 `stage + reason + actor`

## 后续扩展建议

下一轮可把这里的 machine-readable fixture 再升级成可执行 replay：

1. 从 `api/sheeply-e2e.test.js` 抽出完整 notify/dispatch before-after payload
2. 给 `dispatch_receipt` 错误族补齐 ticket_id/stage/agent 三类真实回放样本
3. 把 `workflow_mismatch` false-positive 也补成 JSON before/after replay fixture
4. 增加 fixture 与 live capture batch 的自动关联校验
