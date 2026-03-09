# Agent Ticket System

一个基于 React + Express + SQLite 的工单系统，支持多 Agent 协同处理工单、状态流转、评论时间线与通知摘要。

## 开发命令

```bash
npm install
npm run dev       # 前端开发服务
npm run dev:api   # 后端 API（默认 8788）
npm test          # 单元测试
npm run build     # 前端构建
```

## 存储说明（SQLite only）

当前版本仅使用 **SQLite** 持久化，不再支持 JSON 存储切换。

- DB 路径：`data/tickets.db`
- 可通过环境变量覆盖：`TICKETS_DB_PATH`

## 内置轮询线程（平台直驱）

`npm run dev:api` / `node api/server.js` 启动后会内置 2 个轮询线程，**由平台直接投递到目标会话**，不再经 Sheeply 中转：

1. **dispatch poller**（默认 5 分钟）
   - 检测 `/api/dispatch/ready`
   - 按 **agent → sessionKey** 映射（beavy/donky/cowder/doggy/marely/leoss → 各自 `agent:{agent}:main`）直发目标 agent 主会话；未知 agent（如 workflow_mismatch 告警对象）发往 `agent:main:main`
   - 仅当 OpenClaw `chat.send` 成功（且未超时）时才调用 `/api/dispatch/:id/ack`，超时/错误一律不 ack
2. **notify poller**（默认 2 分钟）
   - 检测 `/api/notifications/ready`
   - 直发 **agent:main:main**（老大/主会话）；仅 delivery 成功后才 ack 对应 notification 事件

> **Sheeply（agent:auditor:main）** 仅保留工单审计等角色，**不再参与 dispatch/notify 执行链路**。业务判断仍由 `/api/dispatch/ready` 与 `/api/notifications/ready` 的 API 决定；平台只负责按 ready 结果直驱投递与严格 ack。

### 相关环境变量

- `TICKET_INTERNAL_POLLERS_ENABLED`：是否启用内置轮询（默认 `true`）
- `TICKET_DISPATCH_POLL_INTERVAL_MS`：dispatch 轮询间隔（默认 `300000`）
- `TICKET_NOTIFY_POLL_INTERVAL_MS`：notify 轮询间隔（默认 `120000`）
- `TICKET_DELIVERY_TIMEOUT_MS`：单次 chat.send 超时（默认 `30000`），超时则不 ack

## 评论增强 v2 API

### 1) 新增评论

`POST /api/tickets/:id/comments`

请求体：

```json
{
  "content": "阻塞 @ops 需要确认",
  "author": "donky",
  "type": "blocker",
  "visibility": "internal",
  "thread_id": "th-ops",
  "mentions": ["qa"]
}
```

字段约束：
- `type`: `progress|blocker|decision|result|system`
- `visibility`: `internal|public`
- `content`: 必填，长度 <= 10000
- `thread_id`: 可选，长度 <= 256
- `author`: 可选，自动截断到 64 字符

响应示例：

```json
{
  "id": 1741300000000123,
  "author": "donky",
  "timestamp": "2026-03-07T00:00:00.000Z",
  "content": "阻塞 @ops 需要确认",
  "type": "blocker",
  "visibility": "internal",
  "thread_id": "th-ops",
  "mentions": ["qa", "ops"],
  "notify_targets": ["qa", "ops", "leader"]
}
```

> 规则：仅当存在 `mentions` 时，`notify_targets = mentions + watchers`（去重）。

### 2) 评论列表（支持过滤）

`GET /api/tickets/:id/comments?type=blocker&visibility=internal&thread_id=th-ops`

响应示例：

```json
{
  "ticket_id": 11,
  "filters": {
    "type": "blocker",
    "visibility": "internal",
    "thread_id": "th-ops"
  },
  "total": 1,
  "comments": [
    {
      "id": 1741300000000123,
      "author": "donky",
      "timestamp": "2026-03-07T00:00:00.000Z",
      "content": "阻塞 @ops 需要确认",
      "type": "blocker",
      "visibility": "internal",
      "thread_id": "th-ops",
      "mentions": ["qa", "ops"],
      "notify_targets": ["qa", "ops", "leader"]
    }
  ]
}
```

### 3) 更新 watchers

`PATCH /api/tickets/:id`

请求体示例：

```json
{
  "watchers": ["leader", "ops"]
}
```

## 已知说明

- 当前无用户认证，`author` 仍属于“客户端可传”模式；生产环境建议接入鉴权并由服务端注入作者身份。
- 测试日志里可能有 React `act(...)` 警告，不影响用例通过。
