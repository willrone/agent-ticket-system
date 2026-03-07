# 工单平台重构任务：从 Push 模式改为 Pull 模式

## 目标
将工单平台从"推模式"（平台主动调用 agent）改为"拉模式"（agent 主动拉取任务），符合业界最佳实践。

## 架构变更

### 当前架构（Push）
```
用户创建工单 → 平台调用 OpenClaw → 等待执行结果 → 返回
问题：同步阻塞、容易超时、agent 无自主权
```

### 目标架构（Pull）
```
用户创建工单 → 立即返回（status: queued）
Agent 轮询 → 拉取工单 → 执行 → 更新状态
优势：异步、解耦、可扩展、agent 自主控制
```

## 具体改动

### 1. 移除主动调用逻辑
- **文件**: `api/openclaw.js`
- **操作**: 删除整个文件（不再需要主动调用 OpenClaw）

### 2. 修改创建工单接口
- **文件**: `api/app.js`
- **接口**: `POST /api/tickets`
- **改动**:
  ```javascript
  // 旧逻辑：创建工单 → 调用 OpenClaw → 等待结果
  // 新逻辑：创建工单 → 立即返回（status: queued）
  
  app.post('/api/tickets', async (req, res) => {
    const { title, description, agent } = req.body || {};
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Bad request', message: '工单标题不能为空' });
    }
    
    const targetAgent = agent || 'donky';
    const ticket = store.createTicket({
      title: title.trim(),
      description: (description || '').trim(),
      status: 'queued',  // 改为 queued
      assigned_agent: targetAgent,
      priority: 'medium',
      created: new Date().toISOString(),
    });
    
    return res.status(201).json(formatTicketForList(ticket));
  });
  ```

### 3. 添加工单拉取接口
- **文件**: `api/app.js`
- **新增接口**: `GET /api/tickets/pull?agent=<agent>&limit=1`
- **功能**: Agent 拉取待处理工单
  ```javascript
  app.get('/api/tickets/pull', (req, res) => {
    const { agent, limit = 1 } = req.query;
    if (!agent) {
      return res.status(400).json({ error: 'Bad request', message: 'agent 参数必填' });
    }
    
    const tickets = store.getAllTickets()
      .filter(t => t.status === 'queued' && t.assigned_agent === agent)
      .sort((a, b) => {
        // 优先级排序：critical > high > medium > low
        const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        return (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
      })
      .slice(0, parseInt(limit));
    
    res.json(tickets.map(formatTicketForList));
  });
  ```

### 4. 修改工单更新接口
- **文件**: `api/app.js`
- **改动**: 确保 `PATCH /api/tickets/:id` 支持状态更新
  ```javascript
  app.patch('/api/tickets/:id', (req, res) => {
    const id = req.params.id;
    const ticket = store.getTicketById(id);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
    }
    
    const { status, result_summary, error, session_key } = req.body || {};
    const updates = {};
    
    if (status) updates.status = status;
    if (result_summary) updates.result_summary = result_summary;
    if (error) updates.error = error;
    if (session_key) updates.session_key = session_key;
    updates.last_update = new Date().toISOString();
    
    store.updateTicket(id, updates);
    const updated = store.getTicketById(id);
    res.json(formatTicketForList(updated));
  });
  ```

### 5. 移除手动派发接口中的 OpenClaw 调用
- **文件**: `api/app.js`
- **接口**: `POST /api/tickets/:id/dispatch`
- **改动**: 只更新 assigned_agent 和状态，不调用 OpenClaw
  ```javascript
  app.post('/api/tickets/:id/dispatch', (req, res) => {
    const id = req.params.id;
    const agent = req.body?.agent || 'donky';
    const ticket = store.getTicketById(id);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found', message: '工单不存在' });
    }
    
    store.updateTicket(id, {
      status: 'queued',
      assigned_agent: agent,
      error: null,
      last_update: new Date().toISOString(),
    });
    
    const updated = store.getTicketById(id);
    res.json(formatTicketForList(updated));
  });
  ```

### 6. 更新 store.js
- **文件**: `api/store.js`
- **改动**: 确保 `createTicket` 支持新的字段
  ```javascript
  // 确保支持 priority, created, last_update 等字段
  ```

### 7. 前端适配
- **文件**: `src/pages/Tickets.jsx`
- **改动**: 创建工单后不再等待执行结果，立即显示在列表中（status: queued）

## 测试验证

### 1. 创建工单
```bash
curl -X POST http://localhost:8788/api/tickets \
  -H "Content-Type: application/json" \
  -d '{"title": "测试工单", "description": "测试描述", "agent": "donky"}'
```
预期：立即返回，status 为 queued

### 2. 拉取工单
```bash
curl "http://localhost:8788/api/tickets/pull?agent=donky&limit=1"
```
预期：返回待处理的工单列表

### 3. 更新工单状态
```bash
curl -X PATCH http://localhost:8788/api/tickets/1 \
  -H "Content-Type: application/json" \
  -d '{"status": "running"}'
```

### 4. 完成工单
```bash
curl -X PATCH http://localhost:8788/api/tickets/1 \
  -H "Content-Type: application/json" \
  -d '{"status": "done", "result_summary": "任务完成"}'
```

## Agent 轮询实现（后续）

在各个 agent 的 HEARTBEAT.md 中添加轮询逻辑：

```bash
# 每 2 分钟检查一次工单
curl -s "http://localhost:8788/api/tickets/pull?agent=donky&limit=1" | \
  jq -r '.[0].id' | \
  while read ticket_id; do
    if [ -n "$ticket_id" ]; then
      # 更新状态为 running
      curl -X PATCH "http://localhost:8788/api/tickets/$ticket_id" \
        -H "Content-Type: application/json" \
        -d '{"status": "running"}'
      
      # 执行任务（通过 sessions_send）
      # ...
      
      # 更新状态为 done
      curl -X PATCH "http://localhost:8788/api/tickets/$ticket_id" \
        -H "Content-Type: application/json" \
        -d '{"status": "done", "result_summary": "..."}'
    fi
  done
```

## 注意事项

1. **向后兼容**: 保留现有的 API 接口，只修改内部实现
2. **状态流转**: queued → running → done/failed
3. **错误处理**: Agent 执行失败时更新 status 为 failed，并记录 error
4. **并发控制**: 多个 agent 同时拉取时避免重复处理（可以加锁机制）
5. **优先级**: 支持 critical > high > medium > low 的优先级排序

## 完成标准

- [ ] 移除 `api/openclaw.js`
- [ ] 修改 `POST /api/tickets` 立即返回
- [ ] 添加 `GET /api/tickets/pull` 接口
- [ ] 修改 `PATCH /api/tickets/:id` 支持状态更新
- [ ] 修改 `POST /api/tickets/:id/dispatch` 移除 OpenClaw 调用
- [ ] 前端适配：创建工单后立即显示
- [ ] 测试验证：创建、拉取、更新工单流程
- [ ] 文档更新：API 文档和使用说明
