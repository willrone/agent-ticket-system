# Incident: workflow_mismatch 误判拦截正常 dispatch

- 日期：2026-03-14
- 类型：workflow mismatch false positive
- 状态：已有修复与回归证据，待补独立 incident fixture

## 现象

历史 stuck 单在恢复过程中，`/api/dispatch/ready` 会因评论内容误判触发 `workflow_mismatch`，拦住正常 running dispatch。已识别的误伤来源包括：

1. system / audit 评论被当作真实阻塞语义参与判断
2. 普通实现说明里的 `context / 上下文` 被误判成 `context_gap`

## 影响

- dispatch ready 结果被错误抑制
- 历史 stuck 单无法自动恢复为正常 running assignment / dispatch
- 审计/评论噪音污染真实责任链判断

## 当前证据

- `memory/2026-03-15.md`
- `memory/2026-03-15-ticket-33.md`
- `api/app.js`（workflow mismatch 相关逻辑）
- `api/app.test.js`（相关回归位于 running / receipt / nudge / review 测试群）

## 建议 fixture（待补）

- `audit-comment-ignored.snapshot.json`
- `context-gap-strict-match.snapshot.json`
- `workflow-mismatch-before-after.diff.json`
