# Incident: queued receipt accepted 后 running successor assignment / dispatch 未及时补发

- 日期：2026-03-14
- 类型：dispatch / receipt / assignment refresh 断链
- 状态：已在仓库测试与记忆中留痕，待补独立 replay fixture

## 现象

queued assignment 完成 `dispatch_receipt(decision=accepted)` 后，ticket 会桥接到 `running`，但历史问题里 successor running assignment / `delivery_requested` / reservation 未完整补建，导致：

- 旧 queued assignment 立刻 stale
- 新 running assignment 没有正常投递入口
- agent 看起来“已经接单”，但拿不到可继续回写的 running contract

## 当前证据

- `api/app.test.js`
  - `queued receipt accepted 桥接到 running 后会立即生成新的 running assignment...`
  - `subagent queued receipt accepted 但缺 worker 时保持 queued，补 worker 后自动桥接到 running`
- memory / 现场记录：
  - `memory/2026-03-15-ticket-33.md`
  - `memory/2026-03-15.md`

## 影响面

- running 阶段 dispatch contract
- stale assignment 校验
- queued -> running 的 hosted contract 闭环

## 建议 fixture（待补）

- `receipt-accepted-successor-running.snapshot.json`
- `subagent-receipt-awaits-worker.snapshot.json`
- `stale-assignment-after-successor.error.json`
