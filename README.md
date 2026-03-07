# Agent Ticket System

一个基于 React + Express + SQLite 的工单系统，支持多 Agent 协同处理工单、状态流转、评论时间线与通知摘要。

## 开发命令

```bash
npm install
npm run dev      # 前端开发服务
npm run api      # 后端 API（默认 8788）
npm test         # 单元测试
npm run build    # 前端构建
```

## 存储说明（SQLite only）

当前版本仅使用 **SQLite** 持久化，不再支持 JSON 存储切换。

- DB 路径：`data/tickets.db`
- 可通过环境变量覆盖：`TICKETS_DB_PATH`

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
