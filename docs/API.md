# Ticket System API Documentation

## Base URL
```
http://127.0.0.1:8788/api
```

---

## 状态转换 API（核心）

### POST /tickets/:id/transition

**描述**：执行工单状态转换（强制接口，禁止直接 PATCH status）

**请求体**：
```json
{
  "action": "start_work",
  "actor": "beavy",
  "comment": "开始处理",
  // ... 其他必填字段
}
```

**支持的 Actions**：

| Action | From | To | 必填字段 |
|--------|------|-----|---------|
| `start_work` | queued | running | actor |
| `submit_for_review` | running | done | actor, result_summary |
| `request_decision` | running/review | pending_decision | actor, decision_summary |
| `approve` | done/review | complete | actor |
| `reject` | done/review | queued | actor, reject_reason |
| `block` | running | blocked | actor, blocker_summary |
| `unblock` | blocked | queued | actor |
| `fail` | running | failed | actor, error |
| `resume_from_decision` | pending_decision | queued | actor |

**响应**：
```json
{
  "success": true,
  "ticket": {
    "id": 22,
    "status": "running",
    "locked_by": "beavy",
    "locked_at": "2026-03-08T15:00:00Z",
    "next_actor": "beavy"
  },
  "message": "状态已从 queued 转换为 running"
}
```

**错误响应**：
```json
{
  "success": false,
  "error": "Cannot submit_for_review from status queued",
  "current_status": "queued",
  "allowed_from": ["running"]
}
```

---

### GET /tickets/:id/actions

**描述**：获取工单当前可执行的 actions

**响应**：
```json
{
  "ticket_id": 22,
  "current_status": "running",
  "available_actions": [
    "submit_for_review",
    "request_decision",
    "block",
    "fail"
  ]
}
```

---

## 工单 CRUD API

### GET /tickets

**描述**：获取工单列表

**查询参数**：
- `status`: 按状态筛选
- `platform`: 按平台筛选
- `assigned_agent`: 按执行人筛选

**响应**：
```json
[
  {
    "id": 1,
    "title": "工单标题",
    "status": "queued",
    "assigned_agent": "beavy",
    "next_actor": "beavy",
    "locked_by": null,
    "created": "2026-03-08T10:00:00Z",
    "last_update": "2026-03-08T10:00:00Z"
  }
]
```

---

### GET /tickets/:id

**描述**：获取工单详情

**响应**：
```json
{
  "id": 1,
  "title": "工单标题",
  "description": "工单描述",
  "status": "running",
  "assigned_agent": "beavy",
  "next_actor": "beavy",
  "locked_by": "beavy",
  "locked_at": "2026-03-08T15:00:00Z",
  "priority": "medium",
  "platform": "ticket-platform",
  "result_summary": null,
  "decision_summary": null,
  "comments": [],
  "created": "2026-03-08T10:00:00Z",
  "last_update": "2026-03-08T15:00:00Z"
}
```

---

### POST /tickets

**描述**：创建工单

**请求体**：
```json
{
  "title": "工单标题",
  "description": "工单描述",
  "assigned_agent": "beavy",
  "platform": "ticket-platform",
  "request_type": "feature"
}
```

**响应**：
```json
{
  "id": 1,
  "status": "queued",
  "assigned_agent": "beavy",
  "next_actor": "beavy"
}
```

---

### PATCH /tickets/:id

**描述**：更新工单字段（禁止直接修改 status）

**请求体**：
```json
{
  "title": "新标题",
  "description": "新描述",
  "priority": "high"
}
```

**注意**：如果尝试修改 `status`，会返回 400 错误：
```json
{
  "error": "Direct status update forbidden",
  "message": "禁止直接修改状态，请使用 POST /api/tickets/:id/transition"
}
```

---

## 评论 API

### POST /tickets/:id/comments

**描述**：添加评论

**请求体**：
```json
{
  "content": "评论内容",
  "author": "Current User",
  "type": "progress",
  "visibility": "internal"
}
```

---

## 派单 API

### GET /dispatch/ready

**描述**：获取待派发工单

**响应**：
```json
{
  "ready": [
    {
      "event_id": "evt_123",
      "ticket_id": 22,
      "agent": "beavy",
      "status": "queued",
      "created_at": "2026-03-08T15:00:00Z"
    }
  ]
}
```

