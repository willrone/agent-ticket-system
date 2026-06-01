# Frontend Acceptance Baseline

用于把工单平台前端验收统一到三层 contract：API contract、DOM contract、浏览器运行态 contract，并保证 fixture / selector / workflow schema 同步。

## 目标

- 防止再次出现“视觉看起来通过，但运行态语义错误”。
- 让 Dashboard / Tickets / Kanban / TicketDetail 四个核心页面共享同一套 canonical baseline。
- reviewer 能复用固定清单做 live 验收，而不是临场猜页面语义。

## Baseline 组成

### 1. API contract

以 `workflow-schema.js` + `ticket-selectors.js` 为单一语义源：

- 状态顺序：`WORKFLOW_STATUS_ORDER`
- 看板列：`KANBAN_COLUMNS`
- bucket 映射：`WORKFLOW_BUCKET_META`
- 指标分组：`WORKFLOW_METRIC_GROUPS`
- 页面 view-model：`buildTicketViewModel()` / `buildDashboardMetrics()`
- agent-facing reviewer action matrix：`FRONTEND_ACCEPTANCE_AGENT_ACTION_MATRIX`，只固化 reviewer 关心的 hosted action 基线（`queue/start_work/pause/resume/approve/reject`），并要求同时对齐 `workflow-schema.js -> listAvailableActionsForStatus()` 与 live hosted runtime fixture `fixtures/ticket-platform-live/2026-03-15T1115+08-baseline/agent-runtime-context.json`

### 2. DOM contract

测试文件：

- `src/pages/frontendAcceptanceBaseline.test.jsx`
- `src/test/frontend-acceptance-fixtures.test.js`

覆盖要求：

- Dashboard 必须展示 runtime-semantic stats 与两张图表容器
- Tickets 必须展示 quick views、平台/类型/执行人等 canonical 列语义
- Kanban 必须逐列展示所有 canonical status，不得把 `done/review/complete` 混成一列
- TicketDetail 必须展示挂起、依赖、补充验证、锁定等 reviewer 关心的运行态 contract
- TicketDetail / shared fixture 必须把 agent-facing action matrix（`queue/start_work/pause/resume/approve/reject`）与 hosted runtime context 的 `ticket_actions.allowed_statuses` 对齐，避免前端 baseline 只校验单点按钮而漏掉整张动作矩阵

### 3. 浏览器运行态 contract

reviewer 验收时至少走一遍 live 页面，确认：

1. Dashboard 图表在真实浏览器运行态可见，不依赖截图脑补
2. Tickets 列表里的状态、Next Actor、筛选 quick view 与 live ticket 真值一致
3. Kanban 每列标签与 workflow schema 一致，`done/review/complete` 不混淆
4. TicketDetail 中挂起原因、依赖关系、补充验证关系与 live API 返回一致
5. 改造期间 8788 服务、dispatch poller、notify poller 正常工作，没有因验收被中断

## Shared fixture

共享 baseline fixture：`src/test/frontend-acceptance-fixtures.js`

约束：

- 必须覆盖全部 canonical status
- fixture 生成的 dashboard metrics 必须直接走 selector helper，而不是手写魔法数字
- quick views / bucket / kanban labels 必须从 workflow schema 推导，不允许另起一套 fixture 语义

## 推荐命令

```bash
npm test -- src/test/frontend-acceptance-fixtures.test.js src/pages/frontendAcceptanceBaseline.test.jsx
```

如需最小页面回归，可再补跑：

```bash
npm test -- src/pages/Dashboard.test.jsx src/pages/Tickets.test.jsx src/pages/KanbanBoard.test.jsx src/pages/TicketDetail.test.jsx ticket-selectors.test.js
```

## Reviewer 清单

- [ ] fixture parity 测试通过
- [ ] 四个核心页面 contract baseline 测试通过
- [ ] live 浏览器运行态核对通过
- [ ] 平台运行期间无中断，无额外停服/重启
- [ ] 新增状态或 selector 变更时，同步更新 shared fixture 与 baseline 文档