### POST /dispatch/ack

**描述**：确认派单

**请求体**：
```json
{
  "event_id": "evt_123"
}
```

---

## 通知 API

### GET /notifications/ready

**描述**：获取待通知事件

**响应**：
```json
{
  "ready": [
    {
      "event_id": 456,
      "type": "done",
      "ticket_id": 22,
      "title": "修复待验收通知路由",
      "status": "done",
      "target_actor": "leoss",
      "target_session_key": "agent:main:ticket:22",
      "message": "📋 工单待验收\n\n#22 修复待验收通知路由\n结果：已完成"
    }
  ]
}
```

**路由规则**：
- `done / review`：`target_session_key` 指向 `review_owner` 的 ticket session
- `pending_decision / complete / failed`：`target_session_key` 指向老大主会话

### POST /notifications/ack

**描述**：确认通知

**请求体**：
```json
{
  "event_id": "evt_456"
}
```

---

## 状态转换示例

### 完整工单流转

```bash
# 1. 创建工单
curl -X POST http://127.0.0.1:8788/api/tickets \
  -H "Content-Type: application/json" \
  -d '{
    "title": "测试工单",
    "assigned_agent": "beavy"
  }'

# 2. 开工
curl -X POST http://127.0.0.1:8788/api/tickets/1/transition \
  -H "Content-Type: application/json" \
  -d '{
    "action": "start_work",
    "actor": "beavy",
    "comment": "开始处理"
  }'

# 3. 提交验收
curl -X POST http://127.0.0.1:8788/api/tickets/1/transition \
  -H "Content-Type: application/json" \
  -d '{
    "action": "submit_for_review",
    "actor": "beavy",
    "result_summary": "已完成功能开发",
    "comment": "请 review"
  }'

# 4. 通过关单
curl -X POST http://127.0.0.1:8788/api/tickets/1/transition \
  -H "Content-Type: application/json" \
  -d '{
    "action": "approve",
    "actor": "leoss",
    "comment": "验收通过"
  }'
```

### 请求决策流程

```bash
# 1. 开工
curl -X POST http://127.0.0.1:8788/api/tickets/2/transition \
  -H "Content-Type: application/json" \
  -d '{
    "action": "start_work",
    "actor": "beavy"
  }'

# 2. 请求决策
curl -X POST http://127.0.0.1:8788/api/tickets/2/transition \
  -H "Content-Type: application/json" \
  -d '{
    "action": "request_decision",
    "actor": "beavy",
    "decision_summary": "需要老大拍板 A/B 方案",
    "decision_context": "A 方案快但不稳定，B 方案慢但可靠",
    "comment": "请老大决策"
  }'

# 3. 恢复执行（老大决策后）
curl -X POST http://127.0.0.1:8788/api/tickets/2/transition \
  -H "Content-Type: application/json" \
  -d '{
    "action": "resume_from_decision",
    "actor": "荣晖",
    "comment": "采用 A 方案，继续执行"
  }'
```

---

## 错误码

| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 201 | 创建成功 |
| 400 | 请求参数错误 |
| 403 | 工单已锁定 |
| 404 | 工单不存在 |
| 500 | 服务器错误 |

---

## 注意事项

1. **禁止直接 PATCH status**：所有状态变更必须走 `POST /tickets/:id/transition`
2. **工单锁定**：`start_work` 会自动锁定工单，其他人无法操作
3. **自动路由**：状态转换会自动设置 `next_actor`
4. **必填字段**：不同 action 有不同的必填字段，缺失会返回 400
5. **状态约束**：只能从合法起始状态转换，否则返回 400

---

## 前端集成

### React 示例

```jsx
import { getTicketActions, transitionTicket } from '../api/tickets';

// 获取可执行 actions
const actions = await getTicketActions(ticketId);
console.log(actions.available_actions); // ['start_work', 'submit_for_review']

// 执行状态转换
const result = await transitionTicket(ticketId, {
  action: 'start_work',
  actor: 'beavy',
  comment: '开始处理'
});

if (result.success) {
  console.log('状态已更新:', result.ticket.status);
}
```

---

**最后更新**：2026-03-08  
**版本**：v2.0（状态机强约束版本）
